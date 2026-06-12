// Package options analyses NIFTY index candles and recommends an options
// strategy + strike structure. It is pure analysis — it never executes anything.
package options

import (
	"fmt"
	"math"
	"time"

	"stockwise/internal/naren/kite"
)

// ─── Domain types ─────────────────────────────────────────────────────────────

type Regime string

const (
	RegimeTrendUp   Regime = "TRENDING_UP"
	RegimeTrendDown Regime = "TRENDING_DOWN"
	RegimeRange     Regime = "RANGE_BOUND"
	RegimeExpiry    Regime = "EXPIRY_LOW_VOL"
)

type StrategyType string

const (
	StratDirectionalCE StrategyType = "DIRECTIONAL_CE"
	StratDirectionalPE StrategyType = "DIRECTIONAL_PE"
	StratIronCondor    StrategyType = "IRON_CONDOR"
	StratIronFly       StrategyType = "IRON_FLY"
	StratStraddle      StrategyType = "SHORT_STRADDLE"
	StratORBCE         StrategyType = "ORB_CE"
	StratORBPE         StrategyType = "ORB_PE"
	StratNone          StrategyType = "NO_TRADE"
)

// LegSpec describes one option leg relative to the ATM strike.
type LegSpec struct {
	OptionType   string  `json:"option_type"`   // CE | PE
	Side         string  `json:"side"`          // BUY | SELL
	StrikeOffset float64 `json:"strike_offset"` // points from ATM (e.g. 0, +200, -400)
	Label        string  `json:"label"`
}

// Indicators is the indicator snapshot used for the decision.
type Indicators struct {
	Spot          float64 `json:"spot"`
	EMA9          float64 `json:"ema9"`
	EMA21         float64 `json:"ema21"`
	ATR14         float64 `json:"atr14"`
	VWAPProxy     float64 `json:"vwap_proxy"`
	TrendStrength float64 `json:"trend_strength"` // 0-100
	ORHigh        float64 `json:"or_high"`
	ORLow         float64 `json:"or_low"`
	DayChangePct  float64 `json:"day_change_pct"`
}

// Recommendation is the analyzer output.
type Recommendation struct {
	Strategy   StrategyType `json:"strategy"`
	Direction  string       `json:"direction"` // BULLISH | BEARISH | NEUTRAL
	Regime     Regime       `json:"regime"`
	Confidence int          `json:"confidence"` // 0-100
	ATMStrike  float64      `json:"atm_strike"`
	Reasoning  []string     `json:"reasoning"`
	Legs       []LegSpec    `json:"legs"`
	Indicators Indicators   `json:"indicators"`
	AsOf       time.Time    `json:"as_of"`
}

// ─── Analyzer ─────────────────────────────────────────────────────────────────

// Analyze examines 15-minute NIFTY candles and returns a strategy recommendation.
// isExpiryDay should be true when today is the nearest weekly expiry.
func Analyze(candles []kite.Candle, isExpiryDay bool) (*Recommendation, error) {
	if len(candles) < 25 {
		return nil, fmt.Errorf("need at least 25 candles, got %d", len(candles))
	}

	closes := make([]float64, len(candles))
	for i, c := range candles {
		closes[i] = c.Close
	}
	spot := closes[len(closes)-1]
	atm := kite.ATMStrike(spot)

	ema9 := ema(closes, 9)
	ema21 := ema(closes, 21)
	atr := atr14(candles)
	vwap := vwapProxy(candles)
	orH, orL := openingRange(candles)

	dayOpen := todayOpen(candles)
	dayChangePct := 0.0
	if dayOpen > 0 {
		dayChangePct = (spot - dayOpen) / dayOpen * 100
	}

	// Trend strength: EMA separation normalised by ATR, plus EMA9 slope.
	sep := math.Abs(ema9-ema21) / math.Max(atr, 1)
	slope := ema9Slope(closes)
	strength := math.Min(100, (sep*40)+(math.Abs(slope)/math.Max(atr, 1)*60))

	ind := Indicators{
		Spot: spot, EMA9: round2(ema9), EMA21: round2(ema21), ATR14: round2(atr),
		VWAPProxy: round2(vwap), TrendStrength: round2(strength),
		ORHigh: orH, ORLow: orL, DayChangePct: round2(dayChangePct),
	}

	bullish := ema9 > ema21 && spot > ema21 && spot > vwap
	bearish := ema9 < ema21 && spot < ema21 && spot < vwap

	now := candles[len(candles)-1].Time
	inORBWindow := now.Hour() == 9 || (now.Hour() == 10 && now.Minute() == 0)

	rec := &Recommendation{ATMStrike: atm, Indicators: ind, AsOf: now}

	// ── Decision tree ──────────────────────────────────────────────────────
	switch {
	// 1) ORB breakout in the morning window takes priority
	case inORBWindow && orH > 0 && spot > orH && bullish:
		rec.Strategy = StratORBCE
		rec.Direction = "BULLISH"
		rec.Regime = RegimeTrendUp
		rec.Confidence = clamp(55 + int(strength/3))
		rec.Reasoning = []string{
			fmt.Sprintf("Opening-range breakout: spot %.0f broke above OR-High %.0f", spot, orH),
			fmt.Sprintf("EMA9 %.0f > EMA21 %.0f and price above VWAP %.0f confirms upside", ema9, ema21, vwap),
		}
		rec.Legs = []LegSpec{{OptionType: "CE", Side: "BUY", StrikeOffset: 0, Label: "Buy ATM CE"}}

	case inORBWindow && orL > 0 && spot < orL && bearish:
		rec.Strategy = StratORBPE
		rec.Direction = "BEARISH"
		rec.Regime = RegimeTrendDown
		rec.Confidence = clamp(55 + int(strength/3))
		rec.Reasoning = []string{
			fmt.Sprintf("Opening-range breakdown: spot %.0f broke below OR-Low %.0f", spot, orL),
			fmt.Sprintf("EMA9 %.0f < EMA21 %.0f and price below VWAP %.0f confirms downside", ema9, ema21, vwap),
		}
		rec.Legs = []LegSpec{{OptionType: "PE", Side: "BUY", StrikeOffset: 0, Label: "Buy ATM PE"}}

	// 2) Expiry day, low trend → iron fly to harvest theta
	case isExpiryDay && strength < 28:
		rec.Strategy = StratIronFly
		rec.Direction = "NEUTRAL"
		rec.Regime = RegimeExpiry
		rec.Confidence = clamp(60 - int(strength))
		rec.Reasoning = []string{
			"Expiry day with weak trend — premium decay favours a neutral, defined-risk structure",
			fmt.Sprintf("Trend strength %.0f/100 is low; spot pinned near %.0f", strength, vwap),
		}
		rec.Legs = []LegSpec{
			{OptionType: "CE", Side: "SELL", StrikeOffset: 0, Label: "Sell ATM CE"},
			{OptionType: "PE", Side: "SELL", StrikeOffset: 0, Label: "Sell ATM PE"},
			{OptionType: "CE", Side: "BUY", StrikeOffset: +300, Label: "Buy +300 CE (wing)"},
			{OptionType: "PE", Side: "BUY", StrikeOffset: -300, Label: "Buy -300 PE (wing)"},
		}

	// 3) Strong trend → directional buy
	case strength >= 50 && bullish:
		rec.Strategy = StratDirectionalCE
		rec.Direction = "BULLISH"
		rec.Regime = RegimeTrendUp
		rec.Confidence = clamp(45 + int(strength/2))
		rec.Reasoning = []string{
			fmt.Sprintf("Strong uptrend: EMA9 %.0f > EMA21 %.0f, strength %.0f/100", ema9, ema21, strength),
			fmt.Sprintf("Spot %.0f above VWAP %.0f, day %+.2f%%", spot, vwap, dayChangePct),
		}
		rec.Legs = []LegSpec{{OptionType: "CE", Side: "BUY", StrikeOffset: 0, Label: "Buy ATM CE"}}

	case strength >= 50 && bearish:
		rec.Strategy = StratDirectionalPE
		rec.Direction = "BEARISH"
		rec.Regime = RegimeTrendDown
		rec.Confidence = clamp(45 + int(strength/2))
		rec.Reasoning = []string{
			fmt.Sprintf("Strong downtrend: EMA9 %.0f < EMA21 %.0f, strength %.0f/100", ema9, ema21, strength),
			fmt.Sprintf("Spot %.0f below VWAP %.0f, day %+.2f%%", spot, vwap, dayChangePct),
		}
		rec.Legs = []LegSpec{{OptionType: "PE", Side: "BUY", StrikeOffset: 0, Label: "Buy ATM PE"}}

	// 4) Choppy / range-bound → iron condor
	case strength < 30:
		rec.Strategy = StratIronCondor
		rec.Direction = "NEUTRAL"
		rec.Regime = RegimeRange
		rec.Confidence = clamp(50 - int(strength))
		rec.Reasoning = []string{
			fmt.Sprintf("Range-bound: weak trend strength %.0f/100, EMAs flat", strength),
			fmt.Sprintf("Sell premium outside ~1.5x ATR (%.0f pts) with protective wings", atr*1.5),
		}
		rec.Legs = []LegSpec{
			{OptionType: "CE", Side: "SELL", StrikeOffset: +200, Label: "Sell +200 CE"},
			{OptionType: "CE", Side: "BUY", StrikeOffset: +400, Label: "Buy +400 CE (wing)"},
			{OptionType: "PE", Side: "SELL", StrikeOffset: -200, Label: "Sell -200 PE"},
			{OptionType: "PE", Side: "BUY", StrikeOffset: -400, Label: "Buy -400 PE (wing)"},
		}

	// 5) Mixed / unclear → stand aside
	default:
		rec.Strategy = StratNone
		rec.Direction = "NEUTRAL"
		rec.Regime = RegimeRange
		rec.Confidence = clamp(int(strength))
		rec.Reasoning = []string{
			fmt.Sprintf("No clean edge: trend strength %.0f/100, direction unclear", strength),
			"Best action is to wait for a breakout or a clearer trend.",
		}
		rec.Legs = nil
	}

	return rec, nil
}

// ─── Indicator math ───────────────────────────────────────────────────────────

func ema(values []float64, period int) float64 {
	if len(values) < period {
		period = len(values)
	}
	k := 2.0 / float64(period+1)
	e := values[0]
	for i := 1; i < len(values); i++ {
		e = values[i]*k + e*(1-k)
	}
	return e
}

func ema9Slope(closes []float64) float64 {
	if len(closes) < 12 {
		return 0
	}
	cur := ema(closes, 9)
	prev := ema(closes[:len(closes)-3], 9)
	return cur - prev
}

func atr14(candles []kite.Candle) float64 {
	period := 14
	if len(candles) <= period {
		period = len(candles) - 1
	}
	var sum float64
	start := len(candles) - period
	for i := start; i < len(candles); i++ {
		h, l, pc := candles[i].High, candles[i].Low, candles[i-1].Close
		tr := math.Max(h-l, math.Max(math.Abs(h-pc), math.Abs(l-pc)))
		sum += tr
	}
	return sum / float64(period)
}

// vwapProxy returns the session typical-price mean (index has no volume).
func vwapProxy(candles []kite.Candle) float64 {
	day := candles[len(candles)-1].Time.YearDay()
	var sum float64
	var n int
	for _, c := range candles {
		if c.Time.YearDay() == day {
			sum += (c.High + c.Low + c.Close) / 3
			n++
		}
	}
	if n == 0 {
		return candles[len(candles)-1].Close
	}
	return sum / float64(n)
}

func openingRange(candles []kite.Candle) (high, low float64) {
	day := candles[len(candles)-1].Time.YearDay()
	for _, c := range candles {
		if c.Time.YearDay() == day && c.Time.Hour() == 9 && c.Time.Minute() < 30 {
			return c.High, c.Low
		}
	}
	return 0, 0
}

func todayOpen(candles []kite.Candle) float64 {
	day := candles[len(candles)-1].Time.YearDay()
	for _, c := range candles {
		if c.Time.YearDay() == day {
			return c.Open
		}
	}
	return candles[0].Open
}

// ─── small helpers ────────────────────────────────────────────────────────────

func clamp(v int) int {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }
