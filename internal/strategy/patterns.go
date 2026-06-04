package strategy

import (
	"math"

	"stockwise/internal/data"
)

// PatternKey identifies a candlestick pattern. These keys are stable and used
// by the frontend pattern picker to toggle which markers are drawn.
type PatternKey string

const (
	PatternDoji            PatternKey = "doji"
	PatternHammer          PatternKey = "hammer"
	PatternInvertedHammer  PatternKey = "inverted_hammer"
	PatternShootingStar    PatternKey = "shooting_star"
	PatternBullishEngulf   PatternKey = "bullish_engulfing"
	PatternBearishEngulf   PatternKey = "bearish_engulfing"
	PatternBullishHarami   PatternKey = "bullish_harami"
	PatternBearishHarami   PatternKey = "bearish_harami"
	PatternMorningStar     PatternKey = "morning_star"
	PatternEveningStar     PatternKey = "evening_star"
	PatternPiercingLine    PatternKey = "piercing_line"
	PatternDarkCloudCover  PatternKey = "dark_cloud_cover"
	PatternThreeWhite      PatternKey = "three_white_soldiers"
	PatternThreeBlack      PatternKey = "three_black_crows"
	PatternBullishMarubozu PatternKey = "bullish_marubozu"
	PatternBearishMarubozu PatternKey = "bearish_marubozu"
)

// PatternMeta describes a pattern for the frontend picker.
type PatternMeta struct {
	Key       PatternKey `json:"key"`
	Name      string     `json:"name"`
	Direction string     `json:"direction"` // bullish / bearish / neutral
}

// AvailablePatterns returns the catalog of detectable patterns for the UI.
func AvailablePatterns() []PatternMeta {
	return []PatternMeta{
		{PatternDoji, "Doji", "neutral"},
		{PatternHammer, "Hammer", "bullish"},
		{PatternInvertedHammer, "Inverted Hammer", "bullish"},
		{PatternShootingStar, "Shooting Star", "bearish"},
		{PatternBullishEngulf, "Bullish Engulfing", "bullish"},
		{PatternBearishEngulf, "Bearish Engulfing", "bearish"},
		{PatternBullishHarami, "Bullish Harami", "bullish"},
		{PatternBearishHarami, "Bearish Harami", "bearish"},
		{PatternMorningStar, "Morning Star", "bullish"},
		{PatternEveningStar, "Evening Star", "bearish"},
		{PatternPiercingLine, "Piercing Line", "bullish"},
		{PatternDarkCloudCover, "Dark Cloud Cover", "bearish"},
		{PatternThreeWhite, "Three White Soldiers", "bullish"},
		{PatternThreeBlack, "Three Black Crows", "bearish"},
		{PatternBullishMarubozu, "Bullish Marubozu", "bullish"},
		{PatternBearishMarubozu, "Bearish Marubozu", "bearish"},
	}
}

// PatternHit is one detected pattern anchored to a candle.
type PatternHit struct {
	Key       PatternKey `json:"key"`
	Name      string     `json:"name"`
	Direction string     `json:"direction"` // bullish / bearish / neutral
	Index     int        `json:"index"`     // candle index within the supplied slice
	Time      int64      `json:"time"`      // unix seconds of the anchoring candle's Start
	Price     float64    `json:"price"`     // anchor price (high for bearish, low for bullish)
}

// ─── candle geometry helpers ──────────────────────────────────────────────────────

func body(c data.Candle) float64    { return math.Abs(c.Close - c.Open) }
func candleRange(c data.Candle) float64 { return c.High - c.Low }
func upperWick(c data.Candle) float64   { return c.High - math.Max(c.Open, c.Close) }
func lowerWick(c data.Candle) float64   { return math.Min(c.Open, c.Close) - c.Low }
func bullish(c data.Candle) bool        { return c.Close > c.Open }
func bearish(c data.Candle) bool        { return c.Close < c.Open }
func midpoint(c data.Candle) float64    { return (c.Open + c.Close) / 2 }

// ─── single / multi-candle detectors ────────────────────────────────────────────

func isDoji(c data.Candle) bool {
	rng := candleRange(c)
	return rng > 0 && body(c) <= 0.1*rng
}

func isHammer(c data.Candle) bool {
	rng := candleRange(c)
	if rng == 0 {
		return false
	}
	return lowerWick(c) >= 2*body(c) && upperWick(c) <= body(c) && body(c) > 0
}

func isInvertedHammer(c data.Candle) bool {
	rng := candleRange(c)
	if rng == 0 {
		return false
	}
	return upperWick(c) >= 2*body(c) && lowerWick(c) <= body(c) && body(c) > 0 && bullish(c)
}

func isShootingStar(c data.Candle) bool {
	rng := candleRange(c)
	if rng == 0 {
		return false
	}
	return upperWick(c) >= 2*body(c) && lowerWick(c) <= body(c) && body(c) > 0 && bearish(c)
}

func isBullishMarubozu(c data.Candle) bool {
	rng := candleRange(c)
	return rng > 0 && bullish(c) && body(c) >= 0.9*rng
}

func isBearishMarubozu(c data.Candle) bool {
	rng := candleRange(c)
	return rng > 0 && bearish(c) && body(c) >= 0.9*rng
}

func engulfsBullish(prev, cur data.Candle) bool {
	return bearish(prev) && bullish(cur) &&
		cur.Close >= prev.Open && cur.Open <= prev.Close && body(cur) > body(prev)
}

func engulfsBearish(prev, cur data.Candle) bool {
	return bullish(prev) && bearish(cur) &&
		cur.Open >= prev.Close && cur.Close <= prev.Open && body(cur) > body(prev)
}

func isBullishHarami(prev, cur data.Candle) bool {
	return bearish(prev) && bullish(cur) &&
		cur.Open > prev.Close && cur.Close < prev.Open && body(cur) < body(prev)
}

func isBearishHarami(prev, cur data.Candle) bool {
	return bullish(prev) && bearish(cur) &&
		cur.Open < prev.Close && cur.Close > prev.Open && body(cur) < body(prev)
}

func isPiercingLine(prev, cur data.Candle) bool {
	return bearish(prev) && bullish(cur) &&
		cur.Open < prev.Low && cur.Close > midpoint(prev) && cur.Close < prev.Open
}

func isDarkCloudCover(prev, cur data.Candle) bool {
	return bullish(prev) && bearish(cur) &&
		cur.Open > prev.High && cur.Close < midpoint(prev) && cur.Close > prev.Open
}

func isMorningStar(a, b, c data.Candle) bool {
	return bearish(a) && body(b) <= 0.5*body(a) && bullish(c) &&
		c.Close > midpoint(a)
}

func isEveningStar(a, b, c data.Candle) bool {
	return bullish(a) && body(b) <= 0.5*body(a) && bearish(c) &&
		c.Close < midpoint(a)
}

func isThreeWhiteSoldiers(a, b, c data.Candle) bool {
	return bullish(a) && bullish(b) && bullish(c) &&
		b.Close > a.Close && c.Close > b.Close &&
		b.Open > a.Open && c.Open > b.Open
}

func isThreeBlackCrows(a, b, c data.Candle) bool {
	return bearish(a) && bearish(b) && bearish(c) &&
		b.Close < a.Close && c.Close < b.Close &&
		b.Open < a.Open && c.Open < b.Open
}

// DetectPatterns scans the candle slice and returns every detected pattern hit,
// anchored to the candle index where the pattern completes.
func DetectPatterns(candles []data.Candle) []PatternHit {
	var hits []PatternHit
	add := func(key PatternKey, name, dir string, i int, price float64) {
		hits = append(hits, PatternHit{
			Key: key, Name: name, Direction: dir,
			Index: i, Time: candles[i].Start.Unix(), Price: price,
		})
	}

	for i := range candles {
		c := candles[i]

		// single-candle
		if isDoji(c) {
			add(PatternDoji, "Doji", "neutral", i, c.High)
		}
		if isHammer(c) {
			add(PatternHammer, "Hammer", "bullish", i, c.Low)
		}
		if isInvertedHammer(c) {
			add(PatternInvertedHammer, "Inverted Hammer", "bullish", i, c.Low)
		}
		if isShootingStar(c) {
			add(PatternShootingStar, "Shooting Star", "bearish", i, c.High)
		}
		if isBullishMarubozu(c) {
			add(PatternBullishMarubozu, "Bullish Marubozu", "bullish", i, c.Low)
		}
		if isBearishMarubozu(c) {
			add(PatternBearishMarubozu, "Bearish Marubozu", "bearish", i, c.High)
		}

		// two-candle
		if i >= 1 {
			prev := candles[i-1]
			if engulfsBullish(prev, c) {
				add(PatternBullishEngulf, "Bullish Engulfing", "bullish", i, c.Low)
			}
			if engulfsBearish(prev, c) {
				add(PatternBearishEngulf, "Bearish Engulfing", "bearish", i, c.High)
			}
			if isBullishHarami(prev, c) {
				add(PatternBullishHarami, "Bullish Harami", "bullish", i, c.Low)
			}
			if isBearishHarami(prev, c) {
				add(PatternBearishHarami, "Bearish Harami", "bearish", i, c.High)
			}
			if isPiercingLine(prev, c) {
				add(PatternPiercingLine, "Piercing Line", "bullish", i, c.Low)
			}
			if isDarkCloudCover(prev, c) {
				add(PatternDarkCloudCover, "Dark Cloud Cover", "bearish", i, c.High)
			}
		}

		// three-candle
		if i >= 2 {
			a, b := candles[i-2], candles[i-1]
			if isMorningStar(a, b, c) {
				add(PatternMorningStar, "Morning Star", "bullish", i, c.Low)
			}
			if isEveningStar(a, b, c) {
				add(PatternEveningStar, "Evening Star", "bearish", i, c.High)
			}
			if isThreeWhiteSoldiers(a, b, c) {
				add(PatternThreeWhite, "Three White Soldiers", "bullish", i, c.Low)
			}
			if isThreeBlackCrows(a, b, c) {
				add(PatternThreeBlack, "Three Black Crows", "bearish", i, c.High)
			}
		}
	}
	return hits
}
