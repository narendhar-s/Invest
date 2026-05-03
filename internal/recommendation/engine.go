package recommendation

import (
	"fmt"
	"math"
	"strings"
	"time"

	"go.uber.org/zap"

	"stockwise/internal/analysis/fundamental"
	"stockwise/internal/analysis/technical"
	"stockwise/internal/storage"
	"stockwise/pkg/config"
	"stockwise/pkg/logger"
)

// Engine generates recommendations for all stocks.
type Engine struct {
	cfg        *config.Config
	repo       *storage.Repository
	faAnalyzer *fundamental.Analyzer
}

func NewEngine(cfg *config.Config, repo *storage.Repository) *Engine {
	return &Engine{
		cfg:        cfg,
		repo:       repo,
		faAnalyzer: fundamental.NewAnalyzer(),
	}
}

// GenerateAll creates recommendations (one per horizon) for all stocks in the database.
func (e *Engine) GenerateAll() error {
	stocks, err := e.repo.GetAllStocks()
	if err != nil {
		return err
	}

	logger.Info("generating recommendations", zap.Int("stocks", len(stocks)))
	today := time.Now().Truncate(24 * time.Hour)
	total := 0

	for _, stock := range stocks {
		horizons := []string{"swing", "longterm"}
		if stock.Market == "NSE" {
			horizons = append([]string{"intraday"}, horizons...)
		}

		for _, horizon := range horizons {
			rec, err := e.generateForHorizon(stock, today, horizon)
			if err != nil {
				continue
			}
			if err := e.repo.UpsertRecommendation(rec); err != nil {
				logger.Warn("storing recommendation",
					zap.String("symbol", stock.Symbol),
					zap.String("horizon", horizon),
					zap.Error(err))
			} else {
				total++
			}
		}
	}

	logger.Info("recommendations generated", zap.Int("total", total))
	return nil
}

func (e *Engine) generateForHorizon(stock storage.Stock, date time.Time, horizon string) (*storage.Recommendation, error) {
	ind, err := e.repo.GetLatestTechnicalIndicator(stock.ID)
	if err != nil {
		return nil, fmt.Errorf("no technical indicator: %w", err)
	}

	bars, err := e.repo.GetLatestPriceBars(stock.ID, 5)
	if err != nil || len(bars) == 0 {
		return nil, fmt.Errorf("no price data: %w", err)
	}
	latestBar := bars[len(bars)-1]
	latestClose := latestBar.Close

	fund, _ := e.repo.GetFundamental(stock.ID)
	srLevels, _ := e.repo.GetSRLevels(stock.ID)

	techScore := ind.TechnicalScore
	signals := technical.ExtractSignals(ind, latestClose)

	fundScore := 50.0
	if fund != nil {
		fundScore = fund.FundamentalScore
		if fundScore == 0 {
			e.faAnalyzer.Score(fund)
			fundScore = fund.FundamentalScore
		}
	}

	// ── Horizon-adjusted weighting ────────────────────────────────────────
	var confidence float64
	switch horizon {
	case "intraday":
		// Heavily technical for intraday
		confidence = techScore*0.85 + fundScore*0.15
	case "swing":
		// Balanced
		confidence = techScore*0.65 + fundScore*0.35
	case "longterm":
		// Fundamentals matter more
		confidence = techScore*0.40 + fundScore*0.60
	}

	// Boost/penalize based on signal consensus
	bullishCount, bearishCount := 0, 0
	for _, s := range signals {
		if s.Bullish {
			bullishCount++
		} else {
			bearishCount++
		}
	}
	sigTotal := bullishCount + bearishCount
	if sigTotal > 0 {
		consensus := float64(bullishCount-bearishCount) / float64(sigTotal)
		confidence = confidence + consensus*8
	}
	confidence = math.Max(0, math.Min(100, confidence))

	// ── Horizon-specific adjustments ─────────────────────────────────────
	switch horizon {
	case "intraday":
		// Require strong momentum for intraday
		if !ind.VolumeSpike && ind.TrendDirection != "UP" {
			confidence *= 0.70
		} else if !ind.VolumeSpike || ind.TrendDirection != "UP" {
			confidence *= 0.85
		}
		// Penalize if RSI is in dead zone (40-60) — no edge
		if ind.RSI != nil && *ind.RSI > 40 && *ind.RSI < 60 {
			confidence *= 0.90
		}
	case "swing":
		// Swing needs trend alignment
		if ind.TrendDirection == "DOWN" {
			confidence *= 0.80
		}
		// Boost if trend is UP with healthy RSI
		if ind.TrendDirection == "UP" && ind.RSI != nil && *ind.RSI > 40 && *ind.RSI < 65 {
			confidence += 5
		}
		// Penalize if no volume confirmation
		if !ind.VolumeSpike && ind.TrendDirection == "SIDEWAYS" {
			confidence *= 0.85
		}
	case "longterm":
		// Fundamentals matter most
		if fund == nil {
			confidence *= 0.75
		} else if fundScore > 70 {
			confidence += 8 // strong fundamentals boost
		} else if fundScore < 35 {
			confidence -= 8 // weak fundamentals penalize
		}
		// SMA200 is critical for long-term trend
		if ind.SMA200 != nil && latestClose > *ind.SMA200 {
			confidence += 5
		} else if ind.SMA200 != nil && latestClose < *ind.SMA200*0.95 {
			confidence -= 8 // well below long-term trend
		}
	}

	thresholds := e.cfg.Recommendation
	recType := "hold"
	switch {
	case confidence >= float64(thresholds.StrongBuyThreshold):
		recType = "strong_buy"
	case confidence >= float64(thresholds.BuyThreshold):
		recType = "buy"
	case confidence >= float64(thresholds.HoldThreshold):
		recType = "hold"
	default:
		recType = "sell"
	}

	riskLevel := "medium"
	if ind.RSI != nil {
		rsi := *ind.RSI
		if rsi > 75 || rsi < 25 {
			riskLevel = "high"
		} else if rsi >= 40 && rsi <= 65 {
			riskLevel = "low"
		}
	}

	targetPrice, stopLoss := e.computeLevels(latestClose, latestBar, ind, srLevels, recType, horizon)

	riskReward := 0.0
	if stopLoss > 0 && stopLoss < latestClose {
		riskReward = (targetPrice - latestClose) / (latestClose - stopLoss)
	}

	techReason := buildTechnicalReason(signals, ind, latestClose)
	fundReason := "Fundamental data not available."
	if fund != nil {
		fundReason = e.faAnalyzer.BuildReasoningText(fund)
	}

	summary := buildSummary(recType, confidence, horizon, techReason, fundReason)

	return &storage.Recommendation{
		StockID:            stock.ID,
		Date:               date,
		RecType:            recType,
		Confidence:         math.Round(confidence*10) / 10,
		RiskLevel:          riskLevel,
		Horizon:            horizon,
		EntryPrice:         latestClose,
		TargetPrice:        math.Round(targetPrice*100) / 100,
		StopLoss:           math.Round(stopLoss*100) / 100,
		RiskReward:         math.Round(riskReward*100) / 100,
		TechnicalFactors:   techReason,
		FundamentalFactors: fundReason,
		Summary:            summary,
		TechnicalScore:     math.Round(techScore*10) / 10,
		FundamentalScore:   math.Round(fundScore*10) / 10,
	}, nil
}

func (e *Engine) computeLevels(
	close float64,
	bar storage.PriceBar,
	ind *storage.TechnicalIndicator,
	srLevels []storage.SupportResistanceLevel,
	recType string,
	horizon string,
) (target, stopLoss float64) {
	isBullish := recType == "strong_buy" || recType == "buy"

	// Wider targets for longer horizons
	targetMult := map[string]float64{"intraday": 1.03, "swing": 1.08, "longterm": 1.20}[horizon]
	stopMult := map[string]float64{"intraday": 0.98, "swing": 0.94, "longterm": 0.88}[horizon]

	if isBullish {
		target = close * targetMult
		for _, level := range srLevels {
			if (level.LevelType == "resistance" || level.LevelType == "supply") &&
				level.Price > close && level.Price < target {
				target = level.Price
			}
		}

		stopLoss = close * stopMult
		for _, level := range srLevels {
			if level.LevelType == "support" && level.Price < close && level.Price > stopLoss {
				stopLoss = level.Price * 0.99
			}
		}
		if ind.SMA50 != nil && *ind.SMA50 < close && *ind.SMA50 > stopLoss {
			stopLoss = math.Max(stopLoss, *ind.SMA50*0.97)
		}
	} else {
		target = close * (2 - targetMult)
		stopLoss = close * (2 - stopMult)
	}

	return target, stopLoss
}

func buildTechnicalReason(signals []technical.Signal, ind *storage.TechnicalIndicator, close float64) string {
	var bullish, bearish []string
	for _, s := range signals {
		if s.Bullish {
			bullish = append(bullish, s.Name)
		} else {
			bearish = append(bearish, s.Name)
		}
	}

	parts := []string{}
	if len(bullish) > 0 {
		parts = append(parts, "Bullish: "+strings.Join(bullish, ", "))
	}
	if len(bearish) > 0 {
		parts = append(parts, "Bearish: "+strings.Join(bearish, ", "))
	}
	if ind.RSI != nil {
		parts = append(parts, fmt.Sprintf("RSI %.1f", *ind.RSI))
	}
	if ind.TrendDirection != "" {
		parts = append(parts, "Trend: "+ind.TrendDirection)
	}
	if ind.SMA20 != nil {
		diff := (close - *ind.SMA20) / *ind.SMA20 * 100
		parts = append(parts, fmt.Sprintf("%.1f%% vs SMA20", diff))
	}
	if len(parts) == 0 {
		return "Insufficient technical data."
	}
	return strings.Join(parts, ". ") + "."
}

func buildSummary(recType string, confidence float64, horizon, techReason, fundReason string) string {
	labels := map[string]string{
		"strong_buy": "STRONG BUY",
		"buy":        "BUY",
		"hold":       "HOLD",
		"sell":       "SELL",
		"strong_sell": "STRONG SELL",
	}
	label := labels[recType]
	if label == "" {
		label = strings.ToUpper(recType)
	}

	// Build actionable description based on horizon + recType
	var action string
	switch {
	case recType == "strong_buy" && horizon == "intraday":
		action = "Strong intraday momentum — scalp long opportunity with tight SL. Volume and RSI confirm bullish setup."
	case recType == "buy" && horizon == "intraday":
		action = "Moderate intraday setup — consider long entry near VWAP/support with 1:2 R:R target."
	case recType == "hold" && horizon == "intraday":
		action = "No clear intraday edge — avoid new positions. Wait for breakout or RSI divergence."
	case recType == "sell" && horizon == "intraday":
		action = "Bearish intraday structure — consider short or exit longs. RSI/MACD turning negative."

	case recType == "strong_buy" && horizon == "swing":
		action = "Strong swing buy — multiple technical signals aligned. Add in tranches over 2-3 sessions with SL below support."
	case recType == "buy" && horizon == "swing":
		action = "Swing buy opportunity — trend and momentum favor upside. Enter on pullbacks near SMA20 with defined risk."
	case recType == "hold" && horizon == "swing":
		action = "No clear swing edge — maintain existing position if held. Wait for trend confirmation before adding."
	case recType == "sell" && horizon == "swing":
		action = "Swing sell signal — technical deterioration. Book profits or tighten trailing SL. Avoid fresh longs."

	case recType == "strong_buy" && horizon == "longterm":
		action = "Strong long-term accumulate — fundamentals and technicals both support. Ideal for SIP or lump-sum investment."
	case recType == "buy" && horizon == "longterm":
		action = "Long-term buy — reasonable valuation with improving technicals. Accumulate on dips for 1-2 year horizon."
	case recType == "hold" && horizon == "longterm":
		action = "Hold for long term — no strong buy or sell trigger. Monitor quarterly results and sector trends."
	case recType == "sell" && horizon == "longterm":
		action = "Long-term underperformer — weak fundamentals or structural decline. Review thesis, consider reallocation."
	default:
		action = fmt.Sprintf("%s for %s horizon based on current analysis.", label, horizon)
	}

	return fmt.Sprintf("[%s | %s | Conf: %.0f%%] %s\n\nTechnical: %s\nFundamental: %s",
		label, strings.ToUpper(horizon), confidence, action, techReason, fundReason)
}
