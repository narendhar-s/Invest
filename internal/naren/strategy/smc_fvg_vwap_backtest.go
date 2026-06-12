package strategy

// ═══════════════════════════════════════════════════════════════════════════
//  SMC + FVG + VWAP  MULTI-TIMEFRAME OPTIONS BACKTEST
//
//  Strategy pipeline (simulated with daily bars):
//    1. HTF CONTEXT  (15-min proxy: last 20 bars)
//       • Market structure: HH+HL = BULL  |  LH+LL = BEAR
//    2. VWAP FILTER  (20-bar volume-weighted average price)
//       • BULL only when close > VWAP;  BEAR only when close < VWAP
//    3. FVG DETECTION  (3-candle imbalance in last 8 bars)
//       • Bullish FVG: high[i-2] < low[i]
//       • Bearish FVG: low[i-2]  > high[i]
//       • Gap must be unfilled at signal bar
//    4. ENTRY TRIGGER  (5-min proxy: next-bar retest)
//       • Bar must touch FVG zone AND close on the correct side
//    5. OPTIONS SIMULATION  (ATM weekly CE / PE)
//       • Target hit  → +55 % premium gain
//       • Stop hit    → –32 % premium loss
//       • EOD         → spot % × delta × leverage factor
//
//  Risk config: target = 1.8×ATR, stop = 0.6×ATR  (3:1 R:R on spot)
// ═══════════════════════════════════════════════════════════════════════════

import (
	"fmt"
	"math"
	"sort"
	"time"

	"stockwise/internal/naren/storage"
)

// ─── Types ────────────────────────────────────────────────────────────────────

type SMCFVGVWAPTrade struct {
	Date         time.Time `json:"date"`
	Direction    string    `json:"direction"`    // BULL | BEAR
	OptionType   string    `json:"option_type"`  // CE | PE
	SpotEntry    float64   `json:"spot_entry"`
	SpotTarget   float64   `json:"spot_target"`
	SpotStop     float64   `json:"spot_stop"`
	SpotExit     float64   `json:"spot_exit"`
	SpotPnLPct   float64   `json:"spot_pnl_pct"`
	OptionPnLPct float64   `json:"option_pnl_pct"`
	ExitReason   string    `json:"exit_reason"` // TARGET | STOP | EOD
	FVGLow       float64   `json:"fvg_low"`
	FVGHigh      float64   `json:"fvg_high"`
	FVGMid       float64   `json:"fvg_mid"`
	VWAPLevel    float64   `json:"vwap_level"`
	HTFBias      string    `json:"htf_bias"`
	ATR          float64   `json:"atr"`
	Confluence   int       `json:"confluence"` // 1-3
	IsWin        bool      `json:"is_win"`
}

type SMCFVGVWAPDirectionStats struct {
	Trades  int     `json:"trades"`
	Wins    int     `json:"wins"`
	WinRate float64 `json:"win_rate"`
	AvgPnL  float64 `json:"avg_pnl_pct"`
}

type SMCFVGVWAPYearlyResult struct {
	Year         int     `json:"year"`
	Trades       int     `json:"trades"`
	WinRate      float64 `json:"win_rate"`
	OptionNetPnL float64 `json:"option_net_pnl_pct"`
	ProfitFactor float64 `json:"profit_factor"`
	MaxDD        float64 `json:"max_drawdown_pct"`
}

type SMCFVGVWAPBacktestResult struct {
	Symbol              string                              `json:"symbol"`
	SymbolName          string                              `json:"symbol_name"`
	PeriodYears         int                                 `json:"period_years"`
	GeneratedAt         string                              `json:"generated_at"`
	TotalBars           int                                 `json:"total_bars"`
	TotalTrades         int                                 `json:"total_trades"`
	WinningTrades       int                                 `json:"winning_trades"`
	LosingTrades        int                                 `json:"losing_trades"`
	WinRate             float64                             `json:"win_rate"`
	AvgWinPct           float64                             `json:"avg_win_pct"`
	AvgLossPct          float64                             `json:"avg_loss_pct"`
	ProfitFactor        float64                             `json:"profit_factor"`
	MaxDrawdownPct      float64                             `json:"max_drawdown_pct"`
	SharpeRatio         float64                             `json:"sharpe_ratio"`
	OptionNetPnLPct     float64                             `json:"option_net_pnl_pct"`
	BestTradePct        float64                             `json:"best_trade_pct"`
	WorstTradePct       float64                             `json:"worst_trade_pct"`
	AvgTradesPerMonth   float64                             `json:"avg_trades_per_month"`
	AvgConfluence       float64                             `json:"avg_confluence"`
	ByExitReason        map[string]int                      `json:"by_exit_reason"`
	ByDirection         map[string]SMCFVGVWAPDirectionStats `json:"by_direction"`
	YearlyBreakdown     []SMCFVGVWAPYearlyResult            `json:"yearly_breakdown"`
	RecentTrades        []SMCFVGVWAPTrade                   `json:"recent_trades"`
	StrategyDescription string                              `json:"strategy_description"`
	Recommendation      string                              `json:"recommendation"`
}

// ─── Config ───────────────────────────────────────────────────────────────────

type smcFVGConfig struct {
	htfLookback   int
	vwapLookback  int
	fvgLookback   int
	swingLB       int
	targetATRMult float64
	stopATRMult   float64
	minFVGSizePct float64
	optionWinPct  float64
	optionLossPct float64
	optionDelta   float64
	eodLeverage   float64
}

var defaultSMCFVGConfig = smcFVGConfig{
	htfLookback:   20,
	vwapLookback:  20,
	fvgLookback:   8,
	swingLB:       3,
	targetATRMult: 1.8,
	stopATRMult:   0.6,
	minFVGSizePct: 0.001, // 0.1% of price minimum gap
	optionWinPct:  55.0,
	optionLossPct: 32.0,
	optionDelta:   0.50,
	eodLeverage:   2.5,
}

// ─── Engine entry point ───────────────────────────────────────────────────────

func (e *Engine) RunSMCFVGVWAPBacktest(years int) (*SMCFVGVWAPBacktestResult, error) {
	stock, err := e.repo.GetStockBySymbol("^NSEI")
	if err != nil {
		stock, err = e.repo.GetStockBySymbol("NIFTY 50")
		if err != nil {
			return nil, err
		}
	}
	to := time.Now()
	from := to.AddDate(-years, 0, 0)
	bars, err := e.repo.GetPriceBars(stock.ID, from, to)
	if err != nil {
		return nil, err
	}
	if len(bars) < 60 {
		return nil, fmt.Errorf("insufficient data: need ≥60 bars, got %d", len(bars))
	}
	result := runSMCFVGVWAPBacktest(bars, years)
	result.Symbol = "^NSEI"
	result.SymbolName = stock.Name
	return result, nil
}

// ─── Core backtest ────────────────────────────────────────────────────────────

func runSMCFVGVWAPBacktest(bars []storage.PriceBar, years int) *SMCFVGVWAPBacktestResult {
	cfg := defaultSMCFVGConfig
	minIdx := cfg.htfLookback + cfg.fvgLookback + cfg.swingLB + 5

	var trades []SMCFVGVWAPTrade
	yearMap := map[int]*SMCFVGVWAPYearlyResult{}
	cooldown := -10

	for i := minIdx; i < len(bars)-1; i++ {
		// Enforce 1-bar cooldown between trades (one trade per day max)
		if i-cooldown < 2 {
			continue
		}

		// ── Step 1: HTF bias ──────────────────────────────────────────────
		bias := computeHTFBias(bars, i)
		if bias == "NEUTRAL" {
			continue
		}

		// ── Step 2: VWAP filter ───────────────────────────────────────────
		vwap := computeRollingVWAP(bars, i, cfg.vwapLookback)
		vwapAligned := (bias == "BULL" && bars[i].Close > vwap) ||
			(bias == "BEAR" && bars[i].Close < vwap)
		if !vwapAligned {
			continue
		}

		// ── Step 3: FVG detection ─────────────────────────────────────────
		flo, fhi, fidx := findFVGMTF(bars, i, bias, cfg.fvgLookback)
		if fidx == -1 {
			continue
		}
		fvgSize := (fhi - flo) / bars[i].Close
		if fvgSize < cfg.minFVGSizePct {
			continue
		}

		// ── Step 4: 5-min entry trigger — next bar retests FVG ────────────
		nb := bars[i+1]
		if !fvgRetest(nb, flo, fhi, bias) {
			continue
		}

		// ── Step 5: Simulate trade ────────────────────────────────────────
		atr := dailyATRPct(bars, i, 14) * bars[i].Close
		if atr <= 0 {
			continue
		}
		fvgMid := (flo + fhi) / 2
		entry := fvgMid

		var target, stop float64
		var direction, optionType string

		if bias == "BULL" {
			target = entry + atr*cfg.targetATRMult
			stop = entry - atr*cfg.stopATRMult
			direction = "BULL"
			optionType = "CE"
		} else {
			target = entry - atr*cfg.targetATRMult
			stop = entry + atr*cfg.stopATRMult
			direction = "BEAR"
			optionType = "PE"
		}

		var exitPrice, spotPnl, optionPnl float64
		var exitReason string

		if direction == "BULL" {
			if nb.High >= target {
				exitPrice = target
				exitReason = "TARGET"
				spotPnl = (target - entry) / entry * 100
				optionPnl = cfg.optionWinPct
			} else if nb.Low <= stop {
				exitPrice = stop
				exitReason = "STOP"
				spotPnl = (stop - entry) / entry * 100
				optionPnl = -cfg.optionLossPct
			} else {
				exitPrice = nb.Close
				exitReason = "EOD"
				spotPnl = (nb.Close - entry) / entry * 100
				optionPnl = spotPnl * cfg.optionDelta * cfg.eodLeverage
			}
		} else {
			if nb.Low <= target {
				exitPrice = target
				exitReason = "TARGET"
				spotPnl = (entry - target) / entry * 100
				optionPnl = cfg.optionWinPct
			} else if nb.High >= stop {
				exitPrice = stop
				exitReason = "STOP"
				spotPnl = (entry - stop) / entry * 100
				optionPnl = -cfg.optionLossPct
			} else {
				exitPrice = nb.Close
				exitReason = "EOD"
				spotPnl = (entry - nb.Close) / entry * 100
				optionPnl = spotPnl * cfg.optionDelta * cfg.eodLeverage
			}
		}

		// Confluence: SMC structure (1) + VWAP (1) + FVG (1) = 3 max
		confluence := 3

		t := SMCFVGVWAPTrade{
			Date:         bars[i].Date,
			Direction:    direction,
			OptionType:   optionType,
			SpotEntry:    r2(entry),
			SpotTarget:   r2(target),
			SpotStop:     r2(stop),
			SpotExit:     r2(exitPrice),
			SpotPnLPct:   r2(spotPnl),
			OptionPnLPct: r2(optionPnl),
			ExitReason:   exitReason,
			FVGLow:       r2(flo),
			FVGHigh:      r2(fhi),
			FVGMid:       r2(fvgMid),
			VWAPLevel:    r2(vwap),
			HTFBias:      bias,
			ATR:          r2(atr),
			Confluence:   confluence,
			IsWin:        optionPnl > 0,
		}
		trades = append(trades, t)

		yr := bars[i].Date.Year()
		if _, ok := yearMap[yr]; !ok {
			yearMap[yr] = &SMCFVGVWAPYearlyResult{Year: yr}
		}
		yd := yearMap[yr]
		yd.Trades++
		yd.OptionNetPnL += optionPnl
		if t.IsWin {
			yd.WinRate++
		}

		cooldown = i
	}

	return buildSMCFVGVWAPResult(trades, yearMap, bars, years)
}

// ─── Result aggregation ───────────────────────────────────────────────────────

func buildSMCFVGVWAPResult(
	trades []SMCFVGVWAPTrade,
	yearMap map[int]*SMCFVGVWAPYearlyResult,
	bars []storage.PriceBar,
	years int,
) *SMCFVGVWAPBacktestResult {

	res := &SMCFVGVWAPBacktestResult{
		PeriodYears:  years,
		GeneratedAt:  time.Now().Format(time.RFC3339),
		TotalBars:    len(bars),
		TotalTrades:  len(trades),
		ByExitReason: map[string]int{},
		ByDirection:  map[string]SMCFVGVWAPDirectionStats{},
		StrategyDescription: "15-min SMC market structure (HH+HL/LH+LL) → " +
			"VWAP alignment → FVG zone detection → 5-min retest entry → " +
			"ATM weekly options buying (CE for BULL / PE for BEAR). " +
			"Target: 1.8×ATR | Stop: 0.6×ATR | Options: +55% win / –32% loss.",
	}

	if len(trades) == 0 {
		res.Recommendation = "No qualifying setups found in the selected period."
		return res
	}

	var pnls []float64
	grossWin, grossLoss := 0.0, 0.0
	totalConf := 0
	dirMap := map[string]SMCFVGVWAPDirectionStats{}
	best, worst := -math.MaxFloat64, math.MaxFloat64

	for _, t := range trades {
		pnls = append(pnls, t.OptionPnLPct)
		res.ByExitReason[t.ExitReason]++
		totalConf += t.Confluence
		res.OptionNetPnLPct += t.OptionPnLPct

		ds := dirMap[t.Direction]
		ds.Trades++
		ds.AvgPnL += t.OptionPnLPct
		if t.IsWin {
			res.WinningTrades++
			grossWin += t.OptionPnLPct
			ds.Wins++
			if t.OptionPnLPct > best {
				best = t.OptionPnLPct
			}
		} else {
			res.LosingTrades++
			grossLoss += math.Abs(t.OptionPnLPct)
			if t.OptionPnLPct < worst {
				worst = t.OptionPnLPct
			}
		}
		dirMap[t.Direction] = ds
	}

	res.WinRate = r2(float64(res.WinningTrades) / float64(res.TotalTrades) * 100)
	if res.WinningTrades > 0 {
		res.AvgWinPct = r2(grossWin / float64(res.WinningTrades))
	}
	if res.LosingTrades > 0 {
		res.AvgLossPct = r2(grossLoss / float64(res.LosingTrades))
	}
	if grossLoss > 0 {
		res.ProfitFactor = r2(grossWin / grossLoss)
	}
	res.OptionNetPnLPct = r2(res.OptionNetPnLPct)
	res.MaxDrawdownPct = r2(calcMaxDD(pnls))
	res.SharpeRatio = r2(calcSharpe(pnls))
	res.BestTradePct = r2(best)
	if worst < math.MaxFloat64 {
		res.WorstTradePct = r2(worst)
	}
	res.AvgConfluence = r2(float64(totalConf) / float64(res.TotalTrades))

	// Monthly rate
	months := float64(years) * 12
	if months > 0 {
		res.AvgTradesPerMonth = r2(float64(res.TotalTrades) / months)
	}

	// Direction stats
	for dir, ds := range dirMap {
		if ds.Trades > 0 {
			ds.WinRate = r2(float64(ds.Wins) / float64(ds.Trades) * 100)
			ds.AvgPnL = r2(ds.AvgPnL / float64(ds.Trades))
		}
		res.ByDirection[dir] = ds
	}

	// Yearly breakdown
	for _, yd := range yearMap {
		if yd.Trades > 0 {
			wins := yd.WinRate // currently a count
			yd.WinRate = r2(wins / float64(yd.Trades) * 100)
			yd.OptionNetPnL = r2(yd.OptionNetPnL)
			// per-year drawdown
			var yPnls []float64
			for _, t := range trades {
				if t.Date.Year() == yd.Year {
					yPnls = append(yPnls, t.OptionPnLPct)
				}
			}
			yd.MaxDD = r2(calcMaxDD(yPnls))
			// per-year PF
			gw, gl := 0.0, 0.0
			for _, t := range trades {
				if t.Date.Year() == yd.Year {
					if t.IsWin {
						gw += t.OptionPnLPct
					} else {
						gl += math.Abs(t.OptionPnLPct)
					}
				}
			}
			if gl > 0 {
				yd.ProfitFactor = r2(gw / gl)
			}
		}
		res.YearlyBreakdown = append(res.YearlyBreakdown, *yd)
	}
	sort.Slice(res.YearlyBreakdown, func(i, j int) bool {
		return res.YearlyBreakdown[i].Year < res.YearlyBreakdown[j].Year
	})

	// Last 25 trades
	start := 0
	if len(trades) > 25 {
		start = len(trades) - 25
	}
	res.RecentTrades = trades[start:]

	res.Recommendation = buildSMCFVGVWAPRecommendation(res)
	return res
}

func buildSMCFVGVWAPRecommendation(r *SMCFVGVWAPBacktestResult) string {
	switch {
	case r.WinRate >= 70 && r.ProfitFactor >= 2.5:
		return fmt.Sprintf("HIGH CONFIDENCE — %.1f%% win rate with %.2f profit factor over %d years. "+
			"SMC+FVG+VWAP confluence is a robust edge for options buying. Use strict risk rules: "+
			"max 2 trades/day, stop at 2 consecutive losses.", r.WinRate, r.ProfitFactor, r.PeriodYears)
	case r.WinRate >= 60 && r.ProfitFactor >= 1.5:
		return fmt.Sprintf("MODERATE CONFIDENCE — %.1f%% win rate, %.2f PF. Edge exists but "+
			"requires discipline. Only trade A+ setups where all 3 factors align perfectly. "+
			"Avoid low-confluence trades.", r.WinRate, r.ProfitFactor)
	default:
		return fmt.Sprintf("USE WITH CAUTION — %.1f%% win rate, %.2f PF. Strategy needs refinement. "+
			"Consider adding volume confirmation or restricting to killzone sessions "+
			"(09:15-10:00, 11:30-12:30, 14:30-15:00).", r.WinRate, r.ProfitFactor)
	}
}

// ─── Indicators ───────────────────────────────────────────────────────────────

// computeRollingVWAP computes volume-weighted average price over the last N bars.
func computeRollingVWAP(bars []storage.PriceBar, endIdx, period int) float64 {
	start := endIdx - period + 1
	if start < 0 {
		start = 0
	}
	sumTPV, sumVol := 0.0, 0.0
	for i := start; i <= endIdx; i++ {
		tp := (bars[i].High + bars[i].Low + bars[i].Close) / 3
		vol := float64(bars[i].Volume)
		sumTPV += tp * vol
		sumVol += vol
	}
	if sumVol == 0 {
		tp := (bars[endIdx].High + bars[endIdx].Low + bars[endIdx].Close) / 3
		return tp
	}
	return sumTPV / sumVol
}

// findFVGMTF finds the most recent unfilled FVG within maxLB bars.
func findFVGMTF(bars []storage.PriceBar, end int, direction string, maxLB int) (lo, hi float64, idx int) {
	for j := end; j > end-maxLB && j >= 2; j-- {
		if direction == "BULL" && bars[j-2].High < bars[j].Low {
			flo := bars[j-2].High
			fhi := bars[j].Low
			filled := false
			for k := j + 1; k <= end; k++ {
				if bars[k].Low <= flo {
					filled = true
					break
				}
			}
			if !filled {
				return flo, fhi, j
			}
		}
		if direction == "BEAR" && bars[j-2].Low > bars[j].High {
			fhi := bars[j-2].Low
			flo := bars[j].High
			filled := false
			for k := j + 1; k <= end; k++ {
				if bars[k].High >= fhi {
					filled = true
					break
				}
			}
			if !filled {
				return flo, fhi, j
			}
		}
	}
	return 0, 0, -1
}

// fvgRetest checks if the bar's range touches the FVG zone and closes on the correct side.
func fvgRetest(nb storage.PriceBar, flo, fhi float64, dir string) bool {
	if dir == "BULL" {
		// Bar low dips into FVG and close is above FVG low (bullish rejection)
		return nb.Low <= fhi && nb.Close >= flo
	}
	// Bar high reaches into FVG and close is below FVG high (bearish rejection)
	return nb.High >= flo && nb.Close <= fhi
}

// sanR2 rounds to 2 decimal places and sanitizes NaN/Inf.
func sanR2(v float64) float64 {
	if math.IsInf(v, 0) || math.IsNaN(v) {
		return 0
	}
	return math.Round(v*100) / 100
}
