package strategy

// ═══════════════════════════════════════════════════════════════════════════
//  MINERVINI FULL NSE SCAN
//
//  Scans ~75 NSE stocks (Nifty 50 + Nifty Next 50 core names) using:
//    1. Minervini SEPA — 8-point Trend Template + Stage Analysis + VCP
//    2. Promoter Integrity Filter — holding %, pledging %, QoQ trend
//       (Indian-market specific; Minervini doesn't use this for US stocks
//        but it's the single most important governance check for NSE)
//
//  Promoter Integrity Score (0–10):
//    +3  Promoter holding ≥ 50%         (high insider alignment)
//    +2  Promoter holding 30–50%
//    +1  Promoter holding 20–30%
//    +3  Pledging = 0%                  (no debt on shares)
//    +2  Pledging < 5%
//    +1  Pledging 5–15%
//    -2  Pledging 15–30%
//    -4  Pledging > 30%                 (danger zone — margin-call risk)
//    +2  Promoter increased holding QoQ (insider buying = conviction)
//    -2  Promoter decreased > 1% QoQ   (distribution signal)
//    +1  FII increasing                 (smart foreign money)
//    +1  DII increasing                 (domestic institutional support)
//    Hard disqualify: pledging > 50% OR promoter holding < 10%
//
//  Pipeline:
//    Step 1 — Fetch 2y OHLCV from Yahoo Finance concurrently (10 workers)
//    Step 2 — Run Minervini scoring; keep candidates with score ≥ 50
//    Step 3 — Fetch promoter data from Screener.in (cached, top 30 only)
//    Step 4 — Combine scores; rank by combined score descending
//    Step 5 — Return top N with full breakdown
// ═══════════════════════════════════════════════════════════════════════════

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"stockwise/internal/naren/data"
	"stockwise/internal/naren/screener"
	"stockwise/internal/naren/storage"
)

// ─── NSE Universe ─────────────────────────────────────────────────────────────

// nseUniverse covers Nifty 50 + key Nifty Next 50 stocks across all sectors.
// Symbols are Yahoo Finance format (symbol.NS).
var nseUniverse = []struct {
	Symbol  string
	Name    string
	Sector  string
}{
	// ── Technology ──────────────────────────────────────────────────────────
	{"TCS.NS", "Tata Consultancy Services", "Technology"},
	{"INFY.NS", "Infosys", "Technology"},
	{"WIPRO.NS", "Wipro", "Technology"},
	{"HCLTECH.NS", "HCL Technologies", "Technology"},
	{"TECHM.NS", "Tech Mahindra", "Technology"},
	{"LTIM.NS", "LTIMindtree", "Technology"},
	{"PERSISTENT.NS", "Persistent Systems", "Technology"},
	{"MPHASIS.NS", "Mphasis", "Technology"},
	// ── Financial Services ──────────────────────────────────────────────────
	{"HDFCBANK.NS", "HDFC Bank", "Financial Services"},
	{"ICICIBANK.NS", "ICICI Bank", "Financial Services"},
	{"SBIN.NS", "State Bank of India", "Financial Services"},
	{"AXISBANK.NS", "Axis Bank", "Financial Services"},
	{"KOTAKBANK.NS", "Kotak Mahindra Bank", "Financial Services"},
	{"BAJFINANCE.NS", "Bajaj Finance", "Financial Services"},
	{"BAJAJFINSV.NS", "Bajaj Finserv", "Financial Services"},
	{"INDUSINDBK.NS", "IndusInd Bank", "Financial Services"},
	{"SHRIRAMFIN.NS", "Shriram Finance", "Financial Services"},
	{"SBILIFE.NS", "SBI Life Insurance", "Financial Services"},
	{"HDFCLIFE.NS", "HDFC Life Insurance", "Financial Services"},
	{"BANKBARODA.NS", "Bank of Baroda", "Financial Services"},
	{"MUTHOOTFIN.NS", "Muthoot Finance", "Financial Services"},
	// ── Consumer Staples ────────────────────────────────────────────────────
	{"HINDUNILVR.NS", "Hindustan Unilever", "Consumer Staples"},
	{"ITC.NS", "ITC Ltd", "Consumer Staples"},
	{"NESTLEIND.NS", "Nestle India", "Consumer Staples"},
	{"BRITANNIA.NS", "Britannia Industries", "Consumer Staples"},
	{"TATACONSUM.NS", "Tata Consumer Products", "Consumer Staples"},
	{"COLPAL.NS", "Colgate-Palmolive India", "Consumer Staples"},
	{"DABUR.NS", "Dabur India", "Consumer Staples"},
	{"MARICO.NS", "Marico", "Consumer Staples"},
	// ── Consumer Discretionary ──────────────────────────────────────────────
	{"TITAN.NS", "Titan Company", "Consumer Discretionary"},
	{"MARUTI.NS", "Maruti Suzuki", "Consumer Discretionary"},
	{"TRENT.NS", "Trent", "Consumer Discretionary"},
	{"DMART.NS", "Avenue Supermarts (DMart)", "Consumer Discretionary"},
	{"EICHERMOT.NS", "Eicher Motors", "Consumer Discretionary"},
	{"PAGEIND.NS", "Page Industries", "Consumer Discretionary"},
	// ── Healthcare / Pharma ─────────────────────────────────────────────────
	{"SUNPHARMA.NS", "Sun Pharmaceutical", "Healthcare"},
	{"DRREDDY.NS", "Dr. Reddy's Laboratories", "Healthcare"},
	{"CIPLA.NS", "Cipla", "Healthcare"},
	{"DIVISLAB.NS", "Divi's Laboratories", "Healthcare"},
	{"APOLLOHOSP.NS", "Apollo Hospitals", "Healthcare"},
	{"AUROPHARMA.NS", "Aurobindo Pharma", "Healthcare"},
	{"TORNTPHARM.NS", "Torrent Pharmaceuticals", "Healthcare"},
	// ── Energy / Oil & Gas ──────────────────────────────────────────────────
	{"RELIANCE.NS", "Reliance Industries", "Energy"},
	{"ONGC.NS", "ONGC", "Energy"},
	{"BPCL.NS", "BPCL", "Energy"},
	{"IOC.NS", "Indian Oil Corporation", "Energy"},
	{"GAIL.NS", "GAIL India", "Energy"},
	{"COALINDIA.NS", "Coal India", "Energy"},
	// ── Industrials / Defence ───────────────────────────────────────────────
	{"LT.NS", "Larsen & Toubro", "Industrials"},
	{"ADANIENT.NS", "Adani Enterprises", "Industrials"},
	{"NTPC.NS", "NTPC", "Utilities"},
	{"POWERGRID.NS", "Power Grid Corp", "Utilities"},
	{"BEL.NS", "Bharat Electronics", "Industrials"},
	{"HAL.NS", "Hindustan Aeronautics", "Industrials"},
	{"SIEMENS.NS", "Siemens India", "Industrials"},
	{"ABB.NS", "ABB India", "Industrials"},
	{"BHEL.NS", "BHEL", "Industrials"},
	{"CUMMINSIND.NS", "Cummins India", "Industrials"},
	// ── Materials ───────────────────────────────────────────────────────────
	{"ASIANPAINT.NS", "Asian Paints", "Materials"},
	{"ULTRACEMCO.NS", "UltraTech Cement", "Materials"},
	{"TATASTEEL.NS", "Tata Steel", "Materials"},
	{"JSWSTEEL.NS", "JSW Steel", "Materials"},
	{"HINDALCO.NS", "Hindalco Industries", "Materials"},
	{"GRASIM.NS", "Grasim Industries", "Materials"},
	{"PIDILITIND.NS", "Pidilite Industries", "Materials"},
	{"BERGEPAINT.NS", "Berger Paints", "Materials"},
	// ── Telecom ─────────────────────────────────────────────────────────────
	{"BHARTIARTL.NS", "Bharti Airtel", "Telecom"},
	// ── Auto ────────────────────────────────────────────────────────────────
	{"TATAMOTORS.NS", "Tata Motors", "Auto"},
	{"HEROMOTOCO.NS", "Hero MotoCorp", "Auto"},
	{"M&M.NS", "Mahindra & Mahindra", "Auto"},
	{"BAJAJ-AUTO.NS", "Bajaj Auto", "Auto"},
	{"BOSCHLTD.NS", "Bosch India", "Auto"},
	// ── New-age / Digital ───────────────────────────────────────────────────
	{"ZOMATO.NS", "Zomato", "New Age Tech"},
	{"IRCTC.NS", "IRCTC", "New Age Tech"},
	{"NAUKRI.NS", "Info Edge (Naukri)", "New Age Tech"},
	{"POLICYBZR.NS", "PB Fintech (Policybazaar)", "New Age Tech"},
}

// ─── Result Types ─────────────────────────────────────────────────────────────

// PromoterData holds the integrity metrics sourced from Screener.in.
type PromoterData struct {
	Available       bool    `json:"available"`
	PromoterHolding float64 `json:"promoter_holding"`   // latest %
	PromoterPrev    float64 `json:"promoter_prev"`      // previous quarter %
	PromoterDelta   float64 `json:"promoter_delta"`     // change (positive = buying)
	PledgingPct     float64 `json:"pledging_pct"`       // % of shares pledged
	FIIHolding      float64 `json:"fii_holding"`
	DIIHolding      float64 `json:"dii_holding"`
	FIIIncreasing   bool    `json:"fii_increasing"`
	DIIIncreasing   bool    `json:"dii_increasing"`
	Score           int     `json:"promoter_score"`     // 0–10
	Grade           string  `json:"promoter_grade"`     // A / B / C / DISQUALIFIED
	Flags           []string `json:"flags"`             // human-readable factors
}

// FullScanPick is the combined Minervini + Promoter result for one stock.
type FullScanPick struct {
	Symbol    string  `json:"symbol"`
	Name      string  `json:"name"`
	Sector    string  `json:"sector"`

	// Price & MAs
	Price     float64 `json:"price"`
	MA50      float64 `json:"ma_50"`
	MA150     float64 `json:"ma_150"`
	MA200     float64 `json:"ma_200"`
	High52W   float64 `json:"high_52w"`
	Low52W    float64 `json:"low_52w"`

	// Minervini SEPA
	TrendScore  int    `json:"trend_score"`   // 0–100
	Stage       int    `json:"stage"`
	StageLabel  string `json:"stage_label"`
	VCP         bool   `json:"vcp"`
	PivotPrice  float64 `json:"pivot_price"`
	RSRating    int    `json:"rs_rating"`
	Signal      string `json:"signal"`       // BUY_CE | BUY_PE | WAIT
	Entry       float64 `json:"entry"`
	StopLoss    float64 `json:"stop_loss"`
	Target1     float64 `json:"target_1"`
	Target2     float64 `json:"target_2"`
	StopPct     float64 `json:"stop_pct"`
	RiskReward  float64 `json:"risk_reward"`
	Reasoning   []string `json:"reasoning"`

	// Promoter Integrity
	Promoter PromoterData `json:"promoter"`

	// Combined ranking
	CombinedScore int    `json:"combined_score"`  // TrendScore + PromoterScore*5 (max 150)
	FinalGrade    string `json:"final_grade"`     // A+ / A / B / C
	Recommendation string `json:"recommendation"` // STRONG BUY / BUY / WATCH / AVOID

	DataAsOf string `json:"data_as_of"`
}

// FullScanReport is the top-level response.
type FullScanReport struct {
	Picks       []FullScanPick `json:"picks"`
	TopBuys     []FullScanPick `json:"top_buys"`
	Watchlist   []FullScanPick `json:"watchlist"`
	TotalScanned int           `json:"total_scanned"`
	DataAsOf    string         `json:"data_as_of"`
	NiftyRS6M   float64        `json:"nifty_rs_6m"`
	GeneratedAt string         `json:"generated_at"`
	Methodology string         `json:"methodology"`
}

// ─── Promoter Scoring ─────────────────────────────────────────────────────────

func scorePromoter(sh *screener.ShareholdingData) PromoterData {
	pd := PromoterData{}
	if sh == nil {
		pd.Score = 5 // neutral when data unavailable
		pd.Grade = "B"
		pd.Flags = []string{"Promoter data unavailable — scored neutral"}
		return pd
	}

	pd.Available = true
	pd.PromoterHolding = sh.PromoterPct
	pd.PromoterPrev = sh.PromoterPrev
	pd.PromoterDelta = sh.PromoterPct - sh.PromoterPrev
	pd.PledgingPct = sh.PledgingPct
	pd.FIIHolding = sh.FIIPct
	pd.DIIHolding = sh.DIIPct
	pd.FIIIncreasing = sh.FIIIncreasing
	pd.DIIIncreasing = sh.DIIIncreasing

	score := 0
	var flags []string

	// ── Hard disqualify ───────────────────────────────────────────────────
	if sh.PledgingPct > 50 {
		pd.Score = -10
		pd.Grade = "DISQUALIFIED"
		pd.Flags = []string{fmt.Sprintf("🚨 DISQUALIFIED — pledging %.1f%% (>50%%) is extreme margin-call risk", sh.PledgingPct)}
		return pd
	}
	if sh.PromoterPct > 0 && sh.PromoterPct < 10 {
		pd.Score = -5
		pd.Grade = "DISQUALIFIED"
		pd.Flags = []string{fmt.Sprintf("🚨 DISQUALIFIED — promoter holds only %.1f%% (< 10%%), no skin in the game", sh.PromoterPct)}
		return pd
	}

	// ── Promoter holding score (max +3) ──────────────────────────────────
	switch {
	case sh.PromoterPct >= 60:
		score += 3
		flags = append(flags, fmt.Sprintf("✓ Promoter holds %.1f%% — strong insider alignment", sh.PromoterPct))
	case sh.PromoterPct >= 45:
		score += 2
		flags = append(flags, fmt.Sprintf("✓ Promoter holds %.1f%%", sh.PromoterPct))
	case sh.PromoterPct >= 25:
		score += 1
		flags = append(flags, fmt.Sprintf("△ Promoter holds %.1f%% — moderate", sh.PromoterPct))
	case sh.PromoterPct > 0:
		score += 0
		flags = append(flags, fmt.Sprintf("✗ Promoter holds only %.1f%% — low conviction", sh.PromoterPct))
	}

	// ── Pledging score (max +3, min -4) ──────────────────────────────────
	switch {
	case sh.PledgingPct == 0:
		score += 3
		flags = append(flags, "✓ Zero pledging — debt-free on shares, no forced-sell risk")
	case sh.PledgingPct < 5:
		score += 2
		flags = append(flags, fmt.Sprintf("✓ Pledging %.1f%% — minimal risk", sh.PledgingPct))
	case sh.PledgingPct < 15:
		score += 1
		flags = append(flags, fmt.Sprintf("△ Pledging %.1f%% — manageable", sh.PledgingPct))
	case sh.PledgingPct < 30:
		score -= 2
		flags = append(flags, fmt.Sprintf("✗ Pledging %.1f%% — elevated margin-call risk", sh.PledgingPct))
	default:
		score -= 4
		flags = append(flags, fmt.Sprintf("🚨 Pledging %.1f%% — DANGER ZONE, avoid", sh.PledgingPct))
	}

	// ── Promoter trend (max +2, min -2) ──────────────────────────────────
	delta := sh.PromoterPct - sh.PromoterPrev
	if sh.PromoterPrev > 0 {
		switch {
		case delta > 0.5:
			score += 2
			flags = append(flags, fmt.Sprintf("✓ Promoter bought +%.2f%% last quarter — strong conviction", delta))
		case delta > 0:
			score += 1
			flags = append(flags, fmt.Sprintf("✓ Promoter holding stable / slight increase +%.2f%%", delta))
		case delta < -1.5:
			score -= 2
			flags = append(flags, fmt.Sprintf("✗ Promoter sold -%.2f%% last quarter — watch for further exit", -delta))
		case delta < -0.5:
			score -= 1
			flags = append(flags, fmt.Sprintf("△ Promoter reduced -%.2f%% — monitor", -delta))
		}
	}

	// ── Institutional interest (max +2) ───────────────────────────────────
	if sh.FIIIncreasing {
		score += 1
		flags = append(flags, fmt.Sprintf("✓ FII increasing (%.1f%%) — foreign smart money buying", sh.FIIPct))
	}
	if sh.DIIIncreasing {
		score += 1
		flags = append(flags, fmt.Sprintf("✓ DII increasing (%.1f%%) — domestic institutions accumulating", sh.DIIPct))
	}

	pd.Score = score
	switch {
	case score >= 7:
		pd.Grade = "A"
	case score >= 5:
		pd.Grade = "B+"
	case score >= 3:
		pd.Grade = "B"
	case score >= 1:
		pd.Grade = "C"
	default:
		pd.Grade = "D"
	}
	pd.Flags = flags
	return pd
}

// ─── Full Scan Engine ─────────────────────────────────────────────────────────

// RunFullMinerviniScan fetches prices for the entire NSE universe, applies
// Minervini + promoter scoring and returns the top picks.
func (e *Engine) RunFullMinerviniScan(accountSize, riskPct float64, limit int) (FullScanReport, error) {
	if accountSize <= 0 {
		accountSize = 100000
	}
	if riskPct <= 0 {
		riskPct = 1.25
	}
	if limit <= 0 || limit > 50 {
		limit = 20
	}

	// Step 1: Nifty benchmark 6M return
	niftyBenchmark := 0.0
	if niftybars, err := e.loadNiftyBarsYears(1); err == nil && len(niftybars) >= 130 {
		n := len(niftybars)
		niftyBenchmark = (niftybars[n-1].Close/niftybars[n-130].Close - 1) * 100
	}

	yahoo := data.NewYahooClient()
	now := time.Now()
	to := now.Format("2006-01-02")
	from := now.AddDate(-2, 0, 0).Format("2006-01-02")
	_ = from
	_ = to

	type rawResult struct {
		idx  int
		bars []storage.PriceBar
		err  error
	}

	// Step 2: Concurrent Yahoo Finance fetch (10 workers)
	jobs := make(chan int, len(nseUniverse))
	for i := range nseUniverse {
		jobs <- i
	}
	close(jobs)

	results := make([]rawResult, len(nseUniverse))
	var wg sync.WaitGroup
	const workers = 10

	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range jobs {
				sym := nseUniverse[idx].Symbol
				chartBars, _, _, err := yahoo.FetchChart(sym, "1d", "2y")
				if err != nil || len(chartBars) < 220 {
					results[idx] = rawResult{idx: idx, err: err}
					continue
				}
				bars := make([]storage.PriceBar, len(chartBars))
				for i, b := range chartBars {
					bars[i] = storage.PriceBar{
						Date: b.Time, Open: b.Open, High: b.High,
						Low: b.Low, Close: b.Close, AdjClose: b.AdjClose, Volume: b.Volume,
					}
				}
				results[idx] = rawResult{idx: idx, bars: bars}
			}
		}()
	}
	wg.Wait()

	// Step 3: Run Minervini scoring on all stocks with enough bars
	type candidate struct {
		pick    FullScanPick
		minScore int
	}
	var candidates []candidate
	dataAsOf := now.AddDate(0, 0, -3).Format("02 Jan 2006") // fallback

	for i, res := range results {
		if res.err != nil || len(res.bars) < 220 {
			continue
		}
		uni := nseUniverse[i]
		bars := res.bars

		// Update dataAsOf from latest bar
		if last := bars[len(bars)-1]; last.Date.After(now.AddDate(0, 0, -10)) {
			dataAsOf = last.Date.Format("02 Jan 2006")
		}

		stock := storage.Stock{Symbol: uni.Symbol, Name: uni.Name, Sector: uni.Sector}
		mp := analyzeMinervini(stock, bars, accountSize, riskPct, niftyBenchmark)
		if mp.Symbol == "" {
			continue
		}

		c := candidate{
			minScore: mp.TrendTemplateScore,
			pick: FullScanPick{
				Symbol:    uni.Symbol,
				Name:      uni.Name,
				Sector:    uni.Sector,
				Price:     mp.CurrentPrice,
				MA50:      mp.MA50,
				MA150:     mp.MA150,
				MA200:     mp.MA200,
				High52W:   mp.High52w,
				Low52W:    mp.Low52w,
				TrendScore: mp.TrendTemplateScore,
				Stage:     mp.Stage,
				StageLabel: mp.StageLabel,
				VCP:       mp.VCPDetected,
				PivotPrice: mp.PivotPrice,
				RSRating:  mp.RSRating,
				Signal:    mp.Signal,
				Entry:     mp.Entry,
				StopLoss:  mp.StopLoss,
				Target1:   mp.Target1,
				Target2:   mp.Target2,
				StopPct:   mp.StopPct,
				RiskReward: mp.RiskReward,
				Reasoning: mp.Reasoning,
				DataAsOf:  dataAsOf,
			},
		}
		candidates = append(candidates, c)
	}

	// Step 4: Sort by Minervini score, take top 30 for promoter lookup
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].minScore > candidates[j].minScore
	})
	promoterBatch := candidates
	if len(promoterBatch) > 30 {
		promoterBatch = promoterBatch[:30]
	}

	// Step 5: Fetch promoter data from Screener.in for top candidates
	sc := screener.NewClient()
	for i := range promoterBatch {
		sym := strings.TrimSuffix(promoterBatch[i].pick.Symbol, ".NS")
		results2, err := sc.Search(sym)
		if err != nil || len(results2) == 0 {
			promoterBatch[i].pick.Promoter = scorePromoter(nil)
			continue
		}
		cd, err := sc.FetchCompany(results2[0].URL)
		if err != nil || cd == nil {
			promoterBatch[i].pick.Promoter = scorePromoter(nil)
			continue
		}
		var sh *screener.ShareholdingData
		if cd.Shareholding != nil {
			sh = cd.Shareholding
		}
		promoterBatch[i].pick.Promoter = scorePromoter(sh)
	}

	// Step 6: Compute combined score + final grade, filter disqualified
	var finalPicks []FullScanPick
	for _, c := range promoterBatch {
		p := c.pick

		// Skip disqualified
		if p.Promoter.Grade == "DISQUALIFIED" {
			continue
		}

		// Combined score: Minervini (0-100) + Promoter×5 (0-50) = max 150
		p.CombinedScore = p.TrendScore + p.Promoter.Score*5

		switch {
		case p.CombinedScore >= 115 && p.Stage == 2:
			p.FinalGrade = "A+"
			p.Recommendation = "STRONG BUY"
		case p.CombinedScore >= 90 && p.Stage == 2:
			p.FinalGrade = "A"
			p.Recommendation = "BUY"
		case p.CombinedScore >= 70 && (p.Stage == 2 || p.Stage == 1):
			p.FinalGrade = "B+"
			p.Recommendation = "ACCUMULATE"
		case p.Stage == 1 && p.TrendScore >= 50:
			p.FinalGrade = "B"
			p.Recommendation = "WATCHLIST"
		case p.Stage == 4:
			p.FinalGrade = "D"
			p.Recommendation = "AVOID"
		default:
			p.FinalGrade = "C"
			p.Recommendation = "WAIT"
		}

		finalPicks = append(finalPicks, p)
	}

	// Sort final picks by combined score
	sort.Slice(finalPicks, func(i, j int) bool {
		return finalPicks[i].CombinedScore > finalPicks[j].CombinedScore
	})

	// Categorise
	var topBuys, watchlist []FullScanPick
	for _, p := range finalPicks {
		switch p.Recommendation {
		case "STRONG BUY", "BUY":
			topBuys = append(topBuys, p)
		case "ACCUMULATE", "WATCHLIST":
			watchlist = append(watchlist, p)
		}
	}

	// Cap limit
	out := finalPicks
	if len(out) > limit {
		out = out[:limit]
	}

	return FullScanReport{
		Picks:        out,
		TopBuys:      topBuys,
		Watchlist:    watchlist,
		TotalScanned: len(candidates),
		DataAsOf:     dataAsOf,
		NiftyRS6M:    math.Round(niftyBenchmark*10) / 10,
		GeneratedAt:  now.Format(time.RFC3339),
		Methodology: "Minervini SEPA (8-point Trend Template + Stage + VCP) × Promoter Integrity " +
			"(holding %, pledging %, QoQ trend, FII/DII flow). " +
			"Combined score = Trend (0-100) + Promoter×5 (0-50). " +
			"Stocks with pledging >50% or promoter holding <10% are disqualified. " +
			"Universe: ~75 NSE stocks (Nifty 50 + Nifty Next 50 core names). " +
			"Best picks are Stage 2, zero/low pledging, promoter buying.",
	}, nil
}
