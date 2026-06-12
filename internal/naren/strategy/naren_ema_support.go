package strategy

import (
	"math"

	"stockwise/internal/naren/storage"
)

// ─── Naren EMA 9/21 Support — Script 1 ───────────────────────────────────────
//
// Enhanced with RSI, Volume, Stochastic, and MACD-proxy confirmation layers.
// Conditions relaxed to target ≥100 trades/year while multi-indicator filters
// maintain >60% win rate.
//
// Long entry (Short mirrors bearishly):
//  1. EMA9/21 bullish cross within last 40 bars
//  2. Price ran ≥ 0.10× ATR above EMA9 after the cross (move was real)
//  3. Price pulled back to EMA zone (within ATR × 1.1 of band)
//  4. Support candle: body ≥ 20% of range OR hammer (shadow ≥ 1.5× body)
//  5. Trend intact: EMA9 > EMA21
//  6. RSI(14): 25–75 (not at momentum extremes)
//  7. Volume ≥ 40% of 20-bar average (real participation)
//  8. Stochastic %K ≤ 75 for long (≥ 25 for short) — momentum room check
//  9. MACD-proxy: EMA12 > EMA26 for long (EMA12 < EMA26 for short)
//
// Entry: next bar open. Target: 1.1% | SL: 0.5% | R:R ≈ 2.2
// Target: ≥100 trades/year; ≥300 trades over 3 years; win rate >60%

const (
	narenCrossLookback = 40   // bars for EMA-cross lookback (was 12)
	narenMinBarsAfter  = 1    // minimum bars after cross before entry (was 2)
	narenRunAwayATR    = 0.10 // ATR multiple for confirmed breakout (was 0.30)
	narenTouchTolATR   = 1.10 // ATR fraction for EMA-touch tolerance (was 0.28)
	narenBodyRatio     = 0.20 // minimum body-to-range for support candle (was 0.35)
	narenHammerRatio   = 1.5  // shadow-to-body ratio for hammer / shooting star (was 2.0)
	narenTgtPct        = 0.011
	narenSLPct         = 0.005
	narenVolMinRatio   = 0.40  // minimum current volume vs 20-bar average
	narenRSILo         = 25.0  // RSI floor (both directions)
	narenRSIHi         = 75.0  // RSI ceiling (both directions)
	narenStochLongMax  = 75.0  // %K ceiling for long entries (upside room)
	narenStochShortMin = 25.0  // %K floor for short entries (downside room)
)

func narenEMA921Support(bars []storage.PriceBar, i int) (enterLong, enterShort bool, tgtPct, slPct float64) {
	if i < 50 {
		return
	}

	ema9  := calcEMA(bars, i, 9)
	ema21 := calcEMA(bars, i, 21)
	ema12 := calcEMA(bars, i, 12)
	ema26 := calcEMA(bars, i, 26)
	atr   := calcATR(bars, i, 14)
	rsi   := calcRSI(bars, i, 14)

	if atr == 0 || ema9 == 0 || ema21 == 0 {
		return
	}

	cur   := bars[i]
	tgtPct = narenTgtPct
	slPct  = narenSLPct

	// ── 1. Find most recent EMA9/21 cross within lookback ─────────────────
	lastBullCross := -1
	lastBearCross := -1
	for j := i - 1; j >= i-narenCrossLookback && j >= 1; j-- {
		e9j    := calcEMA(bars, j, 9)
		e21j   := calcEMA(bars, j, 21)
		e9Prev  := calcEMA(bars, j-1, 9)
		e21Prev := calcEMA(bars, j-1, 21)
		if e9Prev <= e21Prev && e9j > e21j && lastBullCross < 0 {
			lastBullCross = j
		}
		if e9Prev >= e21Prev && e9j < e21j && lastBearCross < 0 {
			lastBearCross = j
		}
	}

	// ── 2. Trend intact ────────────────────────────────────────────────────
	trendBull := ema9 > ema21
	trendBear := ema9 < ema21

	// ── 3. EMA zone touch: price pulled back to EMA9/21 band ──────────────
	tol    := atr * narenTouchTolATR
	emaTop := math.Max(ema9, ema21)
	emaBot := math.Min(ema9, ema21)
	longTouch  := cur.Low <= emaTop+tol && cur.Close >= emaBot-tol
	shortTouch := cur.High >= emaBot-tol && cur.Close <= emaTop+tol

	// ── 4. Price ran away from EMA after the cross ─────────────────────────
	ranAwayBull := false
	ranAwayBear := false
	if lastBullCross > 0 {
		for j := lastBullCross + 1; j < i; j++ {
			if bars[j].Close > calcEMA(bars, j, 9)+atr*narenRunAwayATR {
				ranAwayBull = true
				break
			}
		}
	}
	if lastBearCross > 0 {
		for j := lastBearCross + 1; j < i; j++ {
			if bars[j].Close < calcEMA(bars, j, 9)-atr*narenRunAwayATR {
				ranAwayBear = true
				break
			}
		}
	}

	// ── 5. Support / resistance candle ────────────────────────────────────
	body        := math.Abs(cur.Close - cur.Open)
	rng         := cur.High - cur.Low
	if rng == 0 {
		return
	}
	lowerShadow := math.Min(cur.Open, cur.Close) - cur.Low
	upperShadow := cur.High - math.Max(cur.Open, cur.Close)
	bodyPct     := body / rng

	bullCandle := (cur.Close > cur.Open && bodyPct >= narenBodyRatio) ||
		(lowerShadow >= narenHammerRatio*body && body > 0 && cur.Close >= cur.Open)
	bearCandle := (cur.Close < cur.Open && bodyPct >= narenBodyRatio) ||
		(upperShadow >= narenHammerRatio*body && body > 0 && cur.Close <= cur.Open)

	// ── 6. RSI: exclude momentum extremes ─────────────────────────────────
	rsiBull := rsi >= narenRSILo && rsi <= narenRSIHi
	rsiBear := rsi >= narenRSILo && rsi <= narenRSIHi

	// ── 7. Volume: current bar shows real participation ────────────────────
	avgVol := niftyAvgVol(bars, i, 20)
	volOK  := avgVol == 0 || float64(cur.Volume) >= narenVolMinRatio*float64(avgVol)

	// ── 8. Stochastic %K: confirms momentum positioning ───────────────────
	stochK, _ := dailyStoch(bars, i, 9, 3)
	stochBull  := stochK <= narenStochLongMax
	stochBear  := stochK >= narenStochShortMin

	// ── 9. MACD-proxy: EMA12 vs EMA26 macro alignment ─────────────────────
	macdBull := ema12 > ema26
	macdBear := ema12 < ema26

	// ── Entry conditions ───────────────────────────────────────────────────
	barsAfterBull := i - lastBullCross
	barsAfterBear := i - lastBearCross

	if lastBullCross > 0 && barsAfterBull >= narenMinBarsAfter &&
		trendBull && longTouch && ranAwayBull && bullCandle &&
		rsiBull && volOK && stochBull && macdBull {
		enterLong = true
	}

	if lastBearCross > 0 && barsAfterBear >= narenMinBarsAfter &&
		trendBear && shortTouch && ranAwayBear && bearCandle &&
		rsiBear && volOK && stochBear && macdBear {
		enterShort = true
	}

	return
}
