package fundamental

import (
	"fmt"
	"math"
	"strings"

	"stockwise/internal/naren/screener"
	"stockwise/internal/naren/storage"
)

// BuffettScore holds the Warren Buffett 6-pillar scorecard.
type BuffettScore struct {
	Total       float64 `json:"total"`        // 0-100
	Grade       string  `json:"grade"`        // A+, A, B+, B, C, D
	Verdict     string  `json:"verdict"`      // human verdict
	BuySignal   string  `json:"buy_signal"`   // STRONG_BUY | BUY | HOLD | AVOID

	Pillars [6]Pillar `json:"pillars"`

	// Key metrics for display
	ROCE          float64 `json:"roce"`
	ROE           float64 `json:"roe"`
	DebtEquity    float64 `json:"debt_equity"`
	ProfitMargin  float64 `json:"profit_margin"`
	RevenueCAGR   float64 `json:"revenue_cagr"`
	EPSGrowth     float64 `json:"eps_growth"`
	PEG           float64 `json:"peg"`
	FreeCashFlow  float64 `json:"free_cash_flow"`
	Reasoning     []string `json:"reasoning"`
}

// Pillar is a single Warren Buffett scoring dimension.
type Pillar struct {
	Name    string  `json:"name"`
	Score   float64 `json:"score"`
	MaxScore float64 `json:"max_score"`
	Pct     float64 `json:"pct"` // 0-100
	Status  string  `json:"status"` // STRONG | GOOD | FAIR | WEAK
	Details []string `json:"details"`
}

// ScoreBuffett computes the Warren Buffett scorecard from DB fundamentals and
// optional Screener.in live data. Pass nil for cd when no Screener.in data is available.
func ScoreBuffett(f *storage.Fundamental, cd *screener.CompanyData) BuffettScore {
	var bs BuffettScore
	var reasons []string

	// ── Merge data sources ──────────────────────────────────────────────────
	// Screener.in takes precedence for Indian stocks; Yahoo Finance fills gaps.
	roce := 0.0
	roe := 0.0
	pe := 0.0
	pb := 0.0
	de := 0.0
	pm := 0.0
	fcf := 0.0
	epsGrowth := 0.0
	revGrowth := 0.0
	div := 0.0
	forwardPE := 0.0

	if cd != nil {
		roce = cd.ROCE
		roe = cd.ROE
		pe = cd.PERatio
		pb = cd.PriceToBook
		de = safeScreenerDE(f)
		fcf = cd.FreeCashFlow
		div = cd.DividendYield
		pm = cd.ProfitMargin

		// Compute revenue CAGR from annual results
		revGrowth = computeRevenueGrowth(cd)
		epsGrowth = computeEPSGrowth(cd)
	}

	// Fill from Yahoo/DB if Screener.in didn't provide
	if f != nil {
		if roe == 0 && f.ROE != nil {
			roe = *f.ROE * 100
		}
		if pe == 0 && f.PERatio != nil {
			pe = *f.PERatio
		}
		if pb == 0 && f.PriceToBook != nil {
			pb = *f.PriceToBook
		}
		if de == 0 && f.DebtEquity != nil {
			de = *f.DebtEquity
		}
		if pm == 0 && f.ProfitMargin != nil {
			pm = *f.ProfitMargin * 100
		}
		if epsGrowth == 0 && f.EPSGrowth != nil {
			epsGrowth = *f.EPSGrowth * 100
		}
		if revGrowth == 0 && f.RevenueGrowth != nil {
			revGrowth = *f.RevenueGrowth * 100
		}
		if div == 0 && f.DividendYield != nil {
			div = *f.DividendYield * 100
		}
		if forwardPE == 0 && f.ForwardPE != nil {
			forwardPE = *f.ForwardPE
		}
		if roce == 0 && f.ROE != nil {
			// Estimate ROCE from ROE when not directly available
			roce = *f.ROE * 100
		}
	}

	// Compute PEG
	peg := 0.0
	if pe > 0 && epsGrowth > 0 {
		peg = pe / epsGrowth
	}

	bs.ROCE = roce
	bs.ROE = roe
	bs.DebtEquity = de
	bs.ProfitMargin = pm
	bs.RevenueCAGR = revGrowth
	bs.EPSGrowth = epsGrowth
	bs.PEG = peg
	bs.FreeCashFlow = fcf

	// ── Pillar 1: Business Moat (25 pts) ─────────────────────────────────────
	p1 := Pillar{Name: "Business Moat", MaxScore: 25}
	{
		if roce >= 20 {
			p1.Score += 12
			p1.Details = append(p1.Details, fmt.Sprintf("Excellent ROCE %.1f%% — strong moat", roce))
			reasons = append(reasons, fmt.Sprintf("Exceptional ROCE of %.1f%% signals durable competitive advantage", roce))
		} else if roce >= 15 {
			p1.Score += 9
			p1.Details = append(p1.Details, fmt.Sprintf("Good ROCE %.1f%%", roce))
		} else if roce >= 10 {
			p1.Score += 5
			p1.Details = append(p1.Details, fmt.Sprintf("Moderate ROCE %.1f%%", roce))
		} else if roce > 0 {
			p1.Score += 2
			p1.Details = append(p1.Details, fmt.Sprintf("Weak ROCE %.1f%% — limited pricing power", roce))
		}

		if pm >= 20 {
			p1.Score += 8
			p1.Details = append(p1.Details, fmt.Sprintf("Premium profit margin %.1f%%", pm))
		} else if pm >= 12 {
			p1.Score += 6
			p1.Details = append(p1.Details, fmt.Sprintf("Healthy margin %.1f%%", pm))
		} else if pm >= 5 {
			p1.Score += 3
		}

		if revGrowth >= 20 {
			p1.Score += 5
			p1.Details = append(p1.Details, fmt.Sprintf("Strong revenue growth %.1f%%", revGrowth))
		} else if revGrowth >= 10 {
			p1.Score += 3
		}
	}
	p1.Pct = pct(p1.Score, p1.MaxScore)
	p1.Status = gradeStatus(p1.Pct)
	bs.Pillars[0] = p1

	// ── Pillar 2: Financial Strength (20 pts) ─────────────────────────────────
	p2 := Pillar{Name: "Financial Strength", MaxScore: 20}
	{
		if de == 0 || de < 0.1 {
			p2.Score += 10
			p2.Details = append(p2.Details, "Debt-free or near-zero leverage")
			reasons = append(reasons, "Debt-free balance sheet — Buffett's top preference")
		} else if de < 0.5 {
			p2.Score += 8
			p2.Details = append(p2.Details, fmt.Sprintf("Conservative debt D/E %.2f", de))
		} else if de < 1.0 {
			p2.Score += 5
			p2.Details = append(p2.Details, fmt.Sprintf("Moderate debt D/E %.2f", de))
		} else if de < 2.0 {
			p2.Score += 2
			p2.Details = append(p2.Details, fmt.Sprintf("High debt D/E %.2f — monitor", de))
		} else {
			p2.Details = append(p2.Details, fmt.Sprintf("Dangerous leverage D/E %.2f", de))
			reasons = append(reasons, fmt.Sprintf("High debt D/E %.2f is a red flag — Buffett avoids over-leveraged firms", de))
		}

		if fcf > 0 {
			p2.Score += 10
			p2.Details = append(p2.Details, fmt.Sprintf("Positive free cash flow ₹%.0f Cr", fcf))
			reasons = append(reasons, "Positive FCF — company generates real cash, not just accounting profits")
		} else if fcf < 0 {
			p2.Details = append(p2.Details, "Negative FCF — cash burn risk")
		}
	}
	p2.Pct = pct(p2.Score, p2.MaxScore)
	p2.Status = gradeStatus(p2.Pct)
	bs.Pillars[1] = p2

	// ── Pillar 3: Earnings Quality (20 pts) ───────────────────────────────────
	p3 := Pillar{Name: "Earnings Quality", MaxScore: 20}
	{
		if epsGrowth >= 25 {
			p3.Score += 10
			p3.Details = append(p3.Details, fmt.Sprintf("Exceptional EPS growth %.1f%%", epsGrowth))
			reasons = append(reasons, fmt.Sprintf("EPS growing at %.1f%% — exceptional earnings momentum", epsGrowth))
		} else if epsGrowth >= 15 {
			p3.Score += 8
			p3.Details = append(p3.Details, fmt.Sprintf("Strong EPS growth %.1f%%", epsGrowth))
		} else if epsGrowth >= 8 {
			p3.Score += 5
			p3.Details = append(p3.Details, fmt.Sprintf("Moderate EPS growth %.1f%%", epsGrowth))
		} else if epsGrowth > 0 {
			p3.Score += 2
		} else if epsGrowth < 0 {
			p3.Details = append(p3.Details, fmt.Sprintf("EPS declined %.1f%% — earnings deterioration", -epsGrowth))
		}

		if revGrowth >= 15 {
			p3.Score += 10
			p3.Details = append(p3.Details, fmt.Sprintf("Revenue growing %.1f%% YoY", revGrowth))
		} else if revGrowth >= 8 {
			p3.Score += 7
			p3.Details = append(p3.Details, fmt.Sprintf("Steady revenue %.1f%%", revGrowth))
		} else if revGrowth >= 0 {
			p3.Score += 3
		} else {
			p3.Details = append(p3.Details, fmt.Sprintf("Revenue contracted %.1f%%", -revGrowth))
		}
	}
	p3.Pct = pct(p3.Score, p3.MaxScore)
	p3.Status = gradeStatus(p3.Pct)
	bs.Pillars[2] = p3

	// ── Pillar 4: Management Efficiency (15 pts) ──────────────────────────────
	p4 := Pillar{Name: "Management Quality", MaxScore: 15}
	{
		if roe >= 25 {
			p4.Score += 10
			p4.Details = append(p4.Details, fmt.Sprintf("Exceptional ROE %.1f%% — top-tier capital allocation", roe))
			reasons = append(reasons, fmt.Sprintf("ROE %.1f%% is exceptional — Buffett looks for 15%+ consistently", roe))
		} else if roe >= 18 {
			p4.Score += 8
			p4.Details = append(p4.Details, fmt.Sprintf("Strong ROE %.1f%%", roe))
		} else if roe >= 12 {
			p4.Score += 5
			p4.Details = append(p4.Details, fmt.Sprintf("Acceptable ROE %.1f%%", roe))
		} else if roe > 0 {
			p4.Score += 2
		}

		roa := 0.0
		if f != nil && f.ROA != nil {
			roa = *f.ROA * 100
		}
		if roa >= 10 {
			p4.Score += 5
			p4.Details = append(p4.Details, fmt.Sprintf("High ROA %.1f%% — asset-light efficiency", roa))
		} else if roa >= 5 {
			p4.Score += 3
		}
	}
	p4.Pct = pct(p4.Score, p4.MaxScore)
	p4.Status = gradeStatus(p4.Pct)
	bs.Pillars[3] = p4

	// ── Pillar 5: Valuation (15 pts) ──────────────────────────────────────────
	p5 := Pillar{Name: "Valuation (Value)", MaxScore: 15}
	{
		if pe > 0 {
			if pe < 15 {
				p5.Score += 7
				p5.Details = append(p5.Details, fmt.Sprintf("Deep value P/E %.1fx — potentially undervalued", pe))
				reasons = append(reasons, fmt.Sprintf("P/E of %.1fx is in deep-value territory — rare in quality stocks", pe))
			} else if pe < 25 {
				p5.Score += 5
				p5.Details = append(p5.Details, fmt.Sprintf("Fair P/E %.1fx", pe))
			} else if pe < 40 {
				p5.Score += 3
				p5.Details = append(p5.Details, fmt.Sprintf("Elevated P/E %.1fx — market pricing in growth", pe))
			} else {
				p5.Score += 1
				p5.Details = append(p5.Details, fmt.Sprintf("Premium P/E %.1fx — growth already priced in", pe))
			}
		}

		if pb > 0 {
			if pb < 2 {
				p5.Score += 4
				p5.Details = append(p5.Details, fmt.Sprintf("Trading near book value P/B %.2fx", pb))
			} else if pb < 4 {
				p5.Score += 2
				p5.Details = append(p5.Details, fmt.Sprintf("Moderate P/B %.2fx", pb))
			}
		}

		if div >= 2 {
			p5.Score += 4
			p5.Details = append(p5.Details, fmt.Sprintf("Attractive dividend yield %.1f%%", div))
		} else if div >= 1 {
			p5.Score += 2
			p5.Details = append(p5.Details, fmt.Sprintf("Decent dividend yield %.1f%%", div))
		}

		// PEG bonus
		if peg > 0 && peg < 1 {
			p5.Score = math.Min(p5.Score+2, p5.MaxScore)
			p5.Details = append(p5.Details, fmt.Sprintf("PEG %.2f — paying less than growth rate (undervalued)", peg))
		}
	}
	p5.Pct = pct(p5.Score, p5.MaxScore)
	p5.Status = gradeStatus(p5.Pct)
	bs.Pillars[4] = p5

	// ── Pillar 6: Growth Potential (5 pts) ───────────────────────────────────
	p6 := Pillar{Name: "Future Growth", MaxScore: 5}
	{
		if forwardPE > 0 && pe > 0 && forwardPE < pe {
			p6.Score += 3
			p6.Details = append(p6.Details, fmt.Sprintf("Forward P/E %.1fx < current %.1fx — earnings expected to grow", forwardPE, pe))
		}
		if revGrowth >= 15 && epsGrowth >= 15 {
			p6.Score += 2
			p6.Details = append(p6.Details, "Dual-growth engine — both revenue and EPS accelerating")
		} else if revGrowth >= 10 || epsGrowth >= 10 {
			p6.Score += 1
		}
	}
	p6.Pct = pct(p6.Score, p6.MaxScore)
	p6.Status = gradeStatus(p6.Pct)
	bs.Pillars[5] = p6

	// ── Compute total ─────────────────────────────────────────────────────────
	total := p1.Score + p2.Score + p3.Score + p4.Score + p5.Score + p6.Score
	bs.Total = math.Min(total, 100)

	// Assign grade and verdict
	switch {
	case bs.Total >= 80:
		bs.Grade = "A+"
		bs.Verdict = "Exceptional — Buy and Hold Forever"
		bs.BuySignal = "STRONG_BUY"
		reasons = append(reasons, "This stock passes Warren Buffett's most stringent criteria")
	case bs.Total >= 65:
		bs.Grade = "A"
		bs.Verdict = "Strong Long-Term Compounding Story"
		bs.BuySignal = "STRONG_BUY"
	case bs.Total >= 52:
		bs.Grade = "B+"
		bs.Verdict = "Good Quality — Suitable for Long-Term SIP"
		bs.BuySignal = "BUY"
	case bs.Total >= 40:
		bs.Grade = "B"
		bs.Verdict = "Decent Business — Monitor & Accumulate on Dips"
		bs.BuySignal = "BUY"
	case bs.Total >= 28:
		bs.Grade = "C"
		bs.Verdict = "Average Quality — Caution Advised"
		bs.BuySignal = "HOLD"
	default:
		bs.Grade = "D"
		bs.Verdict = "Weak Fundamentals — Avoid for Long-Term"
		bs.BuySignal = "AVOID"
	}

	bs.Reasoning = dedup(reasons)
	return bs
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func pct(score, max float64) float64 {
	if max == 0 {
		return 0
	}
	return math.Min(score/max*100, 100)
}

func gradeStatus(pct float64) string {
	switch {
	case pct >= 75:
		return "STRONG"
	case pct >= 55:
		return "GOOD"
	case pct >= 35:
		return "FAIR"
	default:
		return "WEAK"
	}
}

func computeRevenueGrowth(cd *screener.CompanyData) float64 {
	if len(cd.AnnualResults) < 2 {
		if len(cd.QuarterlyResults) >= 2 {
			q := cd.QuarterlyResults
			latest := q[len(q)-1].Sales
			prev := q[0].Sales
			if prev > 0 {
				return (latest - prev) / prev * 100
			}
		}
		return 0
	}
	results := cd.AnnualResults
	latest := results[len(results)-1].Sales
	oldest := results[0].Sales
	if oldest <= 0 {
		return 0
	}
	years := float64(len(results) - 1)
	if years <= 0 {
		return 0
	}
	return (math.Pow(latest/oldest, 1/years) - 1) * 100
}

func computeEPSGrowth(cd *screener.CompanyData) float64 {
	if len(cd.AnnualResults) < 2 {
		return 0
	}
	results := cd.AnnualResults
	latest := results[len(results)-1].EPS
	oldest := results[0].EPS
	if oldest <= 0 || latest <= 0 {
		if len(results) >= 2 {
			prev := results[len(results)-2].EPS
			if prev > 0 {
				return (latest - prev) / prev * 100
			}
		}
		return 0
	}
	years := float64(len(results) - 1)
	return (math.Pow(latest/oldest, 1/years) - 1) * 100
}

func safeScreenerDE(f *storage.Fundamental) float64 {
	if f != nil && f.DebtEquity != nil {
		return *f.DebtEquity
	}
	return 0
}

func dedup(ss []string) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(ss))
	for _, s := range ss {
		k := strings.ToLower(s)
		if !seen[k] {
			seen[k] = true
			result = append(result, s)
		}
	}
	return result
}
