package strategy

import (
	"fmt"
	"math"
	"sort"
	"time"

	"stockwise/internal/storage"
)

// ScalpBacktestTrade is one simulated scalp trade.
type ScalpBacktestTrade struct {
	Date       time.Time `json:"date"`
	Direction  string    `json:"direction"` // BUY, SELL
	EntryPrice float64   `json:"entry_price"`
	ExitPrice  float64   `json:"exit_price"`
	PnLPct     float64   `json:"pnl_pct"`
	IsWin      bool      `json:"is_win"`
	ExitReason string    `json:"exit_reason"` // TARGET, STOP, EOD
}

// ScalpStrategyResult holds backtest results for one scalping strategy.
type ScalpStrategyResult struct {
	StrategyName    string               `json:"strategy_name"`
	Description     string               `json:"description"`
	Symbol          string               `json:"symbol"`
	PeriodYears     int                  `json:"period_years"`
	TotalTrades     int                  `json:"total_trades"`
	WinningTrades   int                  `json:"winning_trades"`
	LosingTrades    int                  `json:"losing_trades"`
	WinRate         float64              `json:"win_rate"`         // %
	AvgWinPct       float64              `json:"avg_win_pct"`      // %
	AvgLossPct      float64              `json:"avg_loss_pct"`     // %
	ProfitFactor    float64              `json:"profit_factor"`
	MaxDrawdownPct  float64              `json:"max_drawdown_pct"` // %
	NetPnLPct       float64              `json:"net_pnl_pct"`      // % total P&L
	SharpeRatio     float64              `json:"sharpe_ratio"`
	ExpectancyPct   float64              `json:"expectancy_pct"`   // avg P&L per trade
	BestTradePct    float64              `json:"best_trade_pct"`
	WorstTradePct   float64              `json:"worst_trade_pct"`
	AvgTradesPerMonth float64            `json:"avg_trades_per_month"`
	YearlyBreakdown []YearlyResult       `json:"yearly_breakdown"`
	RecentTrades    []ScalpBacktestTrade `json:"recent_trades"` // last 20
}

// YearlyResult holds per-year backtest stats.
type YearlyResult struct {
	Year        int     `json:"year"`
	Trades      int     `json:"trades"`
	WinRate     float64 `json:"win_rate"`
	NetPnLPct   float64 `json:"net_pnl_pct"`
	ProfitFactor float64 `json:"profit_factor"`
}

// ScalpBacktestReport is the full report returned by the API.
type ScalpBacktestReport struct {
	Symbol       string                `json:"symbol"`
	SymbolName   string                `json:"symbol_name"`
	GeneratedAt  string                `json:"generated_at"`
	PeriodYears  int                   `json:"period_years"`
	DataPoints   int                   `json:"data_points"`
	Strategies   []ScalpStrategyResult `json:"strategies"`
	Summary      BacktestSummary       `json:"summary"`
}

// BacktestSummary holds the aggregated best-performing strategy info.
type BacktestSummary struct {
	BestWinRate        string  `json:"best_win_rate_strategy"`
	BestWinRateValue   float64 `json:"best_win_rate_value"`
	BestProfitFactor   string  `json:"best_profit_factor_strategy"`
	BestProfitFactorV  float64 `json:"best_profit_factor_value"`
	BestNetPnL         string  `json:"best_net_pnl_strategy"`
	BestNetPnLValue    float64 `json:"best_net_pnl_value"`
	OverallWinRate     float64 `json:"overall_win_rate"`
	TotalSignals       int     `json:"total_signals"`
	Recommendation     string  `json:"recommendation"`
}

// RunScalpingBacktest runs all 7 scalping strategies against NIFTY historical data.
// Uses daily bars as sessions — each bar = one trading day.
// Entry = simulated at open of signal day, Exit = target/stop during day using H/L.
func (e *Engine) RunScalpingBacktest(symbol string, years int) (*ScalpBacktestReport, error) {
	stock, err := e.repo.GetStockBySymbol(symbol)
	if err != nil {
		return nil, err
	}

	to := time.Now()
	from := to.AddDate(-years, 0, 0)
	bars, err := e.repo.GetPriceBars(stock.ID, from, to)
	if err != nil || len(bars) < 50 {
		return nil, err
	}

	// Define all 7 strategies as backtest functions
	strategies := []struct {
		name        string
		description string
		fn          func(bars []storage.PriceBar, i int) (bool, bool, float64, float64)
		// returns: (enterLong, enterShort, targetPct, stopPct)
	}{
		{
			name:        "Supertrend Flip",
			description: "Buy when Supertrend flips bullish (daily); Sell when it flips bearish. ATR multiplier=3, period=10.",
			fn:          supertrendFlipStrategy,
		},
		{
			name:        "VWAP + EMA21 Confluence",
			description: "Enter when close is within 0.4% of VWAP (typical price proxy) and EMA21 is aligned with trend.",
			fn:          vwapEMAStrategy,
		},
		{
			name:        "Opening Range Breakout (ORB)",
			description: "Buy/Sell breakout of first-5-bar range with volume confirmation. Daily proxy: prior 5-day range.",
			fn:          orbDailyStrategy,
		},
		{
			name:        "EMA9/EMA21 Crossover",
			description: "Enter on EMA9 crossing EMA21 with above-average volume. Classic momentum strategy.",
			fn:          emaCrossoverStrategy,
		},
		{
			name:        "Stochastic Divergence",
			description: "Buy when Stochastic crosses up in oversold zone (<20); Sell when crosses down from overbought (>80).",
			fn:          stochasticDivergenceStrategy,
		},
		{
			name:        "RSI Extreme Reversal",
			description: "Buy on RSI < 30 with next-bar recovery; Sell on RSI > 70 with reversal confirmation.",
			fn:          rsiExtremeStrategy,
		},
		{
			name:        "BTST Momentum (EOD)",
			description: "End-of-day BTST: strong close, RSI 52-72, volume >1.5x. Exit next day.",
			fn:          btstMomentumStrategy,
		},
	}

	var results []ScalpStrategyResult
	for _, s := range strategies {
		result := runSingleStrategyBacktest(s.name, s.description, symbol, bars, s.fn)
		results = append(results, result)
	}

	summary := buildBacktestSummary(results)

	return &ScalpBacktestReport{
		Symbol:      symbol,
		SymbolName:  stock.Name,
		GeneratedAt: time.Now().Format(time.RFC3339),
		PeriodYears: years,
		DataPoints:  len(bars),
		Strategies:  results,
		Summary:     summary,
	}, nil
}

// runSingleStrategyBacktest simulates one strategy on daily bars.
func runSingleStrategyBacktest(
	name, desc, symbol string,
	bars []storage.PriceBar,
	fn func(bars []storage.PriceBar, i int) (bool, bool, float64, float64),
) ScalpStrategyResult {
	var trades []ScalpBacktestTrade
	yearMap := map[int]*YearlyResult{}

	commission := 0.0005 // 0.05% per side

	for i := 50; i < len(bars)-1; i++ {
		enterLong, enterShort, targetPct, stopPct := fn(bars, i)
		if !enterLong && !enterShort {
			continue
		}

		bar := bars[i]
		nextBar := bars[i+1]

		entry := nextBar.Open // enter at next day open
		entry *= 1 + commission

		direction := "BUY"
		if enterShort {
			direction = "SELL"
		}

		var exit float64
		exitReason := "EOD"

		if direction == "BUY" {
			tgt := entry * (1 + targetPct)
			stop := entry * (1 - stopPct)

			// Check if target or stop hit intraday
			if nextBar.Low <= stop {
				exit = stop
				exitReason = "STOP"
			} else if nextBar.High >= tgt {
				exit = tgt
				exitReason = "TARGET"
			} else {
				exit = nextBar.Close
				exitReason = "EOD"
			}
		} else {
			tgt := entry * (1 - targetPct)
			stop := entry * (1 + stopPct)
			if nextBar.High >= stop {
				exit = stop
				exitReason = "STOP"
			} else if nextBar.Low <= tgt {
				exit = tgt
				exitReason = "TARGET"
			} else {
				exit = nextBar.Close
				exitReason = "EOD"
			}
		}

		exit *= 1 - commission

		pnlPct := 0.0
		if direction == "BUY" {
			pnlPct = (exit - entry) / entry * 100
		} else {
			pnlPct = (entry - exit) / entry * 100
		}

		trade := ScalpBacktestTrade{
			Date:       bar.Date,
			Direction:  direction,
			EntryPrice: roundPct(entry),
			ExitPrice:  roundPct(exit),
			PnLPct:     roundPct(pnlPct),
			IsWin:      pnlPct > 0,
			ExitReason: exitReason,
		}
		trades = append(trades, trade)

		// Yearly breakdown
		yr := bar.Date.Year()
		if _, ok := yearMap[yr]; !ok {
			yearMap[yr] = &YearlyResult{Year: yr}
		}
		yd := yearMap[yr]
		yd.Trades++
		yd.NetPnLPct += pnlPct
		if pnlPct > 0 {
			yd.WinRate++ // increment, divide later
		}
	}

	// Build result
	res := ScalpStrategyResult{
		StrategyName: name,
		Description:  desc,
		Symbol:       symbol,
		PeriodYears:  5,
		TotalTrades:  len(trades),
	}

	if len(trades) == 0 {
		return res
	}

	grossWin, grossLoss := 0.0, 0.0
	var pnls []float64
	best, worst := -math.MaxFloat64, math.MaxFloat64

	for _, t := range trades {
		pnls = append(pnls, t.PnLPct)
		if t.IsWin {
			res.WinningTrades++
			grossWin += t.PnLPct
			if t.PnLPct > best {
				best = t.PnLPct
			}
		} else {
			res.LosingTrades++
			grossLoss += math.Abs(t.PnLPct)
			if t.PnLPct < worst {
				worst = t.PnLPct
			}
		}
		res.NetPnLPct += t.PnLPct
	}

	res.WinRate = roundPct(float64(res.WinningTrades) / float64(res.TotalTrades) * 100)
	if res.WinningTrades > 0 {
		res.AvgWinPct = roundPct(grossWin / float64(res.WinningTrades))
	}
	if res.LosingTrades > 0 {
		res.AvgLossPct = roundPct(grossLoss / float64(res.LosingTrades))
	}
	if grossLoss > 0 {
		res.ProfitFactor = roundPct(grossWin / grossLoss)
	}
	res.NetPnLPct = roundPct(res.NetPnLPct)
	res.BestTradePct = roundPct(best)
	res.WorstTradePct = roundPct(worst)
	res.ExpectancyPct = roundPct(res.NetPnLPct / float64(res.TotalTrades))
	res.MaxDrawdownPct = roundPct(calcMaxDD(pnls))
	res.SharpeRatio = roundPct(calcSharpe(pnls))

	// Monthly trade rate
	if len(trades) > 0 {
		months := float64(len(trades)) / float64(5*12)
		res.AvgTradesPerMonth = roundPct(months)
	}

	// Keep last 20 trades
	start := 0
	if len(trades) > 20 {
		start = len(trades) - 20
	}
	res.RecentTrades = trades[start:]

	// Yearly breakdown
	var years []YearlyResult
	for _, yd := range yearMap {
		if yd.Trades > 0 {
			yd.WinRate = roundPct(yd.WinRate / float64(yd.Trades) * 100)
			yd.NetPnLPct = roundPct(yd.NetPnLPct)
			// simple profit factor
			wins, losses := 0.0, 0.0
			for _, t := range trades {
				if t.Date.Year() == yd.Year {
					if t.IsWin {
						wins += t.PnLPct
					} else {
						losses += math.Abs(t.PnLPct)
					}
				}
			}
			if losses > 0 {
				yd.ProfitFactor = roundPct(wins / losses)
			}
		}
		years = append(years, *yd)
	}
	sort.Slice(years, func(i, j int) bool { return years[i].Year < years[j].Year })
	res.YearlyBreakdown = years

	return res
}

// ── Strategy logic functions (daily proxy) ────────────────────────────────────

// supertrendFlipStrategy: flip in supertrend direction.
func supertrendFlipStrategy(bars []storage.PriceBar, i int) (bool, bool, float64, float64) {
	if i < 12 {
		return false, false, 0, 0
	}
	curr := supertrendDaily(bars, i)
	prev := supertrendDaily(bars, i-1)
	atr := dailyATRPct(bars, i, 14)
	if prev == -1 && curr == 1 {
		return true, false, atr * 2.5, atr * 1.0
	}
	if prev == 1 && curr == -1 {
		return false, true, atr * 2.5, atr * 1.0
	}
	return false, false, 0, 0
}

// vwapEMAStrategy: close near typical-price proxy with EMA21 alignment.
func vwapEMAStrategy(bars []storage.PriceBar, i int) (bool, bool, float64, float64) {
	if i < 21 {
		return false, false, 0, 0
	}
	close := bars[i].Close
	ema21 := dailyEMA(bars, i, 21)
	ema9 := dailyEMA(bars, i, 9)
	tp := (bars[i].High + bars[i].Low + bars[i].Close) / 3 // typical price as VWAP proxy
	vwapDist := math.Abs(close-tp) / tp
	atr := dailyATRPct(bars, i, 14)
	rsi := dailyRSI(bars, i, 14)

	if vwapDist < 0.004 && ema9 > ema21 && close > ema21 && rsi > 42 && rsi < 64 {
		return true, false, atr * 2.0, atr * 1.0
	}
	if vwapDist < 0.004 && ema9 < ema21 && close < ema21 && rsi < 58 && rsi > 36 {
		return false, true, atr * 2.0, atr * 1.0
	}
	return false, false, 0, 0
}

// orbDailyStrategy: 5-day ORB breakout proxy.
func orbDailyStrategy(bars []storage.PriceBar, i int) (bool, bool, float64, float64) {
	if i < 10 {
		return false, false, 0, 0
	}
	orbHigh, orbLow := bars[i-4].High, bars[i-4].Low
	avgVol := int64(0)
	for j := i - 4; j < i; j++ {
		if bars[j].High > orbHigh {
			orbHigh = bars[j].High
		}
		if bars[j].Low < orbLow {
			orbLow = bars[j].Low
		}
		avgVol += bars[j].Volume
	}
	avgVol /= 4
	close := bars[i].Close
	volSpike := bars[i].Volume > avgVol*2
	atr := dailyATRPct(bars, i, 14)
	rsi := dailyRSI(bars, i, 14)

	if close > orbHigh && volSpike && rsi > 50 && rsi < 74 {
		return true, false, atr * 2.0, atr * 0.8
	}
	if close < orbLow && volSpike && rsi < 50 && rsi > 26 {
		return false, true, atr * 2.0, atr * 0.8
	}
	return false, false, 0, 0
}

// emaCrossoverStrategy: EMA9/EMA21 crossover with volume.
func emaCrossoverStrategy(bars []storage.PriceBar, i int) (bool, bool, float64, float64) {
	if i < 25 {
		return false, false, 0, 0
	}
	ema9curr := dailyEMA(bars, i, 9)
	ema21curr := dailyEMA(bars, i, 21)
	ema9prev := dailyEMA(bars, i-1, 9)
	ema21prev := dailyEMA(bars, i-1, 21)
	avgVol := int64(0)
	for j := i - 20; j < i; j++ {
		avgVol += bars[j].Volume
	}
	avgVol /= 20
	if avgVol == 0 {
		return false, false, 0, 0
	}
	volSpike := bars[i].Volume > avgVol+avgVol/2
	atr := dailyATRPct(bars, i, 14)
	rsi := dailyRSI(bars, i, 14)

	if ema9prev <= ema21prev && ema9curr > ema21curr && volSpike && rsi > 48 && rsi < 72 {
		return true, false, atr * 2.5, atr * 1.0
	}
	if ema9prev >= ema21prev && ema9curr < ema21curr && volSpike && rsi < 52 && rsi > 28 {
		return false, true, atr * 2.5, atr * 1.0
	}
	return false, false, 0, 0
}

// stochasticDivergenceStrategy: K crosses D in oversold/overbought.
func stochasticDivergenceStrategy(bars []storage.PriceBar, i int) (bool, bool, float64, float64) {
	if i < 18 {
		return false, false, 0, 0
	}
	kCurr, dCurr := dailyStoch(bars, i, 14, 3)
	kPrev, dPrev := dailyStoch(bars, i-1, 14, 3)
	atr := dailyATRPct(bars, i, 14)

	if kPrev <= dPrev && kCurr > dCurr && kCurr < 30 {
		return true, false, atr * 2.0, atr * 0.8
	}
	if kPrev >= dPrev && kCurr < dCurr && kCurr > 70 {
		return false, true, atr * 2.0, atr * 0.8
	}
	return false, false, 0, 0
}

// rsiExtremeStrategy: RSI extreme with next-bar confirmation.
func rsiExtremeStrategy(bars []storage.PriceBar, i int) (bool, bool, float64, float64) {
	if i < 16 {
		return false, false, 0, 0
	}
	rsiCurr := dailyRSI(bars, i, 14)
	rsiPrev := dailyRSI(bars, i-1, 14)
	atr := dailyATRPct(bars, i, 14)
	greenBar := bars[i].Close > bars[i].Open
	redBar := bars[i].Close < bars[i].Open

	if rsiPrev < 30 && rsiCurr >= 30 && greenBar {
		return true, false, atr * 2.0, atr * 0.8
	}
	if rsiPrev > 70 && rsiCurr <= 70 && redBar {
		return false, true, atr * 2.0, atr * 0.8
	}
	return false, false, 0, 0
}

// btstMomentumStrategy: EOD strong close with volume surge.
func btstMomentumStrategy(bars []storage.PriceBar, i int) (bool, bool, float64, float64) {
	if i < 22 {
		return false, false, 0, 0
	}
	bar := bars[i]
	rsi := dailyRSI(bars, i, 14)
	avgVol := int64(0)
	for j := i - 20; j < i; j++ {
		avgVol += bars[j].Volume
	}
	avgVol /= 20
	if avgVol == 0 {
		return false, false, 0, 0
	}
	volRatio := float64(bar.Volume) / float64(avgVol)
	if math.IsInf(volRatio, 0) || math.IsNaN(volRatio) {
		return false, false, 0, 0
	}
	dayRange := bar.High - bar.Low
	closePos := 0.5
	if dayRange > 0 {
		closePos = (bar.Close - bar.Low) / dayRange
	}
	ema21 := dailyEMA(bars, i, 21)
	atr := dailyATRPct(bars, i, 14)

	if rsi >= 52 && rsi <= 72 && volRatio >= 1.5 && closePos >= 0.60 && bar.Close > ema21 {
		return true, false, atr * 1.8, atr * 0.7
	}
	return false, false, 0, 0
}

// ── Daily indicator helpers ───────────────────────────────────────────────────

func dailyEMA(bars []storage.PriceBar, endIdx, period int) float64 {
	if endIdx < period-1 {
		return bars[endIdx].Close
	}
	k := 2.0 / float64(period+1)
	ema := bars[endIdx-period+1].Close
	for i := endIdx - period + 2; i <= endIdx; i++ {
		ema = bars[i].Close*k + ema*(1-k)
	}
	return ema
}

func dailyRSI(bars []storage.PriceBar, endIdx, period int) float64 {
	if endIdx < period {
		return 50
	}
	gains, losses := 0.0, 0.0
	for i := endIdx - period + 1; i <= endIdx; i++ {
		ch := bars[i].Close - bars[i-1].Close
		if ch > 0 {
			gains += ch
		} else {
			losses -= ch
		}
	}
	if losses == 0 {
		return 100
	}
	rs := (gains / float64(period)) / (losses / float64(period))
	return 100 - 100/(1+rs)
}

func dailyATRPct(bars []storage.PriceBar, endIdx, period int) float64 {
	if endIdx < period {
		return (bars[endIdx].High - bars[endIdx].Low) / bars[endIdx].Close
	}
	sum := 0.0
	for i := endIdx - period + 1; i <= endIdx; i++ {
		tr := bars[i].High - bars[i].Low
		if i > 0 {
			tr = math.Max(tr, math.Abs(bars[i].High-bars[i-1].Close))
			tr = math.Max(tr, math.Abs(bars[i].Low-bars[i-1].Close))
		}
		sum += tr
	}
	atr := sum / float64(period)
	if bars[endIdx].Close == 0 {
		return 0.01
	}
	return atr / bars[endIdx].Close
}

func dailyStoch(bars []storage.PriceBar, endIdx, period, smooth int) (float64, float64) {
	if endIdx < period+smooth {
		return 50, 50
	}
	kVals := make([]float64, smooth)
	for s := 0; s < smooth; s++ {
		start := endIdx - period - s + 1
		end := endIdx - s + 1
		if start < 0 {
			kVals[s] = 50
			continue
		}
		lo, hi := bars[start].Low, bars[start].High
		for j := start + 1; j < end; j++ {
			if bars[j].Low < lo {
				lo = bars[j].Low
			}
			if bars[j].High > hi {
				hi = bars[j].High
			}
		}
		if hi == lo {
			kVals[s] = 50
			continue
		}
		kVals[s] = (bars[end-1].Close - lo) / (hi - lo) * 100
	}
	sumD := 0.0
	for _, k := range kVals {
		sumD += k
	}
	return kVals[0], sumD / float64(smooth)
}

// supertrendDaily: simplified supertrend direction (+1 or -1).
func supertrendDaily(bars []storage.PriceBar, endIdx int) int {
	period := 10
	mult := 3.0
	if endIdx < period {
		return 1
	}
	atr := dailyATRPct(bars, endIdx, period) * bars[endIdx].Close
	hl2 := (bars[endIdx].High + bars[endIdx].Low) / 2
	upper := hl2 + mult*atr
	lower := hl2 - mult*atr
	close := bars[endIdx].Close
	prevClose := bars[endIdx-1].Close

	// Simplified: price above lower band = bullish, below upper band = bearish
	prevAtr := dailyATRPct(bars, endIdx-1, period) * bars[endIdx-1].Close
	prevHL2 := (bars[endIdx-1].High + bars[endIdx-1].Low) / 2
	prevUpper := prevHL2 + mult*prevAtr
	prevLower := prevHL2 - mult*prevAtr

	// Adjust bands (don't widen against trend)
	if prevClose <= prevUpper {
		upper = math.Min(upper, prevUpper)
	}
	if prevClose >= prevLower {
		lower = math.Max(lower, prevLower)
	}

	if close > upper {
		return 1
	}
	if close < lower {
		return -1
	}
	// Previous direction
	if prevClose > prevUpper {
		return 1
	}
	return -1
}

// ── Metric helpers ────────────────────────────────────────────────────────────

func calcMaxDD(pnls []float64) float64 {
	if len(pnls) == 0 {
		return 0
	}
	equity := 100.0
	peak := equity
	maxDD := 0.0
	for _, p := range pnls {
		equity *= 1 + p/100
		if equity > peak {
			peak = equity
		}
		dd := (peak - equity) / peak * 100
		if dd > maxDD {
			maxDD = dd
		}
	}
	return maxDD
}

func calcSharpe(pnls []float64) float64 {
	if len(pnls) < 2 {
		return 0
	}
	mean := 0.0
	for _, p := range pnls {
		mean += p
	}
	mean /= float64(len(pnls))
	variance := 0.0
	for _, p := range pnls {
		variance += (p - mean) * (p - mean)
	}
	variance /= float64(len(pnls) - 1)
	stdDev := math.Sqrt(variance)
	if stdDev == 0 {
		return 0
	}
	return (mean / stdDev) * math.Sqrt(252)
}

func buildBacktestSummary(results []ScalpStrategyResult) BacktestSummary {
	if len(results) == 0 {
		return BacktestSummary{}
	}

	bestWR := results[0]
	bestPF := results[0]
	bestNPnL := results[0]
	totalTrades := 0
	totalWins := 0

	for _, r := range results {
		totalTrades += r.TotalTrades
		totalWins += r.WinningTrades
		if r.WinRate > bestWR.WinRate {
			bestWR = r
		}
		if r.ProfitFactor > bestPF.ProfitFactor {
			bestPF = r
		}
		if r.NetPnLPct > bestNPnL.NetPnLPct {
			bestNPnL = r
		}
	}

	overallWR := 0.0
	if totalTrades > 0 {
		overallWR = roundPct(float64(totalWins) / float64(totalTrades) * 100)
	}

	rec := ""
	if bestWR.WinRate >= 75 {
		rec = "HIGH CONFIDENCE — " + bestWR.StrategyName + " shows " + ftoa(bestWR.WinRate) + "% win rate over 5 years. Recommend as primary scalping strategy for NIFTY."
	} else if bestWR.WinRate >= 65 {
		rec = "MODERATE CONFIDENCE — " + bestWR.StrategyName + " leads with " + ftoa(bestWR.WinRate) + "% win rate. Combine with volume confirmation for higher success."
	} else {
		rec = "USE WITH CAUTION — Best strategy (" + bestWR.StrategyName + ") shows " + ftoa(bestWR.WinRate) + "% win rate. Market may be in a difficult period for technical scalping."
	}

	return BacktestSummary{
		BestWinRate:       bestWR.StrategyName,
		BestWinRateValue:  bestWR.WinRate,
		BestProfitFactor:  bestPF.StrategyName,
		BestProfitFactorV: bestPF.ProfitFactor,
		BestNetPnL:        bestNPnL.StrategyName,
		BestNetPnLValue:   bestNPnL.NetPnLPct,
		OverallWinRate:    overallWR,
		TotalSignals:      totalTrades,
		Recommendation:    rec,
	}
}

func roundPct(v float64) float64 {
	if math.IsInf(v, 0) || math.IsNaN(v) {
		return 0
	}
	return math.Round(v*100) / 100
}

// SanitizeBacktestReport replaces all Inf/NaN float64 values with 0
// to prevent JSON marshaling failures.
func SanitizeBacktestReport(r *ScalpBacktestReport) {
	if r == nil {
		return
	}
	san := func(v *float64) {
		if math.IsInf(*v, 0) || math.IsNaN(*v) {
			*v = 0
		}
	}
	for i := range r.Strategies {
		s := &r.Strategies[i]
		san(&s.WinRate)
		san(&s.AvgWinPct)
		san(&s.AvgLossPct)
		san(&s.ProfitFactor)
		san(&s.MaxDrawdownPct)
		san(&s.NetPnLPct)
		san(&s.SharpeRatio)
		san(&s.ExpectancyPct)
		san(&s.BestTradePct)
		san(&s.WorstTradePct)
		san(&s.AvgTradesPerMonth)
		for j := range s.YearlyBreakdown {
			san(&s.YearlyBreakdown[j].WinRate)
			san(&s.YearlyBreakdown[j].NetPnLPct)
			san(&s.YearlyBreakdown[j].ProfitFactor)
		}
		for j := range s.RecentTrades {
			san(&s.RecentTrades[j].EntryPrice)
			san(&s.RecentTrades[j].ExitPrice)
			san(&s.RecentTrades[j].PnLPct)
		}
	}
	san(&r.Summary.BestWinRateValue)
	san(&r.Summary.BestProfitFactorV)
	san(&r.Summary.BestNetPnLValue)
	san(&r.Summary.OverallWinRate)
}

func ftoa(f float64) string {
	return fmt.Sprintf("%.1f%%", f)
}

