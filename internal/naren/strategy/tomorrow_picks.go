package strategy

import (
	"math"
	"sort"
	"time"

	"stockwise/internal/naren/nifty"
	"stockwise/internal/naren/storage"
)

// barsToLite converts storage.PriceBar slice to nifty.PriceBarLite for ATR calculation.
func barsToLite(bars []storage.PriceBar) []nifty.PriceBarLite {
	out := make([]nifty.PriceBarLite, len(bars))
	for i, b := range bars {
		out[i] = nifty.PriceBarLite{Open: b.Open, High: b.High, Low: b.Low, Close: b.Close}
	}
	return out
}

// WatchSymbol describes a tracked instrument for today/tomorrow picks.
type WatchSymbol struct {
	Symbol string
	Name   string
	Sector string
}

// TomorrowPick holds the best-strategy result for one symbol with
// precise entry / target / stop-loss prices.
type TomorrowPick struct {
	Symbol           string  `json:"symbol"`
	Name             string  `json:"name"`
	Sector           string  `json:"sector"`
	BestStrategy     string  `json:"best_strategy"`
	WinRate          float64 `json:"win_rate"`
	ProfitFactor     float64 `json:"profit_factor"`
	NetPnLPct        float64 `json:"net_pnl_pct"`
	TotalTrades      int     `json:"total_trades"`
	AvgWinPct        float64 `json:"avg_win_pct"`
	AvgLossPct       float64 `json:"avg_loss_pct"`
	MaxDrawdownPct   float64 `json:"max_drawdown_pct"`
	TradeProbability float64 `json:"trade_probability"`
	Direction        string  `json:"direction"` // BUY | SELL | NEUTRAL
	LastClose        float64 `json:"last_close"`
	DataPoints       int     `json:"data_points"`

	// Entry / exit levels
	EntryPrice  float64 `json:"entry_price"`
	TargetPrice float64 `json:"target_price"`
	StopLoss    float64 `json:"stop_loss"`
	TargetPct   float64 `json:"target_pct"`
	StopPct     float64 `json:"stop_pct"`
	RiskReward  float64 `json:"risk_reward"`
	ExpectedPnL float64 `json:"expected_pnl"`

	// Today-specific: how the trade is tracking against today's actual bar
	TodayOpen   float64 `json:"today_open"`
	TodayHigh   float64 `json:"today_high"`
	TodayLow    float64 `json:"today_low"`
	TodayClose  float64 `json:"today_close"`
	TodayStatus string  `json:"today_status"`  // TARGET_HIT | SL_HIT | OPEN | NO_SIGNAL
	TodayPnLPct float64 `json:"today_pnl_pct"`
	SignalDate  string  `json:"signal_date"`

	// Option strike suggestions (CE + PE) with entry/target/SL premiums
	Options *nifty.StrikeSuggestionReport `json:"options,omitempty"`
}

var tomorrowWatchList = []WatchSymbol{
	{Symbol: "^NSEI", Name: "NIFTY 50", Sector: "Index"},
	{Symbol: "HDFCBANK.NS", Name: "HDFC Bank", Sector: "Banking"},
	{Symbol: "SBIN.NS", Name: "State Bank of India", Sector: "Banking"},
	{Symbol: "INFY.NS", Name: "Infosys", Sector: "IT"},
	{Symbol: "RELIANCE.NS", Name: "Reliance Industries", Sector: "Energy"},
	{Symbol: "TATAMOTORS.NS", Name: "Tata Motors", Sector: "Auto"},
	{Symbol: "ITC.NS", Name: "ITC", Sector: "FMCG"},
	{Symbol: "SUNPHARMA.NS", Name: "Sun Pharma", Sector: "Pharma"},
	{Symbol: "TATASTEEL.NS", Name: "Tata Steel", Sector: "Metal"},
	{Symbol: "NTPC.NS", Name: "NTPC", Sector: "Power"},
	{Symbol: "DLF.NS", Name: "DLF", Sector: "Realty"},
	{Symbol: "MUTHOOTFIN.NS", Name: "Muthoot Finance", Sector: "Finance"},
}

var strategyDefs = []struct {
	name string
	fn   func([]storage.PriceBar, int) (bool, bool, float64, float64)
}{
	{"Supertrend Flip", supertrendFlipStrategy},
	{"VWAP + EMA21 Confluence", vwapEMAStrategy},
	{"Opening Range Breakout (ORB)", orbDailyStrategy},
	{"EMA9/EMA21 Crossover", emaCrossoverStrategy},
	{"Stochastic Divergence", stochasticDivergenceStrategy},
	{"RSI Extreme Reversal", rsiExtremeStrategy},
	{"BTST Momentum (EOD)", btstMomentumStrategy},
	{"SMC + FVG + Pivot", smcFVGPivotStrategy},
}

// ─── Public entry points ──────────────────────────────────────────────────────

// GetTomorrowPicks: signal fires on TODAY's last bar → entry tomorrow at open (≈ last close).
// Returns ALL 12 symbols ranked by trade probability so the list is never empty.
func (e *Engine) GetTomorrowPicks(years int) ([]TomorrowPick, error) {
	return e.fanOut(years, pickTomorrow)
}

// GetTodayPicks: signal fired on YESTERDAY's bar → entry was at TODAY's open.
// Shows whether target/SL was hit during today's session using today's H/L.
// Returns ALL 12 symbols so NEUTRAL stocks (no signal) are still visible.
func (e *Engine) GetTodayPicks(years int) ([]TomorrowPick, error) {
	return e.fanOut(years, pickToday)
}

// ─── Fan-out ──────────────────────────────────────────────────────────────────

type pickFn func(ws WatchSymbol, bars []storage.PriceBar, best ScalpStrategyResult) TomorrowPick

func (e *Engine) fanOut(years int, fn pickFn) ([]TomorrowPick, error) {
	type result struct {
		pick TomorrowPick
		err  error
	}
	ch := make(chan result, len(tomorrowWatchList))

	for _, ws := range tomorrowWatchList {
		ws := ws
		go func() {
			bars, err := loadBars(e, ws.Symbol, years)
			if err != nil || len(bars) < 50 {
				ch <- result{err: err}
				return
			}
			best := bestStrategy(bars, ws.Symbol)
			ch <- result{pick: fn(ws, bars, best)}
		}()
	}

	var picks []TomorrowPick
	for range tomorrowWatchList {
		r := <-ch
		if r.err == nil && r.pick.TotalTrades > 0 {
			picks = append(picks, r.pick)
		}
	}

	sort.Slice(picks, func(i, j int) bool {
		return picks[i].TradeProbability > picks[j].TradeProbability
	})
	return picks, nil
}

// ─── Tomorrow logic ───────────────────────────────────────────────────────────

// pickTomorrow reads the signal on bars[last] and sets entry = last close
// (estimated tomorrow open). Always returns a pick regardless of direction.
func pickTomorrow(ws WatchSymbol, bars []storage.PriceBar, best ScalpStrategyResult) TomorrowPick {
	last := len(bars) - 1
	lastClose := bars[last].Close

	direction, targetPct, stopPct := signalAt(best.StrategyName, bars, last)

	// Fall back to historical averages when no signal fired
	if targetPct == 0 {
		targetPct = best.AvgWinPct / 100
	}
	if stopPct == 0 {
		stopPct = math.Abs(best.AvgLossPct) / 100
	}

	entry := lastClose
	target, stop := calcLevels(direction, entry, targetPct, stopPct)

	return buildPick(ws, best, direction, entry, target, stop, targetPct, stopPct, bars)
}

// ─── Today logic ─────────────────────────────────────────────────────────────

// pickToday reads the signal on bars[last-1] (yesterday).
// Entry = bars[last].Open  (today's actual open).
// Status = TARGET_HIT if today's High >= target, SL_HIT if Low <= stop, else OPEN.
func pickToday(ws WatchSymbol, bars []storage.PriceBar, best ScalpStrategyResult) TomorrowPick {
	if len(bars) < 3 {
		return TomorrowPick{}
	}
	signalIdx := len(bars) - 2 // yesterday's bar fired the signal
	todayBar := bars[len(bars)-1]

	direction, targetPct, stopPct := signalAt(best.StrategyName, bars, signalIdx)

	// Fall back to historical averages
	if targetPct == 0 {
		targetPct = best.AvgWinPct / 100
	}
	if stopPct == 0 {
		stopPct = math.Abs(best.AvgLossPct) / 100
	}

	// Entry is today's actual open (the bar after the signal)
	entry := todayBar.Open
	if entry == 0 {
		entry = bars[signalIdx].Close // fallback if open not available
	}
	target, stop := calcLevels(direction, entry, targetPct, stopPct)

	// Determine today's trade status
	status := "NO_SIGNAL"
	todayPnL := 0.0
	if direction != "NEUTRAL" {
		status = "OPEN"
		if direction == "BUY" {
			if todayBar.High >= target {
				status = "TARGET_HIT"
				todayPnL = targetPct * 100
			} else if todayBar.Low <= stop {
				status = "SL_HIT"
				todayPnL = -stopPct * 100
			} else {
				// Use today's close as the unrealised P&L
				todayPnL = (todayBar.Close - entry) / entry * 100
			}
		} else { // SELL
			if todayBar.Low <= target {
				status = "TARGET_HIT"
				todayPnL = targetPct * 100
			} else if todayBar.High >= stop {
				status = "SL_HIT"
				todayPnL = -stopPct * 100
			} else {
				todayPnL = (entry - todayBar.Close) / entry * 100
			}
		}
	}

	pick := buildPick(ws, best, direction, entry, target, stop, targetPct, stopPct, bars)
	pick.TodayOpen = todayBar.Open
	pick.TodayHigh = todayBar.High
	pick.TodayLow = todayBar.Low
	pick.TodayClose = todayBar.Close
	pick.TodayStatus = status
	pick.TodayPnLPct = math.Round(todayPnL*100) / 100
	pick.SignalDate = bars[signalIdx].Date.Format("2006-01-02")
	pick.LastClose = todayBar.Close
	return pick
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

func bestStrategy(bars []storage.PriceBar, symbol string) ScalpStrategyResult {
	var best ScalpStrategyResult
	for _, s := range strategyDefs {
		res := runSingleStrategyBacktest(s.name, "", symbol, bars, s.fn)
		if res.WinRate > best.WinRate {
			best = res
		}
	}
	return best
}

func signalAt(stratName string, bars []storage.PriceBar, idx int) (direction string, targetPct, stopPct float64) {
	fn := findStrategyFn(stratName)
	if fn == nil || idx < 1 {
		return "NEUTRAL", 0, 0
	}
	enterLong, enterShort, tgt, sl := fn(bars, idx)
	if enterLong {
		return "BUY", tgt, sl
	}
	if enterShort {
		return "SELL", tgt, sl
	}
	return "NEUTRAL", 0, 0
}

func calcLevels(direction string, entry, targetPct, stopPct float64) (target, stop float64) {
	if direction == "SELL" {
		target = entry * (1 - targetPct)
		stop = entry * (1 + stopPct)
	} else {
		target = entry * (1 + targetPct)
		stop = entry * (1 - stopPct)
	}
	return math.Round(target*100) / 100, math.Round(stop*100) / 100
}

func buildPick(ws WatchSymbol, best ScalpStrategyResult, direction string,
	entry, target, stop, targetPct, stopPct float64, bars []storage.PriceBar) TomorrowPick {

	rr := 0.0
	if math.Abs(entry-stop) > 0 {
		rr = math.Abs(target-entry) / math.Abs(entry-stop)
	}
	winRate := best.WinRate / 100
	expectedPnL := (winRate * best.AvgWinPct) - ((1 - winRate) * math.Abs(best.AvgLossPct))

	// Generate CE/PE strike suggestions using ATR-derived IV
	opts := nifty.SuggestStrikesForSpot(ws.Symbol, entry, direction, targetPct, stopPct, barsToLite(bars))

	return TomorrowPick{
		Symbol:           ws.Symbol,
		Name:             ws.Name,
		Sector:           ws.Sector,
		BestStrategy:     best.StrategyName,
		WinRate:          best.WinRate,
		ProfitFactor:     best.ProfitFactor,
		NetPnLPct:        best.NetPnLPct,
		TotalTrades:      best.TotalTrades,
		AvgWinPct:        best.AvgWinPct,
		AvgLossPct:       best.AvgLossPct,
		MaxDrawdownPct:   best.MaxDrawdownPct,
		TradeProbability: tradeProbability(best),
		Direction:        direction,
		LastClose:        bars[len(bars)-1].Close,
		DataPoints:       len(bars),
		EntryPrice:       entry,
		TargetPrice:      target,
		StopLoss:         stop,
		TargetPct:        targetPct * 100,
		StopPct:          stopPct * 100,
		RiskReward:       math.Round(rr*100) / 100,
		ExpectedPnL:      math.Round(expectedPnL*100) / 100,
		TodayStatus:      "NO_SIGNAL",
		Options:          opts,
	}
}

// loadBars tries the DB first; falls back to Yahoo Finance live fetch.
func loadBars(e *Engine, symbol string, years int) ([]storage.PriceBar, error) {
	to := time.Now()
	from := to.AddDate(-years, 0, 0)

	if stock, err := e.repo.GetStockBySymbol(symbol); err == nil {
		if bars, err := e.repo.GetPriceBars(stock.ID, from, to); err == nil && len(bars) >= 50 {
			return bars, nil
		}
	}

	days := years * 365
	intradayBars, err := nifty.FetchDailyBarsForSymbol(symbol, days)
	if err != nil {
		return nil, err
	}
	var out []storage.PriceBar
	for _, b := range intradayBars {
		out = append(out, storage.PriceBar{
			Open:   b.Open,
			High:   b.High,
			Low:    b.Low,
			Close:  b.Close,
			Volume: b.Volume,
			Date:   b.Time,
		})
	}
	return out, nil
}

func findStrategyFn(name string) func([]storage.PriceBar, int) (bool, bool, float64, float64) {
	for _, s := range strategyDefs {
		if s.name == name {
			return s.fn
		}
	}
	return nil
}

// tradeProbability: 50% win rate + 30% capped profit factor + 20% capped Sharpe.
func tradeProbability(r ScalpStrategyResult) float64 {
	wr := math.Min(r.WinRate, 100) / 100
	pf := math.Min(r.ProfitFactor, 4) / 4
	if math.IsNaN(pf) || math.IsInf(pf, 0) {
		pf = 0
	}
	sharpe := math.Min(math.Max(r.SharpeRatio, 0), 3) / 3
	if math.IsNaN(sharpe) || math.IsInf(sharpe, 0) {
		sharpe = 0
	}
	return math.Round((wr*0.50+pf*0.30+sharpe*0.20)*1000) / 10
}
