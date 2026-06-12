package api

import (
	"math"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"stockwise/internal/naren/data"
)

// ─── SIP Watchlist Definitions ────────────────────────────────────────────────

var sipWatchlistDefs = []struct {
	Symbol  string
	Name    string
	Sector  string
	Thesis  []string
	SIPNote string
}{
	{
		Symbol: "TSM",
		Name:   "Taiwan Semiconductor Manufacturing",
		Sector: "Semiconductors",
		Thesis: []string{
			"World's only manufacturer of 3nm/2nm chips — NVIDIA, Apple & AMD entirely depend on TSMC",
			"New US (Arizona) & Japan fabs reduce geopolitical risk; diversified fab footprint by 2026",
			"AI chip demand drives 25%+ CoWoS advanced-packaging backlog; 2–3 year lead over Samsung",
		},
		SIPNote: "Core SIP holding — indispensable to the entire AI semiconductor ecosystem; buy every dip",
	},
	{
		Symbol: "NVDA",
		Name:   "NVIDIA Corporation",
		Sector: "Semiconductors",
		Thesis: []string{
			"H100/H200/B200 GPUs dominate AI training with 80%+ market share in data center accelerators",
			"CUDA ecosystem moat — 4M+ developers; switching costs are structurally very high",
			"Expanding into robotics (Isaac), autonomous vehicles, and sovereign AI — multiple growth vectors",
		},
		SIPNote: "Highest-conviction AI play; continue SIP on any dip — multi-decade runway ahead",
	},
	{
		Symbol: "GOOGL",
		Name:   "Alphabet Inc.",
		Sector: "Technology",
		Thesis: []string{
			"Search + YouTube + GCP = dominant three-legged stool generating $300B+ annual revenue",
			"Gemini Ultra + in-house TPU chips position Google as a top-2 AI model provider",
			"Waymo leads in self-driving miles; Android/Maps = unbeatable global distribution moat",
		},
		SIPNote: "Cheapest mega-cap on forward P/E among peers; strong buybacks make it ideal for cost-averaging",
	},
	{
		Symbol: "META",
		Name:   "Meta Platforms Inc.",
		Sector: "Technology",
		Thesis: []string{
			"3.2B+ daily active users across Facebook, Instagram & WhatsApp — largest social graph ever built",
			"AI-powered ad targeting driving margin expansion; 2024 profit margins at all-time highs",
			"Llama open-source LLM leadership + Ray-Ban smart glasses = consumer AI hardware edge",
		},
		SIPNote: "Cheapest mega-cap on forward P/E; strong free cash flow funds continuous SIP accumulation",
	},
	{
		Symbol: "MSFT",
		Name:   "Microsoft Corporation",
		Sector: "Technology",
		Thesis: []string{
			"Azure cloud growing 30%+ YoY; Copilot AI integration across Office 365 drives ARPU expansion",
			"OpenAI partnership gives Microsoft the enterprise AI distribution edge over all competitors",
			"Xbox/Activision, LinkedIn, Dynamics — diversified economic moats across 5+ verticals",
		},
		SIPNote: "Safest large-cap SIP — recession-resistant enterprise software + cloud revenue mix",
	},
	{
		Symbol: "NVO",
		Name:   "Novo Nordisk A/S",
		Sector: "Healthcare",
		Thesis: []string{
			"Ozempic & Wegovy are category-defining GLP-1 drugs; obesity market alone worth $100B+ by 2030",
			"Pipeline includes oral Semaglutide and CagriSema — next-generation obesity/diabetes treatments",
			"Near-monopoly in global insulin market provides stable cash flows to fund massive R&D pipeline",
		},
		SIPNote: "Healthcare compounder — GLP-1 demand is a decades-long secular growth trend; SIP aggressively",
	},
}

var undervaluedGemDefs = []struct {
	Symbol          string
	Name            string
	Sector          string
	WhyUndervalued  string
	GrowthCatalysts []string
	Risks           []string
	SIPRationale    string
	RiskLevel       string
	ExpectedCAGR    float64
	UpsidePct       float64
}{
	{
		Symbol:         "NU",
		Name:           "Nu Holdings Ltd.",
		Sector:         "Fintech / Digital Banking",
		WhyUndervalued: "Trades at ~25x earnings despite 50%+ revenue growth and 100M+ customers — the market has not priced full Latin American fintech penetration at just $10–15/share",
		GrowthCatalysts: []string{
			"100M+ customers across Brazil, Mexico & Colombia — only 30% of addressable market penetrated",
			"New products: NuPay, NuInvest, insurance, payroll credit — revenue per user still very low",
			"Mexico expansion: 8M+ customers in 2 years; Colombia newly launched with strong traction",
			"GAAP profitability since 2023 with expanding net interest margins — inflection just beginning",
		},
		Risks:        []string{"Brazilian Real / currency depreciation risk", "Credit losses in economic downturn", "Regulatory banking-license constraints"},
		SIPRationale: "At $10–15/share, you are buying the Amazon of Latin American banking at an early stage — dollar-cost average aggressively on dips",
		RiskLevel:    "Moderate",
		ExpectedCAGR: 28,
		UpsidePct:    120,
	},
	{
		Symbol:         "GRAB",
		Name:           "Grab Holdings Limited",
		Sector:         "Technology / Super App",
		WhyUndervalued: "Market prices GRAB as a struggling ride-hailing app — ignoring its profitable fintech arm and dominant position across 8 Southeast Asian nations at just $3–6/share",
		GrowthCatalysts: []string{
			"Southeast Asia GDP growing 5%+ CAGR — GRAB is the infrastructure layer for commerce & payments",
			"GrabFinance loans growing 80% YoY; digital banking licenses in Singapore & Malaysia active",
			"Food delivery profitable in most markets; GrabPay reaching 700M population TAM",
			"Less than 20% smartphone-enabled payments penetration — decade of runway ahead",
		},
		Risks:        []string{"Path to consolidated profitability", "Competition from Sea Limited (ShopeePay)", "Regulatory risk across multiple ASEAN jurisdictions"},
		SIPRationale: "At $3–6/share, accumulate the dominant super-app before Southeast Asia's digital economy booms — a 5–10 year SIP compounding thesis",
		RiskLevel:    "Aggressive",
		ExpectedCAGR: 35,
		UpsidePct:    180,
	},
	{
		Symbol:         "SOFI",
		Name:           "SoFi Technologies Inc.",
		Sector:         "Fintech / Digital Banking",
		WhyUndervalued: "Trades at 2x book value while growing revenue 25%+ YoY — market ignores Galileo's B2B financial infrastructure platform (150M+ accounts) which alone justifies current market cap",
		GrowthCatalysts: []string{
			"National bank charter obtained — now earns net interest margin; deposit costs structurally lower",
			"Galileo powers 150M+ accounts for fintechs worldwide; sticky B2B revenue growing 30%+",
			"Student loan refinancing could rebound significantly as interest rates decline",
			"Personal loans and home loans scaling profitably with stable credit quality metrics",
		},
		Risks:        []string{"Interest rate sensitivity on loan book", "Student loan regulatory / political risk", "Competition from established money-center banks"},
		SIPRationale: "At $8–12/share, you get two businesses (consumer bank + infrastructure platform) for the price of one — accumulate monthly",
		RiskLevel:    "Moderate",
		ExpectedCAGR: 32,
		UpsidePct:    150,
	},
}

// ─── Response structs ─────────────────────────────────────────────────────────

type WatchlistStockData struct {
	Symbol    string `json:"symbol"`
	Name      string `json:"name"`
	Sector    string `json:"sector"`

	CurrentPrice   float64 `json:"current_price"`
	PriceChange    float64 `json:"price_change"`
	PriceChangePct float64 `json:"price_change_pct"`

	// Fundamental
	PERatio          *float64 `json:"pe_ratio"`
	ForwardPE        *float64 `json:"forward_pe"`
	EPS              *float64 `json:"eps"`
	EPSGrowthPct     *float64 `json:"eps_growth_pct"`
	RevenueGrowthPct *float64 `json:"revenue_growth_pct"`
	DebtEquity       *float64 `json:"debt_equity"`
	ROEPct           *float64 `json:"roe_pct"`
	ROAPct           *float64 `json:"roa_pct"`
	MarketCapB       float64  `json:"market_cap_b"`
	DividendYieldPct *float64 `json:"dividend_yield_pct"`
	PriceToBook      *float64 `json:"price_to_book"`
	ProfitMarginPct  *float64 `json:"profit_margin_pct"`
	FundamentalScore int      `json:"fundamental_score"`
	FundamentalRating string  `json:"fundamental_rating"`

	// Technical
	RSI      float64 `json:"rsi"`
	MACDHist float64 `json:"macd_hist"`
	SMA20    float64 `json:"sma20"`
	SMA50    float64 `json:"sma50"`
	SMA200   float64 `json:"sma200"`
	Trend    string  `json:"trend"`
	TechSignal string `json:"tech_signal"`
	TechScore  int   `json:"tech_score"`

	ValuationZone string   `json:"valuation_zone"`
	SIPRating     string   `json:"sip_rating"`
	KeyThesis     []string `json:"key_thesis"`
	SIPSuggestion string   `json:"sip_suggestion"`
}

type GemStockData struct {
	Symbol         string `json:"symbol"`
	Name           string `json:"name"`
	Sector         string `json:"sector"`

	CurrentPrice   float64 `json:"current_price"`
	PriceChange    float64 `json:"price_change"`
	PriceChangePct float64 `json:"price_change_pct"`

	UpsidePct       float64  `json:"upside_pct"`
	ExpectedCAGRPct float64  `json:"expected_cagr_pct"`
	PERatio         *float64 `json:"pe_ratio"`
	RSI             float64  `json:"rsi"`
	SMA50           float64  `json:"sma50"`
	Trend           string   `json:"trend"`

	WhyUndervalued  string   `json:"why_undervalued"`
	GrowthCatalysts []string `json:"growth_catalysts"`
	Risks           []string `json:"risks"`
	SIPRationale    string   `json:"sip_rationale"`
	RiskLevel       string   `json:"risk_level"`
}

type WatchlistResponse struct {
	Watchlist       []WatchlistStockData `json:"watchlist"`
	UndervaluedGems []GemStockData       `json:"undervalued_gems"`
	GeneratedAt     string               `json:"generated_at"`
}

// ─── Handler ──────────────────────────────────────────────────────────────────

func (h *Handler) GetWatchlist(c *gin.Context) {
	yc := data.NewYahooClient()

	// Collect all symbols
	allSymbols := make([]string, 0, len(sipWatchlistDefs)+len(undervaluedGemDefs))
	for _, w := range sipWatchlistDefs {
		allSymbols = append(allSymbols, w.Symbol)
	}
	for _, g := range undervaluedGemDefs {
		allSymbols = append(allSymbols, g.Symbol)
	}

	// Fetch chart data in parallel (1 year daily for technicals)
	type chartResult struct {
		symbol string
		bars   []data.ChartBar
	}
	chartCh := make(chan chartResult, len(allSymbols))
	for _, sym := range allSymbols {
		go func(s string) {
			bars, _, _, err := yc.FetchChart(s, "1d", "1y")
			if err != nil {
				chartCh <- chartResult{symbol: s}
				return
			}
			chartCh <- chartResult{symbol: s, bars: bars}
		}(sym)
	}
	barsMap := make(map[string][]data.ChartBar, len(allSymbols))
	for range allSymbols {
		r := <-chartCh
		if len(r.bars) > 0 {
			barsMap[r.symbol] = r.bars
		}
	}

	// Fetch fundamentals in parallel
	type summaryResult struct {
		symbol string
		sd     *data.SummaryData
	}
	summCh := make(chan summaryResult, len(allSymbols))
	for _, sym := range allSymbols {
		go func(s string) {
			sd, err := yc.FetchSummary(s)
			if err != nil {
				summCh <- summaryResult{symbol: s}
				return
			}
			summCh <- summaryResult{symbol: s, sd: sd}
		}(sym)
	}
	summMap := make(map[string]*data.SummaryData, len(allSymbols))
	for range allSymbols {
		r := <-summCh
		if r.sd != nil {
			summMap[r.symbol] = r.sd
		}
	}

	// Build watchlist items
	watchlist := make([]WatchlistStockData, 0, len(sipWatchlistDefs))
	for _, w := range sipWatchlistDefs {
		watchlist = append(watchlist, buildWatchlistStockData(w.Symbol, w.Name, w.Sector, w.Thesis, w.SIPNote, barsMap[w.Symbol], summMap[w.Symbol]))
	}

	// Build gem items
	gems := make([]GemStockData, 0, len(undervaluedGemDefs))
	for _, g := range undervaluedGemDefs {
		gems = append(gems, buildGemStockData(g, barsMap[g.Symbol], summMap[g.Symbol]))
	}

	c.JSON(http.StatusOK, WatchlistResponse{
		Watchlist:       watchlist,
		UndervaluedGems: gems,
		GeneratedAt:     time.Now().Format(time.RFC3339),
	})
}

// ─── Builders ─────────────────────────────────────────────────────────────────

func buildWatchlistStockData(symbol, name, sector string, thesis []string, sipNote string, bars []data.ChartBar, summary *data.SummaryData) WatchlistStockData {
	s := WatchlistStockData{
		Symbol:        symbol,
		Name:          name,
		Sector:        sector,
		KeyThesis:     thesis,
		SIPSuggestion: sipNote,
	}

	closes := extractCloses(bars)

	if len(closes) > 0 {
		s.CurrentPrice = closes[len(closes)-1]
		if len(closes) > 1 {
			prev := closes[len(closes)-2]
			s.PriceChange = s.CurrentPrice - prev
			if prev > 0 {
				s.PriceChangePct = s.PriceChange / prev * 100
			}
		}
	}

	// Technical indicators
	if len(closes) >= 20 {
		s.SMA20 = wlSMA(closes, 20)
	}
	if len(closes) >= 50 {
		s.SMA50 = wlSMA(closes, 50)
	}
	if len(closes) >= 200 {
		s.SMA200 = wlSMA(closes, 200)
	}
	if len(closes) >= 15 {
		s.RSI = wlRSI(closes, 14)
	}
	if len(closes) >= 35 {
		_, _, s.MACDHist = wlMACD(closes)
	}

	techScore := 0
	if s.SMA20 > 0 && s.CurrentPrice > s.SMA20 {
		techScore++
	}
	if s.SMA50 > 0 && s.CurrentPrice > s.SMA50 {
		techScore++
	}
	if s.SMA200 > 0 && s.CurrentPrice > s.SMA200 {
		techScore++
	}
	if s.RSI > 50 {
		techScore++
	}
	if s.MACDHist > 0 {
		techScore++
	}
	s.TechScore = techScore * 20
	switch {
	case techScore >= 4:
		s.Trend = "BULLISH"
		s.TechSignal = "BUY"
	case techScore <= 1:
		s.Trend = "BEARISH"
		s.TechSignal = "SELL"
	default:
		s.Trend = "NEUTRAL"
		s.TechSignal = "HOLD"
	}

	// Fundamentals
	fundScore := 0
	if summary != nil {
		s.PERatio = summary.PERatio
		s.ForwardPE = summary.ForwardPE
		s.EPS = summary.EPS
		if summary.EPSGrowth != nil {
			v := *summary.EPSGrowth * 100
			s.EPSGrowthPct = &v
		}
		if summary.RevenueGrowth != nil {
			v := *summary.RevenueGrowth * 100
			s.RevenueGrowthPct = &v
		}
		s.DebtEquity = summary.DebtEquity
		if summary.ROE != nil {
			v := *summary.ROE * 100
			s.ROEPct = &v
		}
		if summary.ROA != nil {
			v := *summary.ROA * 100
			s.ROAPct = &v
		}
		if summary.MarketCap != nil {
			s.MarketCapB = *summary.MarketCap / 1e9
		}
		if summary.DividendYield != nil {
			v := *summary.DividendYield * 100
			s.DividendYieldPct = &v
		}
		s.PriceToBook = summary.PriceToBook
		if summary.ProfitMargin != nil {
			v := *summary.ProfitMargin * 100
			s.ProfitMarginPct = &v
		}

		if s.PERatio != nil && *s.PERatio < 40 {
			fundScore++
		}
		if s.ROEPct != nil && *s.ROEPct > 15 {
			fundScore++
		}
		if s.EPSGrowthPct != nil && *s.EPSGrowthPct > 10 {
			fundScore++
		}
		if s.RevenueGrowthPct != nil && *s.RevenueGrowthPct > 10 {
			fundScore++
		}
		if s.ProfitMarginPct != nil && *s.ProfitMarginPct > 15 {
			fundScore++
		}

		switch {
		case fundScore >= 4:
			s.FundamentalRating = "EXCELLENT"
		case fundScore == 3:
			s.FundamentalRating = "GOOD"
		case fundScore == 2:
			s.FundamentalRating = "FAIR"
		default:
			s.FundamentalRating = "WEAK"
		}
		s.FundamentalScore = fundScore * 20

		if s.PERatio != nil {
			switch {
			case *s.PERatio < 20:
				s.ValuationZone = "UNDERVALUED"
			case *s.PERatio < 35:
				s.ValuationZone = "FAIR"
			case *s.PERatio < 55:
				s.ValuationZone = "SLIGHTLY_HIGH"
			default:
				s.ValuationZone = "OVERVALUED"
			}
		} else {
			s.ValuationZone = "FAIR"
		}
	} else {
		s.FundamentalRating = "N/A"
		s.ValuationZone = "N/A"
	}

	combined := (s.FundamentalScore + s.TechScore) / 2
	switch {
	case combined >= 75:
		s.SIPRating = "EXCELLENT"
	case combined >= 55:
		s.SIPRating = "GOOD"
	case combined >= 35:
		s.SIPRating = "FAIR"
	default:
		s.SIPRating = "SPECULATIVE"
	}

	return s
}

func buildGemStockData(def struct {
	Symbol          string
	Name            string
	Sector          string
	WhyUndervalued  string
	GrowthCatalysts []string
	Risks           []string
	SIPRationale    string
	RiskLevel       string
	ExpectedCAGR    float64
	UpsidePct       float64
}, bars []data.ChartBar, summary *data.SummaryData) GemStockData {
	g := GemStockData{
		Symbol:          def.Symbol,
		Name:            def.Name,
		Sector:          def.Sector,
		WhyUndervalued:  def.WhyUndervalued,
		GrowthCatalysts: def.GrowthCatalysts,
		Risks:           def.Risks,
		SIPRationale:    def.SIPRationale,
		RiskLevel:       def.RiskLevel,
		ExpectedCAGRPct: def.ExpectedCAGR,
		UpsidePct:       def.UpsidePct,
	}

	closes := extractCloses(bars)
	if len(closes) > 0 {
		g.CurrentPrice = closes[len(closes)-1]
		if len(closes) > 1 {
			prev := closes[len(closes)-2]
			g.PriceChange = g.CurrentPrice - prev
			if prev > 0 {
				g.PriceChangePct = g.PriceChange / prev * 100
			}
		}
	}
	if len(closes) >= 15 {
		g.RSI = wlRSI(closes, 14)
	}
	if len(closes) >= 50 {
		g.SMA50 = wlSMA(closes, 50)
	}
	if g.SMA50 > 0 && g.CurrentPrice > g.SMA50 {
		g.Trend = "BULLISH"
	} else {
		g.Trend = "BEARISH"
	}
	if summary != nil {
		g.PERatio = summary.PERatio
	}
	return g
}

// ─── Technical helpers ────────────────────────────────────────────────────────

func extractCloses(bars []data.ChartBar) []float64 {
	closes := make([]float64, len(bars))
	for i, b := range bars {
		closes[i] = b.Close
	}
	return closes
}

func wlRSI(closes []float64, period int) float64 {
	if len(closes) < period+1 {
		return 50
	}
	gains, losses := 0.0, 0.0
	for i := len(closes) - period; i < len(closes); i++ {
		diff := closes[i] - closes[i-1]
		if diff > 0 {
			gains += diff
		} else {
			losses += math.Abs(diff)
		}
	}
	if losses == 0 {
		return 100
	}
	rs := (gains / float64(period)) / (losses / float64(period))
	return 100 - 100/(1+rs)
}

func wlSMA(closes []float64, period int) float64 {
	if len(closes) < period {
		return 0
	}
	sum := 0.0
	for _, c := range closes[len(closes)-period:] {
		sum += c
	}
	return sum / float64(period)
}

func wlEMA(prices []float64, period int) []float64 {
	if len(prices) < period {
		return nil
	}
	k := 2.0 / float64(period+1)
	emas := make([]float64, len(prices))
	sum := 0.0
	for i := 0; i < period; i++ {
		sum += prices[i]
	}
	emas[period-1] = sum / float64(period)
	for i := period; i < len(prices); i++ {
		emas[i] = prices[i]*k + emas[i-1]*(1-k)
	}
	return emas
}

func wlMACD(closes []float64) (macdLine, signalLine, histogram float64) {
	if len(closes) < 35 {
		return
	}
	ema12 := wlEMA(closes, 12)
	ema26 := wlEMA(closes, 26)
	if len(ema12) == 0 || len(ema26) == 0 {
		return
	}
	n := len(closes)
	macdSeries := make([]float64, n-25)
	for i := 25; i < n; i++ {
		macdSeries[i-25] = ema12[i] - ema26[i]
	}
	signalSeries := wlEMA(macdSeries, 9)
	macdVal := macdSeries[len(macdSeries)-1]
	if len(signalSeries) == 0 {
		return macdVal, 0, macdVal
	}
	sigVal := signalSeries[len(signalSeries)-1]
	return macdVal, sigVal, macdVal - sigVal
}
