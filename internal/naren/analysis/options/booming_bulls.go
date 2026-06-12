package options

import (
	"fmt"
	"math"

	"stockwise/internal/naren/kite"
)

// SignalBoomingBulls implements Anish Singh Thakur's Booming Bulls framework:
//
//   1. Top-Down Analysis  : Aggregate 15m → 1H candles to determine higher-TF trend
//   2. Supply & Demand    : Detect unmitigated S&D zones on the 1H timeframe
//   3. Candlestick Confirm: Hammer / Bullish Engulfing at demand, Shooting Star /
//                           Bearish Engulfing at supply — no blind zone entries
//   4. Alignment Check   : Only trade in the direction of the 1H trend
//   5. No indicators      : Pure price-action — no moving averages, RSI, etc.
//
// References:
//   Booming Bulls Academy (Anish Singh Thakur) — price action + S&D methodology
//   Sam Seiden (founder of the S&D concept as taught in ICT/professional circles)
func SignalBoomingBulls(candles []kite.Candle) BookSignal {
	n := len(candles)
	if n < 30 {
		return noSignal
	}

	today := candles[n-1].Time.YearDay()
	year  := candles[n-1].Time.Year()
	cur   := candles[n-1]
	prev  := candles[n-2]

	// Only look for entries during active trading hours (not first 15 min, not after 2:30)
	h, m := cur.Time.Hour(), cur.Time.Minute()
	if h == 9 && m == 15 { return noSignal }       // skip first candle (zone forming)
	if h > 14 || (h == 14 && m >= 30) { return noSignal } // no late entries

	// ── Step 1: Build 1H candles from 15m ────────────────────────────────────
	candles1H := aggregate15mTo1H(candles)
	if len(candles1H) < 8 {
		return noSignal
	}

	// ── Step 2: Determine higher-TF trend from 1H ────────────────────────────
	trend := higherTFTrend(candles1H)
	if trend == "NEUTRAL" {
		return noSignal // Booming Bulls: never trade in a choppy market
	}

	// ── Step 3: Find unmitigated S&D zones on 1H ─────────────────────────────
	demandZones := detectDemandZones(candles1H)
	supplyZones := detectSupplyZones(candles1H)

	spot := cur.Close

	// ── Step 4: Check if current 15m price is at a zone that aligns with trend ─
	if trend == "BULLISH" {
		// Look for demand zone entry (buy CE)
		for _, zone := range demandZones {
			if !zone.unmitigated { continue }
			if spot >= zone.low && spot <= zone.high*1.002 { // price inside demand zone
				// Candlestick confirmation required
				pattern := bullishConfirmation(prev, cur)
				if pattern == "" { return noSignal }

				// Today's candle must not have previously left the zone (fresh touch)
				if cur.Time.YearDay() != today || cur.Time.Year() != year { continue }

				zoneSize := zone.high - zone.low
				conf := clampConf(60 + int(zoneSize/spot*500))
				return BookSignal{
					Strategy:   "BOOMING_BULLS",
					Direction:  "BULLISH",
					OptionSide: "CE",
					Confidence: conf,
					Reason: fmt.Sprintf(
						"Demand zone %.0f–%.0f | %s confirmation | 1H trend BULLISH (Booming Bulls)",
						zone.low, zone.high, pattern,
					),
				}
			}
		}
	}

	if trend == "BEARISH" {
		// Look for supply zone entry (buy PE)
		for _, zone := range supplyZones {
			if !zone.unmitigated { continue }
			if spot <= zone.high && spot >= zone.low*0.998 { // price inside supply zone
				pattern := bearishConfirmation(prev, cur)
				if pattern == "" { return noSignal }

				if cur.Time.YearDay() != today || cur.Time.Year() != year { continue }

				zoneSize := zone.high - zone.low
				conf := clampConf(60 + int(zoneSize/spot*500))
				return BookSignal{
					Strategy:   "BOOMING_BULLS",
					Direction:  "BEARISH",
					OptionSide: "PE",
					Confidence: conf,
					Reason: fmt.Sprintf(
						"Supply zone %.0f–%.0f | %s confirmation | 1H trend BEARISH (Booming Bulls)",
						zone.low, zone.high, pattern,
					),
				}
			}
		}
	}

	return noSignal
}

// ─── Zone detection ───────────────────────────────────────────────────────────

type sdZone struct {
	low        float64
	high       float64
	unmitigated bool // false once price has entered and left the zone
}

// detectDemandZones finds demand zones on 1H candles using the Booming Bulls
// definition: a "base" (1–4 small-bodied candles) followed by an explosive
// bullish candle. The base itself forms the demand zone boundary.
func detectDemandZones(candles []kite.Candle) []sdZone {
	var zones []sdZone
	n := len(candles)
	if n < 4 { return zones }

	avgBody := avgBodySize(candles)
	currentPrice := candles[n-1].Close

	for i := 2; i < n-1; i++ {
		// Explosive bullish move: body > 2× average
		c := candles[i]
		body := c.Close - c.Open
		if body < avgBody*2.0 || body <= 0 { continue }

		// Base: 1-3 candles before the explosive move with small bodies
		baseStart := i - 1
		for j := i - 1; j >= max(0, i-3); j-- {
			bc := candles[j]
			bBody := math.Abs(bc.Close - bc.Open)
			if bBody < avgBody*0.7 { baseStart = j } else { break }
		}

		// Zone boundaries = range of the base candles
		zLow, zHigh := 1e9, 0.0
		for j := baseStart; j < i; j++ {
			bc := candles[j]
			if bc.Low < zLow   { zLow  = bc.Low  }
			if bc.High > zHigh { zHigh = bc.High }
		}
		if zHigh <= zLow { continue }

		// Check mitigation: zone is mitigated if price re-entered and closed inside
		unmitigated := true
		for j := i + 1; j < n; j++ {
			if candles[j].Low <= zHigh && candles[j].Close < zHigh {
				unmitigated = false; break
			}
		}

		// Only keep zones above current price (demand zones should be below price for it to return)
		if zHigh < currentPrice {
			zones = append(zones, sdZone{low: zLow, high: zHigh, unmitigated: unmitigated})
		}
	}

	// Return closest zones first
	sortZonesByProximity(zones, currentPrice)
	if len(zones) > 5 { zones = zones[:5] }
	return zones
}

// detectSupplyZones finds supply zones: base + explosive bearish move.
func detectSupplyZones(candles []kite.Candle) []sdZone {
	var zones []sdZone
	n := len(candles)
	if n < 4 { return zones }

	avgBody := avgBodySize(candles)
	currentPrice := candles[n-1].Close

	for i := 2; i < n-1; i++ {
		c := candles[i]
		body := c.Open - c.Close // bearish move
		if body < avgBody*2.0 || body <= 0 { continue }

		baseStart := i - 1
		for j := i - 1; j >= max(0, i-3); j-- {
			bc := candles[j]
			bBody := math.Abs(bc.Close - bc.Open)
			if bBody < avgBody*0.7 { baseStart = j } else { break }
		}

		zLow, zHigh := 1e9, 0.0
		for j := baseStart; j < i; j++ {
			bc := candles[j]
			if bc.Low < zLow   { zLow  = bc.Low  }
			if bc.High > zHigh { zHigh = bc.High }
		}
		if zHigh <= zLow { continue }

		unmitigated := true
		for j := i + 1; j < n; j++ {
			if candles[j].High >= zLow && candles[j].Close > zLow {
				unmitigated = false; break
			}
		}

		if zLow > currentPrice { // supply zones should be above current price
			zones = append(zones, sdZone{low: zLow, high: zHigh, unmitigated: unmitigated})
		}
	}

	sortZonesByProximity(zones, currentPrice)
	if len(zones) > 5 { zones = zones[:5] }
	return zones
}

// ─── Higher TF aggregation ────────────────────────────────────────────────────

// aggregate15mTo1H aggregates 15-minute candles into 1-hour candles.
func aggregate15mTo1H(candles []kite.Candle) []kite.Candle {
	if len(candles) == 0 { return nil }
	var out []kite.Candle
	var groupOpen, groupHigh, groupLow, groupClose float64
	var groupVol int64
	count := 0

	for _, c := range candles {
		// Start new 1H group on the hour mark (9:15, 10:15, 11:15, ...)
		isHourStart := c.Time.Minute() == 15 || (count == 0)

		if isHourStart && count > 0 {
			startIdx := (len(out)) * 4
			if startIdx >= 0 && startIdx < len(candles) {
				out = append(out, kite.Candle{
					Time: candles[startIdx].Time,
					Open: groupOpen, High: groupHigh, Low: groupLow,
					Close: groupClose, Volume: groupVol,
				})
			}
			count = 0
			groupVol = 0
		}

		if count == 0 {
			groupOpen  = c.Open
			groupHigh  = c.High
			groupLow   = c.Low
		} else {
			if c.High > groupHigh { groupHigh = c.High }
			if c.Low  < groupLow  { groupLow  = c.Low  }
		}
		groupClose = c.Close
		groupVol  += c.Volume
		count++
	}
	return out
}

// higherTFTrend returns the trend based on 1H candles:
// Bullish: recent 1H candles making higher highs + price above midpoint
// Bearish: lower highs + price below midpoint
// Neutral: mixed
func higherTFTrend(candles1H []kite.Candle) string {
	n := len(candles1H)
	if n < 6 { return "NEUTRAL" }

	// Compare last 3 highs and lows (swing structure)
	// Higher highs + higher lows = uptrend (Booming Bulls: structure is key)
	recentHigh1 := math.Max(candles1H[n-1].High, candles1H[n-2].High)
	recentHigh2 := math.Max(candles1H[n-3].High, candles1H[n-4].High)
	recentLow1  := math.Min(candles1H[n-1].Low,  candles1H[n-2].Low)
	recentLow2  := math.Min(candles1H[n-3].Low,  candles1H[n-4].Low)

	bullishStructure := recentHigh1 > recentHigh2 && recentLow1 > recentLow2
	bearishStructure := recentHigh1 < recentHigh2 && recentLow1 < recentLow2

	// Also check price vs midpoint of recent range
	rangeHigh := math.Max(candles1H[n-1].High, candles1H[n-6].High)
	rangeLow  := math.Min(candles1H[n-1].Low,  candles1H[n-6].Low)
	mid       := (rangeHigh + rangeLow) / 2
	spot      := candles1H[n-1].Close

	switch {
	case bullishStructure && spot > mid:
		return "BULLISH"
	case bearishStructure && spot < mid:
		return "BEARISH"
	default:
		return "NEUTRAL"
	}
}

// ─── Candlestick confirmation ─────────────────────────────────────────────────

// bullishConfirmation returns the pattern name if the current bar shows
// a bullish reversal signal (Booming Bulls requires confirmation at zones).
func bullishConfirmation(prev, cur kite.Candle) string {
	curBody  := cur.Close - cur.Open
	curRange := cur.High - cur.Low
	if curRange == 0 { return "" }

	lowerWick := cur.Open - cur.Low
	upperWick := cur.High - math.Max(cur.Close, cur.Open)
	prevBody  := prev.Open - prev.Close // previous bearish body size

	// Hammer: small body in upper 1/3, lower wick ≥ 2× body
	if curBody > 0 && lowerWick >= math.Abs(curBody)*2.0 && upperWick < math.Abs(curBody)*0.3 {
		return "Hammer"
	}

	// Bullish Engulfing: current bullish body > previous bearish body
	if curBody > 0 && prevBody > 0 && curBody > prevBody*0.9 &&
		cur.Open <= prev.Close && cur.Close >= prev.Open {
		return "Bullish Engulfing"
	}

	// Pin Bar / Dragonfly Doji: very small body, long lower wick
	if math.Abs(curBody) < curRange*0.15 && lowerWick >= curRange*0.6 {
		return "Pin Bar"
	}

	return ""
}

// bearishConfirmation checks for bearish reversal patterns at supply zones.
func bearishConfirmation(prev, cur kite.Candle) string {
	curBody  := cur.Open - cur.Close // bearish body (positive if bearish)
	curRange := cur.High - cur.Low
	if curRange == 0 { return "" }

	upperWick := cur.High - math.Max(cur.Close, cur.Open)
	lowerWick := math.Min(cur.Close, cur.Open) - cur.Low

	// Shooting Star: small body in lower 1/3, upper wick ≥ 2× body
	if curBody > 0 && upperWick >= math.Abs(curBody)*2.0 && lowerWick < math.Abs(curBody)*0.3 {
		return "Shooting Star"
	}

	// Bearish Engulfing: current bearish body > previous bullish body
	prevBullish := prev.Close - prev.Open
	if curBody > 0 && prevBullish > 0 && curBody > prevBullish*0.9 &&
		cur.Open >= prev.Close && cur.Close <= prev.Open {
		return "Bearish Engulfing"
	}

	// Inverted Hammer / Gravestone Doji: upper wick ≥ 60% of range
	if math.Abs(curBody) < curRange*0.15 && upperWick >= curRange*0.6 {
		return "Inverted Pin Bar"
	}

	return ""
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func avgBodySize(candles []kite.Candle) float64 {
	if len(candles) == 0 { return 50 }
	n   := min(20, len(candles))
	sum := 0.0
	for i := len(candles) - n; i < len(candles); i++ {
		sum += math.Abs(candles[i].Close - candles[i].Open)
	}
	if sum == 0 { return 20 }
	return sum / float64(n)
}

func sortZonesByProximity(zones []sdZone, price float64) {
	for i := 0; i < len(zones)-1; i++ {
		for j := i + 1; j < len(zones); j++ {
			di := math.Abs((zones[i].high+zones[i].low)/2 - price)
			dj := math.Abs((zones[j].high+zones[j].low)/2 - price)
			if dj < di { zones[i], zones[j] = zones[j], zones[i] }
		}
	}
}

func max(a, b int) int { if a > b { return a }; return b }
func min(a, b int) int { if a < b { return a }; return b }
