package fundamental

import (
	"fmt"
	"math"

	"stockwise/internal/storage"
)

// Analyzer scores fundamental data.
type Analyzer struct{}

func NewAnalyzer() *Analyzer {
	return &Analyzer{}
}

// Score computes a composite fundamental score (0-100) and updates the model.
func (a *Analyzer) Score(f *storage.Fundamental) float64 {
	score := 0.0
	maxScore := 0.0

	// ── P/E Ratio (lower is better for value) ──────────────────────────────
	if f.PERatio != nil {
		pe := *f.PERatio
		maxScore += 15
		if pe > 0 && pe <= 15 {
			score += 15
		} else if pe > 15 && pe <= 25 {
			score += 12
		} else if pe > 25 && pe <= 40 {
			score += 8
		} else if pe > 40 {
			score += 2
		}
	}

	// ── Forward P/E ────────────────────────────────────────────────────────
	if f.ForwardPE != nil {
		fpe := *f.ForwardPE
		maxScore += 10
		if fpe > 0 && fpe < 20 {
			score += 10
		} else if fpe >= 20 && fpe < 35 {
			score += 7
		} else if fpe >= 35 {
			score += 3
		}
	}

	// ── EPS Growth (higher is better) ─────────────────────────────────────
	if f.EPSGrowth != nil {
		eg := *f.EPSGrowth * 100
		maxScore += 20
		if eg > 25 {
			score += 20
		} else if eg > 15 {
			score += 16
		} else if eg > 5 {
			score += 10
		} else if eg > 0 {
			score += 5
		}
	}

	// ── Revenue Growth ─────────────────────────────────────────────────────
	if f.RevenueGrowth != nil {
		rg := *f.RevenueGrowth * 100
		maxScore += 15
		if rg > 20 {
			score += 15
		} else if rg > 10 {
			score += 11
		} else if rg > 0 {
			score += 6
		}
	}

	// ── Debt/Equity (lower is better) ─────────────────────────────────────
	if f.DebtEquity != nil {
		de := *f.DebtEquity
		maxScore += 15
		if de < 0.3 {
			score += 15
		} else if de < 0.7 {
			score += 11
		} else if de < 1.5 {
			score += 7
		} else if de < 3.0 {
			score += 3
		}
	}

	// ── ROE (higher is better) ─────────────────────────────────────────────
	if f.ROE != nil {
		roe := *f.ROE * 100
		maxScore += 15
		if roe > 20 {
			score += 15
		} else if roe > 15 {
			score += 11
		} else if roe > 10 {
			score += 7
		} else if roe > 0 {
			score += 3
		}
	}

	// ── Profit Margin ─────────────────────────────────────────────────────
	if f.ProfitMargin != nil {
		pm := *f.ProfitMargin * 100
		maxScore += 10
		if pm > 20 {
			score += 10
		} else if pm > 10 {
			score += 7
		} else if pm > 0 {
			score += 3
		}
	}

	if maxScore == 0 {
		return 50
	}

	normalized := (score / maxScore) * 100
	f.FundamentalScore = clamp(normalized, 0, 100)
	return f.FundamentalScore
}

// BuildReasoningText generates a human-readable fundamental analysis summary.
func (a *Analyzer) BuildReasoningText(f *storage.Fundamental) string {
	if f == nil {
		return "Fundamental data not available."
	}

	var parts []string

	if f.PERatio != nil {
		pe := *f.PERatio
		if pe > 0 && pe <= 20 {
			parts = append(parts, fmt.Sprintf("Attractive P/E of %.1fx (value zone)", pe))
		} else if pe > 20 && pe <= 35 {
			parts = append(parts, fmt.Sprintf("Fair P/E of %.1fx", pe))
		} else if pe > 35 {
			parts = append(parts, fmt.Sprintf("High P/E of %.1fx (growth priced in)", pe))
		}
	}

	if f.EPSGrowth != nil {
		eg := *f.EPSGrowth * 100
		if eg > 15 {
			parts = append(parts, fmt.Sprintf("Strong EPS growth of %.1f%%", eg))
		} else if eg > 0 {
			parts = append(parts, fmt.Sprintf("Moderate EPS growth of %.1f%%", eg))
		} else {
			parts = append(parts, fmt.Sprintf("EPS declined %.1f%% YoY", -eg))
		}
	}

	if f.RevenueGrowth != nil {
		rg := *f.RevenueGrowth * 100
		if rg > 10 {
			parts = append(parts, fmt.Sprintf("Revenue growing at %.1f%% YoY", rg))
		} else if rg < 0 {
			parts = append(parts, fmt.Sprintf("Revenue contracted %.1f%% YoY", -rg))
		}
	}

	if f.ROE != nil {
		roe := *f.ROE * 100
		if roe > 15 {
			parts = append(parts, fmt.Sprintf("High ROE of %.1f%% (efficient capital use)", roe))
		}
	}

	if f.DebtEquity != nil {
		de := *f.DebtEquity
		if de > 2 {
			parts = append(parts, fmt.Sprintf("High leverage (D/E: %.2f) — risk factor", de))
		} else if de < 0.5 {
			parts = append(parts, fmt.Sprintf("Low debt (D/E: %.2f) — balance sheet strength", de))
		}
	}

	if len(parts) == 0 {
		return "Limited fundamental data available for analysis."
	}

	result := ""
	for i, p := range parts {
		if i > 0 {
			result += ". "
		}
		result += p
	}
	return result + "."
}

func clamp(v, minVal, maxVal float64) float64 {
	return math.Max(minVal, math.Min(maxVal, v))
}
