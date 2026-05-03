package alpha

import (
	"fmt"
	"math"

	"stockwise/internal/storage"
)

// InvestmentSignal represents a medium-to-long-term investment opportunity.
type InvestmentSignal struct {
	Symbol      string
	Strategy    string
	Horizon     string // swing (1-4 weeks), longterm (3-12 months)
	Direction   string // LONG, AVOID
	EntryPrice  float64
	TargetPrice float64
	StopLoss    float64
	RiskReward  float64
	Confidence  float64
	Reason      string
}

// InvestmentAnalyzer generates investment signals for both India and US markets.
type InvestmentAnalyzer struct{}

func NewInvestmentAnalyzer() *InvestmentAnalyzer {
	return &InvestmentAnalyzer{}
}

// Analyze evaluates a stock for investment opportunities using multiple strategies.
func (ia *InvestmentAnalyzer) Analyze(
	stock *storage.Stock,
	bars []storage.PriceBar,
	indicator *storage.TechnicalIndicator,
	fundamental *storage.Fundamental,
	srLevels []storage.SupportResistanceLevel,
) []InvestmentSignal {
	if len(bars) < 50 || indicator == nil {
		return nil
	}

	var signals []InvestmentSignal

	// Strategy 1: Value + Growth Hybrid
	if sig := ia.valueGrowthStrategy(stock, bars, indicator, fundamental); sig != nil {
		signals = append(signals, *sig)
	}

	// Strategy 2: Trend Following
	if sig := ia.trendFollowingStrategy(stock, bars, indicator, srLevels); sig != nil {
		signals = append(signals, *sig)
	}

	// Strategy 3: Swing (1-4 week) Pullback Entry
	if sig := ia.swingPullbackStrategy(stock, bars, indicator, srLevels); sig != nil {
		signals = append(signals, *sig)
	}

	// Strategy 4: MA Golden Cross
	if sig := ia.goldenCrossStrategy(stock, bars, indicator); sig != nil {
		signals = append(signals, *sig)
	}

	return signals
}

// ─── Value + Growth Hybrid ────────────────────────────────────────────────────

func (ia *InvestmentAnalyzer) valueGrowthStrategy(
	stock *storage.Stock,
	bars []storage.PriceBar,
	ind *storage.TechnicalIndicator,
	fund *storage.Fundamental,
) *InvestmentSignal {
	if fund == nil {
		return nil
	}

	score := 0.0
	reasons := []string{}

	// Fundamental score > 60 = good fundamentals
	if fund.FundamentalScore > 60 {
		score += 30
		reasons = append(reasons, fmt.Sprintf("Strong fundamentals (score: %.0f/100)", fund.FundamentalScore))
	} else if fund.FundamentalScore > 40 {
		score += 15
	}

	// Growth: EPS growth > 10%
	if fund.EPSGrowth != nil && *fund.EPSGrowth*100 > 10 {
		score += 20
		reasons = append(reasons, fmt.Sprintf("EPS growth %.1f%%", *fund.EPSGrowth*100))
	}

	// Value: P/E < 30
	if fund.PERatio != nil && *fund.PERatio < 30 && *fund.PERatio > 0 {
		score += 15
		reasons = append(reasons, fmt.Sprintf("Reasonable P/E of %.1f", *fund.PERatio))
	}

	// Technical confirmation: price above SMA50
	if ind.SMA50 != nil {
		latestClose := bars[len(bars)-1].Close
		if latestClose > *ind.SMA50 {
			score += 20
			reasons = append(reasons, "Price above SMA50 (uptrend confirmation)")
		}
	}

	// RSI not overbought
	if ind.RSI != nil && *ind.RSI < 65 && *ind.RSI > 40 {
		score += 15
		reasons = append(reasons, "RSI in healthy range (40-65)")
	}

	if score < 50 || len(reasons) < 2 {
		return nil
	}

	latestBar := bars[len(bars)-1]
	close := latestBar.Close
	target := close * 1.20 // 20% upside target
	stopLoss := close * 0.92 // 8% stop loss

	if ind.SMA50 != nil && *ind.SMA50 < close {
		stopLoss = math.Max(stopLoss, *ind.SMA50*0.98)
	}

	rr := (target - close) / (close - stopLoss)

	return &InvestmentSignal{
		Symbol:      stock.Symbol,
		Strategy:    "Value_Growth_Hybrid",
		Horizon:     "longterm",
		Direction:   "LONG",
		EntryPrice:  roundTo2(close),
		TargetPrice: roundTo2(target),
		StopLoss:    roundTo2(stopLoss),
		RiskReward:  roundTo2(rr),
		Confidence:  math.Min(score, 85),
		Reason:      "Value+Growth: " + joinReasons(reasons),
	}
}

// ─── Trend Following ──────────────────────────────────────────────────────────

func (ia *InvestmentAnalyzer) trendFollowingStrategy(
	stock *storage.Stock,
	bars []storage.PriceBar,
	ind *storage.TechnicalIndicator,
	srLevels []storage.SupportResistanceLevel,
) *InvestmentSignal {
	if ind.SMA20 == nil || ind.SMA50 == nil || ind.SMA200 == nil {
		return nil
	}

	latestClose := bars[len(bars)-1].Close

	// Triple MA alignment: SMA20 > SMA50 > SMA200 = strong uptrend
	if *ind.SMA20 > *ind.SMA50 && *ind.SMA50 > *ind.SMA200 && latestClose > *ind.SMA20 {
		// Not overbought
		if ind.RSI != nil && *ind.RSI < 70 {
			target := latestClose * 1.15
			stopLoss := *ind.SMA50 * 0.97
			rr := (target - latestClose) / (latestClose - stopLoss)

			if rr >= 1.5 {
				return &InvestmentSignal{
					Symbol:      stock.Symbol,
					Strategy:    "Trend_Following",
					Horizon:     "swing",
					Direction:   "LONG",
					EntryPrice:  roundTo2(latestClose),
					TargetPrice: roundTo2(target),
					StopLoss:    roundTo2(stopLoss),
					RiskReward:  roundTo2(rr),
					Confidence:  72,
					Reason:      fmt.Sprintf("Triple MA alignment: SMA20(%.2f) > SMA50(%.2f) > SMA200(%.2f). Price in confirmed uptrend.", *ind.SMA20, *ind.SMA50, *ind.SMA200),
				}
			}
		}
	}

	return nil
}

// ─── Swing Pullback Entry ─────────────────────────────────────────────────────

func (ia *InvestmentAnalyzer) swingPullbackStrategy(
	stock *storage.Stock,
	bars []storage.PriceBar,
	ind *storage.TechnicalIndicator,
	srLevels []storage.SupportResistanceLevel,
) *InvestmentSignal {
	if len(bars) < 20 {
		return nil
	}

	latestBar := bars[len(bars)-1]
	close := latestBar.Close

	// Condition: uptrend (SMA20 > SMA50) + RSI pulled back to 40-55 range
	if ind.SMA20 == nil || ind.SMA50 == nil || ind.RSI == nil {
		return nil
	}

	if *ind.SMA20 < *ind.SMA50 { // not in uptrend
		return nil
	}

	rsi := *ind.RSI
	if rsi < 35 || rsi > 58 {
		return nil
	}

	// Price near SMA20 or a support level
	priceNearSMA20 := math.Abs(close-*ind.SMA20)/close < 0.02

	priceNearSupport := false
	for _, level := range srLevels {
		if level.LevelType == "support" && math.Abs(level.Price-close)/close < 0.015 {
			priceNearSupport = true
			break
		}
	}

	if !priceNearSMA20 && !priceNearSupport {
		return nil
	}

	// Recent 3-bar pullback (lower closes)
	pullback := false
	if len(bars) >= 4 {
		if bars[len(bars)-1].Close < bars[len(bars)-2].Close &&
			bars[len(bars)-2].Close < bars[len(bars)-3].Close {
			pullback = true
		}
	}

	if !pullback {
		return nil
	}

	target := close * 1.10
	stopLoss := math.Min(latestBar.Low*0.98, *ind.SMA50*0.97)
	rr := (target - close) / (close - stopLoss)

	if rr < 1.5 {
		return nil
	}

	return &InvestmentSignal{
		Symbol:      stock.Symbol,
		Strategy:    "Swing_Pullback",
		Horizon:     "swing",
		Direction:   "LONG",
		EntryPrice:  roundTo2(close),
		TargetPrice: roundTo2(target),
		StopLoss:    roundTo2(stopLoss),
		RiskReward:  roundTo2(rr),
		Confidence:  68,
		Reason:      fmt.Sprintf("Pullback to SMA20/support in uptrend. RSI cooled to %.0f. Good risk/reward entry.", rsi),
	}
}

// ─── Golden Cross ─────────────────────────────────────────────────────────────

func (ia *InvestmentAnalyzer) goldenCrossStrategy(
	stock *storage.Stock,
	bars []storage.PriceBar,
	ind *storage.TechnicalIndicator,
) *InvestmentSignal {
	if ind.SMA50 == nil || ind.SMA200 == nil {
		return nil
	}

	// Golden cross: SMA50 crosses above SMA200 (check recent cross)
	latestClose := bars[len(bars)-1].Close
	sma50 := *ind.SMA50
	sma200 := *ind.SMA200

	// SMA50 > SMA200 and they are close (within 3%) = recent cross
	if sma50 > sma200 && (sma50-sma200)/sma200 < 0.03 {
		if latestClose > sma50 { // price confirming above both MAs
			target := latestClose * 1.25
			stopLoss := sma200 * 0.97

			rr := (target - latestClose) / (latestClose - stopLoss)
			if rr < 1.5 {
				return nil
			}

			return &InvestmentSignal{
				Symbol:      stock.Symbol,
				Strategy:    "Golden_Cross",
				Horizon:     "longterm",
				Direction:   "LONG",
				EntryPrice:  roundTo2(latestClose),
				TargetPrice: roundTo2(target),
				StopLoss:    roundTo2(stopLoss),
				RiskReward:  roundTo2(rr),
				Confidence:  75,
				Reason:      fmt.Sprintf("Golden Cross forming: SMA50(%.2f) crossed above SMA200(%.2f). Historically strong bullish signal.", sma50, sma200),
			}
		}
	}

	return nil
}

// ─── Monthly Rebalance Suggestion ────────────────────────────────────────────

type RebalanceSuggestion struct {
	Symbol     string
	Action     string // BUY, HOLD, SELL, REDUCE
	Weight     float64
	Reason     string
}

// MonthlyRebalance generates portfolio rebalancing suggestions.
func (ia *InvestmentAnalyzer) MonthlyRebalance(
	stocks []storage.Stock,
	indicators map[uint]*storage.TechnicalIndicator,
	fundamentals map[uint]*storage.Fundamental,
) []RebalanceSuggestion {
	type scored struct {
		stock storage.Stock
		score float64
	}

	var scoredStocks []scored
	for _, s := range stocks {
		ind := indicators[s.ID]
		fund := fundamentals[s.ID]
		if ind == nil {
			continue
		}

		score := ind.TechnicalScore
		if fund != nil {
			score = score*0.4 + fund.FundamentalScore*0.6
		}
		scoredStocks = append(scoredStocks, scored{s, score})
	}

	// Sort by combined score descending
	for i := 0; i < len(scoredStocks)-1; i++ {
		for j := i + 1; j < len(scoredStocks); j++ {
			if scoredStocks[j].score > scoredStocks[i].score {
				scoredStocks[i], scoredStocks[j] = scoredStocks[j], scoredStocks[i]
			}
		}
	}

	var suggestions []RebalanceSuggestion
	total := math.Min(float64(len(scoredStocks)), 10)

	for i, s := range scoredStocks {
		if i >= 10 {
			break
		}

		weight := (total - float64(i)) / (total * (total + 1) / 2) * 100

		action := "HOLD"
		if s.score > 70 {
			action = "BUY"
		} else if s.score < 35 {
			action = "REDUCE"
		}

		suggestions = append(suggestions, RebalanceSuggestion{
			Symbol: s.stock.Symbol,
			Action: action,
			Weight: roundTo2(weight),
			Reason: fmt.Sprintf("Combined score: %.1f/100 (Tech: %.1f, Fund: %.1f)",
				s.score,
				func() float64 {
					if ind := indicators[s.stock.ID]; ind != nil {
						return ind.TechnicalScore
					}
					return 0
				}(),
				func() float64 {
					if f := fundamentals[s.stock.ID]; f != nil {
						return f.FundamentalScore
					}
					return 50
				}(),
			),
		})
	}

	return suggestions
}

func joinReasons(reasons []string) string {
	result := ""
	for i, r := range reasons {
		if i > 0 {
			result += "; "
		}
		result += r
	}
	return result
}
