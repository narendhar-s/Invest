package strategy

import (
	"fmt"

	"stockwise/internal/data"
)

func init() {
	Register(&orbStrategy{openingMinutes: 15})
	Register(&deltaNeutral{})
}

// intervalMinutes converts a timeframe label to minutes.
func intervalMinutes(label string) int {
	switch label {
	case "1m":
		return 1
	case "3m":
		return 3
	case "5m":
		return 5
	case "15m":
		return 15
	default:
		return 5
	}
}

// sameDay reports whether two candles fall on the same calendar day.
func sameDay(a, b data.Candle) bool {
	ay, am, ad := a.Start.Date()
	by, bm, bd := b.Start.Date()
	return ay == by && am == bm && ad == bd
}

// todaysCandles returns the trailing run of candles sharing the last candle's day.
func todaysCandles(candles []data.Candle) []data.Candle {
	n := len(candles)
	if n == 0 {
		return nil
	}
	last := candles[n-1]
	start := n - 1
	for start > 0 && sameDay(candles[start-1], last) {
		start--
	}
	return candles[start:]
}

// ─── Opening Range Breakout ──────────────────────────────────────────────────────

type orbStrategy struct{ openingMinutes int }

func (s *orbStrategy) Key() string  { return "orb" }
func (s *orbStrategy) Name() string { return "Opening Range Breakout (ORB)" }
func (s *orbStrategy) Description() string {
	return fmt.Sprintf("Marks the first %d minutes' high/low, then trades a confirmed breakout of that range.", s.openingMinutes)
}
func (s *orbStrategy) MinCandles() int { return 6 }

func (s *orbStrategy) Evaluate(symbol string, candles []data.Candle) *TradeCall {
	day := todaysCandles(candles)
	if len(day) < 2 {
		return nil
	}
	// Use the last candle's interval — it's always a live candle once the engine
	// is running, whereas day[0] may be a seeded candle with a different label
	// (e.g. "5m" seed data backing a "3m" live session).
	perCandle := intervalMinutes(day[len(day)-1].Interval)
	rangeCandles := s.openingMinutes / perCandle
	if rangeCandles < 1 {
		rangeCandles = 1
	}
	// Need the full opening range plus at least one candle after it.
	if len(day) <= rangeCandles+1 {
		return nil
	}

	high, low := day[0].High, day[0].Low
	for i := 1; i < rangeCandles; i++ {
		if day[i].High > high {
			high = day[i].High
		}
		if day[i].Low < low {
			low = day[i].Low
		}
	}

	n := len(day)
	cur := day[n-1]
	prev := day[n-2]

	switch {
	case prev.Close <= high && cur.Close > high:
		return &TradeCall{
			Symbol: symbol, Direction: "BUY", Strategy: s.Name(),
			Price: cur.Close, Target: cur.Close + (high - low), StopLoss: low,
			Confidence: 66,
			Reason:     fmt.Sprintf("Broke above opening range high %.2f", high),
		}
	case prev.Close >= low && cur.Close < low:
		return &TradeCall{
			Symbol: symbol, Direction: "SELL", Strategy: s.Name(),
			Price: cur.Close, Target: cur.Close - (high - low), StopLoss: high,
			Confidence: 64,
			Reason:     fmt.Sprintf("Broke below opening range low %.2f", low),
		}
	}
	return nil
}

// ─── Delta Neutral (signal-only) ─────────────────────────────────────────────────
//
// True delta-neutral positioning uses options (e.g. a straddle/strangle that is
// then delta-hedged) and cannot be expressed as a single equity order, so this
// strategy only emits NEUTRAL signals — it is informational in paper/live modes.

type deltaNeutral struct{}

func (s *deltaNeutral) Key() string  { return "delta_neutral" }
func (s *deltaNeutral) Name() string { return "Delta Neutral (signal-only)" }
func (s *deltaNeutral) Description() string {
	return "Flags low-momentum, range-bound conditions suited to a non-directional options structure (e.g. straddle). Emits NEUTRAL signals only."
}
func (s *deltaNeutral) MinCandles() int { return 20 }

func (s *deltaNeutral) Evaluate(symbol string, candles []data.Candle) *TradeCall {
	if len(candles) < s.MinCandles() {
		return nil
	}
	closes := closesOf(candles)
	r := rsi(closes, 14)
	cur := r[len(r)-1]
	price := closes[len(closes)-1]
	vwap := sessionVWAP(candles)

	// Range-bound: RSI hugging 50 and price sitting close to VWAP.
	rsiNeutral := cur > 45 && cur < 55
	nearVWAP := vwap > 0 && abs(price-vwap)/vwap < 0.002

	// Only emit on transitions into the neutral regime to avoid repeats.
	prev := r[len(r)-2]
	prevNeutral := prev > 45 && prev < 55

	if rsiNeutral && nearVWAP && !prevNeutral {
		return &TradeCall{
			Symbol: symbol, Direction: "NEUTRAL", Strategy: s.Name(),
			Price: price, Target: price, StopLoss: price,
			Confidence: 55,
			Reason:     fmt.Sprintf("Range-bound near VWAP (RSI %.0f) — consider a delta-neutral straddle around %.2f", cur, price),
		}
	}
	return nil
}

func abs(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}
