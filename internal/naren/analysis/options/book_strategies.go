// Package options — book-based strategy signal generators.
//
// Each strategy is taken from a published trading book and adapted to
// NIFTY 15-minute index options. All strategies use the same signal interface
// so they can be run in a fair comparison backtest on identical data.
package options

import (
	"fmt"
	"math"

	"stockwise/internal/naren/kite"
)

// ─── Signal type ──────────────────────────────────────────────────────────────

// BookSignal is the output of one strategy on one bar.
type BookSignal struct {
	Strategy   string  // strategy key
	Direction  string  // BULLISH | BEARISH | NEUTRAL | NONE
	OptionSide string  // CE | PE | STRADDLE_SELL | NONE
	Confidence int     // 0–100
	Reason     string  // one-line human explanation
}

var noSignal = BookSignal{Strategy: "", Direction: "NONE", OptionSide: "NONE"}

// ─── 1. ORB — Toby Crabel ─────────────────────────────────────────────────────
// Source: "Day Trading with Short Term Price Patterns and Opening Range Breakout"
// Logic: The first 15-min bar establishes the OR. A breakout above OR-High or
//        below OR-Low on the second bar triggers a directional entry.
//        Crabel's key insight: the breakout bar must close outside the range
//        (not just touch) to confirm intent.

func SignalORB(candles []kite.Candle) BookSignal {
	n := len(candles)
	if n < 3 {
		return noSignal
	}
	today := candles[n-1].Time.YearDay()
	year  := candles[n-1].Time.Year()

	// Find today's first candle (9:15 bar = opening range)
	var orHigh, orLow float64
	var orSet bool
	for _, c := range candles {
		if c.Time.YearDay() == today && c.Time.Year() == year {
			orHigh = c.High
			orLow  = c.Low
			orSet  = true
			break
		}
	}
	if !orSet { return noSignal }

	cur  := candles[n-1]
	prev := candles[n-2]
	if cur.Time.YearDay() != today { return noSignal }

	// Only signal during the morning session (up to 11:00)
	h, m := cur.Time.Hour(), cur.Time.Minute()
	if h > 11 || (h == 11 && m > 0) { return noSignal }

	// Crabel: close of current bar must be outside the range
	// AND previous bar must have tested the range (been inside or at the boundary)
	if cur.Close > orHigh && prev.Close <= orHigh {
		conf := clampConf(50 + int((cur.Close-orHigh)/orHigh*1000))
		return BookSignal{
			Strategy:   "ORB",
			Direction:  "BULLISH",
			OptionSide: "CE",
			Confidence: conf,
			Reason:     fmt.Sprintf("ORB breakout: close %.0f > OR-High %.0f (Crabel)", cur.Close, orHigh),
		}
	}
	if cur.Close < orLow && prev.Close >= orLow {
		conf := clampConf(50 + int((orLow-cur.Close)/orLow*1000))
		return BookSignal{
			Strategy:   "ORB",
			Direction:  "BEARISH",
			OptionSide: "PE",
			Confidence: conf,
			Reason:     fmt.Sprintf("ORB breakdown: close %.0f < OR-Low %.0f (Crabel)", cur.Close, orLow),
		}
	}
	return noSignal
}

// ─── 2. EMA Crossover — Stan Weinstein ────────────────────────────────────────
// Source: "Secrets for Profiting in Bull and Bear Markets"
// Logic: Weinstein's Stage Analysis. Stage 2 uptrend = price above rising 30-week MA.
//        Adapted to intraday: EMA9 cross above EMA21 + price above both + increasing slope.
//        Sell short (buy PE) when EMA9 crosses below EMA21 with price below both.

func SignalEMACrossover(candles []kite.Candle) BookSignal {
	n := len(candles)
	if n < 25 { return noSignal }

	closes := make([]float64, n)
	for i, c := range candles { closes[i] = c.Close }

	ema9cur   := ema(closes, 9)
	ema21cur  := ema(closes, 21)
	ema9prev  := ema(closes[:n-1], 9)
	ema21prev := ema(closes[:n-1], 21)
	spot      := closes[n-1]

	// Weinstein: confirm with slope (the MA must be rising/falling)
	ema9slope  := ema9cur - ema9prev
	ema21slope := ema21cur - ema21prev

	// Golden cross: EMA9 just crossed above EMA21 (wasn't above in previous bar)
	goldenCross := ema9prev <= ema21prev && ema9cur > ema21cur
	deathCross  := ema9prev >= ema21prev && ema9cur < ema21cur

	if goldenCross && spot > ema9cur && ema21slope > 0 {
		sep := math.Abs(ema9cur-ema21cur) / ema21cur * 100
		conf := clampConf(55 + int(sep*500) + int(ema9slope/closes[n-1]*10000))
		return BookSignal{
			Strategy:   "EMA_CROSS",
			Direction:  "BULLISH",
			OptionSide: "CE",
			Confidence: conf,
			Reason:     fmt.Sprintf("EMA9 %.0f crossed above EMA21 %.0f, Stage 2 uptrend (Weinstein)", ema9cur, ema21cur),
		}
	}
	if deathCross && spot < ema9cur && ema21slope < 0 {
		sep := math.Abs(ema9cur-ema21cur) / ema21cur * 100
		conf := clampConf(55 + int(sep*500) + int(-ema9slope/closes[n-1]*10000))
		return BookSignal{
			Strategy:   "EMA_CROSS",
			Direction:  "BEARISH",
			OptionSide: "PE",
			Confidence: conf,
			Reason:     fmt.Sprintf("EMA9 %.0f crossed below EMA21 %.0f, Stage 4 downtrend (Weinstein)", ema9cur, ema21cur),
		}
	}
	return noSignal
}

// ─── 3. VWAP Reversion — Brian Shannon ────────────────────────────────────────
// Source: "Technical Analysis Using Multiple Timeframes"
// Logic: Shannon's key concept: price is bullish above VWAP, bearish below.
//        A "first pullback to VWAP" after a breakout is the optimal entry.
//        Entry: price pulls to VWAP (within 0.1%) with a bounce candle.

func SignalVWAP(candles []kite.Candle) BookSignal {
	n := len(candles)
	if n < 10 { return noSignal }

	today := candles[n-1].Time.YearDay()
	year  := candles[n-1].Time.Year()

	// Calculate intraday VWAP (typical price sum / count)
	var tpSum float64
	var tpCount int
	for _, c := range candles {
		if c.Time.YearDay() == today && c.Time.Year() == year {
			tpSum += (c.High + c.Low + c.Close) / 3
			tpCount++
		}
	}
	if tpCount < 3 { return noSignal }
	vwap := tpSum / float64(tpCount)

	cur  := candles[n-1]
	prev := candles[n-2]
	spot := cur.Close

	// Determine trend from first 30 min of session
	var sessionOpen float64
	for _, c := range candles {
		if c.Time.YearDay() == today && c.Time.Year() == year {
			sessionOpen = c.Open
			break
		}
	}
	uptrend   := sessionOpen > 0 && spot > vwap && sessionOpen < vwap*1.002
	downtrend := sessionOpen > 0 && spot < vwap && sessionOpen > vwap*0.998

	vwapTolerance := vwap * 0.0015 // 0.15%

	// First pullback to VWAP in uptrend (prev bar touched VWAP, current bounces)
	prevTouchedVWAP := math.Abs(prev.Low-vwap) < vwapTolerance || (prev.Low <= vwap && prev.Close > vwap)
	if uptrend && prevTouchedVWAP && cur.Close > vwap && cur.Close > prev.Close {
		conf := clampConf(58 + int(math.Abs(spot-vwap)/vwap*500))
		return BookSignal{
			Strategy:   "VWAP",
			Direction:  "BULLISH",
			OptionSide: "CE",
			Confidence: conf,
			Reason:     fmt.Sprintf("First pullback to VWAP %.0f in uptrend, bounce confirmed (Shannon)", vwap),
		}
	}
	// First bounce to VWAP in downtrend (prev bar touched VWAP, current rejects)
	prevTouchedVWAPDown := math.Abs(prev.High-vwap) < vwapTolerance || (prev.High >= vwap && prev.Close < vwap)
	if downtrend && prevTouchedVWAPDown && cur.Close < vwap && cur.Close < prev.Close {
		conf := clampConf(58 + int(math.Abs(spot-vwap)/vwap*500))
		return BookSignal{
			Strategy:   "VWAP",
			Direction:  "BEARISH",
			OptionSide: "PE",
			Confidence: conf,
			Reason:     fmt.Sprintf("First bounce to VWAP %.0f in downtrend, rejection confirmed (Shannon)", vwap),
		}
	}
	return noSignal
}

// ─── 4. Short Straddle (Theta Decay) — Lawrence McMillan ─────────────────────
// Source: "Options as a Strategic Investment" (5th ed.)
// Logic: Sell ATM straddle when the market is range-bound (low ATR vs historical ATR).
//        McMillan's rule: only sell straddles when current ATR < 80% of 20-bar avg ATR.
//        This captures theta when realized vol is lower than implied vol.

func SignalShortStraddle(candles []kite.Candle) BookSignal {
	n := len(candles)
	if n < 25 { return noSignal }

	today := candles[n-1].Time.YearDay()
	year  := candles[n-1].Time.Year()

	// Only enter in first 30 min (9:15–9:30) for McMillan straddle
	cur := candles[n-1]
	h, m := cur.Time.Hour(), cur.Time.Minute()
	if !(h == 9 && m <= 30) && !(h == 9 && m == 15) { return noSignal }
	if cur.Time.YearDay() != today || cur.Time.Year() != year { return noSignal }

	// Calculate current ATR vs 20-bar average ATR
	curATR := recentATR14(candles, n-1)
	// Historical ATR (bars 5–25)
	var atrSum float64
	var atrCount int
	for i := n - 25; i < n-5; i++ {
		if i > 0 {
			atrSum += recentATR14(candles, i)
			atrCount++
		}
	}
	if atrCount == 0 { return noSignal }
	avgATR := atrSum / float64(atrCount)

	// McMillan: sell straddle only when market is calm (current ATR < 80% of avg)
	calm := curATR < avgATR*0.80
	if !calm { return noSignal }

	conf := clampConf(60 + int((1.0-curATR/avgATR)*80))
	return BookSignal{
		Strategy:   "SHORT_STRADDLE",
		Direction:  "NEUTRAL",
		OptionSide: "STRADDLE_SELL",
		Confidence: conf,
		Reason:     fmt.Sprintf("ATR %.0f < 80%% of avg %.0f — sell straddle for theta (McMillan)", curATR, avgATR),
	}
}

// ─── 5. ATR Momentum Breakout — Van K. Tharp ─────────────────────────────────
// Source: "Trade Your Way to Financial Freedom"
// Tharp's "Expectancy R-Multiple" system. Entries based on ATR bands:
// when price breaks above VWAP + 1.5×ATR or below VWAP - 1.5×ATR,
// a genuine momentum move is underway. Use 2×ATR as stop, 3×ATR as target.

func SignalATRMomentum(candles []kite.Candle) BookSignal {
	n := len(candles)
	if n < 20 { return noSignal }

	today := candles[n-1].Time.YearDay()
	year  := candles[n-1].Time.Year()
	cur   := candles[n-1]
	if cur.Time.YearDay() != today || cur.Time.Year() != year { return noSignal }

	// Skip first 30 min (let opening volatility settle)
	h := cur.Time.Hour()
	if h == 9 && cur.Time.Minute() < 30 { return noSignal }
	// No new entries after 2 PM
	if h >= 14 { return noSignal }

	atr  := recentATR14(candles, n-1)
	vwap := vwapProxyToday(candles)
	spot := cur.Close

	upperBand := vwap + 1.5*atr
	lowerBand := vwap - 1.5*atr

	prev := candles[n-2]

	// Breakout above upper band (Tharp: price "escaping" from the range)
	if prev.Close <= upperBand && spot > upperBand {
		conf := clampConf(55 + int((spot-upperBand)/atr*30))
		return BookSignal{
			Strategy:   "ATR_MOMENTUM",
			Direction:  "BULLISH",
			OptionSide: "CE",
			Confidence: conf,
			Reason:     fmt.Sprintf("Breakout above VWAP+1.5ATR band (%.0f), R=%.0f (Van Tharp)", upperBand, atr),
		}
	}
	// Breakdown below lower band
	if prev.Close >= lowerBand && spot < lowerBand {
		conf := clampConf(55 + int((lowerBand-spot)/atr*30))
		return BookSignal{
			Strategy:   "ATR_MOMENTUM",
			Direction:  "BEARISH",
			OptionSide: "PE",
			Confidence: conf,
			Reason:     fmt.Sprintf("Breakdown below VWAP-1.5ATR band (%.0f), R=%.0f (Van Tharp)", lowerBand, atr),
		}
	}
	return noSignal
}

// ─── 6. SuperTrend — Olivier Seban ───────────────────────────────────────────
// Source: "Devenez riche" (Seban) + popularised in "How to Day Trade for a Living"
// SuperTrend uses ATR(10) × multiplier(3) as a dynamic trailing stop.
// Signal fires on the first bar after a SuperTrend direction flip.

func SignalSuperTrend(candles []kite.Candle) BookSignal {
	n := len(candles)
	if n < 15 { return noSignal }

	today := candles[n-1].Time.YearDay()
	year  := candles[n-1].Time.Year()
	cur   := candles[n-1]
	if cur.Time.YearDay() != today || cur.Time.Year() != year { return noSignal }
	// No new entries after 2:30 PM
	if cur.Time.Hour() >= 14 && cur.Time.Minute() >= 30 { return noSignal }

	const period = 10
	const multiplier = 3.0

	// Compute SuperTrend for the last 12 bars
	type stBar struct {
		close  float64
		upper  float64
		lower  float64
		upTrend bool
	}
	bars := make([]stBar, n)
	prevUpper, prevLower := 0.0, 0.0
	prevUpTrend := true

	for i := period; i < n; i++ {
		atrI := recentATR14(candles, i)
		hl2  := (candles[i].High + candles[i].Low) / 2
		rawUpper := hl2 + multiplier*atrI
		rawLower := hl2 - multiplier*atrI

		upperI := rawUpper
		lowerI := rawLower
		if i > period {
			if rawUpper < prevUpper || candles[i-1].Close > prevUpper { upperI = rawUpper } else { upperI = prevUpper }
			if rawLower > prevLower || candles[i-1].Close < prevLower { lowerI = rawLower } else { lowerI = prevLower }
		}

		upTrend := true
		if i > period {
			if prevUpTrend {
				upTrend = candles[i].Close >= lowerI
			} else {
				upTrend = candles[i].Close > upperI
			}
		}
		bars[i] = stBar{close: candles[i].Close, upper: upperI, lower: lowerI, upTrend: upTrend}
		prevUpper, prevLower, prevUpTrend = upperI, lowerI, upTrend
	}

	if n < period+2 { return noSignal }
	curST  := bars[n-1]
	prevST := bars[n-2]

	// Signal on direction flip only
	if !prevST.upTrend && curST.upTrend {
		conf := clampConf(60 + int((cur.Close-curST.lower)/cur.Close*1000))
		return BookSignal{
			Strategy:   "SUPERTREND",
			Direction:  "BULLISH",
			OptionSide: "CE",
			Confidence: conf,
			Reason:     fmt.Sprintf("SuperTrend flipped bullish at %.0f (Seban ATR×3 method)", curST.lower),
		}
	}
	if prevST.upTrend && !curST.upTrend {
		conf := clampConf(60 + int((curST.upper-cur.Close)/cur.Close*1000))
		return BookSignal{
			Strategy:   "SUPERTREND",
			Direction:  "BEARISH",
			OptionSide: "PE",
			Confidence: conf,
			Reason:     fmt.Sprintf("SuperTrend flipped bearish at %.0f (Seban ATR×3 method)", curST.upper),
		}
	}
	return noSignal
}

// ─── AllBookStrategies runs all 6 and returns whichever fires ─────────────────

// AllSignals runs all book strategies on a candle slice and returns every
// signal that fires on the latest bar (multiple strategies can fire together).
func AllSignals(candles []kite.Candle) []BookSignal {
	fns := []func([]kite.Candle) BookSignal{
		SignalORB,
		SignalEMACrossover,
		SignalVWAP,
		SignalShortStraddle,
		SignalATRMomentum,
		SignalSuperTrend,
		SignalBoomingBulls,
	}
	var out []BookSignal
	for _, fn := range fns {
		if s := fn(candles); s.Direction != "NONE" {
			out = append(out, s)
		}
	}
	return out
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

func recentATR14(candles []kite.Candle, idx int) float64 {
	period := 14
	start  := idx - period
	if start < 1 { start = 1 }
	var sum float64; var n int
	for i := start; i <= idx; i++ {
		h, l, pc := candles[i].High, candles[i].Low, candles[i-1].Close
		tr := math.Max(h-l, math.Max(math.Abs(h-pc), math.Abs(l-pc)))
		sum += tr; n++
	}
	if n == 0 { return 50 }
	return sum / float64(n)
}

func vwapProxyToday(candles []kite.Candle) float64 {
	if len(candles) == 0 { return 0 }
	today := candles[len(candles)-1].Time.YearDay()
	year  := candles[len(candles)-1].Time.Year()
	var s float64; var n int
	for _, c := range candles {
		if c.Time.YearDay() == today && c.Time.Year() == year {
			s += (c.High + c.Low + c.Close) / 3; n++
		}
	}
	if n == 0 { return candles[len(candles)-1].Close }
	return s / float64(n)
}

func clampConf(v int) int {
	if v < 30 { return 30 }
	if v > 95 { return 95 }
	return v
}
