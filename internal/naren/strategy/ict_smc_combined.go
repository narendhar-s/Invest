package strategy

// ═══════════════════════════════════════════════════════════════════════════
//  ICT + SMC COMBINED STRATEGY FOR NIFTY 50
//
//  ICT (Inner Circle Trader) Components:
//    1. Order Blocks (OB)  — last opposing candle before a strong impulse
//    2. Change of Character (CHoCH) — first structural break against trend
//    3. Market Structure Shift (MSS) — confirmed reversal (consecutive closes)
//    4. OTE Zone — 61.8%–79% Fibonacci retracement (Optimal Trade Entry)
//    5. Premium / Discount — above/below 50% equilibrium of swing range
//    6. Liquidity Levels — equal highs/lows clusters (BSL / SSL)
//
//  SMC (Smart Money Concepts) Components:
//    1. HTF Bias — HH+HL (BULL) / LH+LL (BEAR) market structure
//    2. Liquidity Sweep — wick beyond 12-bar extreme with close inside range
//    3. Fair Value Gap (FVG) — 3-candle imbalance zone
//
//  Combined Signal Logic:
//    - Both ICT + SMC agree  → A+ setup (confluence ≥ 6)
//    - Single framework only → B setup (confluence 4-5)
//    - Biases conflict       → WAIT
//    Entry: OB/FVG overlap; Stop: beyond OB; T1 = 1.5R, T2 = 3R
// ═══════════════════════════════════════════════════════════════════════════

import (
	"fmt"
	"math"
	"time"

	"stockwise/internal/naren/nifty"
	"stockwise/internal/naren/storage"
)

// ─── Types ────────────────────────────────────────────────────────────────────

type ICTOrderBlock struct {
	Index     int     `json:"index"`
	High      float64 `json:"high"`
	Low       float64 `json:"low"`
	Mid       float64 `json:"mid"`
	Type      string  `json:"type"`      // "BULL" | "BEAR"
	Mitigated bool    `json:"mitigated"` // price has traded through OB
	BarsAgo   int     `json:"bars_ago"`
}

type ICTLiquidityLevel struct {
	Price float64 `json:"price"`
	Type  string  `json:"type"`  // "BSL" (buy-side) | "SSL" (sell-side)
	Swept bool    `json:"swept"`
	Count int     `json:"count"` // how many equal H/L cluster here
}

type ICTAnalysis struct {
	Bias         string              `json:"bias"`          // "BULL" | "BEAR" | "NEUTRAL"
	CHoCH        bool                `json:"choch"`
	CHoCHDir     string              `json:"choch_dir"`
	MSS          bool                `json:"mss"`
	BullOB       *ICTOrderBlock      `json:"bull_ob"`
	BearOB       *ICTOrderBlock      `json:"bear_ob"`
	SwingHigh    float64             `json:"swing_high"`
	SwingLow     float64             `json:"swing_low"`
	OTELow       float64             `json:"ote_low"`
	OTEHigh      float64             `json:"ote_high"`
	InOTE        bool                `json:"in_ote"`
	Equilibrium  float64             `json:"equilibrium"`
	InPremium    bool                `json:"in_premium"`
	InDiscount   bool                `json:"in_discount"`
	LiqLevels    []ICTLiquidityLevel `json:"liq_levels"`
}

type ICTSMCSignal struct {
	Symbol       string         `json:"symbol"`
	SpotPrice    float64        `json:"spot_price"`
	ICT          ICTAnalysis    `json:"ict"`
	SMCBias      string         `json:"smc_bias"`
	SMCFVGLow    float64        `json:"smc_fvg_low"`
	SMCFVGHigh   float64        `json:"smc_fvg_high"`
	SMCSweepType string         `json:"smc_sweep_type"`
	CombinedBias string         `json:"combined_bias"`
	Signal       string         `json:"signal"`     // "CE_BUY" | "PE_BUY" | "WAIT"
	Confluence   int            `json:"confluence"` // 0-10 score
	Entry        float64        `json:"entry"`
	StopLoss     float64        `json:"stop_loss"`
	Target1      float64        `json:"target1"`
	Target2      float64        `json:"target2"`
	RiskReward   float64        `json:"risk_reward"`
	Confidence   int            `json:"confidence"`
	Reasoning    []string       `json:"reasoning"`
	Risk         RiskManagement `json:"risk"`
	GeneratedAt  string         `json:"generated_at"`
}

type ICTSMCTrade struct {
	EntryDate  string  `json:"entry_date"`
	ExitDate   string  `json:"exit_date"`
	Direction  string  `json:"direction"`
	Entry      float64 `json:"entry"`
	Exit       float64 `json:"exit"`
	PnLPct     float64 `json:"pnl_pct"`
	Result     string  `json:"result"`
	Setup      string  `json:"setup"`      // "COMBINED" | "ICT_OB" | "SMC_FVG"
	Confluence int     `json:"confluence"`
}

type ICTSMCSubStats struct {
	Trades  int     `json:"trades"`
	Wins    int     `json:"wins"`
	WinRate float64 `json:"win_rate"`
	NetPnL  float64 `json:"net_pnl_pct"`
}

type ICTSMCBacktestResult struct {
	TotalTrades   int            `json:"total_trades"`
	WinningTrades int            `json:"winning_trades"`
	LosingTrades  int            `json:"losing_trades"`
	WinRate       float64        `json:"win_rate"`
	ProfitFactor  float64        `json:"profit_factor"`
	AvgWin        float64        `json:"avg_win_pct"`
	AvgLoss       float64        `json:"avg_loss_pct"`
	MaxDrawdown   float64        `json:"max_drawdown_pct"`
	TotalReturn   float64        `json:"total_return_pct"`
	SharpeRatio   float64        `json:"sharpe_ratio"`
	ICTOBOnly     ICTSMCSubStats `json:"ict_ob_only"`
	SMCFVGOnly    ICTSMCSubStats `json:"smc_fvg_only"`
	CombinedAPlus ICTSMCSubStats `json:"combined_a_plus"`
	Trades        []ICTSMCTrade  `json:"trades"`
}

// ─── ICT Detection Functions ─────────────────────────────────────────────────

// findOrderBlocks finds the most recent valid bull and bear order blocks.
// A bull OB = last bearish candle before a strong upward impulse (≥0.7% in 2 bars).
// A bear OB = last bullish candle before a strong downward impulse.
func findOrderBlocks(bars []storage.PriceBar, end int) (*ICTOrderBlock, *ICTOrderBlock) {
	lookback := 40
	start := end - lookback
	if start < 3 {
		start = 3
	}

	var bullOB, bearOB *ICTOrderBlock

	for i := start; i < end-2; i++ {
		// Check for strong bullish impulse AFTER bar i
		if bars[i+1].Close > bars[i].High && bars[i+2].Close > bars[i+1].Close {
			impulsePct := (bars[i+2].Close - bars[i].Close) / bars[i].Close
			if impulsePct > 0.007 && bars[i].Close < bars[i].Open {
				ob := &ICTOrderBlock{
					Index: i, High: bars[i].High, Low: bars[i].Low,
					Mid:  (bars[i].High + bars[i].Low) / 2,
					Type: "BULL", BarsAgo: end - i,
				}
				for k := i + 1; k <= end; k++ {
					if bars[k].Low <= ob.Low {
						ob.Mitigated = true
						break
					}
				}
				bullOB = ob
			}
		}

		// Check for strong bearish impulse AFTER bar i
		if bars[i+1].Close < bars[i].Low && bars[i+2].Close < bars[i+1].Close {
			impulsePct := (bars[i].Close - bars[i+2].Close) / bars[i].Close
			if impulsePct > 0.007 && bars[i].Close > bars[i].Open {
				ob := &ICTOrderBlock{
					Index: i, High: bars[i].High, Low: bars[i].Low,
					Mid:  (bars[i].High + bars[i].Low) / 2,
					Type: "BEAR", BarsAgo: end - i,
				}
				for k := i + 1; k <= end; k++ {
					if bars[k].High >= ob.High {
						ob.Mitigated = true
						break
					}
				}
				bearOB = ob
			}
		}
	}

	return bullOB, bearOB
}

// detectCHoCH identifies a Change of Character — the first structural break
// against the prevailing HTF trend (break of last swing extreme in opposite dir).
func detectCHoCH(bars []storage.PriceBar, end int, bias string) (bool, string) {
	lb := smcHTFSwingLB
	if end < lb*3+5 || bias == "NEUTRAL" {
		return false, ""
	}

	if bias == "BULL" {
		// CHoCH bearish: break below the most recent swing low
		var lastSwingLow float64
		for i := end - lb; i > end-50 && i >= lb; i-- {
			isL := true
			for k := 1; k <= lb; k++ {
				if i+k > end || bars[i].Low >= bars[i+k].Low || bars[i].Low >= bars[i-k].Low {
					isL = false
					break
				}
			}
			if isL {
				lastSwingLow = bars[i].Low
				break
			}
		}
		if lastSwingLow > 0 && bars[end].Close < lastSwingLow {
			return true, "BEAR"
		}
	} else {
		// CHoCH bullish: break above the most recent swing high
		var lastSwingHigh float64
		for i := end - lb; i > end-50 && i >= lb; i-- {
			isH := true
			for k := 1; k <= lb; k++ {
				if i+k > end || bars[i].High <= bars[i+k].High || bars[i].High <= bars[i-k].High {
					isH = false
					break
				}
			}
			if isH {
				lastSwingHigh = bars[i].High
				break
			}
		}
		if lastSwingHigh > 0 && bars[end].Close > lastSwingHigh {
			return true, "BULL"
		}
	}
	return false, ""
}

// computeOTEZone derives the OTE (Optimal Trade Entry) zone from the last significant swing.
// OTE = 61.8%–79% Fibonacci retracement of the dominant swing.
func computeOTEZone(bars []storage.PriceBar, end int, dir string) (swHigh, swLow, oteLow, oteHigh float64) {
	lookback := 50
	start := end - lookback
	if start < 0 {
		start = 0
	}
	swHigh = bars[start].High
	swLow = bars[start].Low
	for i := start + 1; i <= end; i++ {
		if bars[i].High > swHigh {
			swHigh = bars[i].High
		}
		if bars[i].Low < swLow {
			swLow = bars[i].Low
		}
	}
	rng := swHigh - swLow
	if rng == 0 {
		return
	}
	if dir == "BULL" {
		// Discount zone for longs: price retracted 61.8–79% from swing high
		oteLow = swHigh - rng*0.79
		oteHigh = swHigh - rng*0.618
	} else {
		// Premium zone for shorts: price rallied 61.8–79% from swing low
		oteLow = swLow + rng*0.618
		oteHigh = swLow + rng*0.79
	}
	return
}

// findLiquidityLevels detects equal highs (BSL) and equal lows (SSL) — clusters
// of swing points within 0.15% of each other that act as institutional magnets.
func findLiquidityLevels(bars []storage.PriceBar, end int) []ICTLiquidityLevel {
	lb := smcHTFSwingLB
	start := end - 60
	if start < lb {
		start = lb
	}

	var swHighs, swLows []float64
	for i := start; i < end-lb; i++ {
		isH, isL := true, true
		for k := 1; k <= lb; k++ {
			if i+k > end || bars[i].High <= bars[i+k].High || bars[i].High <= bars[i-k].High {
				isH = false
			}
			if i+k > end || bars[i].Low >= bars[i+k].Low || bars[i].Low >= bars[i-k].Low {
				isL = false
			}
		}
		if isH {
			swHighs = append(swHighs, bars[i].High)
		}
		if isL {
			swLows = append(swLows, bars[i].Low)
		}
	}

	seen := make(map[int]bool)
	var levels []ICTLiquidityLevel

	for i := 0; i < len(swHighs); i++ {
		if seen[i] {
			continue
		}
		count := 1
		for j := i + 1; j < len(swHighs); j++ {
			if math.Abs(swHighs[i]-swHighs[j])/swHighs[i] < 0.0015 {
				count++
				seen[j] = true
			}
		}
		if count >= 2 {
			levels = append(levels, ICTLiquidityLevel{
				Price: math.Round(swHighs[i]*100) / 100,
				Type:  "BSL", Count: count,
				Swept: bars[end].High > swHighs[i],
			})
		}
	}

	seen = make(map[int]bool)
	for i := 0; i < len(swLows); i++ {
		if seen[i] {
			continue
		}
		count := 1
		for j := i + 1; j < len(swLows); j++ {
			if math.Abs(swLows[i]-swLows[j])/swLows[i] < 0.0015 {
				count++
				seen[j] = true
			}
		}
		if count >= 2 {
			levels = append(levels, ICTLiquidityLevel{
				Price: math.Round(swLows[i]*100) / 100,
				Type:  "SSL", Count: count,
				Swept: bars[end].Low < swLows[i],
			})
		}
	}

	return levels
}

// computeICTAnalysis builds the full ICT picture for the given bar index.
func computeICTAnalysis(bars []storage.PriceBar, end int) ICTAnalysis {
	bias := computeHTFBias(bars, end)

	choch, chochDir := detectCHoCH(bars, end, bias)

	effectiveBias := bias
	if choch {
		effectiveBias = chochDir
	}

	// MSS: CHoCH confirmed by 2+ consecutive closes in the new direction
	mss := false
	if choch && end >= 3 {
		consec := 0
		for k := end; k > end-3 && k >= 0; k-- {
			if chochDir == "BULL" && bars[k].Close > bars[k].Open {
				consec++
			} else if chochDir == "BEAR" && bars[k].Close < bars[k].Open {
				consec++
			}
		}
		mss = consec >= 2
	}

	bullOB, bearOB := findOrderBlocks(bars, end)
	swHigh, swLow, oteLow, oteHigh := computeOTEZone(bars, end, effectiveBias)

	cur := bars[end].Close
	inOTE := oteLow > 0 && cur >= oteLow && cur <= oteHigh
	equilib := (swHigh + swLow) / 2

	return ICTAnalysis{
		Bias:        bias,
		CHoCH:       choch, CHoCHDir: chochDir,
		MSS:         mss,
		BullOB:      bullOB, BearOB: bearOB,
		SwingHigh:   math.Round(swHigh*100) / 100,
		SwingLow:    math.Round(swLow*100) / 100,
		OTELow:      math.Round(oteLow*100) / 100,
		OTEHigh:     math.Round(oteHigh*100) / 100,
		InOTE:       inOTE,
		Equilibrium: math.Round(equilib*100) / 100,
		InPremium:   cur > equilib,
		InDiscount:  cur < equilib,
		LiqLevels:   findLiquidityLevels(bars, end),
	}
}

// ─── Combined Signal ──────────────────────────────────────────────────────────

func computeICTSMCSignal(bars []storage.PriceBar) ICTSMCSignal {
	now := time.Now()
	if len(bars) < smcHTFWindow+20 {
		return ICTSMCSignal{Signal: "WAIT", GeneratedAt: now.Format(time.RFC3339)}
	}

	end := len(bars) - 1
	cur := bars[end]
	ict := computeICTAnalysis(bars, end)
	smc := computeSMCSignal(bars)

	sig := ICTSMCSignal{
		SpotPrice:    math.Round(cur.Close*100) / 100,
		ICT:          ict,
		SMCBias:      smc.HTFBias,
		SMCFVGLow:    smc.FVGLow,
		SMCFVGHigh:   smc.FVGHigh,
		SMCSweepType: smc.SweepType,
		Signal:       "WAIT",
		GeneratedAt:  now.Format(time.RFC3339),
	}

	// Effective ICT direction (CHoCH overrides HTF bias)
	ictDir := ict.Bias
	if ict.CHoCH {
		ictDir = ict.CHoCHDir
	}
	smcDir := smc.HTFBias

	reasoning := []string{}
	reasoning = append(reasoning, fmt.Sprintf("ICT HTF Bias: %s", ictDir))
	reasoning = append(reasoning, fmt.Sprintf("SMC HTF Bias: %s", smcDir))
	if ict.CHoCH {
		reasoning = append(reasoning, fmt.Sprintf("CHoCH detected → %s reversal forming", ict.CHoCHDir))
	}
	if ict.MSS {
		reasoning = append(reasoning, fmt.Sprintf("MSS confirmed → institutional order flow shifted %s", ict.CHoCHDir))
	}

	// Determine combined bias
	confluence := 0
	if ictDir != "NEUTRAL" && smcDir != "NEUTRAL" && ictDir == smcDir {
		sig.CombinedBias = ictDir
		confluence += 2
		reasoning = append(reasoning, fmt.Sprintf("✓ ICT + SMC both %s — strong confluence", ictDir))
	} else if ictDir != "NEUTRAL" && (smcDir == "NEUTRAL" || smcDir == "") {
		sig.CombinedBias = ictDir
		confluence++
		reasoning = append(reasoning, fmt.Sprintf("ICT %s bias (SMC neutral)", ictDir))
	} else if smcDir != "NEUTRAL" && (ictDir == "NEUTRAL" || ictDir == "") {
		sig.CombinedBias = smcDir
		confluence++
		reasoning = append(reasoning, fmt.Sprintf("SMC %s bias (ICT neutral)", smcDir))
	} else if ictDir != smcDir && ictDir != "NEUTRAL" && smcDir != "NEUTRAL" {
		sig.CombinedBias = "NEUTRAL"
		sig.Reasoning = append(reasoning, "⚠ ICT and SMC biases conflict — WAIT for alignment")
		return sig
	} else {
		sig.CombinedBias = "NEUTRAL"
		sig.Reasoning = reasoning
		return sig
	}

	if ict.MSS {
		confluence++
	}
	if ict.CHoCH {
		confluence++
	}

	// Order Block check
	var activeOB *ICTOrderBlock
	if sig.CombinedBias == "BULL" && ict.BullOB != nil && !ict.BullOB.Mitigated {
		activeOB = ict.BullOB
		inOB := cur.Close >= activeOB.Low*0.999 && cur.Close <= activeOB.High*1.001
		if inOB {
			confluence += 2
			reasoning = append(reasoning, fmt.Sprintf("✓ Price retesting Bull OB [%.0f–%.0f] (%d bars ago)", activeOB.Low, activeOB.High, activeOB.BarsAgo))
		} else {
			reasoning = append(reasoning, fmt.Sprintf("Bull OB [%.0f–%.0f] — waiting for retest (%d bars ago)", activeOB.Low, activeOB.High, activeOB.BarsAgo))
		}
	} else if sig.CombinedBias == "BEAR" && ict.BearOB != nil && !ict.BearOB.Mitigated {
		activeOB = ict.BearOB
		inOB := cur.Close <= activeOB.High*1.001 && cur.Close >= activeOB.Low*0.999
		if inOB {
			confluence += 2
			reasoning = append(reasoning, fmt.Sprintf("✓ Price retesting Bear OB [%.0f–%.0f] (%d bars ago)", activeOB.Low, activeOB.High, activeOB.BarsAgo))
		} else {
			reasoning = append(reasoning, fmt.Sprintf("Bear OB [%.0f–%.0f] — waiting for retest (%d bars ago)", activeOB.Low, activeOB.High, activeOB.BarsAgo))
		}
	}

	// OTE zone
	if ict.InOTE {
		confluence++
		reasoning = append(reasoning, fmt.Sprintf("✓ Price in OTE zone [%.0f–%.0f] (61.8–79%% Fib)", ict.OTELow, ict.OTEHigh))
	}

	// Premium/Discount
	if sig.CombinedBias == "BULL" && ict.InDiscount {
		confluence++
		reasoning = append(reasoning, fmt.Sprintf("✓ Price in Discount zone (below equilibrium %.0f) — ideal for longs", ict.Equilibrium))
	} else if sig.CombinedBias == "BEAR" && ict.InPremium {
		confluence++
		reasoning = append(reasoning, fmt.Sprintf("✓ Price in Premium zone (above equilibrium %.0f) — ideal for shorts", ict.Equilibrium))
	}

	// FVG confluence
	hasFVG := smc.FVGLow > 0 && smc.FVGHigh > 0
	fvgMid := 0.0
	inFVG := false
	if hasFVG {
		fvgMid = (smc.FVGLow + smc.FVGHigh) / 2
		inFVG = cur.Close >= smc.FVGLow*0.999 && cur.Close <= smc.FVGHigh*1.001
		if inFVG {
			confluence += 2
			reasoning = append(reasoning, fmt.Sprintf("✓ Price in SMC FVG [%.0f–%.0f] — imbalance fill zone", smc.FVGLow, smc.FVGHigh))
		} else {
			reasoning = append(reasoning, fmt.Sprintf("SMC FVG [%.0f–%.0f] — price not yet retesting", smc.FVGLow, smc.FVGHigh))
		}
	}

	// Liquidity sweep alignment
	if smc.SweepType != "" {
		if (sig.CombinedBias == "BULL" && smc.SweepType == "LOW") ||
			(sig.CombinedBias == "BEAR" && smc.SweepType == "HIGH") {
			confluence++
			reasoning = append(reasoning, fmt.Sprintf("✓ Liquidity swept (%s) — smart money repositioning", smc.SweepType))
		}
	}

	sig.Confluence = confluence

	// Minimum confluence threshold to emit a signal
	if confluence < 4 {
		sig.Signal = "WAIT"
		sig.Reasoning = append(reasoning, fmt.Sprintf("Confluence score %d/10 — need ≥4 for entry", confluence))
		return sig
	}

	// Compute entry, SL, targets
	var entry, sl, t1, t2 float64

	if sig.CombinedBias == "BULL" {
		entry = cur.Close
		if activeOB != nil && inFVG {
			entry = math.Max(activeOB.Mid, fvgMid)
		} else if activeOB != nil {
			entry = activeOB.Mid
		} else if inFVG {
			entry = fvgMid
		}

		sl = cur.Close * 0.985
		if activeOB != nil {
			sl = activeOB.Low - 10
		} else if smc.StopLoss > 0 {
			sl = smc.StopLoss
		}

		if entry <= sl || entry <= 0 || sl <= 0 {
			sig.Signal = "WAIT"
			sig.Reasoning = reasoning
			return sig
		}
		risk := entry - sl
		t1 = entry + risk*1.5
		t2 = entry + risk*3.0
		sig.Signal = "CE_BUY"
	} else {
		entry = cur.Close
		if activeOB != nil && inFVG {
			entry = math.Min(activeOB.Mid, fvgMid)
		} else if activeOB != nil {
			entry = activeOB.Mid
		} else if inFVG {
			entry = fvgMid
		}

		sl = cur.Close * 1.015
		if activeOB != nil {
			sl = activeOB.High + 10
		} else if smc.StopLoss > 0 {
			sl = smc.StopLoss
		}

		if sl <= entry || entry <= 0 || sl <= 0 {
			sig.Signal = "WAIT"
			sig.Reasoning = reasoning
			return sig
		}
		risk := sl - entry
		t1 = entry - risk*1.5
		t2 = entry - risk*3.0
		sig.Signal = "PE_BUY"
	}

	rr := math.Abs(t2-entry) / math.Abs(entry-sl)
	confidence := 55 + confluence*4
	if confidence > 92 {
		confidence = 92
	}

	sig.Entry = math.Round(entry*100) / 100
	sig.StopLoss = math.Round(sl*100) / 100
	sig.Target1 = math.Round(t1*100) / 100
	sig.Target2 = math.Round(t2*100) / 100
	sig.RiskReward = math.Round(rr*10) / 10
	sig.Confidence = confidence
	sig.Reasoning = reasoning
	sig.Risk = computeRiskPlan(entry, sl, t2, 100000, 1.0)

	return sig
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

func runICTSMCBacktest(bars []storage.PriceBar) ICTSMCBacktestResult {
	res := ICTSMCBacktestResult{}
	if len(bars) < smcHTFWindow+20 {
		return res
	}

	equity := 100.0
	peak := 100.0
	maxDD := 0.0
	var totalWin, totalLoss, sumRet float64
	cooldown := -10
	const rr = 3.0

	ictOB := ICTSMCSubStats{}
	smcFVG := ICTSMCSubStats{}
	combined := ICTSMCSubStats{}

	for i := smcHTFWindow + 10; i < len(bars)-1; i++ {
		if i-cooldown < 3 {
			continue
		}

		ict := computeICTAnalysis(bars, i)
		smc := computeSMCSignal(bars[:i+1])

		ictDir := ict.Bias
		if ict.CHoCH {
			ictDir = ict.CHoCHDir
		}
		smcDir := smc.HTFBias

		var dir, setup string
		confluence := 0

		switch {
		case ictDir == smcDir && ictDir != "NEUTRAL" && smcDir != "NEUTRAL":
			dir = ictDir
			setup = "COMBINED"
			confluence = 2
			if ict.CHoCH {
				confluence++
			}
			if ict.MSS {
				confluence++
			}
			if dir == "BULL" && ict.BullOB != nil && !ict.BullOB.Mitigated {
				inOB := bars[i].Close >= ict.BullOB.Low*0.999 && bars[i].Close <= ict.BullOB.High*1.001
				if inOB {
					confluence += 2
				}
			} else if dir == "BEAR" && ict.BearOB != nil && !ict.BearOB.Mitigated {
				inOB := bars[i].Close <= ict.BearOB.High*1.001 && bars[i].Close >= ict.BearOB.Low*0.999
				if inOB {
					confluence += 2
				}
			}
			hasFVG := smc.FVGLow > 0
			if hasFVG {
				inFVG := bars[i].Close >= smc.FVGLow*0.999 && bars[i].Close <= smc.FVGHigh*1.001
				if inFVG {
					confluence += 2
				}
			}
			if confluence < 4 {
				continue
			}

		case ictDir != "NEUTRAL" && (smcDir == "NEUTRAL" || smcDir == ""):
			if ictDir == "BULL" && ict.BullOB != nil && !ict.BullOB.Mitigated {
				inOB := bars[i].Close >= ict.BullOB.Low*0.999 && bars[i].Close <= ict.BullOB.High*1.001
				if !inOB {
					continue
				}
				dir = "BULL"
				setup = "ICT_OB"
				confluence = 2
			} else if ictDir == "BEAR" && ict.BearOB != nil && !ict.BearOB.Mitigated {
				inOB := bars[i].Close <= ict.BearOB.High*1.001 && bars[i].Close >= ict.BearOB.Low*0.999
				if !inOB {
					continue
				}
				dir = "BEAR"
				setup = "ICT_OB"
				confluence = 2
			} else {
				continue
			}

		case smcDir != "NEUTRAL" && smcDir != "" && (ictDir == "NEUTRAL" || ictDir == ""):
			if smc.FVGLow <= 0 {
				continue
			}
			inFVG := bars[i].Close >= smc.FVGLow*0.999 && bars[i].Close <= smc.FVGHigh*1.001
			if !inFVG {
				continue
			}
			dir = smcDir
			setup = "SMC_FVG"
			confluence = 2

		default:
			continue
		}

		nb := bars[i+1]
		entryPrice := nb.Open

		var sl, tgt float64
		if dir == "BULL" {
			sl = entryPrice * 0.985
			if ict.BullOB != nil && !ict.BullOB.Mitigated {
				sl = ict.BullOB.Low - 10
			}
			risk := entryPrice - sl
			if risk <= 0 {
				continue
			}
			tgt = entryPrice + risk*rr
		} else {
			sl = entryPrice * 1.015
			if ict.BearOB != nil && !ict.BearOB.Mitigated {
				sl = ict.BearOB.High + 10
			}
			risk := sl - entryPrice
			if risk <= 0 {
				continue
			}
			tgt = entryPrice - risk*rr
		}

		var pnl float64
		var result string
		if dir == "BULL" {
			if nb.High >= tgt {
				pnl = (tgt/entryPrice - 1) * 100
				result = "WIN"
			} else if nb.Low <= sl {
				pnl = (sl/entryPrice - 1) * 100
				result = "LOSS"
			} else {
				pnl = (nb.Close/entryPrice - 1) * 100
				result = "EOD"
			}
		} else {
			if nb.Low <= tgt {
				pnl = (1 - tgt/entryPrice) * 100
				result = "WIN"
			} else if nb.High >= sl {
				pnl = (1 - sl/entryPrice) * 100
				result = "LOSS"
			} else {
				pnl = (1 - nb.Close/entryPrice) * 100
				result = "EOD"
			}
		}

		res.Trades = append(res.Trades, ICTSMCTrade{
			EntryDate: bars[i].Date.Format("2006-01-02"),
			ExitDate:  nb.Date.Format("2006-01-02"),
			Direction: map[string]string{"BULL": "CE", "BEAR": "PE"}[dir],
			Entry:     math.Round(entryPrice*100) / 100,
			Exit:      math.Round(nb.Close*100) / 100,
			PnLPct:    math.Round(pnl*100) / 100,
			Result:    result,
			Setup:     setup,
			Confluence: confluence,
		})

		res.TotalTrades++
		if pnl > 0 {
			res.WinningTrades++
			totalWin += pnl
		} else {
			res.LosingTrades++
			totalLoss += math.Abs(pnl)
		}

		switch setup {
		case "ICT_OB":
			ictOB.Trades++
			if pnl > 0 {
				ictOB.Wins++
			}
			ictOB.NetPnL += pnl
		case "SMC_FVG":
			smcFVG.Trades++
			if pnl > 0 {
				smcFVG.Wins++
			}
			smcFVG.NetPnL += pnl
		case "COMBINED":
			combined.Trades++
			if pnl > 0 {
				combined.Wins++
			}
			combined.NetPnL += pnl
		}

		equity *= 1 + pnl/100
		sumRet += pnl
		if equity > peak {
			peak = equity
		}
		dd := (peak - equity) / peak * 100
		if dd > maxDD {
			maxDD = dd
		}
		cooldown = i
	}

	if res.TotalTrades > 0 {
		res.WinRate = math.Round(float64(res.WinningTrades)/float64(res.TotalTrades)*10000) / 100
		res.TotalReturn = math.Round((equity-100)*100) / 100
		res.MaxDrawdown = math.Round(maxDD*100) / 100
		if totalLoss > 0 {
			res.ProfitFactor = math.Round(totalWin/totalLoss*100) / 100
		}
		if res.WinningTrades > 0 {
			res.AvgWin = math.Round(totalWin/float64(res.WinningTrades)*100) / 100
		}
		if res.LosingTrades > 0 {
			res.AvgLoss = math.Round(totalLoss/float64(res.LosingTrades)*100) / 100
		}
		mean := sumRet / float64(res.TotalTrades)
		var variance float64
		for _, t := range res.Trades {
			d := t.PnLPct - mean
			variance += d * d
		}
		if res.TotalTrades > 1 {
			std := math.Sqrt(variance / float64(res.TotalTrades-1))
			if std > 0 {
				res.SharpeRatio = math.Round(mean/std*math.Sqrt(252)*100) / 100
			}
		}
	}

	calcSub := func(s *ICTSMCSubStats) {
		if s.Trades > 0 {
			s.WinRate = math.Round(float64(s.Wins)/float64(s.Trades)*10000) / 100
			s.NetPnL = math.Round(s.NetPnL*100) / 100
		}
	}
	calcSub(&ictOB)
	calcSub(&smcFVG)
	calcSub(&combined)
	res.ICTOBOnly = ictOB
	res.SMCFVGOnly = smcFVG
	res.CombinedAPlus = combined

	return res
}

// ─── Intraday Events (for chart rendering) ───────────────────────────────────

type ICTSMCBar struct {
	Time   int64   `json:"time"`
	Date   string  `json:"date"`
	Open   float64 `json:"open"`
	High   float64 `json:"high"`
	Low    float64 `json:"low"`
	Close  float64 `json:"close"`
	Volume int64   `json:"volume"`
}

type ICTSMCOBZone struct {
	StartTime int64   `json:"start_time"`
	High      float64 `json:"high"`
	Low       float64 `json:"low"`
	Mid       float64 `json:"mid"`
	Type      string  `json:"type"`      // "BULL" | "BEAR"
	Mitigated bool    `json:"mitigated"`
}

type ICTSMCLevelMarker struct {
	Time  int64   `json:"time"`
	Type  string  `json:"type"`  // "CHOCH_BULL"|"CHOCH_BEAR"|"MSS_BULL"|"MSS_BEAR"|"SWEEP_HIGH"|"SWEEP_LOW"
	Price float64 `json:"price"`
	Label string  `json:"label"`
}

type ICTSMCEventsResponse struct {
	Bars        []ICTSMCBar         `json:"bars"`
	OBZones     []ICTSMCOBZone      `json:"ob_zones"`
	FVGZones    []SMCFVGZone        `json:"fvg_zones"`
	Sweeps      []ICTSMCLevelMarker `json:"sweeps"`
	LiqLevels   []ICTLiquidityLevel `json:"liq_levels"`
	OTELow      float64             `json:"ote_low"`
	OTEHigh     float64             `json:"ote_high"`
	SwingHigh   float64             `json:"swing_high"`
	SwingLow    float64             `json:"swing_low"`
	Equilibrium float64             `json:"equilibrium"`
	Signal      ICTSMCSignal        `json:"signal"`
	GeneratedAt string              `json:"generated_at"`
}

// GetICTSMCEvents returns annotated bars for chart rendering.
// timeframe: "5m" | "15m" (intraday) | "daily" (always available).
// When intraday fetch returns empty (outside market hours), falls back to daily.
func (e *Engine) GetICTSMCEvents(maxBars int, timeframe string) (ICTSMCEventsResponse, error) {
	if maxBars < 30 {
		maxBars = 30
	}
	if maxBars > 500 {
		maxBars = 500
	}

	var ibs []nifty.IntradayBar
	var err error

	switch timeframe {
	case "daily":
		ibs, err = nifty.FetchDailyBarsForSymbol("^NSEI", maxBars)
	case "15m":
		ibs, err = nifty.FetchIntradayBarsForSymbol("^NSEI", "15m")
	default:
		timeframe = "5m"
		ibs, err = nifty.FetchIntradayBarsForSymbol("^NSEI", "5m")
	}

	// Fallback to daily when intraday unavailable (outside market hours)
	if (err != nil || len(ibs) == 0) && timeframe != "daily" {
		ibs, err = nifty.FetchDailyBarsForSymbol("^NSEI", maxBars)
		timeframe = "daily"
	}
	if err != nil || len(ibs) == 0 {
		return ICTSMCEventsResponse{GeneratedAt: time.Now().Format(time.RFC3339)}, err
	}
	if len(ibs) > maxBars {
		ibs = ibs[len(ibs)-maxBars:]
	}

	dateFmt := "2006-01-02 15:04"
	if timeframe == "daily" {
		dateFmt = "2006-01-02"
	}

	bars := make([]storage.PriceBar, len(ibs))
	outBars := make([]ICTSMCBar, len(ibs))
	for i, b := range ibs {
		bars[i] = storage.PriceBar{
			Date: b.Time, Open: b.Open, High: b.High,
			Low: b.Low, Close: b.Close, Volume: b.Volume,
		}
		outBars[i] = ICTSMCBar{
			Time:   b.Time.Unix(),
			Date:   b.Time.Format(dateFmt),
			Open:   b.Open, High: b.High, Low: b.Low, Close: b.Close,
			Volume: b.Volume,
		}
	}

	end := len(bars) - 1
	ict := computeICTAnalysis(bars, end)

	// ── Order Block Zones ────────────────────────────────────────────────────
	var obZones []ICTSMCOBZone
	if ict.BullOB != nil {
		idx := ict.BullOB.Index
		if idx < len(bars) {
			obZones = append(obZones, ICTSMCOBZone{
				StartTime: bars[idx].Date.Unix(),
				High: ict.BullOB.High, Low: ict.BullOB.Low, Mid: ict.BullOB.Mid,
				Type: "BULL", Mitigated: ict.BullOB.Mitigated,
			})
		}
	}
	if ict.BearOB != nil {
		idx := ict.BearOB.Index
		if idx < len(bars) {
			obZones = append(obZones, ICTSMCOBZone{
				StartTime: bars[idx].Date.Unix(),
				High: ict.BearOB.High, Low: ict.BearOB.Low, Mid: ict.BearOB.Mid,
				Type: "BEAR", Mitigated: ict.BearOB.Mitigated,
			})
		}
	}

	// ── FVG Zones (reuse SMC logic) ───────────────────────────────────────────
	var fvgZones []SMCFVGZone
	for i := 2; i < len(bars); i++ {
		if bars[i-2].High < bars[i].Low {
			lo, hi := bars[i-2].High, bars[i].Low
			filled := false
			for k := i + 1; k < len(bars); k++ {
				if bars[k].Low <= lo {
					filled = true
					break
				}
			}
			fvgZones = append(fvgZones, SMCFVGZone{
				StartTime: bars[i-2].Date.Unix(),
				EndTime:   bars[end].Date.Unix(),
				Low: lo, High: hi, Type: "BULL", Filled: filled,
			})
		}
		if bars[i-2].Low > bars[i].High {
			lo, hi := bars[i].High, bars[i-2].Low
			filled := false
			for k := i + 1; k < len(bars); k++ {
				if bars[k].High >= hi {
					filled = true
					break
				}
			}
			fvgZones = append(fvgZones, SMCFVGZone{
				StartTime: bars[i-2].Date.Unix(),
				EndTime:   bars[end].Date.Unix(),
				Low: lo, High: hi, Type: "BEAR", Filled: filled,
			})
		}
	}

	// ── Liquidity Sweep markers ───────────────────────────────────────────────
	var sweepMarkers []ICTSMCLevelMarker
	lb := 20
	for i := lb + 2; i < len(bars); i++ {
		refH := bars[i-lb].High
		refL := bars[i-lb].Low
		for k := i - lb + 1; k < i-2; k++ {
			if bars[k].High > refH {
				refH = bars[k].High
			}
			if bars[k].Low < refL {
				refL = bars[k].Low
			}
		}
		if bars[i].High > refH && bars[i].Close < refH {
			sweepMarkers = append(sweepMarkers, ICTSMCLevelMarker{
				Time: bars[i].Date.Unix(), Type: "SWEEP_HIGH",
				Price: bars[i].High, Label: "SWEEP ▼",
			})
		}
		if bars[i].Low < refL && bars[i].Close > refL {
			sweepMarkers = append(sweepMarkers, ICTSMCLevelMarker{
				Time: bars[i].Date.Unix(), Type: "SWEEP_LOW",
				Price: bars[i].Low, Label: "SWEEP ▲",
			})
		}
	}

	// ── CHoCH / MSS markers ───────────────────────────────────────────────────
	bias := computeHTFBias(bars, end)
	choch, chochDir := detectCHoCH(bars, end, bias)
	if choch {
		mtype := "CHOCH_" + chochDir
		label := "CHoCH"
		if ict.MSS {
			mtype = "MSS_" + chochDir
			label = "MSS ✓"
		}
		sweepMarkers = append(sweepMarkers, ICTSMCLevelMarker{
			Time: bars[end].Date.Unix(), Type: mtype,
			Price: bars[end].Close, Label: label,
		})
	}

	// ── Compute combined signal on intraday bars ──────────────────────────────
	sig := computeICTSMCSignal(bars)
	sig.Symbol = "^NSEI"

	return ICTSMCEventsResponse{
		Bars:        outBars,
		OBZones:     obZones,
		FVGZones:    fvgZones,
		Sweeps:      sweepMarkers,
		LiqLevels:   ict.LiqLevels,
		OTELow:      ict.OTELow,
		OTEHigh:     ict.OTEHigh,
		SwingHigh:   ict.SwingHigh,
		SwingLow:    ict.SwingLow,
		Equilibrium: ict.Equilibrium,
		Signal:      sig,
		GeneratedAt: time.Now().Format(time.RFC3339),
	}, nil
}

// ─── Engine methods ───────────────────────────────────────────────────────────

// GetICTSMCSignal generates the live combined ICT+SMC signal for ^NSEI.
func (e *Engine) GetICTSMCSignal() (ICTSMCSignal, error) {
	bars, err := e.loadNiftyBarsYears(1)
	if err != nil || len(bars) < smcHTFWindow+20 {
		return ICTSMCSignal{Signal: "WAIT", GeneratedAt: time.Now().Format(time.RFC3339)}, err
	}
	sig := computeICTSMCSignal(bars)
	sig.Symbol = "^NSEI"
	return sig, nil
}

// ICTSMCBacktest runs the combined strategy backtest over `years` of Nifty data.
func (e *Engine) ICTSMCBacktest(years int) (ICTSMCBacktestResult, error) {
	bars, err := e.loadNiftyBarsYears(years)
	if err != nil {
		return ICTSMCBacktestResult{}, err
	}
	return runICTSMCBacktest(bars), nil
}
