package alpha

import (
	"fmt"
	"math"
	"sort"

	"stockwise/internal/storage"
)

// UndervaluedStock represents a stock identified as potentially undervalued.
type UndervaluedStock struct {
	Symbol           string   `json:"symbol"`
	Name             string   `json:"name"`
	Market           string   `json:"market"`
	Sector           string   `json:"sector"`
	CurrentPrice     float64  `json:"current_price"`
	FairValueEst     float64  `json:"fair_value_est"`   // estimated fair value
	UpsidePct        float64  `json:"upside_pct"`       // % upside to fair value
	PERatio          float64  `json:"pe_ratio"`
	PriceToBook      float64  `json:"price_to_book"`
	EPSGrowth        float64  `json:"eps_growth_pct"`
	ROE              float64  `json:"roe_pct"`
	DebtEquity       float64  `json:"debt_equity"`
	DividendYield    float64  `json:"dividend_yield_pct"`
	FundScore        float64  `json:"fundamental_score"`
	TechScore        float64  `json:"technical_score"`
	RSI              float64  `json:"rsi"`
	Trend            string   `json:"trend"`
	ValueScore       float64  `json:"value_score"`      // composite 0-100
	Reasons          []string `json:"reasons"`
	InPortfolio      bool     `json:"in_portfolio"`
	PortfolioAction  string   `json:"portfolio_action"` // "ADD_MORE", "WATCH", "NEW_BUY"
}

// UndervaluedAnalyzer detects undervalued stocks across all tracked securities.
type UndervaluedAnalyzer struct{}

func NewUndervaluedAnalyzer() *UndervaluedAnalyzer { return &UndervaluedAnalyzer{} }

// FindUndervalued scans all stocks for undervaluation using fundamental + technical criteria.
// Criteria for undervalued:
//   - P/E < 20 (or P/E < sector avg)
//   - P/B < 2.5
//   - EPS Growth > 0 (positive earnings)
//   - ROE > 10%
//   - D/E < 1.5 (not over-leveraged)
//   - RSI not overbought (< 70)
//   - Fundamental score > 45
func (a *UndervaluedAnalyzer) FindUndervalued(
	stocks []storage.Stock,
	indicators map[uint]*storage.TechnicalIndicator,
	fundamentals map[uint]*storage.Fundamental,
	latestPrices map[uint]float64,
	portfolioSymbols map[string]bool,
) []UndervaluedStock {
	var result []UndervaluedStock

	for _, stock := range stocks {
		if stock.IsIndex {
			continue
		}

		fund := fundamentals[stock.ID]
		ind := indicators[stock.ID]
		if fund == nil {
			continue
		}

		price := latestPrices[stock.ID]
		if price == 0 {
			continue
		}

		uv := a.scoreStock(stock, fund, ind, price)
		if uv == nil {
			continue
		}

		uv.InPortfolio = portfolioSymbols[stock.Symbol] || portfolioSymbols[stock.Name]
		if uv.InPortfolio {
			uv.PortfolioAction = "ADD_MORE"
		} else if uv.ValueScore >= 70 {
			uv.PortfolioAction = "NEW_BUY"
		} else {
			uv.PortfolioAction = "WATCH"
		}

		result = append(result, *uv)
	}

	// Sort by value score descending
	sort.Slice(result, func(i, j int) bool {
		return result[i].ValueScore > result[j].ValueScore
	})

	// Return top 20
	if len(result) > 20 {
		result = result[:20]
	}
	return result
}

func (a *UndervaluedAnalyzer) scoreStock(
	stock storage.Stock,
	fund *storage.Fundamental,
	ind *storage.TechnicalIndicator,
	price float64,
) *UndervaluedStock {
	score := 0.0
	var reasons []string
	qualifies := false

	// ── Valuation checks ────────────────────────────────────────────────────

	pe := 0.0
	if fund.PERatio != nil && *fund.PERatio > 0 {
		pe = *fund.PERatio
		switch {
		case pe < 10:
			score += 25
			reasons = append(reasons, fmt.Sprintf("Very low P/E of %.1f — deep value", pe))
			qualifies = true
		case pe < 15:
			score += 20
			reasons = append(reasons, fmt.Sprintf("Attractive P/E of %.1f — value zone", pe))
			qualifies = true
		case pe < 20:
			score += 15
			reasons = append(reasons, fmt.Sprintf("Reasonable P/E of %.1f — fair value", pe))
			qualifies = true
		case pe < 25:
			score += 8
		case pe > 50:
			score -= 10 // overvalued
		}
	}

	pb := 0.0
	if fund.PriceToBook != nil && *fund.PriceToBook > 0 {
		pb = *fund.PriceToBook
		switch {
		case pb < 1.0:
			score += 20
			reasons = append(reasons, fmt.Sprintf("Price below book value (P/B: %.1f) — asset backed", pb))
			qualifies = true
		case pb < 1.5:
			score += 15
			reasons = append(reasons, fmt.Sprintf("Low P/B ratio of %.1f — undervalued asset", pb))
		case pb < 2.5:
			score += 8
		case pb > 5:
			score -= 5
		}
	}

	// ── Growth checks ────────────────────────────────────────────────────────

	epsGrowth := 0.0
	if fund.EPSGrowth != nil {
		epsGrowth = *fund.EPSGrowth * 100
		switch {
		case epsGrowth > 25:
			score += 20
			reasons = append(reasons, fmt.Sprintf("Strong EPS growth of %.1f%% — growth at value", epsGrowth))
		case epsGrowth > 15:
			score += 15
			reasons = append(reasons, fmt.Sprintf("Healthy EPS growth of %.1f%%", epsGrowth))
		case epsGrowth > 5:
			score += 10
		case epsGrowth < 0:
			score -= 15 // declining earnings = not value
		}
	}

	revenueGrowth := 0.0
	if fund.RevenueGrowth != nil {
		revenueGrowth = *fund.RevenueGrowth * 100
		if revenueGrowth > 10 {
			score += 8
			reasons = append(reasons, fmt.Sprintf("Revenue growing %.1f%% YoY", revenueGrowth))
		}
	}
	_ = revenueGrowth

	// ── Quality checks ───────────────────────────────────────────────────────

	roe := 0.0
	if fund.ROE != nil {
		roe = *fund.ROE * 100
		switch {
		case roe > 20:
			score += 15
			reasons = append(reasons, fmt.Sprintf("High ROE of %.1f%% — efficient capital use", roe))
		case roe > 12:
			score += 10
		case roe > 5:
			score += 4
		case roe < 0:
			score -= 10
		}
	}

	de := 0.0
	if fund.DebtEquity != nil {
		de = *fund.DebtEquity
		switch {
		case de < 0.3:
			score += 12
			reasons = append(reasons, fmt.Sprintf("Debt-free / minimal debt (D/E: %.2f)", de))
		case de < 0.7:
			score += 8
		case de < 1.5:
			score += 3
		case de > 2.5:
			score -= 10 // over-leveraged
		}
	}

	pm := 0.0
	if fund.ProfitMargin != nil {
		pm = *fund.ProfitMargin * 100
		if pm > 15 {
			score += 8
			reasons = append(reasons, fmt.Sprintf("Strong profit margin of %.1f%%", pm))
		} else if pm > 8 {
			score += 4
		} else if pm < 0 {
			score -= 8
		}
	}
	_ = pm

	divYield := 0.0
	if fund.DividendYield != nil {
		divYield = *fund.DividendYield * 100
		if divYield > 3 {
			score += 6
			reasons = append(reasons, fmt.Sprintf("Attractive dividend yield of %.1f%%", divYield))
		} else if divYield > 1.5 {
			score += 3
		}
	}

	// ── Technical check: not overbought, preferably near support ─────────────

	rsi := 50.0
	trend := "SIDEWAYS"
	techScore := 50.0
	if ind != nil {
		if ind.RSI != nil {
			rsi = *ind.RSI
			if rsi < 35 {
				score += 10
				reasons = append(reasons, fmt.Sprintf("Technically oversold (RSI %.0f) — good entry point", rsi))
			} else if rsi > 70 {
				score -= 8 // not a good time to buy even if fundamentally sound
			}
		}
		trend = ind.TrendDirection
		techScore = ind.TechnicalScore
		if trend == "UP" && rsi < 65 {
			score += 5
		}
	}

	// ── Require minimum qualifications ──────────────────────────────────────
	// Must qualify on at least one valuation metric AND have positive earnings
	if !qualifies || epsGrowth < -10 || pe > 50 || de > 3.0 {
		return nil
	}
	// Minimum score threshold
	if score < 35 {
		return nil
	}

	// ── Estimate fair value using simple Graham-like formula ─────────────────
	// Fair value = EPS * (8.5 + 2 * growthRate) [Benjamin Graham formula]
	fairValue := price
	if fund.EPS != nil && *fund.EPS > 0 && epsGrowth > 0 {
		growthRate := math.Min(epsGrowth, 30) // cap growth assumption at 30%
		fairValue = *fund.EPS * (8.5 + 2*growthRate)
		if fairValue <= 0 {
			fairValue = price
		}
	} else if pb > 0 && roe > 0 {
		// Fallback: P/B x ROE based valuation
		fairPB := math.Min(roe/10, 5.0) // fair P/B ≈ ROE/10
		if pb < fairPB {
			fairValue = price * (fairPB / pb)
		}
	}

	upside := 0.0
	if fairValue > price {
		upside = (fairValue - price) / price * 100
	}

	return &UndervaluedStock{
		Symbol:        stock.Symbol,
		Name:          stock.Name,
		Market:        stock.Market,
		Sector:        stock.Sector,
		CurrentPrice:  math.Round(price*100) / 100,
		FairValueEst:  math.Round(fairValue*100) / 100,
		UpsidePct:     math.Round(upside*100) / 100,
		PERatio:       math.Round(pe*100) / 100,
		PriceToBook:   math.Round(pb*100) / 100,
		EPSGrowth:     math.Round(epsGrowth*100) / 100,
		ROE:           math.Round(roe*100) / 100,
		DebtEquity:    math.Round(de*100) / 100,
		DividendYield: math.Round(divYield*100) / 100,
		FundScore:     math.Round(fund.FundamentalScore*100) / 100,
		TechScore:     math.Round(techScore*100) / 100,
		RSI:           math.Round(rsi*10) / 10,
		Trend:         trend,
		ValueScore:    math.Min(math.Round(score*100)/100, 100),
		Reasons:       reasons,
	}
}
