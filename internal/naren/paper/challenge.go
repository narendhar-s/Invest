// Package paper — 90-Day Paper Trading Challenge service.
//
// Signal accuracy pipeline (in order, all must pass):
//  1. 15-minute NIFTY trend signal (EMA9/21 + ATR + VWAP + ORB + SuperTrend)
//  2. PCR filter — only trade if option-chain bias matches signal direction
//  3. Real Kite LTP — use actual live option premium for entry, NOT Black-Scholes
//  4. Entry on NEXT bar open — never same-bar to avoid look-ahead
//  5. Intrabar SL — use bar H/L to check if SL was hit within the candle
//
// NO real orders. All positions are simulated and stored in PostgreSQL.
package paper

import (
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
	"gorm.io/gorm"

	"stockwise/internal/naren/analysis/options"
	"stockwise/internal/naren/kite"
	"stockwise/internal/naren/storage"
)

// ─── ChallengeService ─────────────────────────────────────────────────────────

type ChallengeService struct {
	mu     sync.RWMutex
	db     *storage.DB
	kc     *kite.Client
	ticker *kite.Ticker   // WebSocket real-time tick stream (nil = REST polling fallback)
	log    *zap.Logger

	active    *storage.ChallengeConfig // nil if no active challenge
	openTrade *storage.ChallengeTrade  // nil if no open position

	// In-memory live state — updated on every WebSocket tick, never persisted
	livePnL            float64
	liveOptionPrice    float64   // current option LTP
	openToken          uint32    // instrument token of open option leg
	optionPriceHistory []float64 // ring buffer of last 60 option prices (sparkline)
	liveSpot           float64   // latest NIFTY spot price from ticker

	// Dynamic SL state (paper trades only)
	// entrySLAmt: effective SL in ₹, computed at entry as min(day-profit SL, algo SL).
	// peakPnL:    highest unrealised P&L seen for the current open trade (trailing SL).
	entrySLAmt float64
	peakPnL    float64

	lastSignal     *options.Recommendation
	lastChain      *kite.ChainSnapshot
	lastChainFetch time.Time
	lastError      string

	// strategy configuration — set by the constructor. Defaults reproduce the
	// original OPTIONS challenge exactly; the SCALP variant overrides them.
	ctype        string                                                       // "OPTIONS" | "SCALP"
	interval     string                                                       // Kite candle interval, e.g. "15minute" | "minute"
	lookbackDays int                                                          // history window for the signal
	minCandles   int                                                          // minimum candles before evaluating
	usePCR       bool                                                         // apply the option-chain PCR filter
	analyze      func([]kite.Candle, bool) (*options.Recommendation, error)   // signal generator

	// live trading (real Zerodha orders). All default OFF; liveEnabled also
	// resets to OFF on every restart so live trading is never silently resumed.
	liveAllowed      bool    // server master switch (config kite.live_trading_enabled)
	liveEnabled      bool    // per-challenge UI toggle
	liveProfitTarget float64 // ₹ — square off the open LIVE position when its P&L ≥ this
	liveMaxLots      int     // cap on lots for LIVE orders (0 = no cap)
	liveMinProfit    float64 // ₹ — profit floor: never book a LIVE profit exit below this (0 = no floor)
	liveWindowStart  string  // "HH:MM" IST — earliest time a LIVE entry may open ("" = no limit)
	liveWindowEnd    string  // "HH:MM" IST — latest time a LIVE entry may open ("" = no limit)
	liveHoldConfidence int   // % — keep riding past the profit floor only while signal confidence ≥ this
	liveRR           float64 // risk-reward ratio for LIVE exits (target = risk × RR; 0 = use ₹ target)
	liveMaxDailyLoss   float64 // ₹ — stop taking LIVE trades once the day's realized LIVE loss reaches this (0 = no limit)
	liveMaxConsecLosses int   // stop taking LIVE trades after this many back-to-back LIVE losses in a day (0 = no limit)
	liveDailyRiskCapital float64 // ₹ — day's LIVE risk budget; stop once (live trades today × risk/trade) reaches it (0 = no limit)
	openLiveQty      int     // actual qty sent for the open LIVE position, for an exact SELL on exit

	running bool
	stopCh  chan struct{}

	notify func(string) // optional event sink (e.g. Telegram alerts); nil = no-op
}

// SetNotifier registers a callback invoked on key challenge events (entry, exit,
// live order results). Used by the Telegram bot to push alerts. Safe to leave nil.
func (cs *ChallengeService) SetNotifier(fn func(string)) {
	cs.mu.Lock()
	cs.notify = fn
	cs.mu.Unlock()
}

// emit sends an event string to the registered notifier, if any.
func (cs *ChallengeService) emit(msg string) {
	cs.mu.RLock()
	fn := cs.notify
	cs.mu.RUnlock()
	if fn != nil {
		go fn(msg)
	}
}

// SetLiveAllowed records whether the server config permits real-money trading.
func (cs *ChallengeService) SetLiveAllowed(b bool) {
	cs.mu.Lock()
	cs.liveAllowed = b
	cs.mu.Unlock()
}

// LiveSettings carries the user-configurable LIVE-trading guards (set from the
// UI live-config panel). All apply to REAL Zerodha orders only — the paper
// simulation is unaffected. Zero/empty values mean "no limit".
type LiveSettings struct {
	Enabled        bool    // place real orders
	ProfitTarget   float64 // ₹ — square off the open LIVE position when P&L ≥ this
	MaxLots        int     // cap on lots for LIVE orders (0 = no cap)
	MinProfit      float64 // ₹ — profit floor: never book a LIVE profit exit below this (0 = no floor)
	WindowStart    string  // "HH:MM" IST — earliest a LIVE entry may open ("" = no limit)
	WindowEnd      string  // "HH:MM" IST — latest a LIVE entry may open ("" = no limit)
	HoldConfidence int     // % — keep riding past the floor only while confidence ≥ this (default 70)
	RR             float64 // risk-reward ratio for LIVE exits (target = risk × RR; 0 = use ₹ target)
	MaxDailyLoss     float64 // ₹ — stop LIVE trades once the day's realized LIVE loss reaches this (0 = none)
	MaxConsecLosses  int     // stop LIVE trades after this many back-to-back LIVE losses in a day (0 = none)
	DailyRiskCapital float64 // ₹ — day's LIVE risk budget; stop once committed risk reaches it (0 = none)
}

// SetLiveConfig enables/disables live order placement and sets the LIVE guards
// (profit square-off, max lots, min-profit floor, trading window). Enabling is
// refused unless the server master switch is on.
func (cs *ChallengeService) SetLiveConfig(s LiveSettings) error {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	if s.Enabled && !cs.liveAllowed {
		return fmt.Errorf("live trading is disabled in server config (set kite.live_trading_enabled: true)")
	}
	if s.ProfitTarget < 0 {
		s.ProfitTarget = 0
	}
	if s.MaxLots < 0 {
		s.MaxLots = 0
	}
	if s.MinProfit < 0 {
		s.MinProfit = 0
	}
	if s.HoldConfidence <= 0 {
		s.HoldConfidence = 70
	}
	if s.HoldConfidence > 100 {
		s.HoldConfidence = 100
	}
	if s.RR < 0 {
		s.RR = 0
	}
	if s.MaxDailyLoss < 0 {
		s.MaxDailyLoss = 0
	}
	if s.MaxConsecLosses < 0 {
		s.MaxConsecLosses = 0
	}
	if s.DailyRiskCapital < 0 {
		s.DailyRiskCapital = 0
	}
	cs.liveEnabled = s.Enabled
	cs.liveProfitTarget = s.ProfitTarget
	cs.liveMaxLots = s.MaxLots
	cs.liveMinProfit = s.MinProfit
	cs.liveWindowStart = strings.TrimSpace(s.WindowStart)
	cs.liveWindowEnd = strings.TrimSpace(s.WindowEnd)
	cs.liveHoldConfidence = s.HoldConfidence
	cs.liveRR = s.RR
	cs.liveMaxDailyLoss = s.MaxDailyLoss
	cs.liveMaxConsecLosses = s.MaxConsecLosses
	cs.liveDailyRiskCapital = s.DailyRiskCapital
	if s.Enabled {
		cs.log.Warn("⚠️ LIVE TRADING ENABLED for challenge — real Zerodha orders will be placed",
			zap.Float64("profit_squareoff", s.ProfitTarget), zap.Int("max_lots", s.MaxLots),
			zap.Float64("min_profit_floor", s.MinProfit),
			zap.String("window", cs.liveWindowStart+"–"+cs.liveWindowEnd),
			zap.Int("hold_confidence", s.HoldConfidence), zap.Float64("rr", s.RR),
			zap.Float64("max_daily_loss", s.MaxDailyLoss), zap.Int("max_consec_losses", s.MaxConsecLosses),
			zap.Float64("daily_risk_capital", s.DailyRiskCapital))
	} else {
		cs.log.Info("live trading disabled for challenge")
	}
	return nil
}

// withinLiveWindow reports whether now (IST) is inside the configured LIVE
// entry window. An empty start or end means "no restriction".
func (cs *ChallengeService) withinLiveWindow(now time.Time) bool {
	cs.mu.RLock()
	start, end := cs.liveWindowStart, cs.liveWindowEnd
	cs.mu.RUnlock()
	if start == "" || end == "" {
		return true
	}
	cur := now.Format("15:04")
	return cur >= start && cur <= end
}

// liveRiskBlocks reports whether LIVE entries should be halted for the rest of
// the day per the user-configured daily risk stops: max daily loss, max
// back-to-back losses, and the day's risk-capital budget. LIVE trades only —
// the paper simulation keeps running so the strategy/backtest are unaffected.
func (cs *ChallengeService) liveRiskBlocks(active *storage.ChallengeConfig, now time.Time) (bool, string) {
	cs.mu.RLock()
	maxLoss := cs.liveMaxDailyLoss
	maxConsec := cs.liveMaxConsecLosses
	riskCap := cs.liveDailyRiskCapital
	cs.mu.RUnlock()
	if maxLoss <= 0 && maxConsec <= 0 && riskCap <= 0 {
		return false, ""
	}
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, ist())

	// Max daily loss: realized LIVE P&L today.
	if maxLoss > 0 {
		var realizedLive float64
		cs.db.Model(&storage.ChallengeTrade{}).
			Where("challenge_id = ? AND live = ? AND status = ? AND exit_time >= ?", active.ID, true, "CLOSED", dayStart).
			Select("COALESCE(SUM(pnl),0)").Scan(&realizedLive)
		if realizedLive <= -maxLoss {
			return true, fmt.Sprintf("max daily loss hit (live P&L today ₹%.0f)", realizedLive)
		}
	}

	// Day's risk-capital budget: each live trade commits RiskPerTrade.
	if riskCap > 0 && active.RiskPerTrade > 0 {
		var liveEntriesToday int64
		cs.db.Model(&storage.ChallengeTrade{}).
			Where("challenge_id = ? AND live = ? AND entry_time >= ?", active.ID, true, dayStart).
			Count(&liveEntriesToday)
		// Block the trade we're ABOUT to take if it would push committed risk
		// (trades incl. this one × risk/trade) past the day's budget. This also
		// blocks the first trade when the budget is smaller than one trade's risk.
		wouldCommit := float64(liveEntriesToday+1) * active.RiskPerTrade
		if wouldCommit > riskCap {
			return true, fmt.Sprintf("daily risk budget ₹%.0f reached: %d live trade(s) already commit ₹%.0f, next would commit ₹%.0f (risk/trade ₹%.0f)",
				riskCap, liveEntriesToday, float64(liveEntriesToday)*active.RiskPerTrade, wouldCommit, active.RiskPerTrade)
		}
	}

	// Back-to-back LIVE losses today (trailing streak of losers).
	if maxConsec > 0 {
		var todays []storage.ChallengeTrade
		cs.db.Where("challenge_id = ? AND live = ? AND status = ? AND exit_time >= ?", active.ID, true, "CLOSED", dayStart).
			Order("exit_time DESC").Limit(maxConsec).Find(&todays)
		streak := 0
		for _, t := range todays {
			if t.PnL < 0 {
				streak++
			} else {
				break
			}
		}
		if streak >= maxConsec {
			return true, fmt.Sprintf("%d back-to-back live losses today", streak)
		}
	}
	return false, ""
}

// signalAligned reports whether the latest signal still favors the open
// position (CE wants BULLISH, PE wants BEARISH).
func signalAligned(open *storage.ChallengeTrade, sig *options.Recommendation) bool {
	if sig == nil {
		return false
	}
	if open.OptionType == "CE" {
		return sig.Direction == "BULLISH"
	}
	return sig.Direction == "BEARISH"
}

// computeEffectiveSL returns the stop-loss amount (₹) to use for a new PAPER trade:
//
//  1. If this is the first trade of the calendar day, look back up to 5 trading
//     days to find the most recent day with a positive realized P&L, and use that
//     as the SL ("protect yesterday's gains").
//  2. Otherwise use today's cumulative realized P&L so far as the SL
//     ("never give back more than what you've already made today").
//  3. Take the lesser of that profit-based SL and the algo's fixed RiskPerTrade.
//     If there is no prior profit to protect, fall back to RiskPerTrade.
func (cs *ChallengeService) computeEffectiveSL(active *storage.ChallengeConfig, entryTime time.Time) float64 {
	loc      := ist()
	dayStart := time.Date(entryTime.Year(), entryTime.Month(), entryTime.Day(), 0, 0, 0, 0, loc)

	// How many of this challenge's trades closed today BEFORE entryTime?
	var closedToday int64
	cs.db.Model(&storage.ChallengeTrade{}).
		Where("challenge_id = ? AND status = ? AND exit_time >= ? AND exit_time < ?",
			active.ID, "CLOSED", dayStart, entryTime).
		Count(&closedToday)

	var profitSL float64

	if closedToday == 0 {
		// First trade of the day — walk back up to 5 days for the last profitable day.
		for d := 1; d <= 5; d++ {
			prevStart := dayStart.AddDate(0, 0, -d)
			prevEnd   := dayStart.AddDate(0, 0, -(d - 1))
			var pnl float64
			cs.db.Model(&storage.ChallengeTrade{}).
				Where("challenge_id = ? AND status = ? AND exit_time >= ? AND exit_time < ?",
					active.ID, "CLOSED", prevStart, prevEnd).
				Select("COALESCE(SUM(pnl), 0)").Scan(&pnl)
			if pnl > 0 {
				profitSL = pnl
				break
			}
		}
	} else {
		// Intraday follow-up trade — protect today's realized P&L.
		var pnl float64
		cs.db.Model(&storage.ChallengeTrade{}).
			Where("challenge_id = ? AND status = ? AND exit_time >= ? AND exit_time < ?",
				active.ID, "CLOSED", dayStart, entryTime).
			Select("COALESCE(SUM(pnl), 0)").Scan(&pnl)
		if pnl > 0 {
			profitSL = pnl
		}
	}

	if profitSL > 0 {
		return math.Min(profitSL, active.RiskPerTrade)
	}
	return active.RiskPerTrade
}

// liveExitReason decides whether to close a LIVE position this tick, returning a
// human-readable reason or "" to hold. Priority:
//  1. Stop-loss (always).
//  2. Signal exit — reversal, NO_TRADE/NEUTRAL, or confidence < 55 (entry floor).
//  3. Profit floor crossed — book unless confidence is high AND signal still
//     favors the position (then keep riding).
//  4. RR/₹ target reached — book unless riding on high confidence.
//
// Used for LIVE positions only; paper positions keep the fixed SL/target.
func (cs *ChallengeService) liveExitReason(open *storage.ChallengeTrade, pnl, qty float64) string {
	cs.mu.RLock()
	active := cs.active
	sig := cs.lastSignal
	floor := cs.liveMinProfit
	holdConf := cs.liveHoldConfidence
	rr := cs.liveRR
	liveTgt := cs.liveProfitTarget
	cs.mu.RUnlock()
	if active == nil {
		return ""
	}
	risk := active.RiskPerTrade

	// 1) Stop-loss — always.
	if risk > 0 && pnl <= -risk {
		return fmt.Sprintf("Stop-loss -₹%.0f", risk)
	}

	// 2) Signal-based exit — reversal / NO_TRADE / NEUTRAL / confidence collapse.
	if sig != nil {
		if sig.Strategy == options.StratNone {
			return "Signal exit: NO_TRADE"
		}
		if !signalAligned(open, sig) {
			return fmt.Sprintf("Signal exit: %s reversal", sig.Direction)
		}
		if sig.Confidence < 55 {
			return fmt.Sprintf("Signal exit: confidence %d%% < 55%%", sig.Confidence)
		}
	}

	// Effective live profit target: RR overrides, then a manual ₹ target, then
	// the challenge target.
	effTarget := active.TargetPerTrade
	if liveTgt > 0 {
		effTarget = liveTgt
	}
	if rr > 0 {
		effTarget = risk * rr
	}

	if holdConf <= 0 {
		holdConf = 70
	}
	highConfRide := sig != nil && signalAligned(open, sig) && sig.Confidence >= holdConf

	// 3) Profit floor crossed — book unless riding on high confidence.
	if floor > 0 && pnl >= floor && !highConfRide {
		return fmt.Sprintf("Profit floor booked +₹%.0f (confidence below %d%%)", pnl, holdConf)
	}

	// 4) RR/₹ target reached — book unless riding on high confidence.
	if effTarget > 0 && pnl >= effTarget && !highConfRide {
		if risk > 0 {
			return fmt.Sprintf("Target +₹%.0f (RR 1:%.1f)", effTarget, effTarget/risk)
		}
		return fmt.Sprintf("Target +₹%.0f", effTarget)
	}

	return ""
}

// placeLiveOrder sends a real BUY/SELL market order to Zerodha for an option leg.
func (cs *ChallengeService) placeLiveOrder(side, tradingSymbol string, qty int) (string, error) {
	return cs.kc.PlaceMarketOrder(kite.LiveOrder{
		TradingSymbol:   tradingSymbol,
		Exchange:        "NFO",
		TransactionType: side, // BUY | SELL
		Quantity:        qty,
		Product:         "MIS",
		OrderType:       "MARKET",
	})
}

// NewChallengeService creates the 90-day challenge service.
// ticker may be nil — the service falls back to REST polling every 30 s.
// When ticker is provided, SL/target checks run on every real-time price tick.
func NewChallengeService(db *storage.DB, kc *kite.Client, ticker *kite.Ticker, log *zap.Logger) *ChallengeService {
	cs := &ChallengeService{
		db: db, kc: kc, ticker: ticker, log: log,
		ctype:        "OPTIONS",
		interval:     "5minute",
		lookbackDays: 7,
		minCandles:   25,
		usePCR:       true,
		analyze:      options.Analyze,
	}
	cs.restore()

	// Wire the ticker callback so every price tick drives the challenge loop
	if ticker != nil {
		ticker.OnTick(func(ticks []kite.Tick) {
			for _, t := range ticks {
				cs.onTick(t)
			}
		})
	}
	return cs
}

// NewScalpChallengeService creates a parallel 90-day challenge that trades the
// EMA50/200 + Stochastic 1-minute scalping system (buying ATM CE/PE). It shares
// the same storage tables as the options challenge but is fully isolated by its
// challenge_type ("SCALP"), and should be given its OWN ticker so its tick
// handler doesn't collide with the options challenge.
func NewScalpChallengeService(db *storage.DB, kc *kite.Client, ticker *kite.Ticker, log *zap.Logger) *ChallengeService {
	cs := &ChallengeService{
		db: db, kc: kc, ticker: ticker, log: log,
		ctype:        "SCALP",
		interval:     "minute",
		lookbackDays: 3,
		minCandles:   205,
		usePCR:       false,
		analyze:      options.ScalpAnalyze,
	}
	cs.restore()

	if ticker != nil {
		ticker.OnTick(func(ticks []kite.Tick) {
			for _, t := range ticks {
				cs.onTick(t)
			}
		})
	}
	return cs
}

func (cs *ChallengeService) restore() {
	var cfg storage.ChallengeConfig
	if err := cs.db.Where("status = ? AND challenge_type = ?", "ACTIVE", cs.ctype).First(&cfg).Error; err == nil {
		cs.active = &cfg
	}
	if cs.active == nil { return }

	var trade storage.ChallengeTrade
	if err := cs.db.Where("challenge_id = ? AND status = ?", cs.active.ID, "OPEN").
		First(&trade).Error; err == nil {
		cs.openTrade  = &trade
		// Recompute the effective SL from the trade's original entry time so the
		// trailing-SL logic stays consistent across server restarts.
		cs.entrySLAmt = cs.computeEffectiveSL(cs.active, trade.EntryTime)
		cs.peakPnL    = 0
		// Re-subscribe the option token to the WebSocket ticker after restart.
		// This runs in a goroutine because the ticker may not be started yet.
		go func() {
			// Wait briefly for ticker to initialise
			time.Sleep(3 * time.Second)
			if ins, err := cs.kc.FindOption(trade.Expiry, trade.Strike, trade.OptionType); err == nil && ins != nil {
				cs.mu.Lock()
				cs.openToken = uint32(ins.InstrumentToken)
				cs.mu.Unlock()
				if cs.ticker != nil {
					cs.ticker.Subscribe(kite.NiftyIndexToken, uint32(ins.InstrumentToken))
					cs.log.Info("restored ticker subscription for open trade",
						zap.String("symbol", trade.TradingSymbol), zap.Uint32("token", uint32(ins.InstrumentToken)))
				}
			}
		}()
	}
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

func (cs *ChallengeService) Start() {
	cs.mu.Lock()
	if cs.running { cs.mu.Unlock(); return }
	cs.running = true
	cs.stopCh = make(chan struct{})
	stop := cs.stopCh
	cs.mu.Unlock()
	go cs.loop(stop)
	cs.log.Info("challenge service started")
}

func (cs *ChallengeService) Stop() {
	cs.mu.Lock(); defer cs.mu.Unlock()
	if !cs.running { return }
	cs.running = false
	close(cs.stopCh)
}

func (cs *ChallengeService) loop(stop chan struct{}) {
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	cs.tick()
	for {
		select {
		case <-stop: return
		case <-tick.C: cs.tick()
		}
	}
}

func (cs *ChallengeService) tick() {
	defer func() { if r := recover(); r != nil { cs.log.Error("challenge tick panic", zap.Any("r", r)) } }()

	cs.mu.RLock()
	active   := cs.active
	openTrd  := cs.openTrade
	cs.mu.RUnlock()

	if !cs.kc.IsConnected() { cs.setErr("Kite not connected"); return }
	// Connected now — clear a stale "Kite not connected" error so the UI updates.
	cs.mu.RLock(); stale := cs.lastError == "Kite not connected"; cs.mu.RUnlock()
	if stale { cs.setErr("") }
	if !isMarketOpen() { return }
	if active == nil { return } // no active challenge — do nothing

	// 1. Manage open trade
	if openTrd != nil {
		cs.manageOpenTrade(openTrd)
	}

	// 2. EOD snapshot
	if isAfterSquareOff() {
		cs.mu.RLock(); still := cs.openTrade != nil; cs.mu.RUnlock()
		if still { cs.squareOff("EOD square-off (15:20 IST)") }
		cs.writeDailySnapshot()
		return
	}

	// 3. Generate signal (throttled: once per 2 min)
	if time.Since(cs.lastChainFetch) > 2*time.Minute {
		cs.generateAndMaybeEnter()
	}
}

// ─── Signal + Entry ───────────────────────────────────────────────────────────

// Risk-discipline limits for the challenge entry logic. These encode standard
// professional risk management: cap activity, hard-stop the day's losses, and
// avoid the worst theta-decay setup (expiry-day long buying without a strong
// edge). Tunable here; promote to config if you want them per-challenge.
const (
	maxTradesPerDay     = 3   // no more than N entries in a calendar day
	dailyLossLimitR     = 2.0 // stop for the day once net realized P&L ≤ -N × RiskPerTrade
	expiryMinConfidence = 70  // on expiry day, only take very high-confidence directional buys
)

// dailyRiskBlocks reports whether the day's trading should stop: too many trades
// already taken, or the daily loss limit reached.
func (cs *ChallengeService) dailyRiskBlocks(active *storage.ChallengeConfig, now time.Time) (bool, string) {
	// Only the OPTIONS challenge uses these caps; the SCALP variant manages its
	// own (much higher) trade cadence and is left untouched.
	if cs.ctype != "OPTIONS" {
		return false, ""
	}
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, ist())

	var entriesToday int64
	cs.db.Model(&storage.ChallengeTrade{}).
		Where("challenge_id = ? AND entry_time >= ?", active.ID, dayStart).
		Count(&entriesToday)
	if entriesToday >= maxTradesPerDay {
		return true, fmt.Sprintf("max %d trades/day reached", maxTradesPerDay)
	}

	var realizedToday float64
	cs.db.Model(&storage.ChallengeTrade{}).
		Where("challenge_id = ? AND status = ? AND exit_time >= ?", active.ID, "CLOSED", dayStart).
		Select("COALESCE(SUM(pnl),0)").Scan(&realizedToday)
	if active.RiskPerTrade > 0 && realizedToday <= -dailyLossLimitR*active.RiskPerTrade {
		return true, fmt.Sprintf("daily loss limit hit (today ₹%.0f)", realizedToday)
	}
	return false, ""
}

func (cs *ChallengeService) generateAndMaybeEnter() {
	cs.mu.RLock()
	active  := cs.active
	hasOpen := cs.openTrade != nil
	cs.mu.RUnlock()

	if active == nil || hasOpen { return }

	// Step 1: NIFTY candles → strategy signal (interval/lookback per challenge type)
	now := time.Now().In(ist())
	from := now.AddDate(0, 0, -cs.lookbackDays).Format("2006-01-02 15:04:05")
	to   := now.Format("2006-01-02 15:04:05")
	candles, err := cs.kc.HistoricalData(kite.NiftyIndexToken, cs.interval, from, to)
	if err != nil { cs.setErr("candle fetch: " + err.Error()); return }
	if len(candles) < cs.minCandles { return }

	expiry := options.NiftyWeeklyExpiry(now)
	isExpiry := expiry.Format("2006-01-02") == now.Format("2006-01-02")
	rec, err := cs.analyze(candles, isExpiry)
	if err != nil { return }

	cs.mu.Lock(); cs.lastSignal = rec; cs.mu.Unlock()

	if rec.Strategy == options.StratNone || len(rec.Legs) == 0 { return }
	if rec.Confidence < 55 { return }

	// ── Risk discipline (professional practice) ───────────────────────────
	// Cap trades per day, stop trading for the day after the loss limit, and
	// avoid buying decaying premium on expiry day unless the edge is strong.
	// Applies to paper and live alike so backtests reflect the same rules.
	if block, why := cs.dailyRiskBlocks(active, now); block {
		cs.setErr("entry skipped: " + why)
		return
	}
	if cs.ctype == "OPTIONS" && isExpiry && rec.Confidence < expiryMinConfidence {
		cs.log.Info("entry skipped: expiry-day theta risk",
			zap.Int("confidence", rec.Confidence), zap.Int("need", expiryMinConfidence))
		return
	}

	// Step 2: Option chain → PCR filter (options challenge only; scalp skips it)
	chain, err := cs.kc.NiftyChain(5) // ATM ± 5 strikes
	if err != nil {
		cs.log.Warn("chain fetch failed, skipping PCR filter", zap.Error(err))
	} else {
		cs.mu.Lock(); cs.lastChain = chain; cs.lastChainFetch = time.Now(); cs.mu.Unlock()
		// PCR alignment check
		if cs.usePCR && !pcrAligns(rec.Direction, chain.PCR) {
			cs.log.Info("signal rejected: PCR does not align",
				zap.String("direction", rec.Direction), zap.Float64("pcr", chain.PCR),
				zap.String("pcr_bias", kite.PCRBias(chain.PCR)))
			return
		}
	}

	// Step 3: Directional options only for the challenge (buying CE/PE, no straddles)
	var optType string
	switch rec.Strategy {
	case options.StratDirectionalCE, options.StratORBCE:
		optType = "CE"
	case options.StratDirectionalPE, options.StratORBPE:
		optType = "PE"
	default:
		// For neutral strategies (iron condor, straddle), skip in the challenge
		// The challenge is focused on directional CE/PE buying for clarity
		cs.log.Info("neutral strategy signal — skipping in challenge (directional focus)")
		return
	}

	// Step 4: Real Kite LTP for entry
	spot := candles[len(candles)-1].Close
	atm  := kite.ATMStrike(spot)
	expStr := expiry.Format("2006-01-02")

	realLTP, tradingSymbol, err := cs.kc.RealOptionLTP(expStr, atm, optType)
	if err != nil || realLTP <= 0 {
		cs.log.Warn("real LTP unavailable, skipping entry", zap.Error(err))
		return
	}

	// Step 5: Enter the trade
	cs.enterTrade(active, rec, atm, optType, tradingSymbol, expStr, expiry, realLTP, chain, candles)
}

func (cs *ChallengeService) enterTrade(
	cfg *storage.ChallengeConfig, rec *options.Recommendation,
	strike float64, optType, tradingSymbol, expStr string, expiry time.Time,
	entryPremium float64, chain *kite.ChainSnapshot,
	candles []kite.Candle,
) {
	dte := options.ActualDTE(time.Now(), expiry)
	atr := recentATR(candles, len(candles)-1)
	iv  := options.IVFromATR15m(atr, candles[len(candles)-1].Close)

	pcr := 0.0
	entryOI := 0.0
	snap := storage.OptionSnapshot{}
	if chain != nil {
		pcr = chain.PCR
		snap = storage.OptionSnapshot{
			PCR: chain.PCR, CallOI: chain.TotalCallOI, PutOI: chain.TotalPutOI,
			IV: iv * 100, ATMCallLTP: chain.ATMCallLTP, ATMPutLTP: chain.ATMPutLTP,
		}
		// Get this specific option's OI
		for _, cs2 := range chain.Strikes {
			if math.Abs(cs2.Strike-strike) < 0.01 {
				if optType == "CE" { entryOI = cs2.CEOI } else { entryOI = cs2.PEOI }
				break
			}
		}
	}

	// Resolve the actual contract up front so we use its REAL lot size. NSE
	// revises F&O lot sizes periodically (e.g. NIFTY is no longer 75), and an
	// order quantity that isn't a multiple of the contract's lot size is
	// rejected by Zerodha. Fall back to the NiftyLotSize constant only when the
	// instrument can't be resolved.
	lotSize := kite.NiftyLotSize
	optInstrument, _ := cs.kc.FindOption(expStr, strike, optType)
	if optInstrument != nil && optInstrument.LotSize > 0 {
		lotSize = optInstrument.LotSize
	}

	now := time.Now().In(ist())
	trade := &storage.ChallengeTrade{
		ID:          fmt.Sprintf("CH-%d", now.UnixNano()/1e6),
		ChallengeID: cfg.ID,
		DayNumber:   cfg.DayNumber(now),
		Strategy:    string(rec.Strategy),
		Direction:   rec.Direction,
		Regime:      string(rec.Regime),
		SignalBasis: storage.StringSlice(rec.Reasoning),
		Mode:        "AUTO",
		TradingSymbol: tradingSymbol,
		Expiry:      expStr,
		Strike:      strike,
		OptionType:  optType,
		Lots:        cfg.Lots,
		Qty:         cfg.Lots * lotSize,
		DTE:         dte,
		EntryTime:   now,
		EntrySpot:   rec.Indicators.Spot,
		EntryPremium: entryPremium,
		EntryIV:     iv * 100,
		EntryPCR:    pcr,
		EntryOI:     entryOI,
		EntrySnapshot: snap,
		RR:          cfg.TargetPerTrade / cfg.RiskPerTrade,
		Status:      "OPEN",
	}

	if err := cs.db.Create(trade).Error; err != nil {
		cs.log.Error("failed to record challenge trade", zap.Error(err))
		return
	}

	// ── LIVE: place a real BUY order on Zerodha for this option ────────────
	cs.mu.RLock()
	live := cs.liveEnabled && cs.liveAllowed
	maxLots := cs.liveMaxLots
	winStart, winEnd := cs.liveWindowStart, cs.liveWindowEnd
	cs.mu.RUnlock()
	// Trading-window gate (LIVE only): no real entry outside the configured
	// window. The paper trade is still recorded so the simulation continues.
	if live && !cs.withinLiveWindow(now) {
		cs.log.Info("LIVE entry skipped — outside trading window",
			zap.String("now", now.Format("15:04")), zap.String("window", winStart+"–"+winEnd))
		cs.setErr(fmt.Sprintf("LIVE entry skipped: outside trading window %s–%s", winStart, winEnd))
		live = false
	}
	// Daily risk stops (LIVE only): max daily loss, back-to-back losses, day's
	// risk-capital budget. The paper trade is still recorded either way.
	if live {
		if block, why := cs.liveRiskBlocks(cfg, now); block {
			cs.log.Info("LIVE entry skipped — daily risk stop", zap.String("why", why))
			cs.setErr("LIVE entry skipped: " + why)
			live = false
		}
	}
	if live {
		// Max-lots clamp (LIVE only): cap the real order size. The paper trade
		// record keeps the full configured size.
		liveLots := cfg.Lots
		if maxLots > 0 && liveLots > maxLots {
			liveLots = maxLots
		}
		liveQty := liveLots * lotSize
		if oid, err := cs.placeLiveOrder("BUY", trade.TradingSymbol, liveQty); err != nil {
			cs.log.Error("⚠️ LIVE entry order FAILED — position is paper-only", zap.Error(err))
			cs.setErr("LIVE entry order failed: " + err.Error())
		} else {
			trade.Live = true
			trade.LiveOrderID = oid
			cs.mu.Lock()
			cs.openLiveQty = liveQty
			cs.mu.Unlock()
			cs.db.Model(&storage.ChallengeTrade{}).Where("id = ?", trade.ID).
				Updates(map[string]interface{}{"live": true, "live_order_id": oid})
			cs.log.Warn("⚠️ LIVE entry order PLACED on Zerodha",
				zap.String("symbol", trade.TradingSymbol), zap.Int("qty", liveQty),
				zap.Int("lots", liveLots), zap.String("order_id", oid))
		}
	}

	// Reuse the instrument resolved above for the WebSocket ticker token.
	var optToken uint32
	if optInstrument != nil {
		optToken = uint32(optInstrument.InstrumentToken)
	}

	// Compute the effective SL before taking the lock (DB queries inside).
	// This is the lesser of the day's realized profit and the algo's fixed risk.
	slAmt := cs.computeEffectiveSL(cfg, now)

	cs.mu.Lock()
	cs.openTrade  = trade
	cs.openToken  = optToken
	cs.livePnL    = 0
	cs.entrySLAmt = slAmt
	cs.peakPnL    = 0
	cs.mu.Unlock()

	// Subscribe option token to ticker so onTick() fires on every price change
	if cs.ticker != nil && optToken > 0 {
		cs.ticker.Subscribe(kite.NiftyIndexToken, optToken)
		cs.log.Info("ticker subscribed to option", zap.Uint32("token", optToken))
	}

	cs.log.Info("challenge trade opened",
		zap.String("id", trade.ID), zap.String("symbol", tradingSymbol),
		zap.Float64("premium", entryPremium), zap.Int("dte", dte),
		zap.Bool("realtime", cs.ticker != nil && optToken > 0))

	liveTag := ""
	if trade.Live {
		liveTag = " [LIVE]"
	}
	cs.emit(fmt.Sprintf("🟢 ENTRY%s %s @ ₹%.1f (%s, conf %d%%) — %d qty",
		liveTag, tradingSymbol, entryPremium, rec.Direction, rec.Confidence, trade.Qty))
}

// ─── Manage open trade ────────────────────────────────────────────────────────

// ─── Real-time tick handler (WebSocket path) ──────────────────────────────────

// onTick is called by the WebSocket ticker on every live price update.
// It handles two token types:
//   - NIFTY index (256265): cache latest spot price
//   - Open option token   : update live P&L and check SL / target
//
// This is the primary SL/target enforcement path when the WebSocket is live.
// The 30-second REST fallback in manageOpenTrade() runs only when ticker is nil.
func (cs *ChallengeService) onTick(t kite.Tick) {
	// NIFTY index tick — cache the latest spot price
	if t.InstrumentToken == kite.NiftyIndexToken {
		cs.mu.Lock()
		cs.liveSpot = t.LastPrice
		cs.mu.Unlock()
		return
	}

	cs.mu.RLock()
	open      := cs.openTrade
	token     := cs.openToken
	active    := cs.active
	cs.mu.RUnlock()

	if open == nil || active == nil || t.InstrumentToken != token { return }

	qty := float64(open.Qty)
	ltp := t.LastPrice
	if ltp <= 0 { return }

	pnl := (ltp - open.EntryPremium) * qty

	// Update in-memory live state: P&L, current price, sparkline, and peak P&L
	cs.mu.Lock()
	cs.livePnL         = round2p(pnl)
	cs.liveOptionPrice = ltp
	cs.optionPriceHistory = append(cs.optionPriceHistory, ltp)
	if len(cs.optionPriceHistory) > 60 {
		cs.optionPriceHistory = cs.optionPriceHistory[1:]
	}
	if pnl > cs.peakPnL {
		cs.peakPnL = pnl
	}
	cs.mu.Unlock()

	// ── Exit decision ─────────────────────────────────────────────────────
	cs.mu.RLock()
	liveOn  := cs.liveEnabled && cs.liveAllowed
	slAmt   := cs.entrySLAmt
	peakPnL := cs.peakPnL
	cs.mu.RUnlock()

	// LIVE positions use the confidence/signal-aware exit logic (SL → signal
	// exit → profit floor with high-confidence ride → RR/target cap).
	if open.Live && liveOn {
		if reason := cs.liveExitReason(open, pnl, qty); reason != "" {
			cs.closeTradeWith(open, ltp, ltp, pnl, reason+" [WebSocket]")
		}
		return
	}

	// PAPER positions: dynamic profit-based SL + trailing SL when in profit.
	if slAmt <= 0 {
		slAmt = active.RiskPerTrade // safety fallback
	}
	rewardAmt := active.TargetPerTrade
	slPU      := slAmt / qty
	rewardPU  := rewardAmt / qty

	var reason string
	var exitPrem float64
	switch {
	case pnl >= rewardAmt:
		reason   = fmt.Sprintf("Target +₹%.0f (RR 1:%.1f) [WebSocket]", rewardAmt, open.RR)
		exitPrem = open.EntryPremium + rewardPU
	case pnl <= -slAmt:
		reason   = fmt.Sprintf("Stop-loss -₹%.0f [WebSocket]", slAmt)
		exitPrem = math.Max(0, open.EntryPremium-slPU)
	default:
		// Trailing SL: once the position has returned ≥ 1× the effective SL in
		// profit (i.e. peakPnL > slAmt), trail by the same SL amount from the
		// peak.  This is a 1:1 trailing stop — we give back at most 1R from the
		// best level reached, equivalent to moving the SL to breakeven once 1R
		// is in the bag, then to +1R once 2R is in the bag, and so on.
		trailLevel := peakPnL - slAmt
		if pnl > 0 && trailLevel > 0 && pnl <= trailLevel {
			reason   = fmt.Sprintf("Trailing SL locked +₹%.0f [WebSocket]", trailLevel)
			exitPrem = round2p(open.EntryPremium + trailLevel/qty)
		}
	}
	if reason != "" {
		cs.closeTradeWith(open, ltp, exitPrem, pnl, reason)
	}
}

// ─── REST fallback: manageOpenTrade (runs when ticker is nil) ─────────────────

func (cs *ChallengeService) manageOpenTrade(t *storage.ChallengeTrade) {
	// When the WebSocket ticker is active, it drives SL/target via onTick.
	// This REST path only runs as a 30-second fallback when ticker is nil.
	cs.mu.RLock()
	hasTicker := cs.ticker != nil
	active    := cs.active
	cs.mu.RUnlock()
	if hasTicker || active == nil { return }

	rewardAmt := active.TargetPerTrade
	qty       := float64(t.Qty)
	rewardPU  := rewardAmt / qty

	curLTP, _, err := cs.kc.RealOptionLTP(t.Expiry, t.Strike, t.OptionType)
	if err != nil || curLTP <= 0 {
		expiry, _ := time.Parse("2006-01-02", t.Expiry)
		dte := options.ActualDTE(time.Now(), expiry)
		curLTP = options.BSPrice(cs.currentSpot(), t.Strike, t.EntryIV/100, dte, t.OptionType == "CE")
	}
	if curLTP <= 0 { return }

	pnl := (curLTP - t.EntryPremium) * qty

	cs.mu.Lock()
	cs.livePnL = round2p(pnl)
	if pnl > cs.peakPnL {
		cs.peakPnL = pnl
	}
	cs.mu.Unlock()

	cs.mu.RLock()
	liveOn  := cs.liveEnabled && cs.liveAllowed
	slAmt   := cs.entrySLAmt
	peakPnL := cs.peakPnL
	cs.mu.RUnlock()

	// LIVE positions use the confidence/signal-aware exit logic.
	if t.Live && liveOn {
		if reason := cs.liveExitReason(t, pnl, qty); reason != "" {
			cs.closeTradeWith(t, curLTP, curLTP, pnl, reason)
		}
		return
	}

	// PAPER positions: dynamic profit-based SL + trailing SL when in profit.
	if slAmt <= 0 {
		slAmt = active.RiskPerTrade // safety fallback
	}
	slPU := slAmt / qty

	var reason string
	var exitPrem float64
	switch {
	case pnl >= rewardAmt:
		reason   = fmt.Sprintf("Target +₹%.0f (RR 1:%.1f)", rewardAmt, t.RR)
		exitPrem = t.EntryPremium + rewardPU
	case pnl <= -slAmt:
		reason   = fmt.Sprintf("Stop-loss -₹%.0f", slAmt)
		exitPrem = math.Max(0, t.EntryPremium-slPU)
	default:
		trailLevel := peakPnL - slAmt
		if pnl > 0 && trailLevel > 0 && pnl <= trailLevel {
			reason   = fmt.Sprintf("Trailing SL locked +₹%.0f", trailLevel)
			exitPrem = round2p(t.EntryPremium + trailLevel/qty)
		}
	}
	if reason != "" {
		cs.closeTradeWith(t, curLTP, exitPrem, pnl, reason)
	}
}

func (cs *ChallengeService) currentSpot() float64 {
	// Try ticker cache first (real-time, no network call)
	if cs.ticker != nil {
		if p := cs.ticker.Price(kite.NiftyIndexToken); p > 0 { return p }
	}
	ltp, err := cs.kc.LTP(kite.NiftySymbol)
	if err != nil { return 0 }
	return ltp[kite.NiftySymbol].LastPrice
}

func (cs *ChallengeService) squareOff(reason string) {
	cs.mu.RLock(); t := cs.openTrade; active := cs.active; cs.mu.RUnlock()
	if t == nil || active == nil { return }
	qty := float64(t.Qty)
	curLTP, _, _ := cs.kc.RealOptionLTP(t.Expiry, t.Strike, t.OptionType)
	if curLTP <= 0 {
		expiry, _ := time.Parse("2006-01-02", t.Expiry)
		dte := options.ActualDTE(time.Now(), expiry)
		curLTP = options.BSPrice(cs.currentSpot(), t.Strike, t.EntryIV/100, dte, t.OptionType == "CE")
	}
	pnl := (curLTP - t.EntryPremium) * qty
	// Cap to risk/reward
	if pnl > active.TargetPerTrade  { pnl = active.TargetPerTrade }
	if pnl < -active.RiskPerTrade   { pnl = -active.RiskPerTrade }
	cs.closeTradeWith(t, curLTP, curLTP, pnl, reason)
}

func (cs *ChallengeService) closeTradeWith(t *storage.ChallengeTrade, rawLTP, exitPrem, pnl float64, reason string) {
	now  := time.Now().In(ist())
	spot := cs.currentSpot()
	finalPnL := round2p(pnl)
	pnlPct   := 0.0
	cs.mu.RLock(); active := cs.active; allowLive := cs.liveAllowed; cs.mu.RUnlock()
	if active != nil && active.RiskPerTrade > 0 {
		pnlPct = finalPnL / active.RiskPerTrade * 100
	}

	// ── LIVE: send a real SELL order to Zerodha to flatten the position ────
	exitOrderID := ""
	if t.Live && allowLive {
		// Flatten exactly what was bought live (may be < paper qty due to the
		// max-lots cap); fall back to the trade qty if it wasn't recorded.
		cs.mu.RLock(); sellQty := cs.openLiveQty; cs.mu.RUnlock()
		if sellQty <= 0 {
			sellQty = t.Qty
		}
		if oid, err := cs.placeLiveOrder("SELL", t.TradingSymbol, sellQty); err != nil {
			cs.log.Error("⚠️ LIVE exit order FAILED — flatten this position MANUALLY on Zerodha",
				zap.String("symbol", t.TradingSymbol), zap.Error(err))
			cs.setErr("LIVE exit order failed (square off manually): " + err.Error())
		} else {
			exitOrderID = oid
			cs.log.Warn("⚠️ LIVE exit order PLACED on Zerodha",
				zap.String("symbol", t.TradingSymbol), zap.String("order_id", oid), zap.String("reason", reason))
		}
	}

	upd := map[string]interface{}{
		"exit_time":    now,
		"exit_spot":    spot,
		"exit_premium": round2p(exitPrem),
		"exit_reason":  reason,
		"pnl":          finalPnL,
		"pnl_pct":      round2p(pnlPct),
		"status":       "CLOSED",
		"updated_at":   now,
	}
	if exitOrderID != "" {
		upd["live_exit_order_id"] = exitOrderID
	}
	if err := cs.db.Model(&storage.ChallengeTrade{}).Where("id = ?", t.ID).Updates(upd).Error; err != nil {
		cs.log.Error("failed to close challenge trade", zap.Error(err))
		return
	}

	cs.mu.Lock()
	cs.openTrade           = nil
	cs.openToken           = 0
	cs.openLiveQty         = 0
	cs.livePnL             = 0
	cs.liveOptionPrice     = 0
	cs.optionPriceHistory  = nil
	cs.peakPnL             = 0
	cs.entrySLAmt          = 0
	cs.mu.Unlock()

	// Revert ticker subscription to NIFTY-only (drop the closed option token)
	if cs.ticker != nil {
		cs.ticker.Subscribe(kite.NiftyIndexToken)
	}

	cs.log.Info("challenge trade closed",
		zap.String("id", t.ID), zap.Float64("pnl", finalPnL), zap.String("reason", reason))

	liveTag := ""
	if t.Live {
		liveTag = " [LIVE]"
	}
	emoji := "🔴"
	if finalPnL >= 0 {
		emoji = "✅"
	}
	cs.emit(fmt.Sprintf("%s EXIT%s %s P&L ₹%.0f — %s", emoji, liveTag, t.TradingSymbol, finalPnL, reason))
	_ = rawLTP
}

// ─── Daily snapshot ───────────────────────────────────────────────────────────

func (cs *ChallengeService) writeDailySnapshot() {
	cs.mu.RLock(); active := cs.active; cs.mu.RUnlock()
	if active == nil { return }

	now := time.Now().In(ist())
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, ist())

	// Skip if already written today
	var existing storage.ChallengeDay
	if err := cs.db.Where("challenge_id = ? AND date = ?", active.ID, today).First(&existing).Error; err == nil {
		return
	}

	// Compute today's stats
	var trades []storage.ChallengeTrade
	cs.db.Where("challenge_id = ? AND status = ? AND DATE(exit_time AT TIME ZONE 'Asia/Kolkata') = ?",
		active.ID, "CLOSED", today.Format("2006-01-02")).Find(&trades)

	var dayPnL, bestTrade, worstTrade float64
	wins, losses := 0, 0
	for _, t := range trades {
		dayPnL += t.PnL
		if t.PnL >= 0 { wins++ } else { losses++ }
		if t.PnL > bestTrade  { bestTrade  = t.PnL }
		if t.PnL < worstTrade { worstTrade = t.PnL }
	}

	// Compute opening balance (initial + all prior days' P&L)
	var priorPnL float64
	cs.db.Model(&storage.ChallengeTrade{}).
		Where("challenge_id = ? AND status = ? AND exit_time < ?", active.ID, "CLOSED", today).
		Select("COALESCE(SUM(pnl), 0)").Scan(&priorPnL)
	openingBal := active.InitialCapital + priorPnL
	closingBal := openingBal + dayPnL

	dayNum := active.DayNumber(now)

	// NIFTY prices
	niftyOpen, niftyClose := 0.0, 0.0
	candles, err := cs.kc.HistoricalData(kite.NiftyIndexToken, "day",
		today.Format("2006-01-02 09:00:00"), today.Format("2006-01-02 15:30:00"))
	if err == nil && len(candles) > 0 {
		niftyOpen  = candles[0].Open
		niftyClose = candles[len(candles)-1].Close
	}

	day := storage.ChallengeDay{
		ChallengeID:    active.ID,
		Date:           today,
		DayNumber:      dayNum,
		OpeningBalance: round2p(openingBal),
		ClosingBalance: round2p(closingBal),
		DailyPnL:       round2p(dayPnL),
		TradeCount:     len(trades),
		Wins:           wins,
		Losses:         losses,
		NiftyOpen:      niftyOpen,
		NiftyClose:     niftyClose,
		BestTrade:      round2p(bestTrade),
		WorstTrade:     round2p(worstTrade),
	}
	if err := cs.db.Create(&day).Error; err != nil && !strings.Contains(err.Error(), "duplicate") {
		cs.log.Error("failed to write daily snapshot", zap.Error(err))
	}
}

// ─── Challenge management ─────────────────────────────────────────────────────

// StartChallenge creates a new 90-day challenge.
func (cs *ChallengeService) StartChallenge(lots int, riskPerTrade, targetPerTrade float64, notes string) (*storage.ChallengeConfig, error) {
	cs.mu.RLock(); active := cs.active; cs.mu.RUnlock()
	if active != nil {
		return nil, fmt.Errorf("a challenge is already active (ID %d, started %s). Complete or pause it first",
			active.ID, active.StartDate.Format("Jan 02 2006"))
	}

	now := time.Now().In(ist())
	cfg := storage.ChallengeConfig{
		StartDate:      time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, ist()),
		EndDate:        time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, ist()).AddDate(0, 0, 90),
		InitialCapital: 1_000_000,
		Lots:           lots,
		RiskPerTrade:   riskPerTrade,
		TargetPerTrade: targetPerTrade,
		Status:         "ACTIVE",
		ChallengeType:  cs.ctype,
		Notes:          notes,
	}
	if err := cs.db.Create(&cfg).Error; err != nil {
		return nil, fmt.Errorf("creating challenge: %w", err)
	}
	cs.mu.Lock(); cs.active = &cfg; cs.mu.Unlock()
	cs.log.Info("90-day challenge started", zap.Uint("id", cfg.ID),
		zap.Time("end", cfg.EndDate), zap.Int("lots", lots))
	return &cfg, nil
}

func (cs *ChallengeService) PauseChallenge() error {
	cs.mu.RLock(); active := cs.active; cs.mu.RUnlock()
	if active == nil { return fmt.Errorf("no active challenge") }
	cs.db.Model(active).Update("status", "PAUSED")
	cs.mu.Lock(); cs.active = nil; cs.mu.Unlock()
	return nil
}

func (cs *ChallengeService) ResumeChallenge() error {
	var cfg storage.ChallengeConfig
	if err := cs.db.Where("status = ? AND challenge_type = ?", "PAUSED", cs.ctype).Order("created_at DESC").First(&cfg).Error; err != nil {
		return fmt.Errorf("no paused challenge found")
	}
	cs.db.Model(&cfg).Update("status", "ACTIVE")
	cs.mu.Lock(); cs.active = &cfg; cs.mu.Unlock()
	return nil
}

// ManualEntry allows the user to open a challenge trade manually from the UI.
func (cs *ChallengeService) ManualEntry() (*storage.ChallengeTrade, error) {
	cs.mu.RLock(); active := cs.active; hasOpen := cs.openTrade != nil; cs.mu.RUnlock()
	if active == nil { return nil, fmt.Errorf("no active challenge") }
	if hasOpen      { return nil, fmt.Errorf("a position is already open") }

	// Generate signal and enter
	cs.generateAndMaybeEnter()
	cs.mu.RLock(); t := cs.openTrade; cs.mu.RUnlock()
	if t == nil { return nil, fmt.Errorf("no signal fired — try again during market hours") }
	return t, nil
}

func (cs *ChallengeService) ManualExit() error {
	cs.mu.RLock(); t := cs.openTrade; cs.mu.RUnlock()
	if t == nil { return fmt.Errorf("no open position") }
	cs.squareOff("Manually closed")
	return nil
}

// ─── Snapshot / Status ────────────────────────────────────────────────────────

type ChallengeStatus struct {
	Active         *storage.ChallengeConfig `json:"active"`
	DayNumber      int                       `json:"day_number"`
	DaysRemaining  int                       `json:"days_remaining"`
	ProgressPct    float64                   `json:"progress_pct"`
	CurrentCapital float64                   `json:"current_capital"`
	TotalPnL       float64                   `json:"total_pnl"`
	OpenTrade      *storage.ChallengeTrade   `json:"open_trade"`
	OpenPnL        float64                   `json:"open_pnl"`
	TodayPnL       float64                   `json:"today_pnl"`
	TodayTrades    int                       `json:"today_trades"`
	TotalTrades    int                       `json:"total_trades"`
	WinCount       int                       `json:"win_count"`
	LossCount      int                       `json:"loss_count"`
	WinRate        float64                   `json:"win_rate"`
	BestDay        float64                   `json:"best_day"`
	WorstDay       float64                   `json:"worst_day"`
	CurrentStreak  int                       `json:"current_streak"` // + wins, - losses
	LastSignal     *options.Recommendation   `json:"last_signal"`
	LastChain      *kite.ChainSnapshot       `json:"last_chain"`
	LastError      string                    `json:"last_error"`

	// Live trading state
	LiveAllowed      bool    `json:"live_allowed"`       // server master switch
	LiveEnabled      bool    `json:"live_enabled"`       // per-challenge toggle
	LiveProfitTarget float64 `json:"live_profit_target"` // ₹ per-position square-off
	LiveMaxLots      int     `json:"live_max_lots"`      // cap on lots for LIVE orders
	LiveMinProfit    float64 `json:"live_min_profit"`    // ₹ profit floor for LIVE exits
	LiveWindowStart  string  `json:"live_window_start"`  // "HH:MM" IST entry window start
	LiveWindowEnd    string  `json:"live_window_end"`    // "HH:MM" IST entry window end
	LiveHoldConfidence int   `json:"live_hold_confidence"` // % confidence to keep riding past the floor
	LiveRR           float64 `json:"live_rr"`            // risk-reward ratio for LIVE exits
	LiveMaxDailyLoss     float64 `json:"live_max_daily_loss"`     // ₹ daily loss stop for LIVE
	LiveMaxConsecLosses  int     `json:"live_max_consec_losses"`  // back-to-back LIVE loss stop
	LiveDailyRiskCapital float64 `json:"live_daily_risk_capital"` // ₹ day's LIVE risk budget
}

func (cs *ChallengeService) Status() ChallengeStatus {
	cs.mu.RLock()
	active := cs.active
	openTrd := cs.openTrade
	sig := cs.lastSignal
	chain := cs.lastChain
	lastErr := cs.lastError
	liveAllowed := cs.liveAllowed
	liveEnabled := cs.liveEnabled
	liveTgt := cs.liveProfitTarget
	liveMaxLots := cs.liveMaxLots
	liveMinProfit := cs.liveMinProfit
	liveWinStart := cs.liveWindowStart
	liveWinEnd := cs.liveWindowEnd
	liveHoldConf := cs.liveHoldConfidence
	liveRR := cs.liveRR
	liveMaxDailyLoss := cs.liveMaxDailyLoss
	liveMaxConsec := cs.liveMaxConsecLosses
	liveDailyRiskCap := cs.liveDailyRiskCapital
	cs.mu.RUnlock()

	now := time.Now().In(ist())
	s := ChallengeStatus{
		Active: active, LastSignal: sig, LastChain: chain, LastError: lastErr,
		OpenTrade: openTrd,
		LiveAllowed: liveAllowed, LiveEnabled: liveEnabled, LiveProfitTarget: liveTgt,
		LiveMaxLots: liveMaxLots, LiveMinProfit: liveMinProfit,
		LiveWindowStart: liveWinStart, LiveWindowEnd: liveWinEnd,
		LiveHoldConfidence: liveHoldConf, LiveRR: liveRR,
		LiveMaxDailyLoss: liveMaxDailyLoss, LiveMaxConsecLosses: liveMaxConsec,
		LiveDailyRiskCapital: liveDailyRiskCap,
	}
	if active == nil { return s }

	s.DayNumber     = active.DayNumber(now)
	s.DaysRemaining = active.DaysRemaining(now)
	s.ProgressPct   = round2p(float64(s.DayNumber) / 90 * 100)

	// Cumulative P&L
	var totalPnL float64
	cs.db.Model(&storage.ChallengeTrade{}).
		Where("challenge_id = ? AND status = ?", active.ID, "CLOSED").
		Select("COALESCE(SUM(pnl), 0)").Scan(&totalPnL)
	s.TotalPnL       = round2p(totalPnL)
	s.CurrentCapital = round2p(active.InitialCapital + totalPnL)

	// Open trade live P&L — use in-memory value updated by WebSocket tick
	// (zero REST calls; sub-second latency when ticker is connected)
	cs.mu.RLock()
	s.OpenPnL = cs.livePnL
	cs.mu.RUnlock()
	// If ticker not yet delivered a tick, fall back to one REST call
	if openTrd != nil && s.OpenPnL == 0 {
		if ltp, _, err := cs.kc.RealOptionLTP(openTrd.Expiry, openTrd.Strike, openTrd.OptionType); err == nil && ltp > 0 {
			s.OpenPnL = round2p((ltp - openTrd.EntryPremium) * float64(openTrd.Qty))
		}
	}

	// Today's stats
	todayStr := now.Format("2006-01-02")
	var todayTrades []storage.ChallengeTrade
	cs.db.Where("challenge_id = ? AND status = ? AND DATE(exit_time AT TIME ZONE 'Asia/Kolkata') = ?",
		active.ID, "CLOSED", todayStr).Find(&todayTrades)
	for _, t := range todayTrades { s.TodayPnL += t.PnL; s.TodayTrades++ }
	s.TodayPnL = round2p(s.TodayPnL)

	// All-time stats
	var all []storage.ChallengeTrade
	cs.db.Where("challenge_id = ? AND status = ?", active.ID, "CLOSED").
		Order("exit_time DESC").Find(&all)
	s.TotalTrades = len(all)
	streak := 0
	for i, t := range all {
		s.TotalPnL += 0 // already summed above
		if t.PnL >= 0 { s.WinCount++ } else { s.LossCount++ }
		if t.PnL > s.BestDay  { s.BestDay  = t.PnL }
		if t.PnL < s.WorstDay { s.WorstDay = t.PnL }
		if i == 0 {
			if t.PnL >= 0 { streak = 1 } else { streak = -1 }
		} else {
			if t.PnL >= 0 && streak > 0 { streak++ } else
			if t.PnL < 0 && streak < 0  { streak-- } else
			{ break }
		}
	}
	s.CurrentStreak = streak
	if s.TotalTrades > 0 {
		s.WinRate = round2p(float64(s.WinCount) / float64(s.TotalTrades) * 100)
	}
	return s
}

func (cs *ChallengeService) Trades(limit int) []storage.ChallengeTrade {
	cs.mu.RLock(); active := cs.active; cs.mu.RUnlock()
	if active == nil { return nil }
	var trades []storage.ChallengeTrade
	q := cs.db.Where("challenge_id = ?", active.ID).Order("created_at DESC")
	if limit > 0 { q = q.Limit(limit) }
	q.Find(&trades)
	return trades
}

func (cs *ChallengeService) DailyHistory() []storage.ChallengeDay {
	cs.mu.RLock(); active := cs.active; cs.mu.RUnlock()
	if active == nil { return nil }
	var days []storage.ChallengeDay
	cs.db.Where("challenge_id = ?", active.ID).Order("date ASC").Find(&days)
	return days
}

func (cs *ChallengeService) AllChallenges() []storage.ChallengeConfig {
	var cfgs []storage.ChallengeConfig
	cs.db.Where("challenge_type = ?", cs.ctype).Order("created_at DESC").Find(&cfgs)
	return cfgs
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// pcrAligns checks whether the option-chain PCR supports the signal direction.
// We use a CONTRARIAN interpretation (high put OI → market will bounce up).
func pcrAligns(direction string, pcr float64) bool {
	if pcr == 0 { return true } // no OI data (market closed) — don't block
	bias := kite.PCRBias(pcr)
	switch direction {
	case "BULLISH":
		// Allow BULLISH, MILDLY_BULLISH, NEUTRAL — block extreme bearish
		return bias != "BEARISH"
	case "BEARISH":
		return bias != "BULLISH"
	}
	return true
}

func (cs *ChallengeService) setErr(msg string) {
	cs.mu.Lock(); cs.lastError = msg; cs.mu.Unlock()
}

func (cs *ChallengeService) ForceSnapshot() {
	cs.writeDailySnapshot()
}

// ─── GORM query helpers ───────────────────────────────────────────────────────

// expiryBreakdown returns P&L grouped by expiry date.
func (cs *ChallengeService) ExpiryBreakdown() []map[string]interface{} {
	cs.mu.RLock(); active := cs.active; cs.mu.RUnlock()
	if active == nil { return nil }

	var rows []struct {
		Expiry     string
		Trades     int64
		Wins       int64
		TotalPnL   float64
		AvgPremium float64
	}
	cs.db.Raw(`
		SELECT expiry,
		       COUNT(*) AS trades,
		       SUM(CASE WHEN pnl >= 0 THEN 1 ELSE 0 END) AS wins,
		       SUM(pnl) AS total_pnl,
		       AVG(entry_premium) AS avg_premium
		FROM challenge_trades
		WHERE challenge_id = ? AND status = 'CLOSED'
		GROUP BY expiry ORDER BY expiry`, active.ID).Scan(&rows)

	out := make([]map[string]interface{}, 0, len(rows))
	for _, r := range rows {
		out = append(out, map[string]interface{}{
			"expiry":      r.Expiry,
			"trades":      r.Trades,
			"wins":        r.Wins,
			"losses":      r.Trades - r.Wins,
			"win_rate":    round2p(float64(r.Wins) / float64(r.Trades) * 100),
			"total_pnl":   round2p(r.TotalPnL),
			"avg_premium": round2p(r.AvgPremium),
		})
	}
	return out
}

// ExpiryTradesByDB returns trades for a DB query filtering by active challenge.
func (cs *ChallengeService) DB() *gorm.DB { return cs.db.DB }

// ─── LiveSnapshot — for the real-time terminal ────────────────────────────────

// LiveOptionState is the real-time state of the open option position.
type LiveOptionState struct {
	TradingSymbol  string    `json:"trading_symbol"`
	Strike         float64   `json:"strike"`
	OptionType     string    `json:"option_type"`
	Expiry         string    `json:"expiry"`
	EntryPremium   float64   `json:"entry_premium"`
	CurrentPremium float64   `json:"current_premium"`
	PremiumChange  float64   `json:"premium_change"`
	PnL            float64   `json:"pnl"`
	PnLPct         float64   `json:"pnl_pct"` // % of risk
	SLPremium      float64   `json:"sl_premium"`       // dynamic SL premium (updates as trailing SL moves)
	TargetPremium  float64   `json:"target_premium"`
	PriceHistory   []float64 `json:"price_history"` // sparkline
	EntrySpot      float64   `json:"entry_spot"`
	DTE            int       `json:"dte"`

	// Dynamic SL fields
	EffectiveSLAmt    float64 `json:"effective_sl_amt"`    // ₹ SL used (min of day-profit SL and algo SL)
	PeakPnL           float64 `json:"peak_pnl"`            // highest unrealised P&L seen so far
	TrailingSLActive  bool    `json:"trailing_sl_active"`  // true once trailing SL is engaged
	TrailingSLLevel   float64 `json:"trailing_sl_level"`   // P&L (₹) at which trailing SL fires
	TrailingSLPremium float64 `json:"trailing_sl_premium"` // option premium at which trailing SL fires
}

// FilterState records whether each of the 3 entry gates was passed.
type FilterState struct {
	TechSignal  FilterResult `json:"tech_signal"`
	PCRFilter   FilterResult `json:"pcr_filter"`
	RealLTP     FilterResult `json:"real_ltp"`
	AllPassed   bool         `json:"all_passed"`
}

// FilterResult is one gate's outcome.
type FilterResult struct {
	Pass   bool   `json:"pass"`
	Value  string `json:"value"`
	Reason string `json:"reason"`
}

// LiveSnapshot is everything the live terminal needs in one call.
type LiveSnapshot struct {
	Spot       float64                  `json:"spot"`
	// Current signal state — used to evaluate the NEXT potential trade
	Signal     *options.Recommendation  `json:"signal"`
	Chain      *kite.ChainSnapshot      `json:"chain"`
	// Entry gates for the NEXT trade (only relevant when no position is open)
	Filters    FilterState              `json:"filters"`
	// Open position — includes WHY it was entered (signal basis from DB)
	OpenOption *LiveOptionState         `json:"open_option"`
	OpenTrade  *storage.ChallengeTrade  `json:"open_trade"` // full DB record for signal basis
	// Challenge stats
	Active     *storage.ChallengeConfig `json:"active"`
	DayNumber  int                      `json:"day_number"`
	TotalPnL   float64                  `json:"total_pnl"`
	TodayPnL   float64                  `json:"today_pnl"`
	WinRate    float64                  `json:"win_rate"`
	LastError  string                   `json:"last_error"`
	TickerLive bool                     `json:"ticker_live"`
}

// LiveState returns the current live state for the real-time terminal.
func (cs *ChallengeService) LiveState() LiveSnapshot {
	cs.mu.RLock()
	spot      := cs.liveSpot
	sig       := cs.lastSignal
	chain     := cs.lastChain
	open      := cs.openTrade
	livePrice := cs.liveOptionPrice
	livePnL   := cs.livePnL
	history   := make([]float64, len(cs.optionPriceHistory))
	copy(history, cs.optionPriceHistory)
	active    := cs.active
	lastErr   := cs.lastError
	cs.mu.RUnlock()

	snap := LiveSnapshot{
		Spot:      spot,
		Signal:    sig,
		Chain:     chain,
		Active:    active,
		LastError: lastErr,
		TickerLive: cs.ticker != nil && cs.kc.IsConnected(),
	}

	// Filter states
	snap.Filters = cs.evalFilters(sig, chain)

	// Spot: fall back to REST if WebSocket hasn't delivered a tick yet
	if spot == 0 {
		if ltp, err := cs.kc.LTP(kite.NiftySymbol); err == nil {
			if d, ok := ltp[kite.NiftySymbol]; ok { spot = d.LastPrice }
		}
		snap.Spot = spot
	}

	// Open option state — always built if there's an open trade in memory
	if open == nil && active != nil {
		// DB safety fallback: if in-memory is nil but DB has an open trade, load it
		var dbTrade storage.ChallengeTrade
		if err := cs.db.Where("challenge_id = ? AND status = ?", active.ID, "OPEN").First(&dbTrade).Error; err == nil {
			open = &dbTrade
			cs.mu.Lock(); cs.openTrade = open; cs.mu.Unlock()
		}
	}

	if open != nil {
		// If WebSocket hasn't delivered a price yet, fall back to one REST call
		if livePrice == 0 {
			if rp, _, err := cs.kc.RealOptionLTP(open.Expiry, open.Strike, open.OptionType); err == nil && rp > 0 {
				livePrice = rp
				livePnL   = round2p((livePrice - open.EntryPremium) * float64(open.Qty))
				cs.mu.Lock(); cs.liveOptionPrice = livePrice; cs.livePnL = livePnL; cs.mu.Unlock()
			}
		}

		expiry, _ := time.Parse("2006-01-02", open.Expiry)
		dte       := options.ActualDTE(time.Now(), expiry)
		targetAmt := 0.0
		if active != nil {
			targetAmt = active.TargetPerTrade
		}
		qty := float64(open.Qty)

		// Read the in-memory dynamic SL state (set at entry, updated each tick).
		cs.mu.RLock()
		slAmt   := cs.entrySLAmt
		peakPnL := cs.peakPnL
		cs.mu.RUnlock()
		if slAmt <= 0 && active != nil {
			slAmt = active.RiskPerTrade // fallback if not yet set (e.g. before first tick)
		}

		slPU     := slAmt / qty
		targPU   := targetAmt / qty

		// Trailing SL becomes active once peak profit ≥ 1× the effective SL.
		trailLevel    := peakPnL - slAmt
		trailActive   := peakPnL > slAmt
		trailPnLLevel := math.Max(0, trailLevel)
		trailPremium  := round2p(open.EntryPremium + trailPnLLevel/qty)

		// SLPremium: if trailing is active, show the trailing SL premium;
		// otherwise show the original entry-based SL premium.
		slPremium := round2p(math.Max(0, open.EntryPremium-slPU))
		if trailActive {
			slPremium = trailPremium
		}

		premChange := livePrice - open.EntryPremium
		pnlPct     := 0.0
		if slAmt > 0 {
			pnlPct = livePnL / slAmt * 100
		}

		snap.OpenOption = &LiveOptionState{
			TradingSymbol:     open.TradingSymbol,
			Strike:            open.Strike,
			OptionType:        open.OptionType,
			Expiry:            open.Expiry,
			EntryPremium:      open.EntryPremium,
			CurrentPremium:    livePrice,
			PremiumChange:     round2p(premChange),
			PnL:               livePnL,
			PnLPct:            round2p(pnlPct),
			SLPremium:         slPremium,
			TargetPremium:     round2p(open.EntryPremium + targPU),
			PriceHistory:      history,
			EntrySpot:         open.EntrySpot,
			DTE:               dte,
			EffectiveSLAmt:    round2p(slAmt),
			PeakPnL:           round2p(peakPnL),
			TrailingSLActive:  trailActive,
			TrailingSLLevel:   round2p(trailPnLLevel),
			TrailingSLPremium: trailPremium,
		}
		// Include full DB record so frontend can show entry signal basis, indicators, PCR at entry
		snap.OpenTrade = open
	}

	// Challenge stats
	if active != nil {
		snap.DayNumber = active.DayNumber(time.Now())
		var totalPnL float64
		cs.db.Model(&storage.ChallengeTrade{}).
			Where("challenge_id = ? AND status = ?", active.ID, "CLOSED").
			Select("COALESCE(SUM(pnl), 0)").Scan(&totalPnL)
		snap.TotalPnL = round2p(totalPnL)

		now := time.Now().In(ist())
		todayStr := now.Format("2006-01-02")
		var todayPnL float64
		cs.db.Model(&storage.ChallengeTrade{}).
			Where("challenge_id = ? AND status = ? AND DATE(exit_time AT TIME ZONE 'Asia/Kolkata') = ?",
				active.ID, "CLOSED", todayStr).
			Select("COALESCE(SUM(pnl), 0)").Scan(&todayPnL)
		snap.TodayPnL = round2p(todayPnL)

		var wins, total int64
		cs.db.Model(&storage.ChallengeTrade{}).
			Where("challenge_id = ? AND status = ?", active.ID, "CLOSED").Count(&total)
		cs.db.Model(&storage.ChallengeTrade{}).
			Where("challenge_id = ? AND status = ? AND pnl >= 0", active.ID, "CLOSED").Count(&wins)
		if total > 0 { snap.WinRate = round2p(float64(wins) / float64(total) * 100) }
	}

	return snap
}

// evalFilters computes real-time pass/fail for the 3 entry gates.
func (cs *ChallengeService) evalFilters(sig *options.Recommendation, chain *kite.ChainSnapshot) FilterState {
	fs := FilterState{}

	// Gate 1: Technical signal
	if sig == nil {
		fs.TechSignal = FilterResult{Pass: false, Value: "no signal", Reason: "Waiting for 15m candle data"}
	} else if sig.Strategy == options.StratNone {
		fs.TechSignal = FilterResult{Pass: false, Value: "NO TRADE", Reason: "No clear edge in current 15m structure"}
	} else if sig.Confidence < 55 {
		fs.TechSignal = FilterResult{
			Pass:   false,
			Value:  fmt.Sprintf("%d%%", sig.Confidence),
			Reason: fmt.Sprintf("Confidence %d%% below 55%% threshold", sig.Confidence),
		}
	} else {
		fs.TechSignal = FilterResult{
			Pass:   true,
			Value:  fmt.Sprintf("%s %d%%", sig.Direction, sig.Confidence),
			Reason: sig.Reasoning[0],
		}
	}

	// Gate 2: PCR filter
	if chain == nil || chain.PCR == 0 {
		fs.PCRFilter = FilterResult{Pass: true, Value: "N/A", Reason: "No OI data (market closed) — gate bypassed"}
	} else {
		bias := kite.PCRBias(chain.PCR)
		var aligned bool
		if sig != nil { aligned = pcrAligns(sig.Direction, chain.PCR) } else { aligned = true }
		fs.PCRFilter = FilterResult{
			Pass:   aligned,
			Value:  fmt.Sprintf("%.3f (%s)", chain.PCR, bias),
			Reason: fmt.Sprintf("PCR %.3f → contrarian bias %s", chain.PCR, bias),
		}
		if !aligned && sig != nil {
			fs.PCRFilter.Reason += fmt.Sprintf(" — conflicts with %s signal", sig.Direction)
		}
	}

	// Gate 3: Real Kite LTP available
	if !cs.kc.IsConnected() {
		fs.RealLTP = FilterResult{Pass: false, Value: "disconnected", Reason: "Kite not connected — real LTP unavailable"}
	} else {
		fs.RealLTP = FilterResult{Pass: true, Value: "available", Reason: "Real Kite LTP will be used at fill time"}
	}

	fs.AllPassed = fs.TechSignal.Pass && fs.PCRFilter.Pass && fs.RealLTP.Pass
	return fs
}
