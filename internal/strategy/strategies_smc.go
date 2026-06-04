package strategy

import (
	"fmt"

	"stockwise/internal/data"
)

func init() {
	Register(&smcStructure{})
	Register(&smcFVG{})
	Register(&smcOrderBlock{})
}

// swingLookback is the fractal width used to confirm a swing point.
const swingLookback = 2

// ─── Smart Money Concepts: structure helpers ─────────────────────────────────────

// lastSwingHigh returns the value and index of the most recent confirmed swing
// high (a fractal high with `swingLookback` lower highs on each side). ok=false
// when none is found.
func lastSwingHigh(candles []data.Candle) (float64, int, bool) {
	k := swingLookback
	for i := len(candles) - 1 - k; i >= k; i-- {
		if isSwingHigh(candles, i, k) {
			return candles[i].High, i, true
		}
	}
	return 0, 0, false
}

func lastSwingLow(candles []data.Candle) (float64, int, bool) {
	k := swingLookback
	for i := len(candles) - 1 - k; i >= k; i-- {
		if isSwingLow(candles, i, k) {
			return candles[i].Low, i, true
		}
	}
	return 0, 0, false
}

func isSwingHigh(candles []data.Candle, i, k int) bool {
	for j := 1; j <= k; j++ {
		if candles[i].High <= candles[i-j].High || candles[i].High <= candles[i+j].High {
			return false
		}
	}
	return true
}

func isSwingLow(candles []data.Candle, i, k int) bool {
	for j := 1; j <= k; j++ {
		if candles[i].Low >= candles[i-j].Low || candles[i].Low >= candles[i+j].Low {
			return false
		}
	}
	return true
}

// breakOfStructure detects a Break of Structure on the latest closed candle:
// +1 bullish (close crossed above the last swing high), -1 bearish, 0 none.
// It also returns the broken level.
func breakOfStructure(candles []data.Candle) (int, float64) {
	n := len(candles)
	if n < 2*swingLookback+2 {
		return 0, 0
	}
	cur := candles[n-1]
	prev := candles[n-2]

	if hi, _, ok := lastSwingHigh(candles); ok {
		if prev.Close <= hi && cur.Close > hi {
			return 1, hi
		}
	}
	if lo, _, ok := lastSwingLow(candles); ok {
		if prev.Close >= lo && cur.Close < lo {
			return -1, lo
		}
	}
	return 0, 0
}

// hasBullishFVG reports a bullish Fair Value Gap (3-candle imbalance where
// candle[i].Low > candle[i-2].High) within the trailing window.
func hasBullishFVG(candles []data.Candle, window int) (bool, float64) {
	n := len(candles)
	start := n - window
	if start < 2 {
		start = 2
	}
	for i := n - 1; i >= start; i-- {
		if candles[i].Low > candles[i-2].High {
			return true, candles[i-2].High // gap base = prior candle high
		}
	}
	return false, 0
}

func hasBearishFVG(candles []data.Candle, window int) (bool, float64) {
	n := len(candles)
	start := n - window
	if start < 2 {
		start = 2
	}
	for i := n - 1; i >= start; i-- {
		if candles[i].High < candles[i-2].Low {
			return true, candles[i-2].Low
		}
	}
	return false, 0
}

// findOrderBlock returns the zone [low,high] of the last opposite-color candle
// before the breakout candle. dir=+1 looks for the last bearish (down) candle
// (a bullish order block); dir=-1 looks for the last bullish (up) candle.
func findOrderBlock(candles []data.Candle, dir int) (low, high float64, ok bool) {
	for i := len(candles) - 2; i >= 0; i-- {
		c := candles[i]
		if dir == 1 && c.Close < c.Open {
			return c.Low, c.High, true
		}
		if dir == -1 && c.Close > c.Open {
			return c.Low, c.High, true
		}
	}
	return 0, 0, false
}

// ─── SMC: Break of Structure ──────────────────────────────────────────────────────

type smcStructure struct{}

func (s *smcStructure) Key() string  { return "smc" }
func (s *smcStructure) Name() string { return "SMC — Break of Structure" }
func (s *smcStructure) Description() string {
	return "Tracks market structure via swing highs/lows and trades a confirmed Break of Structure (BOS)."
}
func (s *smcStructure) MinCandles() int { return 30 }

func (s *smcStructure) Evaluate(symbol string, candles []data.Candle) *TradeCall {
	if len(candles) < s.MinCandles() {
		return nil
	}
	dir, level := breakOfStructure(candles)
	price := candles[len(candles)-1].Close
	switch dir {
	case 1:
		return &TradeCall{
			Symbol: symbol, Direction: "BUY", Strategy: s.Name(),
			Price: price, Target: price + (price-level)*2, StopLoss: level * 0.999,
			Confidence: 67, Reason: fmt.Sprintf("Bullish BOS — closed above swing high %.2f", level),
		}
	case -1:
		return &TradeCall{
			Symbol: symbol, Direction: "SELL", Strategy: s.Name(),
			Price: price, Target: price - (level-price)*2, StopLoss: level * 1.001,
			Confidence: 65, Reason: fmt.Sprintf("Bearish BOS — closed below swing low %.2f", level),
		}
	}
	return nil
}

// ─── SMC + Fair Value Gap ──────────────────────────────────────────────────────────

type smcFVG struct{}

func (s *smcFVG) Key() string  { return "smc_fvg" }
func (s *smcFVG) Name() string { return "SMC + Fair Value Gap" }
func (s *smcFVG) Description() string {
	return "BOS confirmed by a same-direction Fair Value Gap (price imbalance) in the recent window."
}
func (s *smcFVG) MinCandles() int { return 30 }

func (s *smcFVG) Evaluate(symbol string, candles []data.Candle) *TradeCall {
	if len(candles) < s.MinCandles() {
		return nil
	}
	dir, level := breakOfStructure(candles)
	if dir == 0 {
		return nil
	}
	price := candles[len(candles)-1].Close
	const fvgWindow = 10

	if dir == 1 {
		if ok, base := hasBullishFVG(candles, fvgWindow); ok {
			return &TradeCall{
				Symbol: symbol, Direction: "BUY", Strategy: s.Name(),
				Price: price, Target: price + (price-base), StopLoss: base,
				Confidence: 71, Reason: fmt.Sprintf("Bullish BOS @ %.2f with FVG support at %.2f", level, base),
			}
		}
	} else if dir == -1 {
		if ok, base := hasBearishFVG(candles, fvgWindow); ok {
			return &TradeCall{
				Symbol: symbol, Direction: "SELL", Strategy: s.Name(),
				Price: price, Target: price - (base - price), StopLoss: base,
				Confidence: 69, Reason: fmt.Sprintf("Bearish BOS @ %.2f with FVG resistance at %.2f", level, base),
			}
		}
	}
	return nil
}

// ─── SMC + Order Block ──────────────────────────────────────────────────────────────

type smcOrderBlock struct{}

func (s *smcOrderBlock) Key() string  { return "smc_ob" }
func (s *smcOrderBlock) Name() string { return "SMC + Order Block" }
func (s *smcOrderBlock) Description() string {
	return "BOS confirmed by an order block (last opposite candle before the impulse); stop sits at the block edge."
}
func (s *smcOrderBlock) MinCandles() int { return 30 }

func (s *smcOrderBlock) Evaluate(symbol string, candles []data.Candle) *TradeCall {
	if len(candles) < s.MinCandles() {
		return nil
	}
	dir, level := breakOfStructure(candles)
	if dir == 0 {
		return nil
	}
	price := candles[len(candles)-1].Close
	obLow, obHigh, ok := findOrderBlock(candles, dir)
	if !ok {
		return nil
	}

	if dir == 1 {
		return &TradeCall{
			Symbol: symbol, Direction: "BUY", Strategy: s.Name(),
			Price: price, Target: price + (price-obLow), StopLoss: obLow,
			Confidence: 70, Reason: fmt.Sprintf("Bullish BOS @ %.2f off demand order block %.2f–%.2f", level, obLow, obHigh),
		}
	}
	return &TradeCall{
		Symbol: symbol, Direction: "SELL", Strategy: s.Name(),
		Price: price, Target: price - (obHigh - price), StopLoss: obHigh,
		Confidence: 68, Reason: fmt.Sprintf("Bearish BOS @ %.2f off supply order block %.2f–%.2f", level, obLow, obHigh),
	}
}
