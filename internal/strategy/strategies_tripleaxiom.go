package strategy

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"

	"stockwise/internal/data"
)

// ─── Triple-Axiom Trend Strategy ──────────────────────────────────────────────
//
// A trend-following intraday/swing strategy combining three ideas:
//
//	1. Olivier Seban's Supertrend (ATR period 10, multiplier 3) defines the
//	   structural bias. Only longs are taken while Supertrend is green (price
//	   above the line); only shorts while it is red (price below the line).
//	2. Andrew Aziz's EMA-pullback execution. With the trend established, we wait
//	   for price to pull back to the 9/20 EMA zone, then trigger on the first
//	   candle that closes back through the 9 EMA in the trend direction.
//	3. Van Tharp's R-multiple risk architecture. The stop is the Supertrend line
//	   (or the recent swing, whichever is closer to entry, i.e. tighter). The
//	   target is a configurable R-multiple of that initial risk (2R by default).
//
// The Direction is BUY/SELL on the underlying so the engine's consensus and
// OI-confirmation filters still gate the call. Position sizing (1% risk) is a
// broker/portfolio concern and is surfaced in the call reason, not the order —
// the engine reasons about direction + entry + stop + target.

// TripleAxiomConfig holds every tunable parameter. JSON tags double as the keys
// the frontend strategy editor renders.
type TripleAxiomConfig struct {
	// Seban — Supertrend filter
	ATRPeriod     int     `json:"atr_period"`     // ATR lookback (Seban default 10)
	Multiplier    float64 `json:"multiplier"`     // ATR multiplier (Seban default 3.0)

	// Aziz — EMA pullback trigger
	FastEMA       int     `json:"fast_ema"`       // trigger EMA (9)
	SlowEMA       int     `json:"slow_ema"`       // pullback EMA (20)
	PullbackBars  int     `json:"pullback_bars"`  // lookback window for a pullback touch
	TouchTolPct   float64 `json:"touch_tol_pct"`  // % band around EMA20 counted as a "touch"
	RequireColor  bool    `json:"require_color"`  // trigger candle must be green (long)/red (short)

	// Tharp — R-multiple risk
	RiskPercent   float64 `json:"risk_percent"`   // account risk per trade (informational, e.g. 1.0)
	TargetR       float64 `json:"target_r"`       // primary target as a multiple of R (2.0)
	SwingLookback int     `json:"swing_lookback"` // bars used to find the recent swing low/high

	// Gating
	MinConfidence float64 `json:"min_confidence"` // suppress calls below this confidence
	StartTime     string  `json:"start_time"`     // intraday window open  "HH:MM" (blank = all day)
	EndTime       string  `json:"end_time"`       // intraday window close "HH:MM"
	MinCandlesReq int     `json:"min_candles"`    // bars required before evaluating
}

// defaultTripleAxiomConfig returns the author-specified defaults.
func defaultTripleAxiomConfig() TripleAxiomConfig {
	return TripleAxiomConfig{
		ATRPeriod:     10,
		Multiplier:    3.0,
		FastEMA:       9,
		SlowEMA:       20,
		PullbackBars:  5,
		TouchTolPct:   0.15,
		RequireColor:  true,
		RiskPercent:   1.0,
		TargetR:       2.0,
		SwingLookback: 10,
		MinConfidence: 60,
		StartTime:     "09:30",
		EndTime:       "15:00",
		MinCandlesReq: 30,
	}
}

// tripleAxiomStrategy is the registered, configurable LiveStrategy.
type tripleAxiomStrategy struct {
	mu  sync.RWMutex
	cfg TripleAxiomConfig
}

func newTripleAxiomStrategy() *tripleAxiomStrategy {
	s := &tripleAxiomStrategy{cfg: defaultTripleAxiomConfig()}
	s.loadFromDisk()
	return s
}

func (s *tripleAxiomStrategy) Key() string  { return "triple_axiom" }
func (s *tripleAxiomStrategy) Name() string { return "Triple-Axiom Trend" }
func (s *tripleAxiomStrategy) Description() string {
	return "Seban Supertrend bias + Aziz EMA9/20 pullback trigger + Tharp R-multiple risk (stop at Supertrend, target 2R)."
}

func (s *tripleAxiomStrategy) MinCandles() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := s.cfg.MinCandlesReq
	// Need enough bars to seed ATR and the slow EMA meaningfully.
	floor := s.cfg.ATRPeriod + 2
	if s.cfg.SlowEMA+2 > floor {
		floor = s.cfg.SlowEMA + 2
	}
	if n < floor {
		n = floor
	}
	return n
}

// ─── Configurable implementation ──────────────────────────────────────────────

func (s *tripleAxiomStrategy) Config() any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg
}

func (s *tripleAxiomStrategy) Defaults() any { return defaultTripleAxiomConfig() }

func (s *tripleAxiomStrategy) SetConfig(raw json.RawMessage) error {
	s.mu.RLock()
	merged := s.cfg
	s.mu.RUnlock()

	if err := json.Unmarshal(raw, &merged); err != nil {
		return fmt.Errorf("invalid triple_axiom config: %w", err)
	}
	if err := validateTripleAxiomConfig(&merged); err != nil {
		return err
	}

	s.mu.Lock()
	s.cfg = merged
	s.mu.Unlock()
	s.saveToDisk()
	return nil
}

// validateTripleAxiomConfig clamps values so a bad edit can never crash the engine.
func validateTripleAxiomConfig(c *TripleAxiomConfig) error {
	if c.ATRPeriod < 1 {
		return fmt.Errorf("atr_period must be positive")
	}
	if c.Multiplier <= 0 {
		return fmt.Errorf("multiplier must be positive")
	}
	if c.FastEMA < 1 || c.SlowEMA < 2 {
		return fmt.Errorf("EMA periods must be positive")
	}
	if c.FastEMA >= c.SlowEMA {
		return fmt.Errorf("fast_ema must be smaller than slow_ema")
	}
	if c.PullbackBars < 1 {
		c.PullbackBars = 5
	}
	if c.TouchTolPct < 0 {
		c.TouchTolPct = 0
	}
	if c.TargetR <= 0 {
		c.TargetR = 2.0
	}
	if c.SwingLookback < 2 {
		c.SwingLookback = 10
	}
	if c.RiskPercent < 0 {
		c.RiskPercent = 0
	}
	if c.MinConfidence < 0 {
		c.MinConfidence = 0
	}
	if c.MinCandlesReq < 5 {
		c.MinCandlesReq = 5
	}
	if _, err := parseClock(c.StartTime); c.StartTime != "" && err != nil {
		return fmt.Errorf("invalid start_time, expected HH:MM")
	}
	if _, err := parseClock(c.EndTime); c.EndTime != "" && err != nil {
		return fmt.Errorf("invalid end_time, expected HH:MM")
	}
	return nil
}

// ─── persistence ──────────────────────────────────────────────────────────────

func tripleAxiomConfigPath() string {
	if dir := os.Getenv("STOCKWISE_DATA_DIR"); dir != "" {
		return filepath.Join(dir, "triple_axiom_strategy.json")
	}
	return "triple_axiom_strategy.json"
}

func (s *tripleAxiomStrategy) saveToDisk() {
	s.mu.RLock()
	cfg := s.cfg
	s.mu.RUnlock()
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(tripleAxiomConfigPath(), b, 0o644)
}

func (s *tripleAxiomStrategy) loadFromDisk() {
	b, err := os.ReadFile(tripleAxiomConfigPath())
	if err != nil {
		return
	}
	cfg := s.cfg
	if err := json.Unmarshal(b, &cfg); err != nil {
		return
	}
	if err := validateTripleAxiomConfig(&cfg); err != nil {
		return
	}
	s.cfg = cfg
}

// ─── evaluation ───────────────────────────────────────────────────────────────

func (s *tripleAxiomStrategy) Evaluate(symbol string, candles []data.Candle) *TradeCall {
	s.mu.RLock()
	c := s.cfg
	s.mu.RUnlock()

	if len(candles) < s.MinCandles() {
		return nil
	}

	last := candles[len(candles)-1]
	if !withinWindow(last.Start, c.StartTime, c.EndTime) {
		return nil
	}

	closes := closesOf(candles)
	n := len(closes)

	stLine, stLong := supertrend(candles, c.ATRPeriod, c.Multiplier)
	fast := ema(closes, c.FastEMA)
	slow := ema(closes, c.SlowEMA)

	price := closes[n-1]
	cur := candles[n-1]
	curFast := fast[n-1]
	stNow := stLine[n-1]
	dirLong := stLong[n-1]

	// Was there a pullback to the EMA20 zone within the recent window? A touch =
	// the bar's range came within TouchTolPct of EMA20 (low dipped to it for a
	// long, high poked it for a short), and the bar did not close beyond the
	// Supertrend line (i.e. the trend structure held through the pullback).
	tol := c.TouchTolPct / 100.0
	pulledBack := false
	startIdx := n - 1 - c.PullbackBars
	if startIdx < 1 {
		startIdx = 1
	}
	for i := startIdx; i < n; i++ {
		band := slow[i] * tol
		if dirLong {
			if candles[i].Low <= slow[i]+band && candles[i].Close >= stLine[i] {
				pulledBack = true
				break
			}
		} else {
			if candles[i].High >= slow[i]-band && candles[i].Close <= stLine[i] {
				pulledBack = true
				break
			}
		}
	}
	if !pulledBack {
		return nil
	}

	green := cur.Close > cur.Open
	red := cur.Close < cur.Open

	var direction string
	switch {
	case dirLong:
		// Trigger: close strictly back above the 9 EMA after the pullback.
		if curFast <= 0 || price <= curFast {
			return nil
		}
		if c.RequireColor && !green {
			return nil
		}
		direction = "BUY"
	case !dirLong:
		if curFast <= 0 || price >= curFast {
			return nil
		}
		if c.RequireColor && !red {
			return nil
		}
		direction = "SELL"
	default:
		return nil
	}

	// ── Tharp risk architecture ──
	// Stop = Supertrend line OR the recent swing, whichever is closer to entry
	// (the tighter stop → smaller R). Target = entry ± TargetR × R.
	stop := tripleAxiomStop(direction, price, stNow, candles, c.SwingLookback)
	risk := math.Abs(price - stop)
	if risk <= 0 {
		return nil // degenerate stop; skip rather than divide by zero
	}

	var target float64
	if direction == "BUY" {
		target = price + c.TargetR*risk
	} else {
		target = price - c.TargetR*risk
	}

	// Confidence scales with how far price has extended from the EMA9 trigger
	// (momentum off the pullback), capped, then floored at a trend-following base.
	mom := math.Abs(price-curFast) / price * 100
	confidence := 65 + math.Min(mom*10, 25) // 65..90
	if confidence < c.MinConfidence {
		return nil
	}

	// Position size at the configured risk % is informational (the engine doesn't
	// size orders) but we surface it so the call carries Tharp's sizing intent.
	rPct := c.RiskPercent
	reason := fmt.Sprintf(
		"Supertrend %s + EMA%d/%d pullback; entry %.2f, stop %.2f (R=%.2f), target %.1fR=%.2f; size for %.2g%% risk",
		map[bool]string{true: "green (long)", false: "red (short)"}[dirLong],
		c.FastEMA, c.SlowEMA, price, stop, risk, c.TargetR, target, rPct,
	)

	return &TradeCall{
		Symbol:     symbol,
		Direction:  direction,
		Strategy:   s.Name(),
		Price:      price,
		Target:     target,
		StopLoss:   stop,
		Confidence: confidence,
		Reason:     reason,
	}
}

// tripleAxiomStop returns the initial stop: the Supertrend line or the recent
// swing low/high, whichever is closer to entry (tighter). It always returns a
// stop on the correct side of entry; if neither candidate is valid it falls back
// to the Supertrend line.
func tripleAxiomStop(direction string, entry, stLine float64, candles []data.Candle, lookback int) float64 {
	n := len(candles)
	start := n - lookback
	if start < 0 {
		start = 0
	}

	if direction == "BUY" {
		swingLow := math.Inf(1)
		for i := start; i < n; i++ {
			if candles[i].Low < swingLow {
				swingLow = candles[i].Low
			}
		}
		// Both stops sit below entry; "closer to entry" = the higher one.
		best := math.Inf(-1)
		for _, cand := range []float64{stLine, swingLow} {
			if cand < entry && cand > best {
				best = cand
			}
		}
		if math.IsInf(best, -1) {
			return stLine
		}
		return best
	}

	// SELL: both stops sit above entry; "closer to entry" = the lower one.
	swingHigh := math.Inf(-1)
	for i := start; i < n; i++ {
		if candles[i].High > swingHigh {
			swingHigh = candles[i].High
		}
	}
	best := math.Inf(1)
	for _, cand := range []float64{stLine, swingHigh} {
		if cand > entry && cand < best {
			best = cand
		}
	}
	if math.IsInf(best, 1) {
		return stLine
	}
	return best
}

// ─── Supertrend ───────────────────────────────────────────────────────────────

// atr returns the Wilder Average True Range series aligned to the input candles.
// out[i] is the ATR using data up to and including candle i. Early values (before
// the period is seeded) use a running simple average of true range.
func atr(candles []data.Candle, period int) []float64 {
	out := make([]float64, len(candles))
	if len(candles) == 0 || period < 1 {
		return out
	}
	trueRange := func(i int) float64 {
		h, l := candles[i].High, candles[i].Low
		if i == 0 {
			return h - l
		}
		pc := candles[i-1].Close
		return math.Max(h-l, math.Max(math.Abs(h-pc), math.Abs(l-pc)))
	}
	// Seed with the SMA of TR over the first `period` bars.
	var sum float64
	for i := 0; i < len(candles); i++ {
		tr := trueRange(i)
		if i < period {
			sum += tr
			out[i] = sum / float64(i+1)
			continue
		}
		if i == period {
			prev := out[period-1] // SMA seed
			out[i] = (prev*float64(period-1) + tr) / float64(period)
			continue
		}
		out[i] = (out[i-1]*float64(period-1) + tr) / float64(period)
	}
	return out
}

// supertrend computes the Supertrend line and direction aligned to the candles.
// line[i] is the active Supertrend value at bar i; long[i] is true when the
// trend is up (price above the line / line is the lower band).
func supertrend(candles []data.Candle, period int, mult float64) (line []float64, long []bool) {
	n := len(candles)
	line = make([]float64, n)
	long = make([]bool, n)
	if n == 0 {
		return line, long
	}
	a := atr(candles, period)

	finalUpper := make([]float64, n)
	finalLower := make([]float64, n)

	for i := 0; i < n; i++ {
		mid := (candles[i].High + candles[i].Low) / 2
		basicUpper := mid + mult*a[i]
		basicLower := mid - mult*a[i]

		if i == 0 {
			finalUpper[i] = basicUpper
			finalLower[i] = basicLower
			// Seed direction by where the first close sits.
			if candles[i].Close <= basicUpper {
				line[i] = basicUpper
				long[i] = false
			} else {
				line[i] = basicLower
				long[i] = true
			}
			continue
		}

		prevClose := candles[i-1].Close
		if basicUpper < finalUpper[i-1] || prevClose > finalUpper[i-1] {
			finalUpper[i] = basicUpper
		} else {
			finalUpper[i] = finalUpper[i-1]
		}
		if basicLower > finalLower[i-1] || prevClose < finalLower[i-1] {
			finalLower[i] = basicLower
		} else {
			finalLower[i] = finalLower[i-1]
		}

		// Carry the trend from the previous bar, flip on a close through the band.
		cl := candles[i].Close
		if long[i-1] {
			if cl < finalLower[i] {
				long[i] = false
				line[i] = finalUpper[i]
			} else {
				long[i] = true
				line[i] = finalLower[i]
			}
		} else {
			if cl > finalUpper[i] {
				long[i] = true
				line[i] = finalLower[i]
			} else {
				long[i] = false
				line[i] = finalUpper[i]
			}
		}
	}
	return line, long
}
