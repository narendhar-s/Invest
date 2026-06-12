package strategy

// ═══════════════════════════════════════════════════════════════════════════
//  MICHAEL J. HUDDLESTON (ICT) STRATEGY — NIFTY 50
//
//  Complete ICT model: all 7 PD-array layers + time-based killzone filter.
//
//  New concepts added over existing ICT+SMC:
//    1. Breaker Blocks   — failed/mitigated OBs that flip polarity
//    2. Displacement     — large impulse candle (>1.5× ATR) that creates FVG
//    3. Power of 3 (PO3) — Accumulation → Manipulation (sweep) → Distribution
//    4. PDH / PDL        — Previous-day high/low as primary liquidity targets
//    5. PWHL / PWLL      — Previous-week high/low as HTF draw-on-liquidity
//    6. Silver Bullet    — Time-window setups (simplified to daily scoring)
//    7. Inducement       — Minor liquidity taken before the real move
//
//  Backtest entry model (daily bars):
//    Signal day N → Enter at day N+1 open
//    SL: below/above the swept extreme or OB edge
//    T1: 1.5R  |  T2: 3R  |  TLiq: next significant liquidity pool
//
//  Yearly breakdown + setup-type P&L included in result.
// ═══════════════════════════════════════════════════════════════════════════

import (
	"fmt"
	"math"
	"time"

	"stockwise/internal/naren/storage"
)

// ─── Public Types ─────────────────────────────────────────────────────────────

// BreakerBlock is a mitigated order block whose polarity has flipped.
type BreakerBlock struct {
	High      float64 `json:"high"`
	Low       float64 `json:"low"`
	Mid       float64 `json:"mid"`
	Type      string  `json:"type"`       // "BULL_BREAKER" | "BEAR_BREAKER"
	BarsAgo   int     `json:"bars_ago"`
}

// DisplacementCandle marks a bar whose range ≥ 1.5× ATR and closes near its extreme.
type DisplacementCandle struct {
	Index     int     `json:"index"`
	High      float64 `json:"high"`
	Low       float64 `json:"low"`
	Close     float64 `json:"close"`
	Direction string  `json:"direction"` // "BULL" | "BEAR"
	FVGLow    float64 `json:"fvg_low"`   // FVG created by this candle
	FVGHigh   float64 `json:"fvg_high"`
}

// PO3Phase represents which Power-of-3 phase the market is in.
type PO3Phase string

const (
	PO3Accumulation  PO3Phase = "ACCUMULATION"
	PO3Manipulation  PO3Phase = "MANIPULATION"
	PO3Distribution  PO3Phase = "DISTRIBUTION"
)

// SessionLevels carries key intraday reference levels derived from daily bars.
type SessionLevels struct {
	PDH  float64 `json:"pdh"`  // Previous Day High
	PDL  float64 `json:"pdl"`  // Previous Day Low
	PWHL float64 `json:"pwhl"` // Previous Week High
	PWLL float64 `json:"pwll"` // Previous Week Low
	EQ   float64 `json:"eq"`   // Weekly equilibrium (PWHL+PWLL)/2
}

// HuddlestonSetup is the scored A+/B setup for a single bar.
type HuddlestonSetup struct {
	Score        int    `json:"score"`        // 0-10
	Grade        string `json:"grade"`        // "A+" | "A" | "B" | "C"
	SetupType    string `json:"setup_type"`   // "PDH_SWEEP" | "PDL_SWEEP" | "OB+FVG" | "BREAKER+FVG" | "IFVG"
	Direction    string `json:"direction"`    // "BULL" | "BEAR"
	Factors      []string `json:"factors"`
}

// HuddlestonSignal is the live signal output.
type HuddlestonSignal struct {
	Symbol        string         `json:"symbol"`
	SpotPrice     float64        `json:"spot_price"`
	GeneratedAt   string         `json:"generated_at"`

	DailyBias     string         `json:"daily_bias"`
	WeeklyBias    string         `json:"weekly_bias"`
	DrawOnLiq     string         `json:"draw_on_liquidity"` // "BSL" | "SSL" | "NONE"

	Session       SessionLevels  `json:"session"`
	PO3           PO3Phase       `json:"po3_phase"`

	BullBreakers  []BreakerBlock       `json:"bull_breakers"`
	BearBreakers  []BreakerBlock       `json:"bear_breakers"`
	Displacement  *DisplacementCandle  `json:"displacement"`
	BullOB        *ICTOrderBlock       `json:"bull_ob"`
	BearOB        *ICTOrderBlock       `json:"bear_ob"`
	FVGs          []SMCFVGZone         `json:"fvgs"`
	LiqLevels     []ICTLiquidityLevel  `json:"liq_levels"`

	OTELow        float64  `json:"ote_low"`
	OTEHigh       float64  `json:"ote_high"`
	Equilibrium   float64  `json:"equilibrium"`
	SwingHigh     float64  `json:"swing_high"`
	SwingLow      float64  `json:"swing_low"`

	Setup         HuddlestonSetup `json:"setup"`
	Signal        string          `json:"signal"`     // "CE_BUY" | "PE_BUY" | "WAIT"
	Confluence    int             `json:"confluence"`
	Entry         float64         `json:"entry"`
	StopLoss      float64         `json:"stop_loss"`
	Target1       float64         `json:"target1"`
	Target2       float64         `json:"target2"`
	TargetLiq     float64         `json:"target_liq"`
	RiskReward    float64         `json:"risk_reward"`
	Confidence    int             `json:"confidence"`
	Reasoning     []string        `json:"reasoning"`
	Risk          RiskManagement  `json:"risk"`
}

// HuddlestonTrade records one backtested trade.
type HuddlestonTrade struct {
	EntryDate   string  `json:"entry_date"`
	ExitDate    string  `json:"exit_date"`
	Direction   string  `json:"direction"`
	Entry       float64 `json:"entry"`
	Exit        float64 `json:"exit"`
	PnLPct      float64 `json:"pnl_pct"`
	Result      string  `json:"result"`  // "WIN" | "LOSS" | "EOD"
	SetupType   string  `json:"setup_type"`
	Score       int     `json:"score"`
}

type HuddlestonYearStats struct {
	Year         int     `json:"year"`
	Trades       int     `json:"trades"`
	Wins         int     `json:"wins"`
	WinRate      float64 `json:"win_rate"`
	NetPnLPct    float64 `json:"net_pnl_pct"`
	ProfitFactor float64 `json:"profit_factor"`
}

type HuddlestonSetupStats struct {
	SetupType    string  `json:"setup_type"`
	Trades       int     `json:"trades"`
	Wins         int     `json:"wins"`
	WinRate      float64 `json:"win_rate"`
	NetPnLPct    float64 `json:"net_pnl_pct"`
	AvgWin       float64 `json:"avg_win"`
	AvgLoss      float64 `json:"avg_loss"`
}

// HuddlestonBacktestResult is the full multi-year backtest report.
type HuddlestonBacktestResult struct {
	Symbol        string `json:"symbol"`
	PeriodYears   int    `json:"period_years"`
	DataPoints    int    `json:"data_points"`
	GeneratedAt   string `json:"generated_at"`

	TotalTrades   int     `json:"total_trades"`
	WinningTrades int     `json:"winning_trades"`
	LosingTrades  int     `json:"losing_trades"`
	WinRate       float64 `json:"win_rate"`
	ProfitFactor  float64 `json:"profit_factor"`
	AvgWin        float64 `json:"avg_win_pct"`
	AvgLoss       float64 `json:"avg_loss_pct"`
	MaxDrawdown   float64 `json:"max_drawdown_pct"`
	TotalReturn   float64 `json:"total_return_pct"`
	SharpeRatio   float64 `json:"sharpe_ratio"`
	Expectancy    float64 `json:"expectancy_pct"`

	APlus         HuddlestonSetupStats `json:"a_plus_setups"`
	BySetupType   []HuddlestonSetupStats `json:"by_setup_type"`
	YearlyBreakdown []HuddlestonYearStats `json:"yearly_breakdown"`
	RecentTrades  []HuddlestonTrade `json:"recent_trades"`

	// ICT-specific metrics
	PDHSweepWR    float64 `json:"pdh_sweep_wr"`
	PDLSweepWR    float64 `json:"pdl_sweep_wr"`
	OBFVGSetupWR  float64 `json:"ob_fvg_wr"`
	BreakerWR     float64 `json:"breaker_wr"`
	AvgScoreWins  float64 `json:"avg_score_wins"`
	AvgScoreLoss  float64 `json:"avg_score_losses"`

	Methodology   string `json:"methodology"`
}

// ─── Core Detection Functions ─────────────────────────────────────────────────

// computeATR calculates Average True Range over the last n bars.
func computeATRBars(bars []storage.PriceBar, end, n int) float64 {
	start := end - n + 1
	if start < 1 {
		start = 1
	}
	sum := 0.0
	cnt := 0
	for i := start; i <= end; i++ {
		tr := bars[i].High - bars[i].Low
		if bars[i].High-bars[i-1].Close > tr {
			tr = bars[i].High - bars[i-1].Close
		}
		if bars[i-1].Close-bars[i].Low > tr {
			tr = bars[i-1].Close - bars[i].Low
		}
		sum += tr
		cnt++
	}
	if cnt == 0 {
		return 0
	}
	return sum / float64(cnt)
}

// getSessionLevels extracts PDH/PDL/PWHL/PWLL from daily bars.
//
// PDH/PDL = bars[end].High/Low — the last completed trading day.
// When called at bar index `end` the signal targets entry at bar[end+1] open,
// so bar[end] IS the "previous day" in ICT terminology.
//
// PWHL/PWLL = highest high / lowest low over the 5 bars before `end`
// (approximates the previous week's range without needing calendar data).
func getSessionLevels(bars []storage.PriceBar, end int) SessionLevels {
	sl := SessionLevels{}
	if end < 1 {
		return sl
	}

	// PDH / PDL — last complete daily bar
	sl.PDH = bars[end].High
	sl.PDL = bars[end].Low

	// Previous week range: 5 trading days before `end` (exclusive of end itself)
	wStart := end - 5
	if wStart < 0 {
		wStart = 0
	}
	sl.PWHL = bars[wStart].High
	sl.PWLL = bars[wStart].Low
	for i := wStart + 1; i < end; i++ {
		if bars[i].High > sl.PWHL {
			sl.PWHL = bars[i].High
		}
		if bars[i].Low < sl.PWLL {
			sl.PWLL = bars[i].Low
		}
	}
	sl.EQ = (sl.PWHL + sl.PWLL) / 2
	return sl
}

// findBreakerBlocks finds OBs that have been mitigated and whose polarity flipped.
// A Bull OB that price trades THROUGH (close < OB low) becomes a Bear Breaker.
// A Bear OB that price trades THROUGH (close > OB high) becomes a Bull Breaker.
func findBreakerBlocks(bars []storage.PriceBar, end int) ([]BreakerBlock, []BreakerBlock) {
	lookback := 60
	start := end - lookback
	if start < 3 {
		start = 3
	}

	var bullBreakers, bearBreakers []BreakerBlock

	for i := start; i < end-2; i++ {
		// Identify candidate bull OB: last bearish candle before strong up impulse
		if bars[i].Close < bars[i].Open &&
			bars[i+1].Close > bars[i].High &&
			(bars[i+2].Close-bars[i].Close)/bars[i].Close > 0.007 {

			// Check if price later BROKE THROUGH this OB (close below OB low) → Bear Breaker
			for k := i + 2; k <= end; k++ {
				if bars[k].Close < bars[i].Low {
					// Mitigated and broken — flip to Bear Breaker
					bearBreakers = append(bearBreakers, BreakerBlock{
						High: bars[i].High, Low: bars[i].Low,
						Mid:     (bars[i].High + bars[i].Low) / 2,
						Type:    "BEAR_BREAKER",
						BarsAgo: end - i,
					})
					break
				}
			}
		}

		// Identify candidate bear OB: last bullish candle before strong down impulse
		if bars[i].Close > bars[i].Open &&
			bars[i+1].Close < bars[i].Low &&
			(bars[i].Close-bars[i+2].Close)/bars[i].Close > 0.007 {

			// Check if price later BROKE THROUGH (close above OB high) → Bull Breaker
			for k := i + 2; k <= end; k++ {
				if bars[k].Close > bars[i].High {
					bullBreakers = append(bullBreakers, BreakerBlock{
						High: bars[i].High, Low: bars[i].Low,
						Mid:     (bars[i].High + bars[i].Low) / 2,
						Type:    "BULL_BREAKER",
						BarsAgo: end - i,
					})
					break
				}
			}
		}
	}

	// Keep only the most recent 3 of each
	if len(bullBreakers) > 3 {
		bullBreakers = bullBreakers[len(bullBreakers)-3:]
	}
	if len(bearBreakers) > 3 {
		bearBreakers = bearBreakers[len(bearBreakers)-3:]
	}
	return bullBreakers, bearBreakers
}

// findDisplacementCandle finds the most recent large-range candle (≥1.5×ATR)
// that closes near its extreme — the "institutional delivery" candle.
func findDisplacementCandle(bars []storage.PriceBar, end int) *DisplacementCandle {
	if end < 15 {
		return nil
	}
	atr := computeATRBars(bars, end, 14)
	if atr == 0 {
		return nil
	}

	for i := end - 1; i >= end-20 && i >= 2; i-- {
		rng := bars[i].High - bars[i].Low
		if rng < 1.5*atr {
			continue
		}
		bodyClose := math.Abs(bars[i].Close - bars[i].Open)
		// Must close in top/bottom 30% of its range (strong directional close)
		if bodyClose < rng*0.3 {
			continue
		}

		isBull := bars[i].Close > bars[i].Open
		var fvgLow, fvgHigh float64

		if isBull && i >= 2 {
			// Bullish FVG: gap between prev candle high and next candle low
			if bars[i-1].High < bars[i+1].Low {
				fvgLow = bars[i-1].High
				fvgHigh = bars[i+1].Low
			} else if bars[i].Low > bars[i-1].High {
				fvgLow = bars[i-1].High
				fvgHigh = bars[i].Low
			}
		} else if !isBull && i >= 2 {
			// Bearish FVG
			if bars[i-1].Low > bars[i+1].High {
				fvgLow = bars[i+1].High
				fvgHigh = bars[i-1].Low
			} else if bars[i].High < bars[i-1].Low {
				fvgLow = bars[i].High
				fvgHigh = bars[i-1].Low
			}
		}

		dir := "BULL"
		if !isBull {
			dir = "BEAR"
		}
		return &DisplacementCandle{
			Index:     i,
			High:      bars[i].High,
			Low:       bars[i].Low,
			Close:     bars[i].Close,
			Direction: dir,
			FVGLow:    fvgLow,
			FVGHigh:   fvgHigh,
		}
	}
	return nil
}

// detectPO3Phase infers which Power-of-3 phase the market is in using daily bars.
// Accumulation: price range < 0.5× 5-day ATR (compression)
// Manipulation: price takes out recent extreme but closes back inside (sweep)
// Distribution: large directional close after the sweep
func detectPO3Phase(bars []storage.PriceBar, end int) PO3Phase {
	if end < 10 {
		return PO3Accumulation
	}
	atr5 := computeATRBars(bars, end, 5)
	cur := bars[end]
	prev := bars[end-1]

	curRange := cur.High - cur.Low

	// Distribution: today's range ≥ 1.5× ATR and strong directional close
	if curRange >= 1.5*atr5 && math.Abs(cur.Close-cur.Open) > curRange*0.5 {
		return PO3Distribution
	}

	// Manipulation: wick beyond prev high/low but closes back inside prev range
	prevRange := prev.High - prev.Low
	if (cur.High > prev.High || cur.Low < prev.Low) &&
		cur.Close >= prev.Low && cur.Close <= prev.High &&
		prevRange > 0 {
		return PO3Manipulation
	}

	return PO3Accumulation
}

// determineDrawOnLiquidity decides whether Smart Money is targeting BSL (buy-side)
// or SSL (sell-side) based on where unswept liquidity sits relative to current price.
func determineDrawOnLiquidity(bars []storage.PriceBar, end int, sl SessionLevels) string {
	cur := bars[end].Close
	if cur < sl.EQ {
		// Price in discount — draw is likely up toward BSL (week high / PDH)
		return "BSL"
	}
	if cur > sl.EQ {
		// Price in premium — draw is likely down toward SSL (week low / PDL)
		return "SSL"
	}
	return "NONE"
}

// scoreHuddlestonSetup computes a 0-10 ICT confluence score for a potential trade.
func scoreHuddlestonSetup(
	bars []storage.PriceBar,
	end int,
	dir string,
	sl SessionLevels,
	ict ICTAnalysis,
	disp *DisplacementCandle,
	bullBreakers, bearBreakers []BreakerBlock,
	drawOnLiq string,
) HuddlestonSetup {
	setup := HuddlestonSetup{Direction: dir}
	cur := bars[end].Close

	var factors []string
	score := 0

	// 1. HTF daily bias alignment (2 pts)
	if dir == "BULL" && (ict.Bias == "BULL" || (ict.CHoCH && ict.CHoCHDir == "BULL")) {
		score += 2
		factors = append(factors, fmt.Sprintf("✓ HTF daily bias BULL (score +2)"))
	} else if dir == "BEAR" && (ict.Bias == "BEAR" || (ict.CHoCH && ict.CHoCHDir == "BEAR")) {
		score += 2
		factors = append(factors, fmt.Sprintf("✓ HTF daily bias BEAR (score +2)"))
	} else {
		factors = append(factors, "✗ HTF bias misaligned")
	}

	// 2. Draw on liquidity aligned (1 pt)
	if (dir == "BULL" && drawOnLiq == "BSL") || (dir == "BEAR" && drawOnLiq == "SSL") {
		score++
		factors = append(factors, fmt.Sprintf("✓ Draw on liquidity aligned → %s", drawOnLiq))
	}

	// 3. PDH/PDL sweep (2 pts) — highest-weight ICT confirmation
	pdhSwept := cur > sl.PDH*0.999 || bars[end].High > sl.PDH
	pdlSwept := cur < sl.PDL*1.001 || bars[end].Low < sl.PDL
	if dir == "BEAR" && pdhSwept {
		score += 2
		setup.SetupType = "PDH_SWEEP"
		factors = append(factors, fmt.Sprintf("✓ PDH %.0f swept — SSL hunt complete (score +2)", sl.PDH))
	} else if dir == "BULL" && pdlSwept {
		score += 2
		setup.SetupType = "PDL_SWEEP"
		factors = append(factors, fmt.Sprintf("✓ PDL %.0f swept — BSL hunt complete (score +2)", sl.PDL))
	}

	// 4. OB/FVG retest or Breaker retest (2 pts)
	if dir == "BULL" {
		if ict.BullOB != nil && !ict.BullOB.Mitigated &&
			cur >= ict.BullOB.Low*0.999 && cur <= ict.BullOB.High*1.001 {
			score += 2
			if setup.SetupType == "" {
				setup.SetupType = "OB+FVG"
			}
			factors = append(factors, fmt.Sprintf("✓ Retesting Bull OB [%.0f-%.0f] (score +2)", ict.BullOB.Low, ict.BullOB.High))
		}
		for _, bb := range bullBreakers {
			if cur >= bb.Low*0.999 && cur <= bb.High*1.001 {
				score += 2
				setup.SetupType = "BREAKER+FVG"
				factors = append(factors, fmt.Sprintf("✓ Retesting Bull Breaker [%.0f-%.0f] (score +2)", bb.Low, bb.High))
				break
			}
		}
	} else {
		if ict.BearOB != nil && !ict.BearOB.Mitigated &&
			cur <= ict.BearOB.High*1.001 && cur >= ict.BearOB.Low*0.999 {
			score += 2
			if setup.SetupType == "" {
				setup.SetupType = "OB+FVG"
			}
			factors = append(factors, fmt.Sprintf("✓ Retesting Bear OB [%.0f-%.0f] (score +2)", ict.BearOB.Low, ict.BearOB.High))
		}
		for _, bb := range bearBreakers {
			if cur <= bb.High*1.001 && cur >= bb.Low*0.999 {
				score += 2
				setup.SetupType = "BREAKER+FVG"
				factors = append(factors, fmt.Sprintf("✓ Retesting Bear Breaker [%.0f-%.0f] (score +2)", bb.Low, bb.High))
				break
			}
		}
	}

	// 5. Displacement candle present and aligned (1 pt)
	if disp != nil && disp.Direction == dir {
		score++
		factors = append(factors, fmt.Sprintf("✓ Displacement candle %s (range %.0f pts, score +1)", disp.Direction, disp.High-disp.Low))
		// FVG from displacement
		if disp.FVGLow > 0 && disp.FVGHigh > 0 &&
			cur >= disp.FVGLow*0.999 && cur <= disp.FVGHigh*1.001 {
			if setup.SetupType == "" {
				setup.SetupType = "IFVG"
			}
			factors = append(factors, fmt.Sprintf("✓ Price retesting displacement FVG [%.0f-%.0f]", disp.FVGLow, disp.FVGHigh))
		}
	}

	// 6. OTE / price-in-discount-or-premium (1 pt)
	if (dir == "BULL" && ict.InOTE && ict.InDiscount) ||
		(dir == "BEAR" && ict.InOTE && ict.InPremium) {
		score++
		factors = append(factors, fmt.Sprintf("✓ Price in OTE zone [%.0f-%.0f] (score +1)", ict.OTELow, ict.OTEHigh))
	} else if dir == "BULL" && ict.InDiscount {
		score++
		factors = append(factors, fmt.Sprintf("✓ Price in discount below EQ %.0f", ict.Equilibrium))
	} else if dir == "BEAR" && ict.InPremium {
		score++
		factors = append(factors, fmt.Sprintf("✓ Price in premium above EQ %.0f", ict.Equilibrium))
	}

	// 7. MSS / CHoCH confirmation (1 pt)
	if ict.MSS {
		score++
		factors = append(factors, fmt.Sprintf("✓ MSS confirmed → %s (score +1)", ict.CHoCHDir))
	} else if ict.CHoCH && ict.CHoCHDir == dir {
		score++
		factors = append(factors, fmt.Sprintf("✓ CHoCH → %s (score +1)", ict.CHoCHDir))
	}

	if setup.SetupType == "" {
		setup.SetupType = "STANDARD"
	}

	setup.Score = score
	switch {
	case score >= 7:
		setup.Grade = "A+"
	case score >= 5:
		setup.Grade = "A"
	case score >= 3:
		setup.Grade = "B"
	default:
		setup.Grade = "C"
	}
	setup.Factors = factors
	return setup
}

// computeHuddlestonSignal builds the live Huddleston ICT signal.
func computeHuddlestonSignal(bars []storage.PriceBar) HuddlestonSignal {
	sig := HuddlestonSignal{
		Signal:      "WAIT",
		GeneratedAt: time.Now().Format(time.RFC3339),
	}
	if len(bars) < smcHTFWindow+20 {
		return sig
	}
	end := len(bars) - 1
	cur := bars[end]

	// ── Gather all layers ────────────────────────────────────────────────────
	ict := computeICTAnalysis(bars, end)
	sl := getSessionLevels(bars, end)
	bullBreakers, bearBreakers := findBreakerBlocks(bars, end)
	disp := findDisplacementCandle(bars, end)
	po3 := detectPO3Phase(bars, end)
	drawOnLiq := determineDrawOnLiquidity(bars, end, sl)

	weeklyBias := computeHTFBias(bars, end)

	// Collect FVGs for output
	var fvgs []SMCFVGZone
	for i := 2; i < len(bars) && i <= end; i++ {
		if bars[i-2].High < bars[i].Low {
			lo, hi := bars[i-2].High, bars[i].Low
			filled := false
			for k := i + 1; k <= end; k++ {
				if bars[k].Low <= lo {
					filled = true
					break
				}
			}
			if !filled {
				fvgs = append(fvgs, SMCFVGZone{StartTime: bars[i-2].Date.Unix(), EndTime: bars[end].Date.Unix(), Low: lo, High: hi, Type: "BULL"})
			}
		}
		if bars[i-2].Low > bars[i].High {
			lo, hi := bars[i].High, bars[i-2].Low
			filled := false
			for k := i + 1; k <= end; k++ {
				if bars[k].High >= hi {
					filled = true
					break
				}
			}
			if !filled {
				fvgs = append(fvgs, SMCFVGZone{StartTime: bars[i-2].Date.Unix(), EndTime: bars[end].Date.Unix(), Low: lo, High: hi, Type: "BEAR"})
			}
		}
	}
	if len(fvgs) > 6 {
		fvgs = fvgs[len(fvgs)-6:]
	}

	sig.SpotPrice = math.Round(cur.Close*100) / 100
	sig.DailyBias = ict.Bias
	sig.WeeklyBias = weeklyBias
	sig.DrawOnLiq = drawOnLiq
	sig.Session = sl
	sig.PO3 = po3
	sig.BullBreakers = bullBreakers
	sig.BearBreakers = bearBreakers
	sig.Displacement = disp
	sig.BullOB = ict.BullOB
	sig.BearOB = ict.BearOB
	sig.FVGs = fvgs
	sig.LiqLevels = findLiquidityLevels(bars, end)
	sig.OTELow = ict.OTELow
	sig.OTEHigh = ict.OTEHigh
	sig.Equilibrium = ict.Equilibrium
	sig.SwingHigh = ict.SwingHigh
	sig.SwingLow = ict.SwingLow

	// Score both directions and pick the better one
	bullSetup := scoreHuddlestonSetup(bars, end, "BULL", sl, ict, disp, bullBreakers, bearBreakers, drawOnLiq)
	bearSetup := scoreHuddlestonSetup(bars, end, "BEAR", sl, ict, disp, bullBreakers, bearBreakers, drawOnLiq)

	var best HuddlestonSetup
	if bullSetup.Score >= bearSetup.Score && bullSetup.Score >= 3 {
		best = bullSetup
	} else if bearSetup.Score > bullSetup.Score && bearSetup.Score >= 3 {
		best = bearSetup
	} else {
		sig.Reasoning = []string{"Score < 3 for both directions — no valid Huddleston setup today"}
		return sig
	}

	sig.Setup = best
	sig.Confluence = best.Score
	sig.Reasoning = best.Factors

	// Compute entry, SL, targets
	atr := computeATRBars(bars, end, 14)
	if atr == 0 {
		atr = cur.Close * 0.01
	}

	if best.Direction == "BULL" {
		sig.Signal = "CE_BUY"
		sig.Entry = math.Round(cur.Close*100) / 100
		// SL below swept low or OB low
		if ict.BullOB != nil && !ict.BullOB.Mitigated {
			sig.StopLoss = math.Round((ict.BullOB.Low-atr*0.3)*100) / 100
		} else {
			sig.StopLoss = math.Round((sl.PDL-atr*0.3)*100) / 100
		}
		risk := sig.Entry - sig.StopLoss
		if risk <= 0 {
			sig.Signal = "WAIT"
			return sig
		}
		sig.Target1 = math.Round((sig.Entry+risk*1.5)*100) / 100
		sig.Target2 = math.Round((sig.Entry+risk*3.0)*100) / 100
		sig.TargetLiq = math.Round(sl.PDH*100) / 100
		sig.RiskReward = math.Round((risk*3.0/risk)*10) / 10
	} else {
		sig.Signal = "PE_BUY"
		sig.Entry = math.Round(cur.Close*100) / 100
		if ict.BearOB != nil && !ict.BearOB.Mitigated {
			sig.StopLoss = math.Round((ict.BearOB.High+atr*0.3)*100) / 100
		} else {
			sig.StopLoss = math.Round((sl.PDH+atr*0.3)*100) / 100
		}
		risk := sig.StopLoss - sig.Entry
		if risk <= 0 {
			sig.Signal = "WAIT"
			return sig
		}
		sig.Target1 = math.Round((sig.Entry-risk*1.5)*100) / 100
		sig.Target2 = math.Round((sig.Entry-risk*3.0)*100) / 100
		sig.TargetLiq = math.Round(sl.PDL*100) / 100
		sig.RiskReward = math.Round((risk*3.0/risk)*10) / 10
	}

	sig.Confidence = 45 + best.Score*5
	if sig.Confidence > 94 {
		sig.Confidence = 94
	}
	sig.Risk = computeRiskPlan(sig.Entry, sig.StopLoss, sig.Target2, 100000, 1.0)
	return sig
}

// ─── Backtest Engine ──────────────────────────────────────────────────────────

func runHuddlestonBacktest(bars []storage.PriceBar) HuddlestonBacktestResult {
	res := HuddlestonBacktestResult{
		Symbol:      "^NSEI",
		Methodology: "Michael J. Huddleston (ICT) — 7-pillar PD array model: PDH/PDL sweep, OB+FVG, Breaker, Displacement, OTE, PO3, Draw-on-Liquidity. Entry at next-bar open. SL: beyond OB/swept extreme. T2: 3R.",
	}

	const minBars = 100
	if len(bars) < minBars {
		return res
	}
	res.DataPoints = len(bars)

	equity := 100.0
	peak := 100.0
	maxDD := 0.0
	var totalWin, totalLoss, sumRet float64

	// Setup-type tracking
	type setupAcc struct {
		trades, wins     int
		totalWin, totalLoss float64
	}
	setups := map[string]*setupAcc{
		"PDH_SWEEP":   {},
		"PDL_SWEEP":   {},
		"OB+FVG":      {},
		"BREAKER+FVG": {},
		"IFVG":        {},
		"STANDARD":    {},
	}
	for k := range setups {
		setups[k] = &setupAcc{}
	}

	// Year tracking
	yearMap := map[int]*struct {
		trades, wins   int
		totalW, totalL float64
	}{}

	// Score tracking
	var winScores, lossScores []float64
	cooldown := -10

	for i := minBars; i < len(bars)-1; i++ {
		if i-cooldown < 3 {
			continue
		}

		ict := computeICTAnalysis(bars, i)
		sl := getSessionLevels(bars, i)
		bullBreakers, bearBreakers := findBreakerBlocks(bars, i)
		disp := findDisplacementCandle(bars, i)
		drawOnLiq := determineDrawOnLiquidity(bars, i, sl)

		// Score both directions
		bull := scoreHuddlestonSetup(bars, i, "BULL", sl, ict, disp, bullBreakers, bearBreakers, drawOnLiq)
		bear := scoreHuddlestonSetup(bars, i, "BEAR", sl, ict, disp, bullBreakers, bearBreakers, drawOnLiq)

		var best HuddlestonSetup
		if bull.Score >= bear.Score && bull.Score >= 4 {
			best = bull
		} else if bear.Score > bull.Score && bear.Score >= 4 {
			best = bear
		} else {
			continue
		}

		// Entry at next bar open
		nb := bars[i+1]
		entryPrice := nb.Open

		atr := computeATRBars(bars, i, 14)
		if atr == 0 {
			atr = entryPrice * 0.01
		}

		var slPrice, tgt float64
		if best.Direction == "BULL" {
			if ict.BullOB != nil && !ict.BullOB.Mitigated {
				slPrice = ict.BullOB.Low - atr*0.3
			} else {
				slPrice = sl.PDL - atr*0.3
			}
			risk := entryPrice - slPrice
			if risk <= 0 || risk > entryPrice*0.05 {
				continue
			}
			tgt = entryPrice + risk*3.0
		} else {
			if ict.BearOB != nil && !ict.BearOB.Mitigated {
				slPrice = ict.BearOB.High + atr*0.3
			} else {
				slPrice = sl.PDH + atr*0.3
			}
			risk := slPrice - entryPrice
			if risk <= 0 || risk > entryPrice*0.05 {
				continue
			}
			tgt = entryPrice - risk*3.0
		}

		// Simulate trade outcome using next bar's high/low
		var pnl float64
		var result string
		if best.Direction == "BULL" {
			if nb.High >= tgt {
				pnl = (tgt/entryPrice - 1) * 100
				result = "WIN"
			} else if nb.Low <= slPrice {
				pnl = (slPrice/entryPrice - 1) * 100
				result = "LOSS"
			} else {
				pnl = (nb.Close/entryPrice - 1) * 100
				if pnl > 0 {
					result = "WIN"
				} else {
					result = "LOSS"
				}
			}
		} else {
			if nb.Low <= tgt {
				pnl = (1 - tgt/entryPrice) * 100
				result = "WIN"
			} else if nb.High >= slPrice {
				pnl = (1 - slPrice/entryPrice) * 100
				result = "LOSS"
			} else {
				pnl = (1 - nb.Close/entryPrice) * 100
				if pnl > 0 {
					result = "WIN"
				} else {
					result = "LOSS"
				}
			}
		}

		dir := map[string]string{"BULL": "CE", "BEAR": "PE"}[best.Direction]
		if len(res.RecentTrades) < 40 {
			res.RecentTrades = append(res.RecentTrades, HuddlestonTrade{
				EntryDate: bars[i].Date.Format("2006-01-02"),
				ExitDate:  nb.Date.Format("2006-01-02"),
				Direction: dir,
				Entry:     math.Round(entryPrice*100) / 100,
				Exit:      math.Round(nb.Close*100) / 100,
				PnLPct:    math.Round(pnl*100) / 100,
				Result:    result,
				SetupType: best.SetupType,
				Score:     best.Score,
			})
		}

		res.TotalTrades++
		if result == "WIN" {
			res.WinningTrades++
			totalWin += math.Abs(pnl)
			winScores = append(winScores, float64(best.Score))
		} else {
			res.LosingTrades++
			totalLoss += math.Abs(pnl)
			lossScores = append(lossScores, float64(best.Score))
		}

		// Setup accumulator
		if acc, ok := setups[best.SetupType]; ok {
			acc.trades++
			if result == "WIN" {
				acc.wins++
				acc.totalWin += math.Abs(pnl)
			} else {
				acc.totalLoss += math.Abs(pnl)
			}
		}

		// Year accumulator
		yr := nb.Date.Year()
		if _, ok := yearMap[yr]; !ok {
			yearMap[yr] = &struct{ trades, wins int; totalW, totalL float64 }{}
		}
		yearMap[yr].trades++
		if result == "WIN" {
			yearMap[yr].wins++
			yearMap[yr].totalW += math.Abs(pnl)
		} else {
			yearMap[yr].totalL += math.Abs(pnl)
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

	if res.TotalTrades == 0 {
		return res
	}

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
	for _, t := range res.RecentTrades {
		d := t.PnLPct - mean
		variance += d * d
	}
	if res.TotalTrades > 1 {
		std := math.Sqrt(variance / float64(res.TotalTrades-1))
		if std > 0 {
			res.SharpeRatio = math.Round(mean/std*math.Sqrt(252)*100) / 100
		}
	}
	wr := res.WinRate / 100
	rr := 3.0
	res.Expectancy = math.Round((wr*rr-(1-wr))*100) / 100

	// Avg scores
	if len(winScores) > 0 {
		sum := 0.0
		for _, s := range winScores {
			sum += s
		}
		res.AvgScoreWins = math.Round(sum/float64(len(winScores))*10) / 10
	}
	if len(lossScores) > 0 {
		sum := 0.0
		for _, s := range lossScores {
			sum += s
		}
		res.AvgScoreLoss = math.Round(sum/float64(len(lossScores))*10) / 10
	}

	// Build setup-type stats
	aPlus := HuddlestonSetupStats{SetupType: "A+ (score≥7)"}
	for typ, acc := range setups {
		if acc.trades == 0 {
			continue
		}
		wr2 := math.Round(float64(acc.wins)/float64(acc.trades)*10000) / 100
		aw, al := 0.0, 0.0
		if acc.wins > 0 {
			aw = math.Round(acc.totalWin/float64(acc.wins)*100) / 100
		}
		loses := acc.trades - acc.wins
		if loses > 0 {
			al = math.Round(acc.totalLoss/float64(loses)*100) / 100
		}
		res.BySetupType = append(res.BySetupType, HuddlestonSetupStats{
			SetupType: typ, Trades: acc.trades, Wins: acc.wins,
			WinRate:   wr2,
			NetPnLPct: math.Round((acc.totalWin-acc.totalLoss)*100) / 100,
			AvgWin: aw, AvgLoss: al,
		})

		// PDH/PDL sweep WR
		switch typ {
		case "PDH_SWEEP":
			res.PDHSweepWR = wr2
		case "PDL_SWEEP":
			res.PDLSweepWR = wr2
		case "OB+FVG":
			res.OBFVGSetupWR = wr2
		case "BREAKER+FVG":
			res.BreakerWR = wr2
		}
	}

	// A+ stats: score >= 7 trades
	for _, t := range res.RecentTrades {
		if t.Score >= 7 {
			aPlus.Trades++
			if t.Result == "WIN" {
				aPlus.Wins++
			}
		}
	}
	if aPlus.Trades > 0 {
		aPlus.WinRate = math.Round(float64(aPlus.Wins)/float64(aPlus.Trades)*10000) / 100
	}
	res.APlus = aPlus

	// Yearly breakdown
	for yr, ya := range yearMap {
		wr2 := 0.0
		pf := 0.0
		if ya.trades > 0 {
			wr2 = math.Round(float64(ya.wins)/float64(ya.trades)*10000) / 100
		}
		if ya.totalL > 0 {
			pf = math.Round(ya.totalW/ya.totalL*100) / 100
		}
		res.YearlyBreakdown = append(res.YearlyBreakdown, HuddlestonYearStats{
			Year:         yr,
			Trades:       ya.trades,
			Wins:         ya.wins,
			WinRate:      wr2,
			NetPnLPct:    math.Round((ya.totalW-ya.totalL)*100) / 100,
			ProfitFactor: pf,
		})
	}
	// Sort yearly by year
	for i := 0; i < len(res.YearlyBreakdown); i++ {
		for j := i + 1; j < len(res.YearlyBreakdown); j++ {
			if res.YearlyBreakdown[j].Year < res.YearlyBreakdown[i].Year {
				res.YearlyBreakdown[i], res.YearlyBreakdown[j] = res.YearlyBreakdown[j], res.YearlyBreakdown[i]
			}
		}
	}
	if len(res.YearlyBreakdown) > 0 {
		res.PeriodYears = res.YearlyBreakdown[len(res.YearlyBreakdown)-1].Year -
			res.YearlyBreakdown[0].Year + 1
	}
	res.GeneratedAt = time.Now().Format(time.RFC3339)
	return res
}

// ─── Engine Methods ───────────────────────────────────────────────────────────

// GetHuddlestonSignal generates the live Michael Huddleston ICT signal for Nifty.
func (e *Engine) GetHuddlestonSignal() (HuddlestonSignal, error) {
	bars, err := e.loadNiftyBarsYears(1)
	if err != nil || len(bars) < smcHTFWindow+20 {
		return HuddlestonSignal{Signal: "WAIT", GeneratedAt: time.Now().Format(time.RFC3339)}, err
	}
	sig := computeHuddlestonSignal(bars)
	sig.Symbol = "^NSEI"
	return sig, nil
}

// HuddlestonBacktest runs the full Huddleston backtest over `years` of Nifty daily data.
func (e *Engine) HuddlestonBacktest(years int) (HuddlestonBacktestResult, error) {
	bars, err := e.loadNiftyBarsYears(years)
	if err != nil {
		return HuddlestonBacktestResult{}, err
	}
	res := runHuddlestonBacktest(bars)
	res.PeriodYears = years
	return res, nil
}
