// Package paper is a NIFTY options paper-trading simulator.
// All state is persisted in PostgreSQL via storage.PaperRepository.
// This package NEVER places real orders — it is purely a simulation.
package paper

import (
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"

	"stockwise/internal/naren/analysis/options"
	"stockwise/internal/naren/kite"
	"stockwise/internal/naren/storage"
)

// ─── Config ───────────────────────────────────────────────────────────────────

type Config struct {
	Capital       float64
	Lots          int
	RiskPct       float64
	RR            float64
	ConfThreshold int
}

// ─── Engine ───────────────────────────────────────────────────────────────────

type Engine struct {
	mu   sync.RWMutex
	kc   *kite.Client
	repo *storage.PaperRepository
	log  *zap.Logger

	// Runtime cache — always mirrors what's in the DB
	account    storage.PaperAccount
	openPos    *storage.PaperPosition // nil if no open position
	lastSignal *options.Recommendation
	lastErr    string

	running bool
	stopCh  chan struct{}
}

func NewEngine(kc *kite.Client, cfg Config, repo *storage.PaperRepository, log *zap.Logger) *Engine {
	e := &Engine{kc: kc, repo: repo, log: log}

	// Load or create account from DB
	acc, err := repo.LoadAccount()
	if err != nil {
		log.Warn("paper engine: failed to load account, using defaults", zap.Error(err))
		e.account = storage.PaperAccount{
			ID: 1, Capital: cfg.Capital, Lots: cfg.Lots,
			RiskPct: cfg.RiskPct, RR: cfg.RR, ConfThreshold: cfg.ConfThreshold,
		}
	} else {
		// Seed defaults on first run if DB has none of our overrides
		if acc.Capital == 0 {
			acc.Capital = cfg.Capital
			acc.Lots = cfg.Lots
			acc.RiskPct = cfg.RiskPct
			acc.RR = cfg.RR
			acc.ConfThreshold = cfg.ConfThreshold
			_ = repo.SaveAccount(acc)
		}
		e.account = *acc
	}

	// Restore any open position from DB
	pos, err := repo.OpenPosition()
	if err != nil {
		log.Warn("paper engine: failed to load open position", zap.Error(err))
	} else {
		e.openPos = pos
	}
	return e
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

func (e *Engine) Start() {
	e.mu.Lock()
	if e.running { e.mu.Unlock(); return }
	e.running = true
	e.stopCh = make(chan struct{})
	stop := e.stopCh
	e.mu.Unlock()
	go e.loop(stop)
}

func (e *Engine) Stop() {
	e.mu.Lock(); defer e.mu.Unlock()
	if !e.running { return }
	e.running = false; close(e.stopCh)
}

func (e *Engine) loop(stop chan struct{}) {
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	e.tick()
	for {
		select {
		case <-stop: return
		case <-tick.C: e.tick()
		}
	}
}

// ─── Core tick ────────────────────────────────────────────────────────────────

func (e *Engine) tick() {
	defer func() { if r := recover(); r != nil { e.log.Error("paper tick panic", zap.Any("r", r)) } }()

	if !e.kc.IsConnected() { e.setErr("Kite not connected — login required"); return }

	// Refresh open position premiums + check SL/target
	e.mu.RLock(); open := e.openPos; e.mu.RUnlock()
	if open != nil { e.refreshAndCheck(open) }

	if isAfterSquareOff() {
		e.mu.RLock(); still := e.openPos != nil; e.mu.RUnlock()
		if still { e.closePosition("EOD square-off (15:20 IST)") }
		return
	}

	// Signal generation — rate-limited to every 2 min
	e.mu.RLock(); sig := e.lastSignal; e.mu.RUnlock()
	if sig != nil && time.Since(sig.AsOf) < 2*time.Minute { return }
	if !isMarketOpen() { return }

	rec, err := e.computeSignal()
	if err != nil { e.setErr(err.Error()); return }

	e.mu.Lock()
	e.lastSignal = rec
	auto := e.account.AutoMode
	hasOpen := e.openPos != nil
	conf := e.account.ConfThreshold
	e.lastErr = ""
	e.mu.Unlock()

	if auto && !hasOpen && rec.Strategy != options.StratNone &&
		len(rec.Legs) > 0 && rec.Confidence >= conf {
		if _, err := e.EnterFromRecommendation(rec, "AUTO"); err != nil {
			e.setErr("auto-entry: " + err.Error())
		}
	}
}

func (e *Engine) computeSignal() (*options.Recommendation, error) {
	now := time.Now().In(ist())
	from := now.AddDate(0, 0, -7).Format("2006-01-02 15:04:05")
	to := now.Format("2006-01-02 15:04:05")
	candles, err := e.kc.HistoricalData(kite.NiftyIndexToken, "15minute", from, to)
	if err != nil { return nil, err }
	expiry := options.NiftyWeeklyExpiry(now)
	isExpiry := expiry.Format("2006-01-02") == now.Format("2006-01-02")
	return options.Analyze(candles, isExpiry)
}

func (e *Engine) refreshAndCheck(pos *storage.PaperPosition) {
	keys := make([]string, len(pos.Legs))
	for i, l := range pos.Legs { keys[i] = l.QuoteKey }
	ltp, err := e.kc.LTP(keys...)
	if err != nil { e.setErr("premium refresh: " + err.Error()); return }

	e.mu.Lock()
	for i := range pos.Legs {
		if d, ok := ltp[pos.Legs[i].QuoteKey]; ok {
			pos.Legs[i].CurrentPremium = d.LastPrice
		}
	}
	pnl := unrealizedPnL(pos.Legs)
	target, stop := pos.TargetPnL, pos.StopPnL
	e.mu.Unlock()

	// Persist updated premiums every tick (lightweight bulk UPDATE)
	_ = e.repo.UpdateLegPremiums(pos.Legs)

	switch {
	case pnl >= target:
		e.closePosition(fmt.Sprintf("Target hit (RR 1:%.1f) +₹%.0f", pos.RR, pnl))
	case pnl <= stop:
		e.closePosition(fmt.Sprintf("Stop-loss hit -₹%.0f", -pnl))
	}
}

// ─── Entry / Exit ─────────────────────────────────────────────────────────────

func (e *Engine) EnterFromRecommendation(rec *options.Recommendation, mode string) (*storage.PaperPosition, error) {
	e.mu.RLock(); hasOpen := e.openPos != nil; e.mu.RUnlock()
	if hasOpen { return nil, fmt.Errorf("position already open — close it first") }
	if len(rec.Legs) == 0 { return nil, fmt.Errorf("recommendation has no tradeable legs") }

	e.mu.RLock(); acc := e.account; e.mu.RUnlock()
	qty := acc.Lots * kite.NiftyLotSize
	riskAmt := acc.Capital * acc.RiskPct
	rewardAmt := riskAmt * acc.RR

	// Resolve and price each leg
	legs := make([]storage.PaperLeg, 0, len(rec.Legs))
	keys := make([]string, 0, len(rec.Legs))
	for _, spec := range rec.Legs {
		strike := rec.ATMStrike + spec.StrikeOffset
		leg, err := e.kc.ResolveLeg(strike, spec.OptionType, "")
		if err != nil { return nil, err }
		legs = append(legs, storage.PaperLeg{
			TradingSymbol:   leg.TradingSymbol,
			QuoteKey:        leg.QuoteKey,
			InstrumentToken: leg.InstrumentToken,
			OptionType:      leg.OptionType,
			Strike:          leg.Strike,
			Side:            spec.Side,
			Qty:             qty,
			Label:           spec.Label,
		})
		keys = append(keys, leg.QuoteKey)
	}

	// Fetch entry premiums
	ltp, err := e.kc.LTP(keys...)
	if err != nil { return nil, fmt.Errorf("fetching entry premiums: %w", err) }
	for i := range legs {
		d, ok := ltp[legs[i].QuoteKey]
		if !ok || d.LastPrice <= 0 { return nil, fmt.Errorf("no live premium for %s", legs[i].QuoteKey) }
		legs[i].EntryPremium = d.LastPrice
		legs[i].CurrentPremium = d.LastPrice
	}

	pos := &storage.PaperPosition{
		ID:         fmt.Sprintf("PT-%d", time.Now().UnixNano()/1e6),
		Strategy:   string(rec.Strategy),
		Direction:  rec.Direction,
		Regime:     string(rec.Regime),
		Confidence: rec.Confidence,
		Mode:       mode,
		RR:         acc.RR,
		Lots:       acc.Lots,
		Spot:       rec.Indicators.Spot,
		ATMStrike:  rec.ATMStrike,
		TargetPnL:  rewardAmt,
		StopPnL:    -riskAmt,
		Status:     "OPEN",
		EntryTime:  time.Now().In(ist()),
		Reasoning:  storage.StringSlice(rec.Reasoning),
		Legs:       legs,
	}

	if err := e.repo.CreatePosition(pos); err != nil {
		return nil, fmt.Errorf("saving position to DB: %w", err)
	}
	e.mu.Lock(); e.openPos = pos; e.mu.Unlock()
	e.log.Info("paper position opened",
		zap.String("id", pos.ID), zap.String("strategy", pos.Strategy),
		zap.String("mode", mode), zap.Float64("target", rewardAmt), zap.Float64("stop", -riskAmt))
	return pos, nil
}

func (e *Engine) closePosition(reason string) {
	e.mu.Lock(); pos := e.openPos; e.mu.Unlock()
	if pos == nil { return }

	now := time.Now().In(ist())
	pnl := unrealizedPnL(pos.Legs)
	// Clamp to defined risk/reward
	if pnl > pos.TargetPnL { pnl = pos.TargetPnL }
	if pnl < pos.StopPnL   { pnl = pos.StopPnL }

	// Save exit premiums on legs
	for i := range pos.Legs {
		pos.Legs[i].ExitPremium = pos.Legs[i].CurrentPremium
	}

	if err := e.repo.ClosePosition(pos.ID, now, pnl, reason, pos.Legs); err != nil {
		e.log.Error("failed to close position in DB", zap.Error(err))
		return
	}
	e.mu.Lock(); e.openPos = nil; e.mu.Unlock()
	e.log.Info("paper position closed", zap.String("id", pos.ID), zap.Float64("pnl", pnl), zap.String("reason", reason))
}

func (e *Engine) CloseOpen() error {
	e.mu.RLock(); open := e.openPos; e.mu.RUnlock()
	if open == nil { return fmt.Errorf("no open position") }
	e.refreshAndCheck(open)
	e.mu.RLock(); still := e.openPos != nil; e.mu.RUnlock()
	if still { e.closePosition("Manually closed") }
	return nil
}

// ─── Settings ─────────────────────────────────────────────────────────────────

func (e *Engine) SetAutoMode(on bool) {
	e.mu.Lock(); e.account.AutoMode = on; acc := e.account; e.mu.Unlock()
	_ = e.repo.SaveAccount(&acc)
}

func (e *Engine) SetParams(rr, riskPct float64, lots, conf int) {
	e.mu.Lock()
	if rr > 0     { e.account.RR = rr }
	if riskPct > 0 { e.account.RiskPct = riskPct }
	if lots > 0   { e.account.Lots = lots }
	if conf > 0   { e.account.ConfThreshold = conf }
	acc := e.account
	e.mu.Unlock()
	_ = e.repo.SaveAccount(&acc)
}

// ─── Signal + Snapshot ────────────────────────────────────────────────────────

func (e *Engine) LatestSignal() (*options.Recommendation, error) {
	rec, err := e.computeSignal()
	if err != nil { return nil, err }
	e.mu.Lock(); e.lastSignal = rec; e.lastErr = ""; e.mu.Unlock()
	return rec, nil
}

type Snapshot struct {
	Connected      bool                    `json:"connected"`
	Running        bool                    `json:"running"`
	AutoMode       bool                    `json:"auto_mode"`
	Capital        float64                 `json:"capital"`
	Lots           int                     `json:"lots"`
	RiskPct        float64                 `json:"risk_pct"`
	RR             float64                 `json:"rr"`
	ConfThreshold  int                     `json:"conf_threshold"`
	MarketOpen     bool                    `json:"market_open"`
	Open           *storage.PaperPosition  `json:"open"`
	OpenPnL        float64                 `json:"open_pnl"`
	History        []storage.PaperPosition `json:"history"`
	TodayRealized  float64                 `json:"today_realized"`
	TodayTrades    int                     `json:"today_trades"`
	TotalRealized  float64                 `json:"total_realized"`
	WinCount       int                     `json:"win_count"`
	LossCount      int                     `json:"loss_count"`
	LastSignal     *options.Recommendation `json:"last_signal"`
	LastError      string                  `json:"last_error"`
}

func (e *Engine) Snapshot() Snapshot {
	e.mu.RLock()
	snap := Snapshot{
		Connected:     e.kc.IsConnected(),
		Running:       e.running,
		AutoMode:      e.account.AutoMode,
		Capital:       e.account.Capital,
		Lots:          e.account.Lots,
		RiskPct:       e.account.RiskPct,
		RR:            e.account.RR,
		ConfThreshold: e.account.ConfThreshold,
		MarketOpen:    isMarketOpen(),
		Open:          e.openPos,
		LastSignal:    e.lastSignal,
		LastError:     e.lastErr,
	}
	if e.openPos != nil { snap.OpenPnL = unrealizedPnL(e.openPos.Legs) }
	e.mu.RUnlock()

	// DB queries outside the mutex
	hist, _ := e.repo.History(50)
	snap.History = hist
	snap.TodayRealized, snap.TodayTrades, _ = e.repo.TodayStats()
	snap.TotalRealized, snap.WinCount, snap.LossCount, _ = e.repo.AllTimeStats()
	return snap
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func (e *Engine) setErr(msg string) { e.mu.Lock(); e.lastErr = msg; e.mu.Unlock() }

func unrealizedPnL(legs []storage.PaperLeg) float64 {
	var s float64
	for _, l := range legs {
		if l.Side == "BUY" {
			s += (l.CurrentPremium - l.EntryPremium) * float64(l.Qty)
		} else {
			s += (l.EntryPremium - l.CurrentPremium) * float64(l.Qty)
		}
	}
	return s
}

func ist() *time.Location {
	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil { return time.FixedZone("IST", 5*3600+30*60) }
	return loc
}

func isMarketOpen() bool {
	now := time.Now().In(ist())
	if now.Weekday() == time.Saturday || now.Weekday() == time.Sunday { return false }
	mins := now.Hour()*60 + now.Minute()
	return mins >= 9*60+15 && mins <= 15*60+30
}

func isAfterSquareOff() bool {
	now := time.Now().In(ist())
	mins := now.Hour()*60 + now.Minute()
	return mins >= 15*60+20
}
