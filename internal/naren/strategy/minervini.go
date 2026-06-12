package strategy

import (
	"math"
	"sort"
	"strings"
	"time"

	"stockwise/internal/naren/storage"
)

// ═══════════════════════════════════════════════════════════════════════════
//   MARK MINERVINI'S SEPA STRATEGY
//   Source: "Trade Like a Stock Market Wizard" (2013)
//           "Think & Trade Like a Champion" (2017)
//   Author audited returns: 155% (1997 US Investing Championship)
//                            220% (2021 US Investing Championship)
//                            30-year average ~30% annual
//
//   PIPELINE:
//     1. Trend Template (8 binary criteria, max 100 score)
//     2. Stage Analysis (1=basing, 2=advancing, 3=topping, 4=declining)
//     3. VCP (Volatility Contraction Pattern) detection
//     4. Pivot Buy Point calculation
//     5. Position sizing (1.25% risk per trade, 7-8% max stop)
//     6. Profit-taking rules (1/3 at +8%, trail rest on 20MA break)
//
//   FOR NIFTY OPTIONS USAGE:
//     - Stocks in Stage 2 with high Trend Template score → BUY CE
//     - Stocks in Stage 4 with low Trend Template score   → BUY PE
//     - Stage 1/3 → WAIT (no trade)
// ═══════════════════════════════════════════════════════════════════════════

type MinerviniPick struct {
	Symbol           string  `json:"symbol"`
	Name             string  `json:"name"`
	Sector           string  `json:"sector"`
	CurrentPrice     float64 `json:"current_price"`

	// 8-Point Trend Template (each = 12.5 pts, max 100)
	Pt1PriceAbove150_200 bool `json:"pt1_price_above_150_200"`
	Pt2_150Above200      bool `json:"pt2_150_above_200"`
	Pt3_200TrendingUp    bool `json:"pt3_200_trending_up"`
	Pt4_50AboveBoth      bool `json:"pt4_50_above_both"`
	Pt5PriceAbove50      bool `json:"pt5_price_above_50"`
	Pt6_30PctAboveLow    bool `json:"pt6_30pct_above_low"`
	Pt7Within25PctHigh   bool `json:"pt7_within_25pct_high"`
	Pt8RSRating70Plus    bool `json:"pt8_rs_rating_70plus"`
	TrendTemplateScore   int  `json:"trend_template_score"` // 0-100

	// Stage Analysis
	Stage       int    `json:"stage"`        // 1=basing, 2=advancing, 3=topping, 4=declining
	StageLabel  string `json:"stage_label"`

	// VCP Pattern
	VCPDetected     bool    `json:"vcp_detected"`
	VCPContractions int     `json:"vcp_contractions"`
	BasePriceLow    float64 `json:"base_price_low"`
	BasePriceHigh   float64 `json:"base_price_high"`
	PivotPrice      float64 `json:"pivot_price"`

	// Key levels
	MA50  float64 `json:"ma_50"`
	MA150 float64 `json:"ma_150"`
	MA200 float64 `json:"ma_200"`
	Low52w float64 `json:"low_52w"`
	High52w float64 `json:"high_52w"`
	RSRating int   `json:"rs_rating"`

	// Trade levels
	Signal         string  `json:"signal"`          // BUY_CE | BUY_PE | HOLD | WAIT
	Direction      string  `json:"direction"`       // CE | PE | NONE
	Entry          float64 `json:"entry"`
	StopLoss       float64 `json:"stop_loss"`
	StopPct        float64 `json:"stop_pct"`        // Distance to stop in %
	Target1        float64 `json:"target_1"`        // +8% profit lock
	Target2        float64 `json:"target_2"`        // +20-25% full target
	SuggestedLots  int     `json:"suggested_lots"`
	MaxLossINR     float64 `json:"max_loss_inr"`
	TargetGainINR  float64 `json:"target_gain_inr"`
	RiskReward     float64 `json:"risk_reward"`

	// Rating
	Rating       string   `json:"rating"`         // EXCELLENT | GOOD | FAIR | WAIT | AVOID
	Reasoning    []string `json:"reasoning"`
	Caveats      []string `json:"caveats"`

	GeneratedAt string `json:"generated_at"`
}

type MinerviniReport struct {
	Picks       []MinerviniPick `json:"picks"`
	TopBuys     []MinerviniPick `json:"top_buys"`       // Stage 2, score ≥ 75
	TopShorts   []MinerviniPick `json:"top_shorts"`     // Stage 4, score ≤ 25
	Stage1Watch []MinerviniPick `json:"stage1_watch"`   // Bases forming
	Methodology string          `json:"methodology"`
	BookSource  string          `json:"book_source"`
	GeneratedAt string          `json:"generated_at"`
	DataAsOf    string          `json:"data_as_of"`     // date of the most recent price bar used
	NiftyRS6M   float64         `json:"nifty_rs_6m"`    // Nifty 6-month return used as RS benchmark
}

// ─── ENGINE ENTRY POINT ──────────────────────────────────────────────────────

func (e *Engine) GetMinerviniPicks(accountSize, riskPct float64) (MinerviniReport, error) {
	if accountSize <= 0 {
		accountSize = 100000
	}
	if riskPct <= 0 {
		riskPct = 1.25 // Minervini's exact recommendation
	}

	stocks, err := e.repo.GetStocksByMarket("NSE")
	if err != nil {
		return MinerviniReport{}, err
	}

	var picks []MinerviniPick
	now := time.Now()
	from := now.AddDate(-2, 0, 0)

	// Compute Nifty's 6-month return as the RS benchmark for all stocks
	niftyBenchmark := 0.0
	if niftybars, err2 := e.loadNiftyBarsYears(1); err2 == nil && len(niftybars) >= 130 {
		n := len(niftybars)
		niftyBenchmark = (niftybars[n-1].Close/niftybars[n-130].Close - 1) * 100
	}

	for _, s := range stocks {
		// Only Nifty stocks (NSE market, not index)
		if s.IsIndex || s.Market != "NSE" {
			continue
		}
		bars, err := e.repo.GetPriceBars(s.ID, from, now)
		if err != nil || len(bars) < 220 {
			continue
		}
		pick := analyzeMinervini(s, bars, accountSize, riskPct, niftyBenchmark)
		if pick.Symbol == "" {
			continue
		}
		picks = append(picks, pick)
	}

	sort.Slice(picks, func(i, j int) bool {
		return picks[i].TrendTemplateScore > picks[j].TrendTemplateScore
	})

	// Categorize
	var topBuys, topShorts, stage1Watch []MinerviniPick
	for _, p := range picks {
		switch {
		case p.Stage == 2 && p.TrendTemplateScore >= 75:
			topBuys = append(topBuys, p)
		case p.Stage == 4 && p.TrendTemplateScore <= 25:
			topShorts = append(topShorts, p)
		case p.Stage == 1:
			stage1Watch = append(stage1Watch, p)
		}
	}

	// Data-as-of: last price bar date across all analyzed stocks
	dataAsOf := ""
	if len(picks) > 0 {
		// Use the last bar date from any pick that has one (they all share the same pipeline run date)
		for _, s := range stocks {
			if s.IsIndex || s.Market != "NSE" {
				continue
			}
			if lastDate, err2 := e.repo.GetLastPriceDate(s.ID); err2 == nil && !lastDate.IsZero() {
				dataAsOf = lastDate.Format("02 Jan 2006")
				break
			}
		}
	}

	return MinerviniReport{
		Picks:       picks,
		TopBuys:     topBuys,
		TopShorts:   topShorts,
		Stage1Watch: stage1Watch,
		Methodology: "Mark Minervini's SEPA: Trend Template (8 criteria) + Stage Analysis + VCP Pattern Detection. " +
			"BUY only Stage 2 stocks with 75+ score on confirmed VCP pivot breakout. " +
			"Max risk 1.25% per trade, hard stop at 7-8% below entry. " +
			"Sell 1/3 at +8% to lock profit, trail rest with 20-day MA break.",
		BookSource:  "Trade Like a Stock Market Wizard (Minervini, 2013) — verified 220% return at 2021 US Investing Championship",
		GeneratedAt: now.Format(time.RFC3339),
		DataAsOf:    dataAsOf,
		NiftyRS6M:   math.Round(niftyBenchmark*10) / 10,
	}, nil
}

// ─── Name map — fallback when DB name is empty ────────────────────────────────

var nseDisplayNames = map[string]string{
	"TCS.NS":        "Tata Consultancy Services",
	"ICICIBANK.NS":  "ICICI Bank",
	"HDFCBANK.NS":   "HDFC Bank",
	"INFY.NS":       "Infosys",
	"RELIANCE.NS":   "Reliance Industries",
	"HINDUNILVR.NS": "Hindustan Unilever",
	"SBIN.NS":       "State Bank of India",
	"BHARTIARTL.NS": "Bharti Airtel",
	"ITC.NS":        "ITC Ltd",
	"KOTAKBANK.NS":  "Kotak Mahindra Bank",
	"LT.NS":         "Larsen & Toubro",
	"AXISBANK.NS":   "Axis Bank",
	"ASIANPAINT.NS": "Asian Paints",
	"MARUTI.NS":     "Maruti Suzuki",
	"TITAN.NS":      "Titan Company",
	"BAJFINANCE.NS": "Bajaj Finance",
	"WIPRO.NS":      "Wipro",
	"HCLTECH.NS":    "HCL Technologies",
	"ULTRACEMCO.NS": "UltraTech Cement",
	"NESTLEIND.NS":  "Nestle India",
	"SUNPHARMA.NS":  "Sun Pharma",
	"ONGC.NS":       "ONGC",
	"NTPC.NS":       "NTPC",
	"POWERGRID.NS":  "Power Grid Corp",
	"ADANIENT.NS":   "Adani Enterprises",
	"CIPLA.NS":      "Cipla",
	"DRREDDY.NS":    "Dr. Reddy's Laboratories",
	"TATAMOTORS.NS": "Tata Motors",
	"BAJAJFINSV.NS": "Bajaj Finserv",
	"M&M.NS":        "Mahindra & Mahindra",
}

// ─── ANALYSIS ────────────────────────────────────────────────────────────────

// analyzeMinervini scores one stock. benchmarkReturn6M is the Nifty 50's own
// 6-month return (%) — used to compute true relative strength (RS rating).
func analyzeMinervini(stock storage.Stock, bars []storage.PriceBar, accountSize, riskPct, benchmarkReturn6M float64) MinerviniPick {
	n := len(bars)
	if n < 220 {
		return MinerviniPick{}
	}

	closes := make([]float64, n)
	highs := make([]float64, n)
	lows := make([]float64, n)
	vols := make([]float64, n)
	for i, b := range bars {
		closes[i] = b.Close
		highs[i] = b.High
		lows[i] = b.Low
		vols[i] = float64(b.Volume)
	}

	last := bars[n-1]
	price := last.Close

	// Moving averages (simple)
	ma50 := smaTail(closes, 50)
	ma150 := smaTail(closes, 150)
	ma200 := smaTail(closes, 200)
	ma200_30daysAgo := smaTail(closes[:n-21], 200)

	// 52-week high/low
	low52 := minF(lows[n-min(252, n):])
	high52 := maxF(highs[n-min(252, n):])

	// RS Rating proxy: stock's 6-month return percentile (vs Nifty 50, using Nifty's return as benchmark)
	rs := computeRSRating(closes, n, benchmarkReturn6M)

	// ─── 8-Point Trend Template ─────────────────────────────────────────────
	pt1 := price > ma150 && price > ma200
	pt2 := ma150 > ma200
	pt3 := ma200 > ma200_30daysAgo
	pt4 := ma50 > ma150 && ma50 > ma200
	pt5 := price > ma50
	pt6 := low52 > 0 && (price/low52-1) >= 0.30
	pt7 := high52 > 0 && (1-price/high52) <= 0.25
	pt8 := rs >= 70

	score := 0
	for _, ok := range []bool{pt1, pt2, pt3, pt4, pt5, pt6, pt7, pt8} {
		if ok {
			score += 13 // 13×8 = 104 (rounding gives nice numbers)
		}
	}
	if score > 100 {
		score = 100
	}

	// ─── Stage Analysis ─────────────────────────────────────────────────────
	stage, stageLbl := detectStage(price, ma50, ma150, ma200, ma200_30daysAgo, closes, n)

	// ─── VCP Detection ──────────────────────────────────────────────────────
	vcpDetected, contractions, baseLo, baseHi, pivot := detectVCP(bars)

	// ─── Signal ─────────────────────────────────────────────────────────────
	signal := "WAIT"
	direction := "NONE"
	entry := price
	stop := price * 0.92  // default 8% stop
	tgt1 := price * 1.08
	tgt2 := price * 1.25

	reasoning := []string{}
	caveats := []string{}

	if stage == 2 && score >= 75 {
		signal = "BUY_CE"
		direction = "CE"
		if vcpDetected && pivot > 0 {
			entry = pivot
			stop = baseLo * 0.99 // 1% below base low
			if stop < entry*0.92 {
				stop = entry * 0.92 // cap at 8% per Minervini
			}
			tgt1 = entry * 1.08
			tgt2 = entry * 1.25
			reasoning = append(reasoning, "✓ Stage 2 advancing — Minervini's only buyable stage")
			reasoning = append(reasoning, "✓ VCP pattern detected with "+itoaSafe(contractions)+" contractions — base is tight")
			reasoning = append(reasoning, "✓ Pivot buy point at ₹"+fmt2f(pivot)+" — enter on breakout with volume")
		} else {
			reasoning = append(reasoning, "✓ Stage 2 advancing — strong trend")
			reasoning = append(reasoning, "△ No clean VCP yet — wait for tight base before entry")
			caveats = append(caveats, "Best to wait for VCP base to form rather than chase")
		}
		reasoning = append(reasoning, "✓ Trend Template "+itoaSafe(score)+"/100 — high quality")
	} else if stage == 4 && score <= 25 {
		signal = "BUY_PE"
		direction = "PE"
		entry = price
		stop = ma50 * 1.02 // PE stop just above 50MA reclaim
		if stop > entry*1.08 {
			stop = entry * 1.08
		}
		tgt1 = entry * 0.92
		tgt2 = entry * 0.75
		reasoning = append(reasoning, "✗ Stage 4 declining — short opportunity")
		reasoning = append(reasoning, "✗ Trend Template "+itoaSafe(score)+"/100 — weak")
		caveats = append(caveats, "Shorts/PE buys are higher-risk than longs — keep tight stops")
	} else if stage == 1 {
		signal = "WAIT"
		reasoning = append(reasoning, "△ Stage 1 basing — accumulate watchlist, no entry yet")
		reasoning = append(reasoning, "△ Wait for breakout above resistance to confirm Stage 2 transition")
	} else if stage == 3 {
		signal = "HOLD"
		reasoning = append(reasoning, "△ Stage 3 topping — existing holders should tighten stops")
		caveats = append(caveats, "Avoid new long entries; distribution often follows")
	} else {
		signal = "WAIT"
		reasoning = append(reasoning, "△ No clean setup — Trend Template "+itoaSafe(score)+"/100")
	}

	// Stop distance + position size
	stopDistPct := math.Abs(entry-stop) / entry * 100
	if stopDistPct < 1 {
		stopDistPct = 1
	}
	riskINR := accountSize * riskPct / 100
	// Each lot of 50 qty, option premium move ≈ spot move × 0.5 delta
	slPremiumPerLot := stopDistPct / 100 * entry * 0.5 * 50
	lots := 1
	if slPremiumPerLot > 0 {
		lots = int(math.Floor(riskINR / slPremiumPerLot))
	}
	if lots < 1 {
		lots = 1
	}
	maxLoss := slPremiumPerLot * float64(lots)
	tgtMove := math.Abs(tgt1-entry) / entry * 100
	tgtGain := tgtMove / 100 * entry * 0.5 * 50 * float64(lots)
	rr := math.Abs(tgt1-entry) / math.Max(math.Abs(entry-stop), 0.0001)

	// ─── Rating ─────────────────────────────────────────────────────────────
	rating := "WAIT"
	if signal == "BUY_CE" && vcpDetected && score >= 87 {
		rating = "EXCELLENT"
	} else if signal == "BUY_CE" && score >= 75 {
		rating = "GOOD"
	} else if signal == "BUY_PE" && score <= 25 {
		rating = "GOOD"
	} else if signal == "WAIT" && stage == 1 {
		rating = "WATCH"
	} else if signal == "HOLD" {
		rating = "FAIR"
	} else {
		rating = "AVOID"
	}

	displayName := stock.Name
	if displayName == "" {
		if n, ok := nseDisplayNames[stock.Symbol]; ok {
			displayName = n
		} else {
			// Strip .NS suffix as readable fallback
			displayName = strings.TrimSuffix(stock.Symbol, ".NS")
		}
	}

	return MinerviniPick{
		Symbol:               stock.Symbol,
		Name:                 displayName,
		Sector:               stock.Sector,
		CurrentPrice:         math.Round(price*100) / 100,
		Pt1PriceAbove150_200: pt1,
		Pt2_150Above200:      pt2,
		Pt3_200TrendingUp:    pt3,
		Pt4_50AboveBoth:      pt4,
		Pt5PriceAbove50:      pt5,
		Pt6_30PctAboveLow:    pt6,
		Pt7Within25PctHigh:   pt7,
		Pt8RSRating70Plus:    pt8,
		TrendTemplateScore:   score,
		Stage:                stage,
		StageLabel:           stageLbl,
		VCPDetected:          vcpDetected,
		VCPContractions:      contractions,
		BasePriceLow:         math.Round(baseLo*100) / 100,
		BasePriceHigh:        math.Round(baseHi*100) / 100,
		PivotPrice:           math.Round(pivot*100) / 100,
		MA50:                 math.Round(ma50*100) / 100,
		MA150:                math.Round(ma150*100) / 100,
		MA200:                math.Round(ma200*100) / 100,
		Low52w:               math.Round(low52*100) / 100,
		High52w:              math.Round(high52*100) / 100,
		RSRating:             rs,
		Signal:               signal,
		Direction:            direction,
		Entry:                math.Round(entry*100) / 100,
		StopLoss:             math.Round(stop*100) / 100,
		StopPct:              math.Round(stopDistPct*100) / 100,
		Target1:              math.Round(tgt1*100) / 100,
		Target2:              math.Round(tgt2*100) / 100,
		SuggestedLots:        lots,
		MaxLossINR:           math.Round(maxLoss),
		TargetGainINR:        math.Round(tgtGain),
		RiskReward:           math.Round(rr*100) / 100,
		Rating:               rating,
		Reasoning:            reasoning,
		Caveats:              caveats,
		GeneratedAt:          time.Now().Format(time.RFC3339),
	}
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

func smaTail(values []float64, period int) float64 {
	if len(values) < period {
		return values[len(values)-1]
	}
	sum := 0.0
	for _, v := range values[len(values)-period:] {
		sum += v
	}
	return sum / float64(period)
}

func minF(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	m := values[0]
	for _, v := range values {
		if v < m {
			m = v
		}
	}
	return m
}

func maxF(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	m := values[0]
	for _, v := range values {
		if v > m {
			m = v
		}
	}
	return m
}

// computeRSRating calculates true relative strength vs the Nifty benchmark.
// benchmarkReturn6M is the Nifty 50 6-month return (as a percentage, e.g. -8.5).
// A stock with RS 70+ is outperforming ~70% of the market — Minervini's minimum.
func computeRSRating(closes []float64, n int, benchmarkReturn6M float64) int {
	if n < 130 {
		return 50
	}
	stockReturn := (closes[n-1]/closes[n-130] - 1) * 100
	// Relative outperformance vs Nifty
	relStrength := stockReturn - benchmarkReturn6M
	// Map: -20% relative → 0,  +20% relative → 100  (neutral = 50)
	r := int((relStrength+20)/40*100)
	if r < 0 {
		r = 0
	}
	if r > 100 {
		r = 100
	}
	return r
}

func detectStage(price, ma50, ma150, ma200, ma200Prev float64, closes []float64, n int) (int, string) {
	ma200Up := ma200 > ma200Prev            // MA200 rising at all
	ma200Down := ma200 < ma200Prev          // MA200 falling at all (removed the 0.98 threshold that caused Stage 4 misses)

	above50 := price > ma50
	above150 := price > ma150
	above200 := price > ma200
	ma50Above200 := ma50 > ma200
	ma50Above150 := ma50 > ma150

	// Stage 2: price above all key MAs, MA200 trending up — Minervini's only buyable stage
	if above50 && above150 && above200 && ma50Above200 && ma50Above150 && ma200Up {
		return 2, "Stage 2 — Advancing (BUY zone)"
	}
	// Stage 4: price below key MAs, MA200 declining — avoid longs, PE opportunity
	if !above50 && !above200 && !ma50Above200 && ma200Down {
		return 4, "Stage 4 — Declining (avoid longs)"
	}
	// Stage 3: was in Stage 2, now breaking down (price below 50MA but still above 200MA)
	if above200 && !above50 && ma200Up {
		return 3, "Stage 3 — Topping (tighten stops)"
	}
	// Stage 1: basing — price near 200MA, range contracting
	recent := closes[n-min(40, n):]
	hi := maxF(recent)
	lo := minF(recent)
	rangeIsNarrow := lo > 0 && (hi-lo)/lo < 0.18
	if math.Abs(price-ma200)/ma200 < 0.12 && rangeIsNarrow {
		return 1, "Stage 1 — Basing (watchlist)"
	}
	// Clear downtrend below all MAs
	if !above50 && !above200 {
		return 4, "Stage 4 — Declining"
	}
	// Clear uptrend above all MAs
	if above50 && above200 {
		return 2, "Stage 2 — Advancing"
	}
	return 1, "Stage 1 — Basing"
}

// detectVCP — looks for 2-4 contractions of progressively decreasing range
// Returns (detected, contractionCount, baseLow, baseHigh, pivotPrice)
func detectVCP(bars []storage.PriceBar) (bool, int, float64, float64, float64) {
	if len(bars) < 30 {
		return false, 0, 0, 0, 0
	}
	// Look at last 40-60 bars for a base
	baseLen := 50
	if len(bars) < baseLen+5 {
		baseLen = len(bars) - 5
	}
	base := bars[len(bars)-baseLen:]

	// Find swing pivots in the base
	type pivot struct{ idx int; price float64; isHigh bool }
	var pivots []pivot
	lb := 3
	for i := lb; i < len(base)-lb; i++ {
		isH := true
		isL := true
		for k := 1; k <= lb; k++ {
			if base[i].High <= base[i+k].High || base[i].High <= base[i-k].High {
				isH = false
			}
			if base[i].Low >= base[i+k].Low || base[i].Low >= base[i-k].Low {
				isL = false
			}
		}
		if isH {
			pivots = append(pivots, pivot{i, base[i].High, true})
		}
		if isL {
			pivots = append(pivots, pivot{i, base[i].Low, false})
		}
	}

	if len(pivots) < 3 {
		return false, 0, 0, 0, 0
	}

	// Compute contraction ranges (H-L pairs)
	var ranges []float64
	for i := 0; i < len(pivots)-1; i++ {
		ranges = append(ranges, math.Abs(pivots[i].price-pivots[i+1].price))
	}
	if len(ranges) < 2 {
		return false, 0, 0, 0, 0
	}

	// Check that ranges are contracting (each smaller than previous)
	contractions := 0
	for i := 1; i < len(ranges); i++ {
		if ranges[i] < ranges[i-1]*0.85 {
			contractions++
		}
	}

	// Base bounds
	baseHi := 0.0
	baseLo := math.MaxFloat64
	for _, b := range base {
		if b.High > baseHi {
			baseHi = b.High
		}
		if b.Low < baseLo {
			baseLo = b.Low
		}
	}

	// Pivot = highest swing high in last 15 bars (the next breakout level)
	last15 := base[len(base)-15:]
	pivotPrice := 0.0
	for _, b := range last15 {
		if b.High > pivotPrice {
			pivotPrice = b.High
		}
	}

	detected := contractions >= 2 && (baseHi-baseLo)/baseLo < 0.20 // base must be tight (< 20%)
	return detected, contractions + 1, baseLo, baseHi, pivotPrice
}

// ─── NIFTY INDEX SIGNAL ──────────────────────────────────────────────────────
// Applies Minervini's SEPA framework to the NIFTY 50 INDEX itself.
// Generates options signals (CE/PE) for trading NIFTY INDEX options.

type NiftyIndexSignal struct {
	// Index state
	SpotPrice   float64 `json:"spot_price"`
	MA50        float64 `json:"ma_50"`
	MA150       float64 `json:"ma_150"`
	MA200       float64 `json:"ma_200"`
	Low52w      float64 `json:"low_52w"`
	High52w     float64 `json:"high_52w"`
	RSRating    int     `json:"rs_rating"`

	// Trend Template
	Pt1PriceAbove150_200 bool `json:"pt1_price_above_150_200"`
	Pt2_150Above200      bool `json:"pt2_150_above_200"`
	Pt3_200TrendingUp    bool `json:"pt3_200_trending_up"`
	Pt4_50AboveBoth      bool `json:"pt4_50_above_both"`
	Pt5PriceAbove50      bool `json:"pt5_price_above_50"`
	Pt6_30PctAboveLow    bool `json:"pt6_30pct_above_low"`
	Pt7Within25PctHigh   bool `json:"pt7_within_25pct_high"`
	Pt8MomentumPositive  bool `json:"pt8_momentum_positive"` // 3-month momentum > 0 for index (no RS vs market)
	TrendTemplateScore   int  `json:"trend_template_score"`

	// Stage
	Stage      int    `json:"stage"`
	StageLabel string `json:"stage_label"`

	// VCP on NIFTY
	VCPDetected     bool    `json:"vcp_detected"`
	VCPContractions int     `json:"vcp_contractions"`
	BaseLow         float64 `json:"base_low"`
	BaseHigh        float64 `json:"base_high"`
	PivotLevel      float64 `json:"pivot_level"`

	// Options signal
	Signal      string  `json:"signal"`       // BUY_CE | BUY_PE | WAIT
	Direction   string  `json:"direction"`    // CE | PE | NONE
	StrikePrice float64 `json:"strike_price"` // ATM or ATM±1 strike
	Expiry      string  `json:"expiry"`       // nearest weekly expiry

	// Risk management
	Entry         float64 `json:"entry"`           // NIFTY index level at entry
	StopLoss      float64 `json:"stop_loss"`       // NIFTY level stop
	Target1       float64 `json:"target_1"`        // +1.5% for CE / -1.5% for PE
	Target2       float64 `json:"target_2"`        // +3% for CE / -3% for PE
	StopPct       float64 `json:"stop_pct"`
	RiskReward    float64 `json:"risk_reward"`
	SuggestedLots int     `json:"suggested_lots"`
	LotSize       int     `json:"lot_size"`    // Nifty lot = 25
	MaxLossINR    float64 `json:"max_loss_inr"`
	TargetGainINR float64 `json:"target_gain_inr"`

	// Context
	Confluence []string `json:"confluence"`
	Caveats    []string `json:"caveats"`
	Rating     string   `json:"rating"` // STRONG | MODERATE | WEAK | NO_TRADE
	GeneratedAt string  `json:"generated_at"`
}

// GetMinerviniNiftyIndex applies Minervini's SEPA to the NIFTY 50 index (^NSEI).
func (e *Engine) GetMinerviniNiftyIndex(accountSize, riskPct float64) (NiftyIndexSignal, error) {
	if accountSize <= 0 {
		accountSize = 100000
	}
	if riskPct <= 0 {
		riskPct = 1.25
	}

	idx, err := e.repo.GetStockBySymbol("^NSEI")
	if err != nil {
		return NiftyIndexSignal{}, err
	}

	now := time.Now()
	from := now.AddDate(-2, 0, 0)
	bars, err := e.repo.GetPriceBars(idx.ID, from, now)
	if err != nil || len(bars) < 220 {
		// Try fetching fresh if not enough bars stored
		return NiftyIndexSignal{Signal: "WAIT", Direction: "NONE",
			GeneratedAt: now.Format(time.RFC3339)}, nil
	}

	return analyzeMinerviniIndex(bars, accountSize, riskPct), nil
}

func analyzeMinerviniIndex(bars []storage.PriceBar, accountSize, riskPct float64) NiftyIndexSignal {
	n := len(bars)
	closes := make([]float64, n)
	highs := make([]float64, n)
	lows := make([]float64, n)
	for i, b := range bars {
		closes[i] = b.Close
		highs[i] = b.High
		lows[i] = b.Low
	}

	price := closes[n-1]

	ma50 := smaTail(closes, 50)
	ma150 := smaTail(closes, 150)
	ma200 := smaTail(closes, 200)
	ma200_30dAgo := smaTail(closes[:n-21], 200)

	low52 := minF(lows[n-min(252, n):])
	high52 := maxF(highs[n-min(252, n):])

	// 8-point Trend Template (Pt8 = momentum proxy for index)
	pt1 := price > ma150 && price > ma200
	pt2 := ma150 > ma200
	pt3 := ma200 > ma200_30dAgo
	pt4 := ma50 > ma150 && ma50 > ma200
	pt5 := price > ma50
	pt6 := low52 > 0 && (price/low52-1) >= 0.25 // index: 25% above 52w low (vs 30% for stocks)
	pt7 := high52 > 0 && (1-price/high52) <= 0.20 // index: within 20% of 52w high
	// Pt8 for index: 3-month momentum positive
	mom3m := 0.0
	if n >= 65 {
		mom3m = (closes[n-1]/closes[n-65] - 1) * 100
	}
	pt8 := mom3m >= 0

	rsRating := computeRSRating(closes, n, 0) // index is its own benchmark — RS vs itself = 50

	score := 0
	for _, ok := range []bool{pt1, pt2, pt3, pt4, pt5, pt6, pt7, pt8} {
		if ok {
			score += 13
		}
	}
	if score > 100 {
		score = 100
	}

	stage, stageLabel := detectStage(price, ma50, ma150, ma200, ma200_30dAgo, closes, n)

	vcpDetected, contractions, baseLo, baseHi, pivotLvl := detectVCP(bars)

	// ─── Signal determination ─────────────────────────────────────────────────
	signal := "WAIT"
	direction := "NONE"
	confluence := []string{}
	caveats := []string{}
	rating := "NO_TRADE"

	entry := price
	stop := price * 0.99   // default 1% stop for index
	tgt1 := price * 1.015  // +1.5%
	tgt2 := price * 1.03   // +3%

	if stage == 2 && score >= 62 {
		signal = "BUY_CE"
		direction = "CE"
		entry = price
		if vcpDetected && pivotLvl > price*0.99 {
			entry = pivotLvl
		}
		stop = ma50 * 0.993 // 0.7% below 50MA
		if stop > entry*0.99 {
			stop = entry * 0.99 // max 1% stop for index scalp
		}
		tgt1 = entry * 1.015
		tgt2 = entry * 1.03
		confluence = append(confluence, "✓ Stage 2 Advancing — Minervini's ONLY buyable stage")
		confluence = append(confluence, "✓ Trend Template "+itoaSafe(score)+"/100 — "+trendStrength(score)+" quality")
		if vcpDetected {
			confluence = append(confluence, "✓ VCP pattern on NIFTY — "+itoaSafe(contractions)+" contractions, tight base")
		}
		if pt8 {
			confluence = append(confluence, "✓ 3-month momentum positive ("+fmt2f(mom3m)+"%)")
		}
		if ma50 > ma150 && ma150 > ma200 {
			confluence = append(confluence, "✓ All MAs aligned bullishly (50>150>200)")
		}
		rating = "STRONG"
		if score < 75 {
			rating = "MODERATE"
			caveats = append(caveats, "Score <75: not all Trend Template criteria met — reduce position size")
		}
		if !vcpDetected {
			caveats = append(caveats, "No VCP on index yet — wait for consolidation before full entry")
		}
	} else if stage == 4 && score <= 37 {
		signal = "BUY_PE"
		direction = "PE"
		entry = price
		stop = ma50 * 1.007 // 0.7% above 50MA
		if stop < entry*1.01 {
			stop = entry * 1.01
		}
		tgt1 = entry * 0.985
		tgt2 = entry * 0.97
		confluence = append(confluence, "✗ Stage 4 Declining — index in downtrend")
		confluence = append(confluence, "✗ Trend Template "+itoaSafe(score)+"/100 — weak")
		if !pt4 {
			confluence = append(confluence, "✗ 50 MA below 150 & 200 — bearish alignment")
		}
		if mom3m < 0 {
			confluence = append(confluence, "✗ 3-month momentum negative ("+fmt2f(mom3m)+"%)")
		}
		caveats = append(caveats, "PE/shorts are riskier — use strict 1% SL and exit fast")
		rating = "MODERATE"
	} else if stage == 1 {
		signal = "WAIT"
		confluence = append(confluence, "△ Stage 1 Basing — NIFTY in consolidation, not ready yet")
		confluence = append(confluence, "△ Watch for 52-week high breakout to confirm Stage 2")
		rating = "NO_TRADE"
	} else if stage == 3 {
		signal = "WAIT"
		confluence = append(confluence, "△ Stage 3 Topping — avoid new longs, tighten existing stops")
		caveats = append(caveats, "Distribution phase — risk/reward poor for new entries")
		rating = "NO_TRADE"
	} else {
		signal = "WAIT"
		confluence = append(confluence, "△ Mixed signals — no clear stage")
		rating = "NO_TRADE"
	}

	// ─── ATM strike calculation ───────────────────────────────────────────────
	// NIFTY strikes are in multiples of 50
	atm := math.Round(price/50) * 50
	strikePrice := atm
	if direction == "CE" {
		strikePrice = atm // ATM CE
	} else if direction == "PE" {
		strikePrice = atm // ATM PE
	}

	// Nearest weekly expiry (Thursday)
	expiry := nextThursday()

	// ─── Position sizing ──────────────────────────────────────────────────────
	// NIFTY options lot size = 25 (post-SEBI 2024 change from 50)
	lotSize := 25
	stopPct := math.Abs(entry-stop) / entry * 100
	if stopPct < 0.5 {
		stopPct = 0.5
	}
	riskINR := accountSize * riskPct / 100
	// Premium move ≈ delta × index move; delta ≈ 0.5 for ATM
	// Index moves stopPct%; ATM CE moves ≈ stopPct% × 0.5 × entry / 100
	premiumRiskPerLot := stopPct / 100 * entry * 0.5 * float64(lotSize)
	lots := 1
	if premiumRiskPerLot > 0 {
		lots = int(math.Floor(riskINR / premiumRiskPerLot))
	}
	if lots < 1 {
		lots = 1
	}
	if lots > 10 {
		lots = 10 // safety cap
	}
	maxLoss := premiumRiskPerLot * float64(lots)

	tgtMovePct := math.Abs(tgt1-entry) / entry * 100
	tgtGain := tgtMovePct / 100 * entry * 0.5 * float64(lotSize) * float64(lots)
	rr := math.Abs(tgt1-entry) / math.Max(math.Abs(entry-stop), 0.0001)

	return NiftyIndexSignal{
		SpotPrice:            math.Round(price),
		MA50:                 math.Round(ma50),
		MA150:                math.Round(ma150),
		MA200:                math.Round(ma200),
		Low52w:               math.Round(low52),
		High52w:              math.Round(high52),
		RSRating:             rsRating,
		Pt1PriceAbove150_200: pt1,
		Pt2_150Above200:      pt2,
		Pt3_200TrendingUp:    pt3,
		Pt4_50AboveBoth:      pt4,
		Pt5PriceAbove50:      pt5,
		Pt6_30PctAboveLow:    pt6,
		Pt7Within25PctHigh:   pt7,
		Pt8MomentumPositive:  pt8,
		TrendTemplateScore:   score,
		Stage:                stage,
		StageLabel:           stageLabel,
		VCPDetected:          vcpDetected,
		VCPContractions:      contractions,
		BaseLow:              math.Round(baseLo),
		BaseHigh:             math.Round(baseHi),
		PivotLevel:           math.Round(pivotLvl),
		Signal:               signal,
		Direction:            direction,
		StrikePrice:          strikePrice,
		Expiry:               expiry,
		Entry:                math.Round(entry),
		StopLoss:             math.Round(stop),
		Target1:              math.Round(tgt1),
		Target2:              math.Round(tgt2),
		StopPct:              math.Round(stopPct*10) / 10,
		RiskReward:           math.Round(rr*100) / 100,
		SuggestedLots:        lots,
		LotSize:              lotSize,
		MaxLossINR:           math.Round(maxLoss),
		TargetGainINR:        math.Round(tgtGain),
		Confluence:           confluence,
		Caveats:              caveats,
		Rating:               rating,
		GeneratedAt:          time.Now().Format(time.RFC3339),
	}
}

func trendStrength(score int) string {
	if score >= 87 {
		return "excellent"
	}
	if score >= 75 {
		return "good"
	}
	if score >= 50 {
		return "moderate"
	}
	return "weak"
}

func itoaSafe(i int) string {
	const digits = "0123456789"
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var b strings.Builder
	for i > 0 {
		b.WriteByte(digits[i%10])
		i /= 10
	}
	s := b.String()
	r := []byte(s)
	for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
		r[i], r[j] = r[j], r[i]
	}
	if neg {
		return "-" + string(r)
	}
	return string(r)
}
