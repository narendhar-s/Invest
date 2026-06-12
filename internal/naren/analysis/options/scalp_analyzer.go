package options

import (
	"fmt"
	"math"

	"stockwise/internal/naren/kite"
)

// ScalpAnalyze implements a trend-following 1-minute scalping system:
//
//	Step 1  Chart      : 1-minute NIFTY candles, two indicators only — EMA50 & EMA200.
//	Step 2  Trend      : price above BOTH EMAs → bullish (buys only)
//	                     price below BOTH EMAs → bearish (sells only)
//	                     price between the EMAs → no trade.
//	Step 3  Trigger    : Stochastic Oscillator (14,3) default settings —
//	                     BUY  = bullish AND %K crosses up through the 20 level
//	                     SELL = bearish AND %K crosses down through the 80 level
//	                     Both the trend and the trigger must be true.
//	Step 4  Entry       : fire immediately on the confirming candle.
//	Step 5/6 Stop/Exit  : a swing-based stop with a 1.5 R:R target is applied by
//	                      the caller (challenge / backtest). The swing levels are
//	                      surfaced here in the reasoning for transparency.
//
// It returns a directional ATM-option recommendation (DIRECTIONAL_CE for longs,
// DIRECTIONAL_PE for shorts) so it plugs straight into the existing challenge
// entry path, or StratNone when there is no valid setup. The isExpiryDay flag is
// ignored — this system is purely price/indicator driven.
func ScalpAnalyze(candles []kite.Candle, _ bool) (*Recommendation, error) {
	const need = 205 // EMA200 needs a healthy seed
	if len(candles) < need {
		return nil, fmt.Errorf("need at least %d 1m candles, got %d", need, len(candles))
	}
	n := len(candles)
	closes := make([]float64, n)
	highs := make([]float64, n)
	lows := make([]float64, n)
	for i, c := range candles {
		closes[i] = c.Close
		highs[i] = c.High
		lows[i] = c.Low
	}

	spot := closes[n-1]
	ema50 := ema(closes, 50)
	ema200 := ema(closes, 200)

	// Stochastic %K (14), smoothed by 3 (slow %K). Need the last two values so we
	// can detect a *cross* of the 20 / 80 levels rather than just a level.
	kPrev := stochK(highs, lows, closes, n-2, 14, 3)
	kNow := stochK(highs, lows, closes, n-1, 14, 3)

	swingLow, swingHigh := scalpSwing(highs, lows, 20)
	atm := kite.ATMStrike(spot)
	now := candles[n-1].Time

	bullish := spot > ema50 && spot > ema200
	bearish := spot < ema50 && spot < ema200

	rec := &Recommendation{
		Strategy:   StratNone,
		Direction:  "NEUTRAL",
		Regime:     RegimeRange,
		ATMStrike:  atm,
		AsOf:       now,
		Indicators: Indicators{Spot: spot, EMA9: round2(ema50), EMA21: round2(ema200)},
	}

	crossUp20 := kPrev <= 20 && kNow > 20
	crossDn80 := kPrev >= 80 && kNow < 80

	switch {
	case bullish && crossUp20:
		rec.Strategy = StratDirectionalCE
		rec.Direction = "BULLISH"
		rec.Regime = RegimeTrendUp
		rec.Confidence = scalpConfidence(spot, ema50, ema200, true)
		rec.Legs = []LegSpec{{OptionType: "CE", Side: "BUY", StrikeOffset: 0, Label: "Buy ATM CE"}}
		rec.Reasoning = []string{
			fmt.Sprintf("Price %.1f above EMA50 %.1f & EMA200 %.1f → bullish trend", spot, ema50, ema200),
			fmt.Sprintf("Stochastic %%K crossed up through 20 (%.0f→%.0f) → long trigger", kPrev, kNow),
			fmt.Sprintf("Stop ref: swing low %.1f · target 1.5R", swingLow),
		}
	case bearish && crossDn80:
		rec.Strategy = StratDirectionalPE
		rec.Direction = "BEARISH"
		rec.Regime = RegimeTrendDown
		rec.Confidence = scalpConfidence(spot, ema50, ema200, false)
		rec.Legs = []LegSpec{{OptionType: "PE", Side: "BUY", StrikeOffset: 0, Label: "Buy ATM PE"}}
		rec.Reasoning = []string{
			fmt.Sprintf("Price %.1f below EMA50 %.1f & EMA200 %.1f → bearish trend", spot, ema50, ema200),
			fmt.Sprintf("Stochastic %%K crossed down through 80 (%.0f→%.0f) → short trigger", kPrev, kNow),
			fmt.Sprintf("Stop ref: swing high %.1f · target 1.5R", swingHigh),
		}
	default:
		reason := "No EMA50/200 + Stochastic alignment — waiting"
		if !bullish && !bearish {
			reason = fmt.Sprintf("Price %.1f between EMA50 %.1f & EMA200 %.1f → no trade", spot, ema50, ema200)
		}
		rec.Reasoning = []string{reason}
	}
	return rec, nil
}

// stochK returns the slow %K (raw %K smoothed over `smooth` bars) at index i,
// using a `period`-bar lookback window. Returns 50 (neutral) when there isn't
// enough history.
func stochK(highs, lows, closes []float64, i, period, smooth int) float64 {
	if i < period+smooth {
		return 50
	}
	raw := func(j int) float64 {
		hh := highs[j-period+1]
		ll := lows[j-period+1]
		for k := j - period + 1; k <= j; k++ {
			if highs[k] > hh {
				hh = highs[k]
			}
			if lows[k] < ll {
				ll = lows[k]
			}
		}
		if hh-ll == 0 {
			return 50
		}
		return (closes[j] - ll) / (hh - ll) * 100
	}
	sum := 0.0
	for s := 0; s < smooth; s++ {
		sum += raw(i - s)
	}
	return sum / float64(smooth)
}

// scalpSwing returns the most-recent swing low and swing high over the last
// `lookback` bars (used for the protective stop reference).
func scalpSwing(highs, lows []float64, lookback int) (low, high float64) {
	n := len(lows)
	start := n - lookback
	if start < 0 {
		start = 0
	}
	low = lows[start]
	high = highs[start]
	for i := start; i < n; i++ {
		if lows[i] < low {
			low = lows[i]
		}
		if highs[i] > high {
			high = highs[i]
		}
	}
	return low, high
}

// scalpConfidence scores the setup higher when the EMAs are well separated and
// correctly stacked for the trend direction.
func scalpConfidence(spot, ema50, ema200 float64, long bool) int {
	sep := math.Abs(ema50-ema200) / math.Max(spot, 1) * 100 // % separation
	conf := 60.0 + math.Min(sep*8, 20)
	if long && ema50 > ema200 {
		conf += 5
	}
	if !long && ema50 < ema200 {
		conf += 5
	}
	if conf > 90 {
		conf = 90
	}
	if conf < 55 {
		conf = 55
	}
	return int(conf)
}
