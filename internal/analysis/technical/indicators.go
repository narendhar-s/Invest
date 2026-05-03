package technical

import (
	"math"
	"time"

	"stockwise/internal/storage"
	"stockwise/pkg/config"
)

// ─── Result Types ─────────────────────────────────────────────────────────────

// IndicatorSet holds all computed indicators for a price series.
type IndicatorSet struct {
	SMA20  []float64
	SMA50  []float64
	SMA200 []float64
	EMA20  []float64
	EMA50  []float64

	RSI []float64

	MACDLine   []float64
	SignalLine  []float64
	MACDHist   []float64

	BBUpper  []float64
	BBMiddle []float64
	BBLower  []float64
	BBWidth  []float64

	VWAP           []float64
	RelativeVolume []float64
	VolumeSpike    []bool

	TrendDirection []string
	TrendStrength  []float64
}

// Analyzer runs all technical indicator calculations.
type Analyzer struct {
	cfg *config.IndicatorsConfig
}

func NewAnalyzer(cfg *config.IndicatorsConfig) *Analyzer {
	return &Analyzer{cfg: cfg}
}

// Compute calculates all indicators for the given price bars.
func (a *Analyzer) Compute(bars []storage.PriceBar) IndicatorSet {
	n := len(bars)
	if n == 0 {
		return IndicatorSet{}
	}

	closes := extractFloats(bars, func(b storage.PriceBar) float64 { return b.Close })
	highs := extractFloats(bars, func(b storage.PriceBar) float64 { return b.High })
	lows := extractFloats(bars, func(b storage.PriceBar) float64 { return b.Low })
	volumes := extractInt64s(bars)
	typicalPrices := typicalPrice(highs, lows, closes)

	set := IndicatorSet{}

	// Moving Averages
	set.SMA20 = sma(closes, 20)
	set.SMA50 = sma(closes, 50)
	set.SMA200 = sma(closes, 200)
	set.EMA20 = ema(closes, 20)
	set.EMA50 = ema(closes, 50)

	// RSI
	set.RSI = computeRSI(closes, a.cfg.RSIPeriod)

	// MACD
	set.MACDLine, set.SignalLine, set.MACDHist = computeMACD(closes,
		a.cfg.MACDFast, a.cfg.MACDSlow, a.cfg.MACDSignal)

	// Bollinger Bands
	set.BBUpper, set.BBMiddle, set.BBLower, set.BBWidth = computeBB(closes,
		a.cfg.BBPeriod, a.cfg.BBStdDev)

	// VWAP
	set.VWAP = computeVWAP(typicalPrices, volumes)

	// Volume analysis
	set.RelativeVolume, set.VolumeSpike = computeVolumeAnalysis(volumes, 20)

	// Trend detection
	set.TrendDirection, set.TrendStrength = computeTrend(closes, highs, lows, 20)

	return set
}

// ToStorageModels converts the IndicatorSet into storage models for each bar date.
func (a *Analyzer) ToStorageModels(stockID uint, bars []storage.PriceBar, set IndicatorSet) []storage.TechnicalIndicator {
	n := len(bars)
	result := make([]storage.TechnicalIndicator, 0, n)

	for i := 0; i < n; i++ {
		ind := storage.TechnicalIndicator{
			StockID:        stockID,
			Date:           bars[i].Date,
			TechnicalScore: a.computeScore(i, set, bars),
		}

		ind.SMA20 = ptrAt(set.SMA20, i)
		ind.SMA50 = ptrAt(set.SMA50, i)
		ind.SMA200 = ptrAt(set.SMA200, i)
		ind.EMA20 = ptrAt(set.EMA20, i)
		ind.EMA50 = ptrAt(set.EMA50, i)
		ind.RSI = ptrAt(set.RSI, i)
		ind.MACDLine = ptrAt(set.MACDLine, i)
		ind.SignalLine = ptrAt(set.SignalLine, i)
		ind.MACDHist = ptrAt(set.MACDHist, i)
		ind.BBUpper = ptrAt(set.BBUpper, i)
		ind.BBMiddle = ptrAt(set.BBMiddle, i)
		ind.BBLower = ptrAt(set.BBLower, i)
		ind.BBWidth = ptrAt(set.BBWidth, i)
		ind.VWAP = ptrAt(set.VWAP, i)
		ind.RelativeVolume = ptrAt(set.RelativeVolume, i)

		if i < len(set.VolumeSpike) {
			ind.VolumeSpike = set.VolumeSpike[i]
		}
		if i < len(set.TrendDirection) {
			ind.TrendDirection = set.TrendDirection[i]
		}
		ind.TrendStrength = ptrAt(set.TrendStrength, i)

		result = append(result, ind)
	}

	return result
}

// computeScore generates a technical score (0-100) for bar at index i.
func (a *Analyzer) computeScore(i int, set IndicatorSet, bars []storage.PriceBar) float64 {
	score := 50.0
	signals := 0
	bullish := 0

	close := bars[i].Close

	// RSI signal
	if rsi := valAt(set.RSI, i); rsi > 0 {
		signals++
		if rsi < 30 {
			bullish += 2 // oversold → strong buy signal
		} else if rsi < 45 {
			bullish++
		} else if rsi > 70 {
			// overbought
		} else if rsi > 55 {
			bullish++
		}
	}

	// MACD signal
	if macdHist := valAt(set.MACDHist, i); macdHist != 0 {
		signals++
		if macdHist > 0 {
			bullish++
		}
	}
	// MACD crossover (current hist positive, previous negative)
	if i > 0 {
		if valAt(set.MACDHist, i) > 0 && valAt(set.MACDHist, i-1) < 0 {
			bullish++ // golden cross momentum
		}
	}

	// Price vs MA signals
	if sma20 := valAt(set.SMA20, i); sma20 > 0 {
		signals++
		if close > sma20 {
			bullish++
		}
	}
	if sma50 := valAt(set.SMA50, i); sma50 > 0 {
		signals++
		if close > sma50 {
			bullish++
		}
	}
	if sma200 := valAt(set.SMA200, i); sma200 > 0 {
		signals++
		if close > sma200 {
			bullish++
		}
	}

	// Bollinger band position
	if bbLower := valAt(set.BBLower, i); bbLower > 0 {
		bbUpper := valAt(set.BBUpper, i)
		bbMid := valAt(set.BBMiddle, i)
		signals++
		if close <= bbLower {
			bullish += 2 // price at lower band = oversold
		} else if close > bbMid && close < bbUpper {
			bullish++
		}
	}

	// VWAP signal (for daily bars, VWAP serves as a reference)
	if vwap := valAt(set.VWAP, i); vwap > 0 {
		signals++
		if close > vwap {
			bullish++
		}
	}

	// Volume spike with price up = bullish confirmation
	if i < len(set.VolumeSpike) && set.VolumeSpike[i] {
		if i > 0 && bars[i].Close > bars[i-1].Close {
			bullish++
		}
		signals++
	}

	// MA alignment (20>50>200 = strong uptrend)
	sma20 := valAt(set.SMA20, i)
	sma50 := valAt(set.SMA50, i)
	sma200 := valAt(set.SMA200, i)
	if sma20 > 0 && sma50 > 0 && sma200 > 0 {
		if sma20 > sma50 && sma50 > sma200 {
			bullish += 2
			signals += 2
		} else if sma20 < sma50 && sma50 < sma200 {
			signals += 2 // all bearish, no bullish points
		}
	}

	if signals > 0 {
		score = (float64(bullish) / float64(signals)) * 100
	}

	return clamp(score, 0, 100)
}

// ─── SMA ──────────────────────────────────────────────────────────────────────

func sma(data []float64, period int) []float64 {
	n := len(data)
	result := make([]float64, n)
	if period > n {
		return result
	}
	sum := 0.0
	for i := 0; i < period; i++ {
		sum += data[i]
	}
	result[period-1] = sum / float64(period)
	for i := period; i < n; i++ {
		sum += data[i] - data[i-period]
		result[i] = sum / float64(period)
	}
	return result
}

// ─── EMA ──────────────────────────────────────────────────────────────────────

func ema(data []float64, period int) []float64 {
	n := len(data)
	result := make([]float64, n)
	if period > n {
		return result
	}
	k := 2.0 / float64(period+1)

	// Seed with SMA
	sum := 0.0
	for i := 0; i < period; i++ {
		sum += data[i]
	}
	result[period-1] = sum / float64(period)

	for i := period; i < n; i++ {
		result[i] = data[i]*k + result[i-1]*(1-k)
	}
	return result
}

// ─── RSI ──────────────────────────────────────────────────────────────────────

func computeRSI(closes []float64, period int) []float64 {
	n := len(closes)
	result := make([]float64, n)
	if n < period+1 {
		return result
	}

	// Calculate initial average gain/loss
	avgGain, avgLoss := 0.0, 0.0
	for i := 1; i <= period; i++ {
		change := closes[i] - closes[i-1]
		if change > 0 {
			avgGain += change
		} else {
			avgLoss += -change
		}
	}
	avgGain /= float64(period)
	avgLoss /= float64(period)

	if avgLoss == 0 {
		result[period] = 100
	} else {
		rs := avgGain / avgLoss
		result[period] = 100 - (100 / (1 + rs))
	}

	// Wilder's smoothing for subsequent values
	for i := period + 1; i < n; i++ {
		change := closes[i] - closes[i-1]
		gain, loss := 0.0, 0.0
		if change > 0 {
			gain = change
		} else {
			loss = -change
		}
		avgGain = (avgGain*float64(period-1) + gain) / float64(period)
		avgLoss = (avgLoss*float64(period-1) + loss) / float64(period)

		if avgLoss == 0 {
			result[i] = 100
		} else {
			rs := avgGain / avgLoss
			result[i] = 100 - (100 / (1 + rs))
		}
	}
	return result
}

// ─── MACD ─────────────────────────────────────────────────────────────────────

func computeMACD(closes []float64, fast, slow, signal int) ([]float64, []float64, []float64) {
	n := len(closes)
	emaFast := ema(closes, fast)
	emaSlow := ema(closes, slow)

	macdLine := make([]float64, n)
	for i := slow - 1; i < n; i++ {
		macdLine[i] = emaFast[i] - emaSlow[i]
	}

	signalLine := ema(macdLine, signal)

	histogram := make([]float64, n)
	for i := 0; i < n; i++ {
		histogram[i] = macdLine[i] - signalLine[i]
	}

	return macdLine, signalLine, histogram
}

// ─── Bollinger Bands ──────────────────────────────────────────────────────────

func computeBB(closes []float64, period int, stdDev float64) ([]float64, []float64, []float64, []float64) {
	n := len(closes)
	upper := make([]float64, n)
	middle := sma(closes, period)
	lower := make([]float64, n)
	width := make([]float64, n)

	for i := period - 1; i < n; i++ {
		mean := middle[i]
		variance := 0.0
		for j := i - period + 1; j <= i; j++ {
			diff := closes[j] - mean
			variance += diff * diff
		}
		sd := math.Sqrt(variance / float64(period))
		upper[i] = mean + stdDev*sd
		lower[i] = mean - stdDev*sd
		if mean > 0 {
			width[i] = (upper[i] - lower[i]) / mean * 100
		}
	}

	return upper, middle, lower, width
}

// ─── VWAP ─────────────────────────────────────────────────────────────────────

func computeVWAP(typicalPrices []float64, volumes []int64) []float64 {
	n := len(typicalPrices)
	result := make([]float64, n)

	// Rolling VWAP (reset daily for intraday; for daily bars, compute cumulative)
	cumTPV := 0.0
	cumVol := 0.0
	for i := 0; i < n; i++ {
		cumTPV += typicalPrices[i] * float64(volumes[i])
		cumVol += float64(volumes[i])
		if cumVol > 0 {
			result[i] = cumTPV / cumVol
		}
	}
	return result
}

// ─── Volume Analysis ─────────────────────────────────────────────────────────

func computeVolumeAnalysis(volumes []int64, period int) ([]float64, []bool) {
	n := len(volumes)
	relVol := make([]float64, n)
	spikes := make([]bool, n)

	for i := period; i < n; i++ {
		sum := 0.0
		for j := i - period; j < i; j++ {
			sum += float64(volumes[j])
		}
		avg := sum / float64(period)
		if avg > 0 {
			rv := float64(volumes[i]) / avg
			relVol[i] = rv
			spikes[i] = rv > 2.0 // volume spike = 2x average
		}
	}
	return relVol, spikes
}

// ─── Trend Detection ──────────────────────────────────────────────────────────

func computeTrend(closes, highs, lows []float64, lookback int) ([]string, []float64) {
	n := len(closes)
	directions := make([]string, n)
	strengths := make([]float64, n)

	for i := lookback; i < n; i++ {
		window := closes[i-lookback : i+1]
		highWindow := highs[i-lookback : i+1]
		lowWindow := lows[i-lookback : i+1]

		hhCount := 0 // higher highs
		hlCount := 0 // higher lows
		lhCount := 0 // lower highs
		llCount := 0 // lower lows

		for j := 1; j < len(highWindow); j++ {
			if highWindow[j] > highWindow[j-1] {
				hhCount++
			} else {
				lhCount++
			}
			if lowWindow[j] > lowWindow[j-1] {
				hlCount++
			} else {
				llCount++
			}
		}

		total := float64(lookback)
		// Uptrend = higher highs + higher lows
		upScore := (float64(hhCount) + float64(hlCount)) / (total * 2)
		// Downtrend = lower highs + lower lows
		downScore := (float64(lhCount) + float64(llCount)) / (total * 2)

		// Linear regression slope for additional confirmation
		slope := linearRegressionSlope(window)

		if upScore > 0.6 && slope > 0 {
			directions[i] = "UP"
			strengths[i] = upScore * 100
		} else if downScore > 0.6 && slope < 0 {
			directions[i] = "DOWN"
			strengths[i] = downScore * 100
		} else {
			directions[i] = "SIDEWAYS"
			strengths[i] = 50
		}
	}

	return directions, strengths
}

func linearRegressionSlope(data []float64) float64 {
	n := float64(len(data))
	if n < 2 {
		return 0
	}
	sumX, sumY, sumXY, sumX2 := 0.0, 0.0, 0.0, 0.0
	for i, y := range data {
		x := float64(i)
		sumX += x
		sumY += y
		sumXY += x * y
		sumX2 += x * x
	}
	denom := n*sumX2 - sumX*sumX
	if denom == 0 {
		return 0
	}
	return (n*sumXY - sumX*sumY) / denom
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func typicalPrice(highs, lows, closes []float64) []float64 {
	n := len(closes)
	tp := make([]float64, n)
	for i := 0; i < n; i++ {
		tp[i] = (highs[i] + lows[i] + closes[i]) / 3
	}
	return tp
}

func extractFloats(bars []storage.PriceBar, fn func(storage.PriceBar) float64) []float64 {
	result := make([]float64, len(bars))
	for i, b := range bars {
		result[i] = fn(b)
	}
	return result
}

func extractInt64s(bars []storage.PriceBar) []int64 {
	result := make([]int64, len(bars))
	for i, b := range bars {
		result[i] = b.Volume
	}
	return result
}

func ptrAt(data []float64, i int) *float64 {
	if i < len(data) && data[i] != 0 {
		v := data[i]
		return &v
	}
	return nil
}

func valAt(data []float64, i int) float64 {
	if i < len(data) {
		return data[i]
	}
	return 0
}

func clamp(v, min, max float64) float64 {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

// ─── Signal helpers (used by recommendation engine) ───────────────────────────

type Signal struct {
	Name      string
	Bullish   bool
	Strength  float64 // 0-1
	Timestamp time.Time
}

// ExtractSignals creates named signals from the latest indicator values.
func ExtractSignals(ind *storage.TechnicalIndicator, latestClose float64) []Signal {
	var signals []Signal

	if ind.RSI != nil {
		rsi := *ind.RSI
		s := Signal{Name: "RSI"}
		if rsi < 30 {
			s.Bullish = true
			s.Strength = 1.0
			s.Name = "RSI Oversold (<30)"
		} else if rsi > 70 {
			s.Bullish = false
			s.Strength = 0.9
			s.Name = "RSI Overbought (>70)"
		} else if rsi < 45 {
			s.Bullish = true
			s.Strength = 0.5
			s.Name = "RSI Approaching Oversold"
		} else {
			s.Bullish = true
			s.Strength = 0.4
			s.Name = "RSI Neutral"
		}
		signals = append(signals, s)
	}

	if ind.MACDHist != nil {
		hist := *ind.MACDHist
		s := Signal{Name: "MACD"}
		if hist > 0 {
			s.Bullish = true
			s.Strength = math.Min(math.Abs(hist)/latestClose*1000, 1.0)
			s.Name = "MACD Bullish"
		} else {
			s.Bullish = false
			s.Strength = math.Min(math.Abs(hist)/latestClose*1000, 1.0)
			s.Name = "MACD Bearish"
		}
		signals = append(signals, s)
	}

	if ind.SMA20 != nil && latestClose > *ind.SMA20 {
		signals = append(signals, Signal{Name: "Above SMA20", Bullish: true, Strength: 0.5})
	}
	if ind.SMA50 != nil && latestClose > *ind.SMA50 {
		signals = append(signals, Signal{Name: "Above SMA50", Bullish: true, Strength: 0.6})
	}
	if ind.SMA200 != nil && latestClose > *ind.SMA200 {
		signals = append(signals, Signal{Name: "Above SMA200", Bullish: true, Strength: 0.8})
	}

	if ind.TrendDirection == "UP" {
		signals = append(signals, Signal{Name: "Uptrend", Bullish: true, Strength: 0.7})
	} else if ind.TrendDirection == "DOWN" {
		signals = append(signals, Signal{Name: "Downtrend", Bullish: false, Strength: 0.7})
	}

	if ind.VolumeSpike {
		signals = append(signals, Signal{Name: "Volume Spike", Bullish: true, Strength: 0.6})
	}

	if ind.BBLower != nil && latestClose <= *ind.BBLower {
		signals = append(signals, Signal{Name: "Price at Bollinger Lower Band", Bullish: true, Strength: 0.8})
	} else if ind.BBUpper != nil && latestClose >= *ind.BBUpper {
		signals = append(signals, Signal{Name: "Price at Bollinger Upper Band", Bullish: false, Strength: 0.8})
	}

	return signals
}
