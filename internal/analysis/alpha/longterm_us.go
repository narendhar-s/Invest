package alpha

import (
	"fmt"
	"math"
	"sort"
	"time"

	"stockwise/internal/storage"
)

// ─── Data Types ───────────────────────────────────────────────────────────────

// LongTermUSPick represents a US stock scored for 3-year monthly SIP investing.
type LongTermUSPick struct {
	Symbol            string  `json:"symbol"`
	Name              string  `json:"name"`
	Sector            string  `json:"sector"`
	GrowthSector      string  `json:"growth_sector"`
	GrowthSectorLabel string  `json:"growth_sector_label"`
	CurrentPrice      float64 `json:"current_price"`
	Target3YrLow      float64 `json:"target_3yr_low"`
	Target3YrHigh     float64 `json:"target_3yr_high"`
	ExpectedCAGR      float64 `json:"expected_cagr_pct"`

	// Composite scores (each component's max shown in comment)
	OverallSIPScore float64 `json:"overall_sip_score"` // 0-100
	FundScore       float64 `json:"fund_score"`        // 0-35
	TechScore       float64 `json:"tech_score"`        // 0-10
	ValuationScore  float64 `json:"valuation_score"`   // 0-25
	GrowthScore     float64 `json:"growth_score"`      // 0-25
	SIPBonus        float64 `json:"sip_bonus"`         // 0-5

	// Fundamentals
	PERatio       float64 `json:"pe_ratio"`
	ForwardPE     float64 `json:"forward_pe"`
	PriceToBook   float64 `json:"price_to_book"`
	EPSGrowth     float64 `json:"eps_growth_pct"`
	RevenueGrowth float64 `json:"revenue_growth_pct"`
	ROE           float64 `json:"roe_pct"`
	ROA           float64 `json:"roa_pct"`
	DebtEquity    float64 `json:"debt_equity"`
	ProfitMargin  float64 `json:"profit_margin_pct"`
	DividendYield float64 `json:"dividend_yield_pct"`

	// Technical
	RSI         float64 `json:"rsi"`
	Trend       string  `json:"trend"`
	AboveSMA200 bool    `json:"above_sma200"`
	MATrend     string  `json:"ma_trend"`   // BULLISH | BEARISH | NEUTRAL
	TechEntry   string  `json:"tech_entry"` // GOOD | FAIR | WAIT

	// SIP-specific fields
	SIPRating     string  `json:"sip_rating"`      // EXCELLENT | GOOD | FAIR | SPECULATIVE
	RiskProfile   string  `json:"risk_profile"`    // CONSERVATIVE | MODERATE | AGGRESSIVE
	MonthlySIPPct float64 `json:"monthly_sip_pct"` // suggested % of monthly SIP budget
	ValuationZone string  `json:"valuation_zone"`  // UNDERVALUED | FAIR | SLIGHTLY_HIGH | OVERVALUED

	// Investment thesis
	Thesis      []string `json:"thesis"`
	Risks       []string `json:"risks"`
	BestBuyZone string   `json:"best_buy_zone"`

	GeneratedAt string `json:"generated_at"`
}

// LongTermUSReport is the full API response.
type LongTermUSReport struct {
	Picks          []LongTermUSPick  `json:"picks"`
	SectorSummary  []SIPSectorItem   `json:"sector_summary"`
	TotalPicks     int               `json:"total_picks"`
	AvgExpCAGR     float64           `json:"avg_expected_cagr_pct"`
	SIPMethodology string            `json:"sip_methodology"`
	GeneratedAt    string            `json:"generated_at"`
}

// SIPSectorItem summarises picks per growth sector.
type SIPSectorItem struct {
	GrowthSector string  `json:"growth_sector"`
	Label        string  `json:"label"`
	Count        int     `json:"count"`
	AvgScore     float64 `json:"avg_score"`
	AvgCAGR      float64 `json:"avg_cagr_pct"`
	AllocPct     float64 `json:"alloc_pct"`
}

// ─── Sector Definitions ──────────────────────────────────────────────────────

type growthSectorInfo struct {
	Label       string
	CAGRLow     float64
	CAGRHigh    float64
	BaseScore   float64 // sector tailwind (out of 25)
	PETolerance float64 // P/E considered "fair" for this sector
}

var growthSectors = map[string]growthSectorInfo{
	"AI_TECH":      {"AI & Technology",    18, 35, 25, 45},
	"HEALTHCARE":   {"Healthcare",          12, 22, 22, 30},
	"CLEAN_ENERGY": {"Clean Energy & EV",  15, 30, 20, 40},
	"FINTECH":      {"Financial Tech",      10, 18, 17, 25},
	"CONSUMER":     {"Consumer & Retail",    8, 14, 13, 22},
	"ENERGY":       {"Traditional Energy",   5, 12,  9, 18},
	"COMMODITY":    {"Commodity/ETF",         3,  8,  5, 15},
}

var stockGrowthSector = map[string]string{
	"AAPL": "AI_TECH", "MSFT": "AI_TECH", "GOOGL": "AI_TECH",
	"AMZN": "AI_TECH", "NVDA": "AI_TECH", "META": "AI_TECH",
	"NFLX": "AI_TECH", "ADBE": "AI_TECH", "CRM": "AI_TECH",
	"AMD":  "AI_TECH", "INTC": "AI_TECH",
	"TSLA": "CLEAN_ENERGY",
	"JPM": "FINTECH", "V": "FINTECH", "MA": "FINTECH", "BAC": "FINTECH",
	"JNJ": "HEALTHCARE", "UNH": "HEALTHCARE", "ABBV": "HEALTHCARE", "PFE": "HEALTHCARE",
	"PG": "CONSUMER", "HD": "CONSUMER", "COST": "CONSUMER",
	"XOM": "ENERGY", "CVX": "ENERGY",
	"GLD": "COMMODITY",
}

// ─── Investment Thesis Database ───────────────────────────────────────────────

type stockInsight struct {
	thesis []string
	risks  []string
}

var stockInsights = map[string]stockInsight{
	"AAPL": {
		thesis: []string{
			"Apple Intelligence driving services revenue acceleration to 20%+ growth",
			"iPhone upgrade supercycle expected as AI features require A18+ chips",
			"$100B+ annual buybacks reduce share count 3–4% yearly — compounding machine",
			"Services (App Store, iCloud, Pay) at 30%+ margins growing 15% annually",
			"2B+ active device installed base creates deep ecosystem lock-in",
		},
		risks: []string{
			"Premium valuation (30–35x P/E) limits multiple expansion from here",
			"China revenue (~20%) exposed to tariff and geopolitical escalation",
			"Regulatory antitrust pressure on App Store 30% commission model",
		},
	},
	"MSFT": {
		thesis: []string{
			"Azure AI growing 35%+ YoY — fastest hyperscaler with best AI positioning",
			"OpenAI exclusive partnership creates unmatched enterprise AI moat",
			"Microsoft 365 Copilot at $30/user/month — ARPU doubling opportunity",
			"GitHub Copilot 1.8M+ paid seats — AI-coding market leader",
			"65%+ gross margins with consistent 20%+ EPS CAGR for 5+ years",
		},
		risks: []string{
			"30x+ forward P/E priced for sustained perfection",
			"Google Cloud and AWS competing aggressively on AI pricing",
			"EU Digital Markets Act adding regulatory complexity",
		},
	},
	"GOOGL": {
		thesis: []string{
			"Gemini AI integration defending the $300B+ global search advertising moat",
			"Google Cloud growing 25%+ driven by Vertex AI infrastructure demand",
			"YouTube #2 streaming platform — ads + subscription revenue diversifying",
			"Cheapest of Big 6 tech at ~20x forward earnings — compelling value",
			"Waymo AV and DeepMind biotech represent massive unpriced optionality",
		},
		risks: []string{
			"AI-native search (Perplexity, ChatGPT) steadily eroding query share",
			"EU antitrust fines ($10B+ cumulative) and structural break-up risk",
			"Advertising spend is highly macro-sensitive during recessions",
		},
	},
	"AMZN": {
		thesis: []string{
			"AWS Bedrock + Trainium AI chips growing 40%+ YoY — cloud AI leader",
			"Advertising at $50B+ revenue and 90%+ margin — underappreciated gem",
			"Prime membership flywheel: 200M+ members, 15+ bundled services",
			"Retail margin expansion story: fulfillment network now structurally profitable",
			"Anthropic (Claude) investment provides strategic AI platform partnership",
		},
		risks: []string{
			"Retail low margins make earnings sensitive to cost/macro swings",
			"FTC antitrust scrutiny on marketplace seller and Prime bundling practices",
			"AWS 2025 capex $75B+ creates near-term free cash flow pressure",
		},
	},
	"NVDA": {
		thesis: []string{
			"AI data center GPU monopoly — 80%+ market share in training compute",
			"Blackwell B200 delivers 3–5x performance per watt over Hopper generation",
			"CUDA software ecosystem lock-in requires 5–10 years to replicate",
			"Inference compute demand growing 10x as AI models move to production",
			"Sovereign AI (40+ countries) and edge AI opening entirely new demand pools",
		},
		risks: []string{
			"40x+ forward P/E is the richest valuation in mega-cap technology",
			"US chip export restrictions permanently blocking ~15–20% China revenue",
			"AMD MI300X + custom chips (Google TPU, AWS Trainium) eroding share",
			"Top-5 customer concentration at 40%+ revenue — vulnerable to order swings",
		},
	},
	"META": {
		thesis: []string{
			"3.35B daily active people — largest social graph, impossible to replicate",
			"AI-driven ad targeting delivering 30%+ ROAS improvement for advertisers",
			"Llama open-source model building a developer ecosystem around Meta infra",
			"WhatsApp Business monetisation barely started — $10B+ revenue potential",
			"Ray-Ban AI glasses 3M+ units sold — nascent AR/wearables platform forming",
		},
		risks: []string{
			"Reality Labs burning $15B+/year — metaverse timeline unclear",
			"Teen and young adult engagement declining in North America and Europe",
			"EU Digital Services Act and GDPR limiting ad-targeting precision",
		},
	},
	"TSLA": {
		thesis: []string{
			"Full Self-Driving v13 approaching L3/L4 autonomy — trillion-dollar optionality",
			"Robotaxi commercial launch (Austin 2025) could disrupt $2T ride-hail market",
			"Optimus humanoid robot at target $20K/unit — potentially largest product ever",
			"Energy storage (Megapack) growing 150%+ YoY at higher margins than vehicles",
			"Vertical integration (cells, software, hardware) = ultimate manufacturing moat",
		},
		risks: []string{
			"95%+ of current valuation is speculative future businesses, not earnings",
			"EV demand softening globally; Model 3/Y price cuts compressing margins",
			"Elon Musk DOGE/political activities causing brand damage and boycotts",
			"BYD + Chinese OEMs competing aggressively at lower price points globally",
		},
	},
	"JPM": {
		thesis: []string{
			"Best-in-class management (Jamie Dimon) with proven crisis-navigation record",
			"$50B+ annual earnings with 9–10% ROE — best returns in US banking",
			"AI deployment saving $1.5B+ annually in operational costs",
			"Investment banking recovery as M&A and IPO cycle normalises post-2024",
			"Dividend growing 8–10% annually with $20B+ buyback capacity",
		},
		risks: []string{
			"Each 100bps of rate cuts compresses net interest margin by ~$4B",
			"Basel III endgame capital requirements constrain capital return flexibility",
			"Consumer credit quality stress if unemployment rises above 5%",
		},
	},
	"JNJ": {
		thesis: []string{
			"Oncology pipeline (Carvykti, Darzalex, Rybrevant) driving 8–12% EPS growth",
			"MedTech (Shockwave, Abiomed) growing 8%+ organically vs sector peers",
			"Talc liability substantially resolved — major valuation overhang clearing",
			"AAA credit rating — one of only two US companies with this distinction",
			"62-year consecutive dividend increase streak — Dividend King",
		},
		risks: []string{
			"IRA drug pricing negotiation reducing pharmaceutical pricing power 2025–2026",
			"Patent cliff: Darzalex ($10B+ drug) faces biosimilar entry in 2027",
			"MedTech procedure volume sensitive to hospital budget cuts",
		},
	},
	"V": {
		thesis: []string{
			"Global payments rails processing $15T+ annually — internet infrastructure for money",
			"Cashless penetration only 40–50% in emerging markets = decades of runway",
			"Value-added services (fraud prevention, analytics) growing 20%+ annually",
			"Cross-border transactions yield 2x domestic — biggest tailwind from travel",
			"Asset-light model: 50%+ net margins compound at 15%+ EPS CAGR",
		},
		risks: []string{
			"CFPB credit card fee regulation — potential $10B+ revenue impact",
			"FedNow real-time payments and Zelle reducing card transaction volumes",
			"Stablecoin/crypto payment rails threatening card economics long-term",
		},
	},
	"PG": {
		thesis: []string{
			"65 #1 or #2 global brands with strong pricing power across 180+ countries",
			"Emerging market penetration in Africa and SE Asia still in early innings",
			"67-year consecutive dividend increase — longest streak in the S&P 500",
			"AI-driven supply chain and marketing efficiency expanding operating margins",
			"Organic growth 4–6% + buybacks = reliable 9–11% annual total return",
		},
		risks: []string{
			"Private label competition intensifies during consumer spending pullbacks",
			"Raw material inflation (palm oil, resins, energy) squeezes margins",
			"Slow growth limits relative outperformance vs high-growth alternatives",
		},
	},
	"MA": {
		thesis: []string{
			"Visa/Mastercard duopoly controls 90%+ of global card payment rails",
			"B2B payments ($125T addressable market) less than 10% digitised",
			"Mastercard Send real-time disbursement growing 30%+ YoY",
			"Services revenue (cybersecurity, data, loyalty) growing 15%+ at high margins",
			"53%+ net margin with minimal capex = extraordinary capital return capacity",
		},
		risks: []string{
			"CFPB interchange fee regulation — same existential risk as Visa",
			"EU instant payment regulation reducing card-present transaction share",
			"Account-to-account payments infrastructure bypassing card networks globally",
		},
	},
	"UNH": {
		thesis: []string{
			"Optum Health managing 90M+ patients in value-based care — transforming delivery",
			"Medicare Advantage enrolling 65M+ by 2030 from ageing US demographics",
			"Optum Rx pharmacy benefits driving $200B+ annual revenue via scale",
			"AI-powered claims management reducing medical loss ratio 1–2%",
			"Consistent 13–16% EPS CAGR for 10+ consecutive years — rare reliability",
		},
		risks: []string{
			"DOJ antitrust investigation into Optum vertical integration — divestiture risk",
			"CMS rate cut risk for Medicare Advantage plan reimbursement",
			"Medical cost trend elevated with post-COVID utilisation normalisation",
		},
	},
	"HD": {
		thesis: []string{
			"50M homeowners locked at sub-3.5% mortgages choosing remodel over move",
			"Pro contractor (B2B) segment growing 2x faster than DIY consumer",
			"SRS Distribution acquisition adds $6.5B in specialty distribution revenue",
			"US housing stock median age 42 years — structural demand for repair/replace",
			"30%+ operating margins with disciplined buybacks and 17-year dividend growth",
		},
		risks: []string{
			"Housing market normalisation as rates fall could reduce renovation spending",
			"Consumer discretionary cuts during recession disproportionately hit HD",
			"Tariffs on Chinese goods (tools, appliances) add 5–10% COGS pressure",
		},
	},
	"BAC": {
		thesis: []string{
			"Most rate-sensitive mega bank: every 100bps = $3B+ net interest income",
			"Merrill Lynch $3T wealth management provides fee income regardless of rates",
			"75%+ digital banking adoption driving significant branch cost reduction",
			"$20B+ annual buyback capacity at historically low 1x book valuation",
			"Warren Buffett 13% ownership stake validates long-term value thesis",
		},
		risks: []string{
			"$500B+ held-to-maturity bond portfolio with large unrealised losses",
			"Commercial real estate loan exposure elevated at $60B+",
			"Consumer credit normalisation: net charge-off rates rising toward historic norms",
		},
	},
	"XOM": {
		thesis: []string{
			"Pioneer acquisition creates largest US Permian Basin operator",
			"Low-cost $35/barrel breakeven ensures profitability in all reasonable scenarios",
			"LNG export capacity meeting global energy security demand post-Ukraine war",
			"$20B carbon capture investment positions for long-term energy transition",
			"5%+ dividend yield plus buybacks = 10–12% total shareholder return",
		},
		risks: []string{
			"Oil below $50/barrel would force dividend cut and capex reduction",
			"EV adoption accelerating — long-term petroleum demand peak by 2030–2035",
			"Carbon taxes globally increasing cost of fossil fuel operations",
		},
	},
	"CVX": {
		thesis: []string{
			"Hess acquisition adds high-margin Guyana deepwater assets (long-life, low-cost)",
			"Free cash flow yield 8%+ at $70 oil funds buybacks and growing dividend",
			"Lower net debt ratio than ExxonMobil provides superior balance sheet flexibility",
			"Hydrogen and carbon capture investments building energy-transition credibility",
			"36 consecutive years of dividend increases — Dividend Aristocrat",
		},
		risks: []string{
			"Hess/ExxonMobil arbitration over Guyana ROFR creates deal uncertainty",
			"Every $10 change in oil = ~$2B FCF impact — high commodity exposure",
			"Capital-intensive deepwater development has multi-year payback periods",
		},
	},
	"ABBV": {
		thesis: []string{
			"Skyrizi and Rinvoq growing 50%+ annually — fully replacing $20B+ Humira cliff",
			"Allergan aesthetics (Botox, Juvederm) growing 10%+ post-COVID normalisation",
			"Oncology pipeline (navitoclax, telisotuzumab) building $5B+ revenue by 2027",
			"11+ year dividend growth streak with 5%+ current yield — income + growth",
			"Best pharma capital allocator track record of the decade",
		},
		risks: []string{
			"Humira biosimilar erosion steeper than guidance — multiple entrants in market",
			"IRA drug price negotiation targeting immunology drugs 2026–2027",
			"Skyrizi/Rinvoq long-term safety: any black box warning would be severe",
		},
	},
	"PFE": {
		thesis: []string{
			"Seagen oncology acquisition builds $10B+ ADC (antibody-drug conjugate) pipeline",
			"Danuglipron oral GLP-1 could be blockbuster if Phase 3 succeeds in 2025",
			"Non-COVID business (Eliquis, Vyndaqel, Prevnar) growing 8–10% annually",
			"Stock near multi-decade low — significant asymmetric upside potential",
			"5.5%+ dividend yield among highest in pharma — strong income play",
		},
		risks: []string{
			"Multiple Phase 3 pipeline failures in 2024 damaged investor confidence",
			"Seagen integration costs and potential $30B+ goodwill impairment risk",
			"GLP-1 pill development 3+ years behind Novo Nordisk and Eli Lilly",
			"2025 patent cliff: Eliquis ($6B) faces generic competition",
		},
	},
	"COST": {
		thesis: []string{
			"90%+ membership renewal rate creates annuity-like recession-resistant revenue",
			"Treasure hunt experience drives 14+ shopping trips/year — unmatched traffic",
			"International expansion (50+ new warehouses/year) sustaining 7–9% unit growth",
			"Kirkland Signature private label (30%+ of sales) at 50%+ gross margins",
			"E-commerce growing 20%+ while complementing warehouse store economics",
		},
		risks: []string{
			"45x+ P/E is extremely high for a retailer — modest slowdown = large derating",
			"Membership fee increases risk alienating price-sensitive core members",
			"Labor cost inflation: Costco pays $30/hour average — highest in retail",
		},
	},
	"NFLX": {
		thesis: []string{
			"Ad-supported tier growing to 100M+ subscribers — high-margin new revenue stream",
			"Password sharing crackdown added 70M+ paying members in 18 months",
			"Live sports rights (NFL Christmas games, WWE) reducing churn and driving engagement",
			"AI content personalisation and localisation expanding global addressable market",
			"International markets (India, LATAM, SE Asia) underpenetrated at $5–7/month",
		},
		risks: []string{
			"Content spending arms race with Disney+, Amazon, Apple TV+ — $17B+ annual cost",
			"Ad-tier CPMs under pressure as inventory scales faster than brand demand",
			"North American subscriber saturation limits core market growth to price increases",
		},
	},
	"ADBE": {
		thesis: []string{
			"Firefly generative AI deeply integrated across Creative Cloud — best content AI",
			"Document Cloud AI (AI Assistant in Acrobat) automating enterprise workflows",
			"Stock at 3-year low post-Figma cancellation — significant valuation reset",
			"25M+ creative professionals on subscription with high switching costs",
			"Experience Cloud (marketing analytics) growing 15%+ with enterprise stickiness",
		},
		risks: []string{
			"Canva and Figma penetrating Adobe's core creative market with free tiers",
			"OpenAI Sora, Midjourney, and open-source tools disrupting Firefly pricing",
			"Enterprise marketing tech budgets vulnerable to IT spending cuts",
		},
	},
	"CRM": {
		thesis: []string{
			"Agentforce autonomous AI agents replacing RPA/BPO — entirely new product category",
			"Data Cloud + AI combining into the most comprehensive B2B data platform",
			"Slack integration creating irreplaceable enterprise collaboration and workflow hub",
			"70%+ subscription revenue with multi-year contracts = outstanding visibility",
			"Operating margin expanding from 20% toward 30%+ as growth investments mature",
		},
		risks: []string{
			"Microsoft Dynamics + Copilot directly threatening core sales automation business",
			"Enterprise tech budget scrutiny slowing new logo acquisition",
			"Benioff governance concerns: dual-class shares and Board turnover",
		},
	},
	"AMD": {
		thesis: []string{
			"MI300X GPU gaining real datacenter share — $5B+ AI accelerator run rate in 2024",
			"EPYC server CPU at 25%+ market share, taking from Intel every quarter",
			"ROCm software stack improving — large model training increasingly portable to AMD",
			"ZT Systems acquisition adds AI system integration and manufacturing scale",
			"30x forward P/E vs NVDA's 40x with similar TAM growth — relative discount",
		},
		risks: []string{
			"NVIDIA CUDA ecosystem lock-in is a 5–10 year competitive moat",
			"US export restrictions could expand to AMD chips as well",
			"Intel foundry improvement could erode AMD's CPU performance leadership",
			"Customer concentration: top AI hyperscalers control AMD's GPU destiny",
		},
	},
	"INTC": {
		thesis: []string{
			"Intel 18A process node (late 2025) could recover manufacturing competitiveness",
			"$8.5B CHIPS Act grant + $25B in loan eligibility de-risking the capex",
			"Intel Foundry attracting US national security chip manufacturing customers",
			"Stock at ~0.8x book value — deep value if turnaround succeeds",
			"Gaudi 3 AI accelerator competing in inference market at competitive price points",
		},
		risks: []string{
			"18A yield ramp — another major process delay could be existential",
			"AMD captured 25%+ CPU datacenter share — very hard to reclaim",
			"$10B+/year FCF burn straining balance sheet without sustained government support",
			"TSMC 2nm risk: if Intel 18A fails, TSMC becomes the only alternative",
		},
	},
}

// ─── Analyzer ─────────────────────────────────────────────────────────────────

// LongTermUSAnalyzer generates 3-year SIP picks for US growth stocks.
type LongTermUSAnalyzer struct{}

func NewLongTermUSAnalyzer() *LongTermUSAnalyzer { return &LongTermUSAnalyzer{} }

// GeneratePicks runs the full multi-factor analysis and returns a ranked SIP report.
func (a *LongTermUSAnalyzer) GeneratePicks(
	stocks []storage.Stock,
	indicators map[uint]*storage.TechnicalIndicator,
	fundamentals map[uint]*storage.Fundamental,
	latestPrices map[uint]float64,
) LongTermUSReport {
	now := time.Now().Format(time.RFC3339)
	var picks []LongTermUSPick

	for _, stock := range stocks {
		if stock.IsIndex || stock.Market != "US" {
			continue
		}
		price := latestPrices[stock.ID]
		if price == 0 {
			continue
		}
		pick := a.analyzePick(stock, fundamentals[stock.ID], indicators[stock.ID], price, now)
		picks = append(picks, pick)
	}

	sort.Slice(picks, func(i, j int) bool {
		return picks[i].OverallSIPScore > picks[j].OverallSIPScore
	})

	assignSIPAllocations(picks)

	totalCAGR := 0.0
	for _, p := range picks {
		totalCAGR += p.ExpectedCAGR
	}
	avgCAGR := 0.0
	if len(picks) > 0 {
		avgCAGR = math.Round(totalCAGR/float64(len(picks))*10) / 10
	}

	return LongTermUSReport{
		Picks:         picks,
		SectorSummary: buildSIPSectorSummary(picks),
		TotalPicks:    len(picks),
		AvgExpCAGR:    avgCAGR,
		SIPMethodology: "Multi-factor scoring: Growth Sector Tailwind 25% + Fundamental Quality 35% +" +
			" Valuation Attractiveness 25% + Technical Entry 10% + SIP Suitability 5%." +
			" Designed for monthly DCA over 36 months (3-year horizon).",
		GeneratedAt: now,
	}
}

func (a *LongTermUSAnalyzer) analyzePick(
	stock storage.Stock,
	fund *storage.Fundamental,
	ind *storage.TechnicalIndicator,
	price float64,
	now string,
) LongTermUSPick {
	gs, ok := stockGrowthSector[stock.Symbol]
	if !ok {
		gs = "CONSUMER"
	}
	sectorInfo := growthSectors[gs]

	pe, fpE, pb, epsG, revG, roe, roa, de, pm, divY := extractFunds(fund)
	rsi, trend, aboveSMA200, maTrend := extractTechs(ind, price)

	// ── Score Components ──────────────────────────────────────────────────────

	growthScore := sectorInfo.BaseScore // 0-25

	fundScore, _ := scoreFunds(epsG, revG, roe, de, pm, divY) // 0-35

	valScore, valZone := scoreVal(pe, fpE, rsi, aboveSMA200, sectorInfo.PETolerance) // 0-25

	techScore, techEntry := scoreTechEntry(rsi, aboveSMA200, maTrend, ind) // 0-10

	sipBonus := 5.0 // US stocks are highly liquid — always gets base bonus
	if de > 2.0 {
		sipBonus -= 2
	}
	if pe <= 0 && fpE <= 0 {
		sipBonus -= 1 // no earnings data
	}

	overall := math.Min(growthScore+fundScore+valScore+techScore+sipBonus, 100)
	overall = math.Round(overall*10) / 10

	// ── CAGR + 3-Year Targets ─────────────────────────────────────────────────

	cagrLow, cagrHigh := projectCAGRRange(gs, epsG, revG, roe, de, rsi, aboveSMA200, valZone)
	expectedCAGR := math.Round((cagrLow+cagrHigh)/2*10) / 10
	target3Low := math.Round(price*math.Pow(1+cagrLow/100, 3)*100) / 100
	target3High := math.Round(price*math.Pow(1+cagrHigh/100, 3)*100) / 100

	// ── Classifications ───────────────────────────────────────────────────────

	sipRating := sipRatingLabel(overall)
	riskProfile := classifyRiskProfile(gs, de, divY, pe, epsG)

	// ── Thesis & Risks ────────────────────────────────────────────────────────

	insight, hasInsight := stockInsights[stock.Symbol]
	thesis := []string{}
	risks := []string{}
	if hasInsight {
		thesis = insight.thesis
		risks = insight.risks
	} else {
		thesis = []string{
			fmt.Sprintf("%s sector with %.0f–%.0f%% expected 3-year CAGR", sectorInfo.Label, sectorInfo.CAGRLow, sectorInfo.CAGRHigh),
			fmt.Sprintf("EPS growth %.1f%% and ROE %.1f%% show operational quality", epsG, roe),
		}
		if divY > 1 {
			thesis = append(thesis, fmt.Sprintf("%.1f%% dividend yield provides income during accumulation", divY))
		}
		risks = []string{
			"Limited fundamental data — monitor earnings reports closely",
			"Sector competition may intensify over the 3-year horizon",
		}
	}

	return LongTermUSPick{
		Symbol:            stock.Symbol,
		Name:              stock.Name,
		Sector:            stock.Sector,
		GrowthSector:      gs,
		GrowthSectorLabel: sectorInfo.Label,
		CurrentPrice:      math.Round(price*100) / 100,
		Target3YrLow:      target3Low,
		Target3YrHigh:     target3High,
		ExpectedCAGR:      expectedCAGR,
		OverallSIPScore:   overall,
		FundScore:         math.Round(fundScore*10) / 10,
		TechScore:         math.Round(techScore*10) / 10,
		ValuationScore:    math.Round(valScore*10) / 10,
		GrowthScore:       growthScore,
		SIPBonus:          sipBonus,
		PERatio:           math.Round(pe*100) / 100,
		ForwardPE:         math.Round(fpE*100) / 100,
		PriceToBook:       math.Round(pb*100) / 100,
		EPSGrowth:         math.Round(epsG*100) / 100,
		RevenueGrowth:     math.Round(revG*100) / 100,
		ROE:               math.Round(roe*100) / 100,
		ROA:               math.Round(roa*100) / 100,
		DebtEquity:        math.Round(de*100) / 100,
		ProfitMargin:      math.Round(pm*100) / 100,
		DividendYield:     math.Round(divY*100) / 100,
		RSI:               math.Round(rsi*10) / 10,
		Trend:             trend,
		AboveSMA200:       aboveSMA200,
		MATrend:           maTrend,
		TechEntry:         techEntry,
		SIPRating:         sipRating,
		RiskProfile:       riskProfile,
		MonthlySIPPct:     0, // assigned later by assignSIPAllocations
		ValuationZone:     valZone,
		Thesis:            thesis,
		Risks:             risks,
		BestBuyZone:       buyZoneLabel(price, rsi, aboveSMA200, ind),
		GeneratedAt:       now,
	}
}

// ─── Scoring Helpers ──────────────────────────────────────────────────────────

func extractFunds(fund *storage.Fundamental) (pe, fpE, pb, epsG, revG, roe, roa, de, pm, divY float64) {
	if fund == nil {
		return
	}
	if fund.PERatio != nil {
		pe = *fund.PERatio
	}
	if fund.ForwardPE != nil {
		fpE = *fund.ForwardPE
	}
	if fund.PriceToBook != nil {
		pb = *fund.PriceToBook
	}
	if fund.EPSGrowth != nil {
		epsG = *fund.EPSGrowth * 100
	}
	if fund.RevenueGrowth != nil {
		revG = *fund.RevenueGrowth * 100
	}
	if fund.ROE != nil {
		roe = *fund.ROE * 100
	}
	if fund.ROA != nil {
		roa = *fund.ROA * 100
	}
	if fund.DebtEquity != nil {
		de = *fund.DebtEquity
	}
	if fund.ProfitMargin != nil {
		pm = *fund.ProfitMargin * 100
	}
	if fund.DividendYield != nil {
		divY = *fund.DividendYield * 100
	}
	return
}

func extractTechs(ind *storage.TechnicalIndicator, price float64) (rsi float64, trend string, aboveSMA200 bool, maTrend string) {
	rsi = 50
	trend = "SIDEWAYS"
	maTrend = "NEUTRAL"
	if ind == nil {
		return
	}
	if ind.RSI != nil {
		rsi = *ind.RSI
	}
	trend = ind.TrendDirection

	var sma20, sma50, sma200 float64
	if ind.SMA20 != nil {
		sma20 = *ind.SMA20
	}
	if ind.SMA50 != nil {
		sma50 = *ind.SMA50
	}
	if ind.SMA200 != nil {
		sma200 = *ind.SMA200
	}
	if sma200 > 0 {
		aboveSMA200 = price > sma200
	}
	if sma20 > 0 && sma50 > 0 && sma200 > 0 {
		switch {
		case sma20 > sma50 && sma50 > sma200:
			maTrend = "BULLISH"
		case sma20 < sma50 && sma50 < sma200:
			maTrend = "BEARISH"
		default:
			maTrend = "NEUTRAL"
		}
	}
	return
}

func scoreFunds(epsG, revG, roe, de, pm, divY float64) (float64, []string) {
	score := 0.0
	var reasons []string

	switch {
	case epsG > 25:
		score += 12
		reasons = append(reasons, fmt.Sprintf("Strong EPS growth %.1f%%", epsG))
	case epsG > 15:
		score += 9
		reasons = append(reasons, fmt.Sprintf("Solid EPS growth %.1f%%", epsG))
	case epsG > 8:
		score += 6
	case epsG > 0:
		score += 3
	case epsG < -5:
		score -= 5
	}

	switch {
	case revG > 20:
		score += 8
		reasons = append(reasons, fmt.Sprintf("Revenue growing %.1f%% YoY", revG))
	case revG > 10:
		score += 6
		reasons = append(reasons, fmt.Sprintf("Revenue growing %.1f%%", revG))
	case revG > 5:
		score += 3
	case revG < -3:
		score -= 3
	}

	switch {
	case roe > 25:
		score += 8
		reasons = append(reasons, fmt.Sprintf("High ROE %.1f%% — capital efficient", roe))
	case roe > 15:
		score += 6
	case roe > 8:
		score += 3
	case roe < 0:
		score -= 4
	}

	switch {
	case de < 0.3:
		score += 4
		reasons = append(reasons, fmt.Sprintf("Very low debt D/E %.2f", de))
	case de < 0.7:
		score += 3
	case de < 1.5:
		score += 1
	case de > 3.0:
		score -= 3
	}

	switch {
	case pm > 20:
		score += 3
		reasons = append(reasons, fmt.Sprintf("High profit margin %.1f%%", pm))
	case pm > 10:
		score += 2
	case pm < 0:
		score -= 2
	}

	if divY > 2 {
		score += 2
	} else if divY > 0.5 {
		score += 1
	}

	return math.Max(0, math.Min(score, 35)), reasons
}

func scoreVal(pe, fpE, rsi float64, aboveSMA200 bool, peTol float64) (float64, string) {
	score := 0.0
	zone := "FAIR"

	effectivePE := pe
	if fpE > 0 && fpE < pe {
		effectivePE = fpE
	}

	if effectivePE > 0 && peTol > 0 {
		ratio := effectivePE / peTol
		switch {
		case ratio < 0.55:
			score += 18
			zone = "UNDERVALUED"
		case ratio < 0.70:
			score += 15
			zone = "UNDERVALUED"
		case ratio < 0.85:
			score += 12
			zone = "FAIR"
		case ratio < 1.0:
			score += 9
			zone = "FAIR"
		case ratio < 1.15:
			score += 5
			zone = "SLIGHTLY_HIGH"
		case ratio < 1.40:
			score += 2
			zone = "SLIGHTLY_HIGH"
		default:
			score -= 3
			zone = "OVERVALUED"
		}
	} else {
		score += 3 // no P/E data (ETF / negative earnings)
	}

	switch {
	case rsi < 35:
		score += 5
	case rsi < 50:
		score += 4
	case rsi < 65:
		score += 3
	case rsi < 75:
		score += 1
	default:
		score -= 2
	}

	if aboveSMA200 {
		score += 2
	}

	return math.Max(0, math.Min(score, 25)), zone
}

func scoreTechEntry(rsi float64, aboveSMA200 bool, maTrend string, ind *storage.TechnicalIndicator) (float64, string) {
	score := 0.0

	if aboveSMA200 {
		score += 4
	}

	switch {
	case rsi >= 40 && rsi < 65:
		score += 3
	case rsi >= 30 && rsi < 40:
		score += 2
	case rsi >= 65 && rsi < 75:
		score += 1
	case rsi >= 75:
		score -= 1
	}

	if ind != nil && ind.MACDHist != nil && *ind.MACDHist > 0 {
		score += 2
	}

	if maTrend == "BULLISH" {
		score += 1
	}

	entry := "FAIR"
	switch {
	case score >= 8:
		entry = "GOOD"
	case score <= 3 || rsi > 75:
		entry = "WAIT"
	}

	return math.Max(0, math.Min(score, 10)), entry
}

func projectCAGRRange(gs string, epsG, revG, roe, de, rsi float64, aboveSMA200 bool, valZone string) (low, high float64) {
	info := growthSectors[gs]
	low, high = info.CAGRLow, info.CAGRHigh

	if epsG > 20 {
		high += 3
		low += 2
	} else if epsG < 5 {
		high -= 3
		low -= 3
	}
	if revG > 15 {
		high += 2
		low += 1
	}
	if roe > 20 {
		high += 2
		low += 1
	}
	if de > 2.0 {
		high -= 3
		low -= 2
	}

	switch valZone {
	case "UNDERVALUED":
		high += 4
		low += 2
	case "OVERVALUED":
		high -= 4
		low -= 3
	}

	if aboveSMA200 && rsi < 65 {
		high += 1
		low += 1
	}

	if low < 2 {
		low = 2
	}
	if high < low+3 {
		high = low + 3
	}
	if high > 50 {
		high = 50
	}

	return math.Round(low*10) / 10, math.Round(high*10) / 10
}

func sipRatingLabel(score float64) string {
	switch {
	case score >= 78:
		return "EXCELLENT"
	case score >= 63:
		return "GOOD"
	case score >= 48:
		return "FAIR"
	default:
		return "SPECULATIVE"
	}
}

func classifyRiskProfile(gs string, de, divY, pe, epsG float64) string {
	switch gs {
	case "CONSUMER", "HEALTHCARE":
		if de < 0.5 && divY > 1.0 {
			return "CONSERVATIVE"
		}
	case "ENERGY":
		if divY > 3 {
			return "CONSERVATIVE"
		}
		return "MODERATE"
	case "COMMODITY":
		return "CONSERVATIVE"
	}
	if pe > 40 || epsG > 25 || gs == "CLEAN_ENERGY" {
		return "AGGRESSIVE"
	}
	return "MODERATE"
}

func buyZoneLabel(price, rsi float64, aboveSMA200 bool, ind *storage.TechnicalIndicator) string {
	if rsi > 70 {
		target := math.Round(price*0.92*100) / 100
		return fmt.Sprintf("Wait for pullback ~$%.2f — RSI overbought (%.0f)", target, rsi)
	}
	if rsi < 40 {
		return fmt.Sprintf("Strong SIP entry now at $%.2f — RSI oversold (%.0f), accumulate aggressively", price, rsi)
	}
	if ind != nil && ind.SMA50 != nil && *ind.SMA50 > 0 {
		sma50 := *ind.SMA50
		lo := math.Round(sma50*0.97*100) / 100
		hi := math.Round(price*1.03*100) / 100
		return fmt.Sprintf("Buy zone $%.2f–$%.2f (current $%.2f near SMA50 support)", lo, hi, price)
	}
	return fmt.Sprintf("Current price $%.2f is fair SIP entry — accumulate monthly", price)
}

// assignSIPAllocations distributes 100% of the monthly SIP budget proportionally
// to overall scores, capped at 18% per stock and floored at 2%.
func assignSIPAllocations(picks []LongTermUSPick) {
	if len(picks) == 0 {
		return
	}
	totalScore := 0.0
	for _, p := range picks {
		if p.OverallSIPScore > 30 {
			totalScore += p.OverallSIPScore
		}
	}
	if totalScore == 0 {
		return
	}
	for i := range picks {
		if picks[i].OverallSIPScore > 30 {
			raw := (picks[i].OverallSIPScore / totalScore) * 100
			clamped := math.Max(2, math.Min(18, raw))
			picks[i].MonthlySIPPct = math.Round(clamped*2) / 2 // nearest 0.5
		}
	}
	// Re-normalise to sum to 100
	total := 0.0
	for _, p := range picks {
		total += p.MonthlySIPPct
	}
	if total > 0 {
		scale := 100.0 / total
		for i := range picks {
			picks[i].MonthlySIPPct = math.Round(picks[i].MonthlySIPPct*scale*2) / 2
		}
	}
}

func buildSIPSectorSummary(picks []LongTermUSPick) []SIPSectorItem {
	type agg struct {
		count      int
		totalScore float64
		totalCAGR  float64
		allocPct   float64
	}
	m := map[string]*agg{}
	for _, p := range picks {
		if m[p.GrowthSector] == nil {
			m[p.GrowthSector] = &agg{}
		}
		m[p.GrowthSector].count++
		m[p.GrowthSector].totalScore += p.OverallSIPScore
		m[p.GrowthSector].totalCAGR += p.ExpectedCAGR
		m[p.GrowthSector].allocPct += p.MonthlySIPPct
	}
	var out []SIPSectorItem
	for gs, d := range m {
		info := growthSectors[gs]
		out = append(out, SIPSectorItem{
			GrowthSector: gs,
			Label:        info.Label,
			Count:        d.count,
			AvgScore:     math.Round(d.totalScore/float64(d.count)*10) / 10,
			AvgCAGR:      math.Round(d.totalCAGR/float64(d.count)*10) / 10,
			AllocPct:     math.Round(d.allocPct*10) / 10,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AllocPct > out[j].AllocPct })
	return out
}
