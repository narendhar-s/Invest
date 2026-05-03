package alpha

import (
	"math"
	"time"

	"stockwise/internal/storage"
)

// IntradaySignal represents a generated intraday trading signal.
type IntradaySignal struct {
	Symbol      string
	Strategy    string
	Direction   string // LONG, SHORT
	EntryPrice  float64
	TargetPrice float64
	StopLoss    float64
	RiskReward  float64
	Confidence  float64 // 0-100
	Reason      string
	GeneratedAt time.Time
}

// IntradayAnalyzer generates intraday signals for Indian market stocks.
type IntradayAnalyzer struct{}

func NewIntradayAnalyzer() *IntradayAnalyzer {
	return &IntradayAnalyzer{}
}

// Analyze runs all intraday strategies and returns signals.
func (ia *IntradayAnalyzer) Analyze(
	stock *storage.Stock,
	bars []storage.PriceBar,
	indicator *storage.TechnicalIndicator,
	srLevels []storage.SupportResistanceLevel,
) []IntradaySignal {
	if len(bars) < 20 || indicator == nil {
		return nil
	}

	var signals []IntradaySignal

	// Only for NSE/BSE market
	if stock.Market != "NSE" && stock.Market != "BSE" {
		return nil
	}

	latestBar := bars[len(bars)-1]

	// Strategy 1: VWAP-based entry
	if sig := ia.vwapStrategy(stock, latestBar, indicator); sig != nil {
		signals = append(signals, *sig)
	}

	// Strategy 2: Opening Range Breakout
	if sig := ia.orbStrategy(stock, bars, indicator); sig != nil {
		signals = append(signals, *sig)
	}

	// Strategy 3: Momentum Breakout
	if sig := ia.momentumBreakout(stock, bars, indicator, srLevels); sig != nil {
		signals = append(signals, *sig)
	}

	// Strategy 4: Volume Spike + Trend
	if sig := ia.volumeSpikeStrategy(stock, bars, indicator); sig != nil {
		signals = append(signals, *sig)
	}

	return signals
}

// ─── VWAP Strategy ───────────────────────────────────────────────────────────

func (ia *IntradayAnalyzer) vwapStrategy(
	stock *storage.Stock,
	bar storage.PriceBar,
	ind *storage.TechnicalIndicator,
) *IntradaySignal {
	if ind.VWAP == nil {
		return nil
	}

	vwap := *ind.VWAP
	close := bar.Close
	atr := estimateATR(bar)

	// Bullish VWAP: price pulls back to VWAP + RSI not overbought
	if close >= vwap*0.995 && close <= vwap*1.005 {
		// Price is at VWAP — wait for direction
		if ind.RSI != nil && *ind.RSI < 60 && ind.TrendDirection == "UP" {
			target := close + atr*2
			stopLoss := vwap - atr*0.8
			rr := (target - close) / (close - stopLoss)
			if rr < 1.5 {
				return nil
			}
			return &IntradaySignal{
				Symbol:      stock.Symbol,
				Strategy:    "VWAP_Reversion",
				Direction:   "LONG",
				EntryPrice:  close,
				TargetPrice: roundTo2(target),
				StopLoss:    roundTo2(stopLoss),
				RiskReward:  roundTo2(rr),
				Confidence:  65,
				Reason:      "Price at VWAP support with uptrend. RSI not overbought. ATR-based target.",
				GeneratedAt: time.Now(),
			}
		}
	}

	// Bearish VWAP: price at VWAP resistance + downtrend
	if close >= vwap*0.998 && close <= vwap*1.01 && ind.TrendDirection == "DOWN" {
		target := close - atr*2
		stopLoss := vwap + atr*0.8
		rr := (close - target) / (stopLoss - close)
		if rr < 1.5 {
			return nil
		}
		return &IntradaySignal{
			Symbol:      stock.Symbol,
			Strategy:    "VWAP_Short",
			Direction:   "SHORT",
			EntryPrice:  close,
			TargetPrice: roundTo2(target),
			StopLoss:    roundTo2(stopLoss),
			RiskReward:  roundTo2(rr),
			Confidence:  60,
			Reason:      "Price rejected at VWAP in downtrend. Short opportunity.",
			GeneratedAt: time.Now(),
		}
	}

	return nil
}

// ─── Opening Range Breakout ───────────────────────────────────────────────────

func (ia *IntradayAnalyzer) orbStrategy(
	stock *storage.Stock,
	bars []storage.PriceBar,
	ind *storage.TechnicalIndicator,
) *IntradaySignal {
	// Use the first bar of the session as the "opening range"
	// For daily data, use first 5% of the daily range
	if len(bars) < 5 {
		return nil
	}

	latestBar := bars[len(bars)-1]
	prevBars := bars[len(bars)-5:]

	// Compute the 5-bar opening range (proxy for 15-min range on daily data)
	orbHigh := prevBars[0].High
	orbLow := prevBars[0].Low
	for _, b := range prevBars[1:] {
		if b.High > orbHigh {
			orbHigh = b.High
		}
		if b.Low < orbLow {
			orbLow = b.Low
		}
	}

	close := latestBar.Close
	orbRange := orbHigh - orbLow
	atr := estimateATR(latestBar)

	// Bullish breakout: close above ORB high with volume
	if close > orbHigh && ind.VolumeSpike {
		target := orbHigh + orbRange*1.5
		stopLoss := orbHigh - orbRange*0.3
		rr := (target - close) / (close - stopLoss)
		if rr >= 2.0 {
			return &IntradaySignal{
				Symbol:      stock.Symbol,
				Strategy:    "ORB_Long",
				Direction:   "LONG",
				EntryPrice:  close,
				TargetPrice: roundTo2(target),
				StopLoss:    roundTo2(stopLoss),
				RiskReward:  roundTo2(rr),
				Confidence:  70,
				Reason:      "Breakout above 5-bar opening range high with volume spike. Target: 1.5x range.",
				GeneratedAt: time.Now(),
			}
		}
	}

	// Bearish breakdown: close below ORB low with volume
	if close < orbLow && ind.VolumeSpike {
		target := orbLow - orbRange*1.5
		stopLoss := orbLow + orbRange*0.3
		rr := (close - target) / (stopLoss - close)
		if rr >= 2.0 {
			return &IntradaySignal{
				Symbol:      stock.Symbol,
				Strategy:    "ORB_Short",
				Direction:   "SHORT",
				EntryPrice:  close,
				TargetPrice: roundTo2(target),
				StopLoss:    roundTo2(stopLoss),
				RiskReward:  roundTo2(rr),
				Confidence:  68,
				Reason:      "Breakdown below 5-bar opening range low with volume spike.",
				GeneratedAt: time.Now(),
			}
		}
	}

	_ = atr
	return nil
}

// ─── Momentum Breakout ────────────────────────────────────────────────────────

func (ia *IntradayAnalyzer) momentumBreakout(
	stock *storage.Stock,
	bars []storage.PriceBar,
	ind *storage.TechnicalIndicator,
	srLevels []storage.SupportResistanceLevel,
) *IntradaySignal {
	if len(bars) < 10 {
		return nil
	}

	latestBar := bars[len(bars)-1]
	close := latestBar.Close

	// Find the nearest resistance level above current price
	var nearestResistance float64
	nearestResistanceDist := math.MaxFloat64

	for _, level := range srLevels {
		if level.LevelType == "resistance" || level.LevelType == "breakout" {
			if level.Price > close {
				dist := level.Price - close
				if dist < nearestResistanceDist {
					nearestResistanceDist = dist
					nearestResistance = level.Price
				}
			}
		}
	}

	if nearestResistance == 0 {
		return nil
	}

	distPct := nearestResistanceDist / close

	// Momentum: price approaching resistance (within 0.5%) + strong RSI + volume
	if distPct < 0.005 && ind.RSI != nil && *ind.RSI > 55 && *ind.RSI < 75 {
		if ind.VolumeSpike || (ind.RelativeVolume != nil && *ind.RelativeVolume > 1.5) {
			atr := estimateATR(latestBar)
			target := nearestResistance + atr*2
			stopLoss := close - atr*1.0
			rr := (target - close) / (close - stopLoss)
			if rr >= 1.8 {
				return &IntradaySignal{
					Symbol:      stock.Symbol,
					Strategy:    "Momentum_Breakout",
					Direction:   "LONG",
					EntryPrice:  close,
					TargetPrice: roundTo2(target),
					StopLoss:    roundTo2(stopLoss),
					RiskReward:  roundTo2(rr),
					Confidence:  72,
					Reason:      "Price approaching key resistance with momentum (RSI>55) and elevated volume. Breakout trade.",
					GeneratedAt: time.Now(),
				}
			}
		}
	}

	return nil
}

// ─── Volume Spike Strategy ────────────────────────────────────────────────────

func (ia *IntradayAnalyzer) volumeSpikeStrategy(
	stock *storage.Stock,
	bars []storage.PriceBar,
	ind *storage.TechnicalIndicator,
) *IntradaySignal {
	if !ind.VolumeSpike {
		return nil
	}

	latestBar := bars[len(bars)-1]
	close := latestBar.Close
	atr := estimateATR(latestBar)

	// Bullish: volume spike on an up candle in uptrend
	if latestBar.Close > latestBar.Open && ind.TrendDirection == "UP" {
		if ind.RSI != nil && *ind.RSI > 40 && *ind.RSI < 70 {
			target := close + atr*1.5
			stopLoss := latestBar.Low - atr*0.3
			rr := (target - close) / (close - stopLoss)
			if rr >= 1.5 {
				return &IntradaySignal{
					Symbol:      stock.Symbol,
					Strategy:    "Volume_Spike_Long",
					Direction:   "LONG",
					EntryPrice:  close,
					TargetPrice: roundTo2(target),
					StopLoss:    roundTo2(stopLoss),
					RiskReward:  roundTo2(rr),
					Confidence:  65,
					Reason:      "Bullish volume spike (>2x avg) on up candle in uptrend. Institutional buying signal.",
					GeneratedAt: time.Now(),
				}
			}
		}
	}

	// Bearish: volume spike on a down candle in downtrend
	if latestBar.Close < latestBar.Open && ind.TrendDirection == "DOWN" {
		target := close - atr*1.5
		stopLoss := latestBar.High + atr*0.3
		rr := (close - target) / (stopLoss - close)
		if rr >= 1.5 {
			return &IntradaySignal{
				Symbol:      stock.Symbol,
				Strategy:    "Volume_Spike_Short",
				Direction:   "SHORT",
				EntryPrice:  close,
				TargetPrice: roundTo2(target),
				StopLoss:    roundTo2(stopLoss),
				RiskReward:  roundTo2(rr),
				Confidence:  60,
				Reason:      "Bearish volume spike (>2x avg) on down candle in downtrend. Distribution signal.",
				GeneratedAt: time.Now(),
			}
		}
	}

	return nil
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// estimateATR uses the day's range as a simple ATR proxy.
func estimateATR(bar storage.PriceBar) float64 {
	atr := bar.High - bar.Low
	if atr < bar.Close*0.005 { // min 0.5% of price
		atr = bar.Close * 0.005
	}
	return atr
}

func roundTo2(v float64) float64 {
	return math.Round(v*100) / 100
}
