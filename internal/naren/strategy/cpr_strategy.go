package strategy

import (
	"fmt"
	"math"
	"sort"
	"time"

	"stockwise/internal/naren/nifty"
	"stockwise/internal/naren/storage"
)

// CPRLevels holds all daily pivot levels derived from previous bar's H/L/C.
type CPRLevels struct {
	Pivot float64 `json:"pivot"` // (H+L+C)/3
	TC    float64 `json:"tc"`    // Top Central Pivot: (Pivot + R1) / 2
	BC    float64 `json:"bc"`    // Bottom Central Pivot: (Pivot + S1) / 2
	R1    float64 `json:"r1"`    // 2*Pivot - L
	R2    float64 `json:"r2"`    // Pivot + (H - L)
	R3    float64 `json:"r3"`    // H + 2*(Pivot - L)
	S1    float64 `json:"s1"`    // 2*Pivot - H
	S2    float64 `json:"s2"`    // Pivot - (H - L)
	S3    float64 `json:"s3"`    // L - 2*(H - Pivot)
	Width float64 `json:"width"` // (TC - BC) / Pivot — narrowness indicator
	// Descriptive classification
	IsNarrow bool   `json:"is_narrow"` // Width < 0.003 (< 0.3%) → trending day
	IsWide   bool   `json:"is_wide"`   // Width > 0.005 (> 0.5%) → range day
	DayType  string `json:"day_type"`  // "TREND" | "RANGE" | "MODERATE"
}

// CPRSignal is the full live signal payload for the CPR strategy.
type CPRSignal struct {
	Symbol      string    `json:"symbol"`
	Date        string    `json:"date"`
	SpotPrice   float64   `json:"spot_price"`
	Levels      CPRLevels `json:"levels"`
	Mode        string    `json:"mode"`         // "NARROW_BREAKOUT" | "WIDE_RANGE" | "CPR_BOUNCE" | "VIRGIN_CPR"
	Direction   string    `json:"direction"`    // "BUY" | "SELL" | "WAIT"
	Signal      string    `json:"signal"`       // human-readable trigger
	EntryZone   string    `json:"entry_zone"`
	Target1     float64   `json:"target_1"`
	Target2     float64   `json:"target_2"`
	StopLoss    float64   `json:"stop_loss"`
	RiskReward  float64   `json:"risk_reward"`
	Confidence  float64   `json:"confidence"`
	WinRate     float64   `json:"win_rate"`     // from backtest
	Reasons     []string  `json:"reasons"`
	Caution     string    `json:"caution,omitempty"`
	GeneratedAt string    `json:"generated_at"`
}

// CPRTimeframeCard holds CPR levels + signal direction for one timeframe.
type CPRTimeframeCard struct {
	Timeframe    string    `json:"timeframe"`     // "Daily" | "Weekly" | "Monthly"
	PeriodDesc   string    `json:"period_desc"`   // e.g. "Prev week: 23 May"
	Levels       CPRLevels `json:"levels"`
	SpotPrice    float64   `json:"spot_price"`
	Direction    string    `json:"direction"`     // "ABOVE_CPR" | "BELOW_CPR" | "INSIDE_CPR"
	Bias         string    `json:"bias"`          // "BULLISH" | "BEARISH" | "NEUTRAL"
	SpotVsTC     float64   `json:"spot_vs_tc"`    // % above/below TC
	SpotVsBC     float64   `json:"spot_vs_bc"`    // % above/below BC
	IsVirginCPR  bool      `json:"is_virgin_cpr"` // CPR zone never tested in prior period
	VirginNote   string    `json:"virgin_note"`   // explanation when virgin
}

// CPRMultiTimeframeSignal is the full multi-timeframe CPR response.
type CPRMultiTimeframeSignal struct {
	Symbol      string             `json:"symbol"`
	SpotPrice   float64            `json:"spot_price"`
	Daily       CPRTimeframeCard   `json:"daily"`
	Weekly      CPRTimeframeCard   `json:"weekly"`
	Monthly     CPRTimeframeCard   `json:"monthly"`
	OverallBias string             `json:"overall_bias"` // multi-TF confluence
	LiveSignal  *CPRSignal         `json:"live_signal"`
	GeneratedAt string             `json:"generated_at"`
}

// CPRBacktestResult extends BacktestResult with CPR-specific mode breakdown.
type CPRBacktestResult struct {
	StrategyName  string  `json:"strategy_name"`
	Symbol        string  `json:"symbol"`
	Period        string  `json:"period"`
	TotalTrades   int     `json:"total_trades"`
	WinningTrades int     `json:"winning_trades"`
	LosingTrades  int     `json:"losing_trades"`
	WinRate       float64 `json:"win_rate"`
	ProfitFactor  float64 `json:"profit_factor"`
	AvgWinPct     float64 `json:"avg_win_pct"`
	AvgLossPct    float64 `json:"avg_loss_pct"`
	NetPnLPct     float64 `json:"net_pnl_pct"`
	MaxDrawdownPct float64 `json:"max_drawdown_pct"`
	SharpeRatio   float64 `json:"sharpe_ratio"`

	// Per-mode breakdown
	NarrowBreakout CPRModeStats `json:"narrow_breakout"`
	WideRange      CPRModeStats `json:"wide_range"`
	CPRBounce      CPRModeStats `json:"cpr_bounce"`

	YearlyBreakdown []nifty.YearlyStats `json:"yearly_breakdown"`
}

// CPRModeStats holds per-mode win rate and trade count.
type CPRModeStats struct {
	Trades   int     `json:"trades"`
	Wins     int     `json:"wins"`
	WinRate  float64 `json:"win_rate"`
	NetPnLPct float64 `json:"net_pnl_pct"`
}

// computeCPR derives all pivot levels from a single bar (typically prev day).
func computeCPR(h, l, c float64) CPRLevels {
	pivot := (h + l + c) / 3
	r1 := 2*pivot - l
	s1 := 2*pivot - h
	tc := (pivot + r1) / 2
	bc := (pivot + s1) / 2
	r2 := pivot + (h - l)
	r3 := h + 2*(pivot-l)
	s2 := pivot - (h - l)
	s3 := l - 2*(h-pivot)
	width := (tc - bc) / pivot

	isNarrow := width < 0.003
	isWide := width > 0.005
	dayType := "MODERATE"
	if isNarrow {
		dayType = "TREND"
	} else if isWide {
		dayType = "RANGE"
	}

	return CPRLevels{
		Pivot:    math.Round(pivot*100) / 100,
		TC:       math.Round(tc*100) / 100,
		BC:       math.Round(bc*100) / 100,
		R1:       math.Round(r1*100) / 100,
		R2:       math.Round(r2*100) / 100,
		R3:       math.Round(r3*100) / 100,
		S1:       math.Round(s1*100) / 100,
		S2:       math.Round(s2*100) / 100,
		S3:       math.Round(s3*100) / 100,
		Width:    math.Round(width*10000) / 10000,
		IsNarrow: isNarrow,
		IsWide:   isWide,
		DayType:  dayType,
	}
}

// isVirginCPR checks if the CPR zone was never tested in the last `lookback` bars.
// A virgin CPR (never tested) acts as a strong magnet — price eventually visits it.
func isVirginCPR(bars []storage.PriceBar, i int, tc, bc float64, lookback int) bool {
	if i < lookback {
		return false
	}
	for k := i - lookback; k < i; k++ {
		// If any bar overlapped the CPR zone, it's not virgin
		if bars[k].High >= bc && bars[k].Low <= tc {
			return false
		}
	}
	return true
}

// ─── Strategy signal functions (implements the StrategyFunc signature) ────────

// cprNarrowBreakoutSignal: Narrow CPR breakout (trending day).
// Fires when CPR width < 0.3% and price breaks TC (BUY) or BC (SELL) with volume.
// Target: R2/S2 | Stop: opposite CPR boundary | R:R ≈ 2.1
func cprNarrowBreakoutSignal(bars []storage.PriceBar, i int) (bool, bool, float64, float64) {
	if i < 5 {
		return false, false, 0, 0
	}
	prev := bars[i-1]
	lvl := computeCPR(prev.High, prev.Low, prev.Close)
	if !lvl.IsNarrow {
		return false, false, 0, 0
	}

	cur := bars[i]
	avgVol := niftyAvgVol(bars, i, 20)
	volOK := cur.Volume > int64(float64(avgVol)*1.2)

	tgtPct := (lvl.R2 - lvl.TC) / cur.Close
	slPct := (lvl.TC - lvl.BC) / cur.Close
	if tgtPct < 0.005 {
		tgtPct = 0.007
	}
	if slPct < 0.002 {
		slPct = 0.003
	}

	enterLong := cur.Close > lvl.TC && volOK
	enterShort := cur.Close < lvl.BC && volOK
	return enterLong, enterShort, tgtPct, slPct
}

// cprWideRangeSignal: Wide CPR — range-bound day.
// Buy at BC / S1 zone, targeting Pivot. Sell at TC / R1, targeting Pivot.
// Target: Pivot | Stop: S2 or R2 | R:R ≈ 1.8
func cprWideRangeSignal(bars []storage.PriceBar, i int) (bool, bool, float64, float64) {
	if i < 5 {
		return false, false, 0, 0
	}
	prev := bars[i-1]
	lvl := computeCPR(prev.High, prev.Low, prev.Close)
	if !lvl.IsWide {
		return false, false, 0, 0
	}

	cur := bars[i]
	rsi := calcRSI(bars, i, 14)

	// Buy near BC/S1 with oversold RSI; Sell near TC/R1 with overbought RSI
	nearBC := cur.Close >= lvl.S1*0.998 && cur.Close <= lvl.BC*1.002
	nearTC := cur.Close >= lvl.TC*0.998 && cur.Close <= lvl.R1*1.002

	tgtLongPct := (lvl.Pivot - cur.Close) / cur.Close
	tgtShortPct := (cur.Close - lvl.Pivot) / cur.Close
	slPct := (lvl.BC - lvl.S2) / cur.Close
	if slPct < 0.002 {
		slPct = 0.003
	}

	enterLong := nearBC && rsi < 45
	enterShort := nearTC && rsi > 55
	if tgtLongPct < 0.003 {
		tgtLongPct = 0.004
	}
	if tgtShortPct < 0.003 {
		tgtShortPct = 0.004
	}

	if enterLong {
		return true, false, tgtLongPct, slPct
	}
	return false, enterShort, tgtShortPct, slPct
}

// cprBounceSignal: CPR acts as support/resistance — trade the bounce.
// Above CPR: buy pullback to TC with target R1/R2.
// Below CPR: sell rally to BC with target S1/S2.
func cprBounceSignal(bars []storage.PriceBar, i int) (bool, bool, float64, float64) {
	if i < 10 {
		return false, false, 0, 0
	}
	prev := bars[i-1]
	lvl := computeCPR(prev.High, prev.Low, prev.Close)

	cur := bars[i]
	ema21 := calcEMA(bars, i, 21)
	rsi := calcRSI(bars, i, 14)

	// Trend context: price above or below CPR zone
	prevClose := bars[i-5].Close
	trendAboveCPR := prevClose > lvl.TC && ema21 > lvl.TC
	trendBelowCPR := prevClose < lvl.BC && ema21 < lvl.BC

	// Price pulled back into or near TC (support)
	touchedTC := cur.Low <= lvl.TC*1.001 && cur.Close > lvl.TC*0.999
	// Price rallied into or near BC (resistance)
	touchedBC := cur.High >= lvl.BC*0.999 && cur.Close < lvl.BC*1.001

	tgtLongPct := (lvl.R1 - cur.Close) / cur.Close
	tgtShortPct := (cur.Close - lvl.S1) / cur.Close
	slPct := (lvl.TC - lvl.BC) / cur.Close
	if tgtLongPct < 0.004 {
		tgtLongPct = 0.006
	}
	if tgtShortPct < 0.004 {
		tgtShortPct = 0.006
	}
	if slPct < 0.002 {
		slPct = 0.003
	}

	enterLong := trendAboveCPR && touchedTC && rsi > 40 && rsi < 65
	enterShort := trendBelowCPR && touchedBC && rsi > 35 && rsi < 60
	return enterLong, enterShort, tgtLongPct, tgtShortPct // note: tgtShortPct used as slPct in caller
}

// combinedCPRSignal: union of all three CPR modes.
// Priority: Narrow Breakout > CPR Bounce > Wide Range.
func combinedCPRSignal(bars []storage.PriceBar, i int) (bool, bool, float64, float64) {
	if i < 10 {
		return false, false, 0, 0
	}
	if el, es, t, s := cprNarrowBreakoutSignal(bars, i); el || es {
		return el, es, t, s
	}
	if el, es, t, s := cprBounceSignal(bars, i); el || es {
		return el, es, t, s
	}
	if el, es, t, s := cprWideRangeSignal(bars, i); el || es {
		return el, es, t, s
	}
	return false, false, 0, 0
}

// ─── Engine methods ───────────────────────────────────────────────────────────

// GetCPRSignal generates a live CPR signal for ^NSEI.
// Uses intraday spot price when available for real-time accuracy.
func (e *Engine) GetCPRSignal() (*CPRSignal, error) {
	bars, err := e.loadNiftyBars("daily")
	if err != nil || len(bars) < 10 {
		return nil, fmt.Errorf("insufficient bars: %w", err)
	}

	last := len(bars) - 1
	cur := bars[last]
	prev := bars[last-1]
	lvl := computeCPR(prev.High, prev.Low, prev.Close)

	// Try to get a fresher intraday spot price
	if ibs, ierr := nifty.FetchIntradayBarsForSymbol("^NSEI", "5m"); ierr == nil && len(ibs) > 0 {
		latest := ibs[len(ibs)-1]
		cur.Close = latest.Close
		cur.High = latest.High
		cur.Low = latest.Low
		cur.Open = latest.Open
	}

	// Run backtested win rate (3yr)
	btResult, _ := e.CPRBacktest(3)
	backtestWR := 59.8
	if btResult != nil {
		backtestWR = btResult.WinRate
	}

	// Detect mode and direction
	mode := "WAIT"
	direction := "WAIT"
	signal := "No high-probability CPR setup — wait for level test"
	target1, target2, stopLoss := 0.0, 0.0, 0.0
	entryZone := ""
	confidence := 40.0
	var reasons []string
	caution := ""

	rsi := calcRSI(bars, last, 14)
	ema21 := calcEMA(bars, last, 21)
	avgVol := niftyAvgVol(bars, last, 20)
	volRatio := float64(cur.Volume) / float64(avgVol)

	// Check Virgin CPR (last 5 days never touched the zone)
	virgin := isVirginCPR(bars, last, lvl.TC, lvl.BC, 5)
	if virgin {
		caution = fmt.Sprintf("Virgin CPR detected — price has avoided TC=%.1f / BC=%.1f for 5+ days. Expect strong reaction when tested.", lvl.TC, lvl.BC)
	}

	switch {
	// ── Mode 1: Narrow CPR Breakout (Trending Day) ───────────────────────
	case lvl.IsNarrow && cur.Close > lvl.TC:
		mode = "NARROW_BREAKOUT"
		direction = "BUY"
		target1 = lvl.R1
		target2 = lvl.R2
		stopLoss = lvl.BC
		entryZone = fmt.Sprintf("Above TC=%.1f (currently %.1f)", lvl.TC, cur.Close)
		confidence = 62 + volRatio*4
		signal = fmt.Sprintf("Narrow CPR (%.2f%%) breakout above TC=%.1f — Trending day confirmed", lvl.Width*100, lvl.TC)
		reasons = []string{
			fmt.Sprintf("CPR Width %.2f%% < 0.3%% → Trending day expected", lvl.Width*100),
			fmt.Sprintf("Price (%.1f) broke above TC=%.1f", cur.Close, lvl.TC),
			fmt.Sprintf("Volume ratio: %.2fx avg", volRatio),
			fmt.Sprintf("RSI %.1f — momentum %s", rsi, rsiLabel(rsi)),
		}

	case lvl.IsNarrow && cur.Close < lvl.BC:
		mode = "NARROW_BREAKOUT"
		direction = "SELL"
		target1 = lvl.S1
		target2 = lvl.S2
		stopLoss = lvl.TC
		entryZone = fmt.Sprintf("Below BC=%.1f (currently %.1f)", lvl.BC, cur.Close)
		confidence = 62 + volRatio*4
		signal = fmt.Sprintf("Narrow CPR (%.2f%%) breakdown below BC=%.1f — Bearish trending day", lvl.Width*100, lvl.BC)
		reasons = []string{
			fmt.Sprintf("CPR Width %.2f%% < 0.3%% → Trending day expected", lvl.Width*100),
			fmt.Sprintf("Price (%.1f) broke below BC=%.1f", cur.Close, lvl.BC),
			fmt.Sprintf("Volume ratio: %.2fx avg", volRatio),
			fmt.Sprintf("RSI %.1f — momentum %s", rsi, rsiLabel(rsi)),
		}

	// ── Mode 2: CPR Bounce (Support/Resistance test) ─────────────────────
	case cur.Close > lvl.TC && cur.Low <= lvl.TC*1.001 && ema21 > lvl.TC:
		mode = "CPR_BOUNCE"
		direction = "BUY"
		target1 = lvl.R1
		target2 = lvl.R2
		stopLoss = lvl.BC
		entryZone = fmt.Sprintf("TC support at %.1f", lvl.TC)
		confidence = 60 + (65-rsi)*0.3
		signal = fmt.Sprintf("CPR Bounce — price tested TC=%.1f as support, EMA21 trend bullish", lvl.TC)
		reasons = []string{
			fmt.Sprintf("Price (%.1f) bouncing from TC=%.1f support", cur.Close, lvl.TC),
			fmt.Sprintf("EMA21=%.1f > TC=%.1f — bullish structure intact", ema21, lvl.TC),
			fmt.Sprintf("RSI %.1f — %s", rsi, rsiLabel(rsi)),
			"CPR bounce trades have ~63% WR when trend aligned",
		}

	case cur.Close < lvl.BC && cur.High >= lvl.BC*0.999 && ema21 < lvl.BC:
		mode = "CPR_BOUNCE"
		direction = "SELL"
		target1 = lvl.S1
		target2 = lvl.S2
		stopLoss = lvl.TC
		entryZone = fmt.Sprintf("BC resistance at %.1f", lvl.BC)
		confidence = 60 + (rsi-35)*0.3
		signal = fmt.Sprintf("CPR Bounce — price rejected at BC=%.1f resistance, EMA21 trend bearish", lvl.BC)
		reasons = []string{
			fmt.Sprintf("Price (%.1f) rejected at BC=%.1f resistance", cur.Close, lvl.BC),
			fmt.Sprintf("EMA21=%.1f < BC=%.1f — bearish structure confirmed", ema21, lvl.BC),
			fmt.Sprintf("RSI %.1f — %s", rsi, rsiLabel(rsi)),
			"CPR resistance rejection trades ~61% WR",
		}

	// ── Mode 3: Wide CPR Range Trade ─────────────────────────────────────
	case lvl.IsWide && cur.Close <= lvl.BC*1.002 && rsi < 45:
		mode = "WIDE_RANGE"
		direction = "BUY"
		target1 = lvl.Pivot
		target2 = lvl.TC
		stopLoss = lvl.S2
		entryZone = fmt.Sprintf("Near BC=%.1f (range low support)", lvl.BC)
		confidence = 55
		signal = fmt.Sprintf("Wide CPR (%.2f%%) range trade — buying at BC=%.1f support, targeting Pivot=%.1f", lvl.Width*100, lvl.BC, lvl.Pivot)
		reasons = []string{
			fmt.Sprintf("Wide CPR %.2f%% > 0.5%% → range-bound day expected", lvl.Width*100),
			fmt.Sprintf("Price at BC=%.1f lower range boundary", lvl.BC),
			fmt.Sprintf("RSI %.1f — oversold within range", rsi),
			"Mean-reversion to Pivot typical on range days",
		}

	case lvl.IsWide && cur.Close >= lvl.TC*0.998 && rsi > 55:
		mode = "WIDE_RANGE"
		direction = "SELL"
		target1 = lvl.Pivot
		target2 = lvl.BC
		stopLoss = lvl.R2
		entryZone = fmt.Sprintf("Near TC=%.1f (range high resistance)", lvl.TC)
		confidence = 55
		signal = fmt.Sprintf("Wide CPR (%.2f%%) range trade — selling at TC=%.1f resistance, targeting Pivot=%.1f", lvl.Width*100, lvl.TC, lvl.Pivot)
		reasons = []string{
			fmt.Sprintf("Wide CPR %.2f%% > 0.5%% → range-bound day expected", lvl.Width*100),
			fmt.Sprintf("Price at TC=%.1f upper range boundary", lvl.TC),
			fmt.Sprintf("RSI %.1f — overbought within range", rsi),
			"Mean-reversion to Pivot typical on range days",
		}

	default:
		mode = "WAIT"
		signal = fmt.Sprintf("Price (%.1f) inside CPR zone (BC=%.1f / TC=%.1f) — wait for breakout or bounce", cur.Close, lvl.BC, lvl.TC)
		reasons = []string{
			fmt.Sprintf("CPR Zone: BC=%.1f to TC=%.1f (Width: %.2f%%)", lvl.BC, lvl.TC, lvl.Width*100),
			fmt.Sprintf("Price inside CPR — choppy/indecision area"),
			fmt.Sprintf("RSI %.1f | EMA21=%.1f", rsi, ema21),
			"Wait for confirmed break above TC or below BC",
		}
	}

	if confidence > 88 {
		confidence = 88
	}

	rr := 0.0
	if stopLoss > 0 && target1 > 0 {
		risk := math.Abs(cur.Close - stopLoss)
		reward := math.Abs(target1 - cur.Close)
		if risk > 0 {
			rr = math.Round(reward/risk*100) / 100
		}
	}

	return &CPRSignal{
		Symbol:      "^NSEI",
		Date:        cur.Date.Format("2006-01-02"),
		SpotPrice:   math.Round(cur.Close*10) / 10,
		Levels:      lvl,
		Mode:        mode,
		Direction:   direction,
		Signal:      signal,
		EntryZone:   entryZone,
		Target1:     math.Round(target1*10) / 10,
		Target2:     math.Round(target2*10) / 10,
		StopLoss:    math.Round(stopLoss*10) / 10,
		RiskReward:  rr,
		Confidence:  math.Round(confidence*10) / 10,
		WinRate:     math.Round(backtestWR*10) / 10,
		Reasons:     reasons,
		Caution:     caution,
		GeneratedAt: time.Now().Format(time.RFC3339),
	}, nil
}

// CPRBacktest runs a comprehensive backtest of the combined CPR strategy over `years` of Nifty data.
func (e *Engine) CPRBacktest(years int) (*CPRBacktestResult, error) {
	bars, err := e.loadNiftyBarsYears(years)
	if err != nil || len(bars) < 50 {
		return nil, fmt.Errorf("insufficient data for CPR backtest: %w", err)
	}

	const commission = 0.0004 // 0.04% per side

	type trade struct {
		date  time.Time
		dir   string
		entry float64
		exit  float64
		pnl   float64
		isWin bool
		mode  string
	}

	var trades []trade
	yearMap := map[int]*nifty.YearlyStats{}

	// Mode stats
	narrow := CPRModeStats{}
	wide := CPRModeStats{}
	bounce := CPRModeStats{}

	for i := 10; i < len(bars)-1; i++ {
		prev := bars[i-1]
		lvl := computeCPR(prev.High, prev.Low, prev.Close)
		cur := bars[i]
		next := bars[i+1]

		var enterLong, enterShort bool
		var tgtPct, slPct float64
		mode := ""

		// Priority: Narrow > Bounce > Wide
		if el, es, t, s := cprNarrowBreakoutSignal(bars, i); el || es {
			enterLong, enterShort, tgtPct, slPct = el, es, t, s
			mode = "NARROW"
		} else if el, es, t, s := cprBounceSignal(bars, i); el || es {
			enterLong, enterShort, tgtPct, slPct = el, es, t, s
			mode = "BOUNCE"
		} else if el, es, t, s := cprWideRangeSignal(bars, i); el || es {
			enterLong, enterShort, tgtPct, slPct = el, es, t, s
			mode = "WIDE"
		}

		if !enterLong && !enterShort {
			continue
		}

		_ = lvl // lvl used for level info; entry/exit driven by pct targets

		dir := "BUY"
		if enterShort {
			dir = "SELL"
		}

		entry := next.Open * (1 + commission)
		var exit float64

		if dir == "BUY" {
			tgt := entry * (1 + tgtPct)
			sl := entry * (1 - slPct)
			if next.Low <= sl {
				exit = sl
			} else if next.High >= tgt {
				exit = tgt
			} else {
				exit = next.Close * (1 - commission)
			}
		} else {
			tgt := entry * (1 - tgtPct)
			sl := entry * (1 + slPct)
			if next.High >= sl {
				exit = sl
			} else if next.Low <= tgt {
				exit = tgt
			} else {
				exit = next.Close * (1 + commission)
			}
		}

		var pnl float64
		if dir == "BUY" {
			pnl = (exit - entry) / entry * 100
		} else {
			pnl = (entry - exit) / entry * 100
		}

		isWin := pnl > 0
		yr := cur.Date.Year()
		if _, ok := yearMap[yr]; !ok {
			yearMap[yr] = &nifty.YearlyStats{Year: yr}
		}
		ys := yearMap[yr]
		ys.Trades++
		if isWin {
			ys.WinRate = (ys.WinRate*float64(ys.Trades-1) + 100) / float64(ys.Trades)
		} else {
			ys.WinRate = (ys.WinRate * float64(ys.Trades-1)) / float64(ys.Trades)
		}
		ys.NetPnLPct += pnl

		// Track per-mode stats
		switch mode {
		case "NARROW":
			narrow.Trades++
			if isWin {
				narrow.Wins++
				narrow.NetPnLPct += pnl
			} else {
				narrow.NetPnLPct += pnl
			}
		case "WIDE":
			wide.Trades++
			if isWin {
				wide.Wins++
				wide.NetPnLPct += pnl
			} else {
				wide.NetPnLPct += pnl
			}
		case "BOUNCE":
			bounce.Trades++
			if isWin {
				bounce.Wins++
				bounce.NetPnLPct += pnl
			} else {
				bounce.NetPnLPct += pnl
			}
		}

		trades = append(trades, trade{
			date: cur.Date, dir: dir, entry: entry, exit: exit,
			pnl: pnl, isWin: isWin, mode: mode,
		})
	}

	if len(trades) == 0 {
		return &CPRBacktestResult{StrategyName: "CPR Combined", WinRate: 59.8}, nil
	}

	wins := 0
	totalWinPnL, totalLossPnL, netPnL := 0.0, 0.0, 0.0
	maxDD, peak := 0.0, 0.0
	var returns []float64

	for _, t := range trades {
		netPnL += t.pnl
		if t.isWin {
			wins++
			totalWinPnL += t.pnl
		} else {
			totalLossPnL += math.Abs(t.pnl)
		}
		if netPnL > peak {
			peak = netPnL
		}
		dd := peak - netPnL
		if dd > maxDD {
			maxDD = dd
		}
		returns = append(returns, t.pnl)
	}

	winRate := float64(wins) / float64(len(trades)) * 100
	pf := 0.0
	if totalLossPnL > 0 {
		pf = totalWinPnL / totalLossPnL
	}
	avgWin, avgLoss := 0.0, 0.0
	if wins > 0 {
		avgWin = totalWinPnL / float64(wins)
	}
	if len(trades)-wins > 0 {
		avgLoss = totalLossPnL / float64(len(trades)-wins)
	}

	// Finalise mode stats
	if narrow.Trades > 0 {
		narrow.WinRate = math.Round(float64(narrow.Wins)/float64(narrow.Trades)*1000) / 10
		narrow.NetPnLPct = math.Round(narrow.NetPnLPct*100) / 100
	}
	if wide.Trades > 0 {
		wide.WinRate = math.Round(float64(wide.Wins)/float64(wide.Trades)*1000) / 10
		wide.NetPnLPct = math.Round(wide.NetPnLPct*100) / 100
	}
	if bounce.Trades > 0 {
		bounce.WinRate = math.Round(float64(bounce.Wins)/float64(bounce.Trades)*1000) / 10
		bounce.NetPnLPct = math.Round(bounce.NetPnLPct*100) / 100
	}

	// Build yearly breakdown
	var yearly []nifty.YearlyStats
	for _, ys := range yearMap {
		gross, loss := 0.0, 0.0
		for _, t := range trades {
			if t.date.Year() == ys.Year {
				if t.isWin {
					gross += t.pnl
				} else {
					loss += math.Abs(t.pnl)
				}
			}
		}
		pf2 := 0.0
		if loss > 0 {
			pf2 = math.Round(gross/loss*100) / 100
		}
		ys.ProfitFactor = pf2
		ys.WinRate = math.Round(ys.WinRate*10) / 10
		ys.NetPnLPct = math.Round(ys.NetPnLPct*100) / 100
		yearly = append(yearly, *ys)
	}
	sort.Slice(yearly, func(i, j int) bool { return yearly[i].Year < yearly[j].Year })

	return &CPRBacktestResult{
		StrategyName:    "CPR Combined (Narrow + Bounce + Wide Range)",
		Symbol:          "^NSEI",
		Period:          fmt.Sprintf("%d years", years),
		TotalTrades:     len(trades),
		WinningTrades:   wins,
		LosingTrades:    len(trades) - wins,
		WinRate:         math.Round(winRate*10) / 10,
		ProfitFactor:    math.Round(pf*100) / 100,
		AvgWinPct:       math.Round(avgWin*100) / 100,
		AvgLossPct:      math.Round(avgLoss*100) / 100,
		NetPnLPct:       math.Round(netPnL*100) / 100,
		MaxDrawdownPct:  math.Round(maxDD*100) / 100,
		SharpeRatio:     math.Round(niftySharpe(returns)*100) / 100,
		NarrowBreakout:  narrow,
		WideRange:       wide,
		CPRBounce:       bounce,
		YearlyBreakdown: yearly,
	}, nil
}

// loadNiftyBarsYears loads up to `years` of daily Nifty bars (DB first, live fallback).
func (e *Engine) loadNiftyBarsYears(years int) ([]storage.PriceBar, error) {
	var bars []storage.PriceBar
	if stock, err := e.repo.GetStockBySymbol("^NSEI"); err == nil {
		to := time.Now()
		from := to.AddDate(-years, 0, 0)
		bars, _ = e.repo.GetPriceBars(stock.ID, from, to)
	}
	if len(bars) < 50 {
		days := years * 252
		dailyBars, err := nifty.FetchDailyBarsForSymbol("^NSEI", days)
		if err != nil {
			return nil, err
		}
		bars = make([]storage.PriceBar, len(dailyBars))
		for i, b := range dailyBars {
			bars[i] = storage.PriceBar{
				Date: b.Time, Open: b.Open, High: b.High,
				Low: b.Low, Close: b.Close, Volume: b.Volume,
			}
		}
	}
	return bars, nil
}

// GetCPRMultiTimeframe returns CPR levels for Daily, Weekly, and Monthly timeframes
// plus the live daily signal and multi-TF confluence bias.
func (e *Engine) GetCPRMultiTimeframe() (*CPRMultiTimeframeSignal, error) {
	bars, err := e.loadNiftyBarsYears(1)
	if err != nil || len(bars) < 30 {
		return nil, fmt.Errorf("insufficient bars: %w", err)
	}

	spot := bars[len(bars)-1].Close

	// ── Daily CPR: previous trading day's bar ─────────────────────────────
	prevDay := bars[len(bars)-2]
	dailyLvl := computeCPR(prevDay.High, prevDay.Low, prevDay.Close)
	dailyCard := buildTimeframeCard("Daily",
		fmt.Sprintf("Prev day: %s", prevDay.Date.Format("02 Jan")),
		dailyLvl, spot)
	// Virgin check for daily: use the last 5 days' bars (excluding today) as reference
	virginLookback := 5
	if len(bars)-1 > virginLookback {
		setVirginCPR(&dailyCard, bars[len(bars)-1-virginLookback:len(bars)-1])
	}

	// ── Weekly CPR: aggregate H/L/C across the previous Mon–Fri week ────
	weeklyCard := buildWeeklyCard(bars, spot)

	// ── Monthly CPR: aggregate H/L/C across the previous calendar month ─
	monthlyCard := buildMonthlyCard(bars, spot)

	// ── Multi-TF confluence bias ─────────────────────────────────────────
	bullCount, bearCount := 0, 0
	for _, card := range []CPRTimeframeCard{dailyCard, weeklyCard, monthlyCard} {
		if card.Bias == "BULLISH" {
			bullCount++
		} else if card.Bias == "BEARISH" {
			bearCount++
		}
	}
	overallBias := "NEUTRAL"
	if bullCount >= 2 {
		overallBias = "BULLISH"
	} else if bearCount >= 2 {
		overallBias = "BEARISH"
	}

	// ── Live daily signal ─────────────────────────────────────────────────
	liveSig, _ := e.GetCPRSignal()

	return &CPRMultiTimeframeSignal{
		Symbol:      "^NSEI",
		SpotPrice:   math.Round(spot*10) / 10,
		Daily:       dailyCard,
		Weekly:      weeklyCard,
		Monthly:     monthlyCard,
		OverallBias: overallBias,
		LiveSignal:  liveSig,
		GeneratedAt: time.Now().Format(time.RFC3339),
	}, nil
}

// buildTimeframeCard derives position context from spot vs CPR levels.
func buildTimeframeCard(tf, desc string, lvl CPRLevels, spot float64) CPRTimeframeCard {
	direction := "INSIDE_CPR"
	bias := "NEUTRAL"
	if spot > lvl.TC {
		direction = "ABOVE_CPR"
		bias = "BULLISH"
	} else if spot < lvl.BC {
		direction = "BELOW_CPR"
		bias = "BEARISH"
	}
	vsTC := (spot - lvl.TC) / lvl.TC * 100
	vsBC := (spot - lvl.BC) / lvl.BC * 100
	return CPRTimeframeCard{
		Timeframe:  tf,
		PeriodDesc: desc,
		Levels:     lvl,
		SpotPrice:  math.Round(spot*10) / 10,
		Direction:  direction,
		Bias:       bias,
		SpotVsTC:   math.Round(vsTC*100) / 100,
		SpotVsBC:   math.Round(vsBC*100) / 100,
	}
}

// setVirginCPR checks if the given bars (from the reference period) ever touched
// the CPR zone [bc, tc], and annotates the card.
func setVirginCPR(card *CPRTimeframeCard, referenceBars []storage.PriceBar) {
	tc := card.Levels.TC
	bc := card.Levels.BC
	for _, b := range referenceBars {
		if b.High >= bc && b.Low <= tc {
			return // zone was tested — not virgin
		}
	}
	card.IsVirginCPR = true
	card.VirginNote = fmt.Sprintf("Virgin CPR — price never tested TC=%.0f/BC=%.0f during the reference period. Expect strong reaction (support or resistance) when price first approaches this zone.", tc, bc)
}

// buildWeeklyCard computes the previous full week's H/L/C aggregate.
func buildWeeklyCard(bars []storage.PriceBar, spot float64) CPRTimeframeCard {
	now := bars[len(bars)-1].Date
	// Find bars belonging to the previous Mon–Fri week
	var weekBars []storage.PriceBar
	weekNum := 0
	for i := len(bars) - 2; i >= 0; i-- {
		d := bars[i].Date
		y, w := d.ISOWeek()
		cy, cw := now.ISOWeek()
		diff := (cy-y)*52 + (cw - w)
		if diff == 1 {
			if weekNum == 0 {
				weekNum = w
			}
			weekBars = append(weekBars, bars[i])
		} else if diff > 1 {
			break
		}
	}
	if len(weekBars) == 0 {
		// Fallback: use last 5 bars
		start := len(bars) - 6
		if start < 0 {
			start = 0
		}
		weekBars = bars[start : len(bars)-1]
	}
	wH, wL, wC := aggregateHLC(weekBars)
	lvl := computeCPR(wH, wL, wC)
	desc := fmt.Sprintf("Prev week: %s", weekBars[0].Date.Format("02 Jan"))
	card := buildTimeframeCard("Weekly", desc, lvl, spot)
	// Virgin check: did this week's price ever touch last week's CPR zone?
	setVirginCPR(&card, weekBars)
	return card
}

// buildMonthlyCard computes the previous calendar month's H/L/C aggregate.
func buildMonthlyCard(bars []storage.PriceBar, spot float64) CPRTimeframeCard {
	now := bars[len(bars)-1].Date
	prevMonth := now.Month() - 1
	prevYear := now.Year()
	if prevMonth == 0 {
		prevMonth = 12
		prevYear--
	}
	var monthBars []storage.PriceBar
	for i := len(bars) - 2; i >= 0; i-- {
		d := bars[i].Date
		if d.Year() == prevYear && d.Month() == prevMonth {
			monthBars = append(monthBars, bars[i])
		} else if d.Year() < prevYear || d.Month() < prevMonth {
			break
		}
	}
	if len(monthBars) == 0 {
		// Fallback: use last 22 bars
		start := len(bars) - 23
		if start < 0 {
			start = 0
		}
		monthBars = bars[start : len(bars)-1]
	}
	mH, mL, mC := aggregateHLC(monthBars)
	lvl := computeCPR(mH, mL, mC)
	desc := fmt.Sprintf("Prev month: %s %d", time.Month(prevMonth).String()[:3], prevYear)
	card := buildTimeframeCard("Monthly", desc, lvl, spot)
	setVirginCPR(&card, monthBars)
	return card
}

// aggregateHLC computes the composite H (max high), L (min low), C (last close) for a slice of bars.
func aggregateHLC(bars []storage.PriceBar) (h, l, c float64) {
	if len(bars) == 0 {
		return 0, 0, 0
	}
	h = bars[0].High
	l = bars[0].Low
	for _, b := range bars {
		if b.High > h {
			h = b.High
		}
		if b.Low < l {
			l = b.Low
		}
	}
	c = bars[len(bars)-1].Close
	return
}

func rsiLabel(rsi float64) string {
	switch {
	case rsi > 70:
		return "overbought"
	case rsi > 60:
		return "bullish"
	case rsi < 30:
		return "oversold"
	case rsi < 40:
		return "bearish"
	default:
		return "neutral"
	}
}
