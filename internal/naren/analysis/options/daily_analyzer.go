package options

import (
	"fmt"
	"math"
	"time"

	"stockwise/internal/naren/kite"
)

// AnalyzeDaily runs the strategy classifier on DAILY NIFTY candles.
// Intended for the 1-year daily backtest where 15m data is unavailable.
// Uses EMA20/EMA50 trend + ATR-based regime detection.
func AnalyzeDaily(candles []kite.Candle, isExpiryDay bool) (*Recommendation, error) {
	if len(candles) < 55 {
		return nil, fmt.Errorf("need at least 55 daily candles, got %d", len(candles))
	}

	closes := make([]float64, len(candles))
	for i, c := range candles {
		closes[i] = c.Close
	}

	spot := closes[len(closes)-1]
	atm  := kite.ATMStrike(spot)

	ema20 := ema(closes, 20)
	ema50 := ema(closes, 50)
	atr   := dailyATR(candles, 14)

	// Weekly momentum: compare last close to 5-bar-ago close
	prevWeekClose := closes[len(closes)-6]
	weeklyChangePct := (spot - prevWeekClose) / prevWeekClose * 100

	// Trend strength: EMA separation scaled by ATR
	sep      := math.Abs(ema20-ema50) / math.Max(atr, 1)
	strength := math.Min(100, sep*60+math.Abs(weeklyChangePct)*8)

	ema20Slope := ema20 - ema(closes[:len(closes)-3], 20)
	if ema20Slope > 0 {
		strength = math.Min(100, strength+10)
	} else {
		strength = math.Max(0, strength-10)
	}

	bullish := ema20 > ema50 && spot > ema20 && weeklyChangePct > 0
	bearish := ema20 < ema50 && spot < ema20 && weeklyChangePct < 0

	// VWAP proxy = simple 5-day mean close
	var vwapSum float64
	for _, c := range closes[len(closes)-5:] {
		vwapSum += c
	}
	vwap := vwapSum / 5

	ind := Indicators{
		Spot: spot, EMA9: round2(ema20), EMA21: round2(ema50),
		ATR14: round2(atr), VWAPProxy: round2(vwap),
		TrendStrength: round2(strength), DayChangePct: round2(weeklyChangePct),
	}

	now := candles[len(candles)-1].Time
	rec := &Recommendation{ATMStrike: atm, Indicators: ind, AsOf: now}

	switch {
	case isExpiryDay && strength < 25:
		rec.Strategy   = StratIronFly
		rec.Direction  = "NEUTRAL"
		rec.Regime     = RegimeExpiry
		rec.Confidence = clamp(55 - int(strength))
		rec.Reasoning  = []string{
			fmt.Sprintf("Expiry day, low trend strength %.0f/100 — theta harvest favoured", strength),
			fmt.Sprintf("EMA20 %.0f ≈ EMA50 %.0f, spot near VWAP %.0f", ema20, ema50, vwap),
		}
		rec.Legs = []LegSpec{
			{OptionType: "CE", Side: "SELL", StrikeOffset: 0, Label: "Sell ATM CE"},
			{OptionType: "PE", Side: "SELL", StrikeOffset: 0, Label: "Sell ATM PE"},
			{OptionType: "CE", Side: "BUY", StrikeOffset: +300, Label: "Buy +300 CE (wing)"},
			{OptionType: "PE", Side: "BUY", StrikeOffset: -300, Label: "Buy -300 PE (wing)"},
		}

	case strength >= 45 && bullish:
		rec.Strategy   = StratDirectionalCE
		rec.Direction  = "BULLISH"
		rec.Regime     = RegimeTrendUp
		rec.Confidence = clamp(40 + int(strength/2))
		rec.Reasoning  = []string{
			fmt.Sprintf("EMA20 %.0f > EMA50 %.0f, trend strength %.0f/100", ema20, ema50, strength),
			fmt.Sprintf("Weekly change %+.1f%%, spot %.0f above VWAP %.0f", weeklyChangePct, spot, vwap),
		}
		rec.Legs = []LegSpec{{OptionType: "CE", Side: "BUY", StrikeOffset: 0, Label: "Buy ATM CE"}}

	case strength >= 45 && bearish:
		rec.Strategy   = StratDirectionalPE
		rec.Direction  = "BEARISH"
		rec.Regime     = RegimeTrendDown
		rec.Confidence = clamp(40 + int(strength/2))
		rec.Reasoning  = []string{
			fmt.Sprintf("EMA20 %.0f < EMA50 %.0f, trend strength %.0f/100", ema20, ema50, strength),
			fmt.Sprintf("Weekly change %+.1f%%, spot %.0f below VWAP %.0f", weeklyChangePct, spot, vwap),
		}
		rec.Legs = []LegSpec{{OptionType: "PE", Side: "BUY", StrikeOffset: 0, Label: "Buy ATM PE"}}

	case strength < 28:
		rec.Strategy   = StratIronCondor
		rec.Direction  = "NEUTRAL"
		rec.Regime     = RegimeRange
		rec.Confidence = clamp(48 - int(strength))
		rec.Reasoning  = []string{
			fmt.Sprintf("Range-bound market, trend strength %.0f/100", strength),
			fmt.Sprintf("ATR %.0f pts — sell strangles outside 1.5×ATR band", atr),
		}
		rec.Legs = []LegSpec{
			{OptionType: "CE", Side: "SELL", StrikeOffset: +200, Label: "Sell +200 CE"},
			{OptionType: "CE", Side: "BUY", StrikeOffset: +400, Label: "Buy +400 CE (wing)"},
			{OptionType: "PE", Side: "SELL", StrikeOffset: -200, Label: "Sell -200 PE"},
			{OptionType: "PE", Side: "BUY", StrikeOffset: -400, Label: "Buy -400 PE (wing)"},
		}

	default:
		rec.Strategy   = StratNone
		rec.Direction  = "NEUTRAL"
		rec.Regime     = RegimeRange
		rec.Confidence = clamp(int(strength))
		rec.Reasoning  = []string{
			fmt.Sprintf("No clear daily edge: strength %.0f/100, direction unclear", strength),
		}
	}
	return rec, nil
}

// dailyATR computes ATR(14) from daily candles.
func dailyATR(candles []kite.Candle, period int) float64 {
	if len(candles) <= 1 {
		return 100
	}
	start := len(candles) - period - 1
	if start < 1 {
		start = 1
	}
	var sum float64
	var n int
	for i := start; i < len(candles); i++ {
		h, l, pc := candles[i].High, candles[i].Low, candles[i-1].Close
		tr := math.Max(h-l, math.Max(math.Abs(h-pc), math.Abs(l-pc)))
		sum += tr
		n++
	}
	if n == 0 {
		return 100
	}
	return sum / float64(n)
}

// IVFromDailyATR converts a daily ATR to annualised IV.
// For daily candles, ATR is already a daily figure — no scaling needed.
func IVFromDailyATR(dailyAtr, spot float64) float64 {
	if spot <= 0 {
		return 0.15
	}
	annualised := (dailyAtr / spot) * math.Sqrt(252) * 1.15
	if annualised < 0.12 {
		return 0.12
	}
	if annualised > 0.35 {
		return 0.35
	}
	return annualised
}

// NextTuesdayFromDate returns the next Tuesday expiry from a given date.
// Used in daily backtest to compute trade DTE correctly.
func NextTuesdayFromDate(d time.Time) time.Time {
	ist := ISTLoc()
	t := d.In(ist)
	daysUntil := (2 - int(t.Weekday()) + 7) % 7
	if daysUntil == 0 {
		daysUntil = 7
	}
	exp := t.AddDate(0, 0, daysUntil)
	return time.Date(exp.Year(), exp.Month(), exp.Day(), 0, 0, 0, 0, ist)
}
