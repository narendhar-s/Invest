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

// ─── Personal EMA Strategy ────────────────────────────────────────────────────
//
// A systematic intraday options strategy on the 5-minute timeframe, restricted to
// the 09:30–15:00 IST window. It takes a directional view on the underlying when
// three conditions align on the same candle:
//
//	1. EMA cross   — 9 EMA crosses the 21 EMA (bull = up, bear = down).
//	2. VWAP filter — longs only when price is above session VWAP; shorts below.
//	3. Volume      — the signal candle's volume is at least VolMult× (1.5×) the
//	                 average volume of the previous VolLookback (10) candles.
//
// The view is expressed on the options side: bullish → BUY CE (or SELL PE when
// SellSide is on), bearish → BUY PE (or SELL CE). Direction stays BUY/SELL on the
// underlying, so the live engine's OI-confirmation filter still gates the call —
// a bearish option chain blocks bullish calls and vice-versa. That is how OI is
// "checked" for buy/sell calls: the strategy proposes the leg, the engine confirms
// it against the live option-chain bias before any order is sent.
//
// Risk is a fixed reward:risk ratio (researched default 1:2). The stop is a small
// % of the underlying; the target is StopLossPct × RewardRisk away.

// PersonalEMAConfig holds every tunable parameter. JSON tags double as editor keys.
type PersonalEMAConfig struct {
	// Trigger
	FastEMA int `json:"fast_ema"` // 9
	SlowEMA int `json:"slow_ema"` // 21

	// Filters
	UseVWAPFilter bool    `json:"use_vwap_filter"` // longs above VWAP, shorts below
	VolMult       float64 `json:"vol_mult"`        // signal vol ≥ this × avg of prev N (1.5)
	VolLookback   int     `json:"vol_lookback"`    // candles averaged for the volume gate (10)
	UseRSIGuard   bool    `json:"use_rsi_guard"`   // block longs ≥ overbought, shorts ≤ oversold
	RSIPeriod     int     `json:"rsi_period"`      // RSI lookback (14)
	RSIOverbought float64 `json:"rsi_overbought"`  // no fresh long at/above this (70)
	RSIOversold   float64 `json:"rsi_oversold"`    // no fresh short at/below this (30)

	// Options leg
	StrikeStep float64 `json:"strike_step"` // chain strike interval (Nifty 50)
	OTMOffset  int     `json:"otm_offset"`  // strikes OTM (0 = ATM)
	SellSide   bool    `json:"sell_side"`   // false = buy premium, true = sell premium

	// Risk (reward:risk)
	StopLossPct float64 `json:"stop_loss_pct"` // stop as % of underlying price
	RewardRisk  float64 `json:"reward_risk"`   // target = stop × this (RRR, e.g. 2.0)

	// Gating
	MinConfidence float64 `json:"min_confidence"`
	StartTime     string  `json:"start_time"` // "09:30"
	EndTime       string  `json:"end_time"`   // "15:00"
	MinCandlesReq int     `json:"min_candles"`
}

// defaultPersonalEMAConfig returns the researched defaults: 5m, 09:30–15:00,
// 9/21 EMA, VWAP on, 1.5× volume, 1:2 reward:risk (0.3% stop → 0.6% target).
func defaultPersonalEMAConfig() PersonalEMAConfig {
	return PersonalEMAConfig{
		FastEMA:       9,
		SlowEMA:       21,
		UseVWAPFilter: true,
		VolMult:       1.5,
		VolLookback:   10,
		UseRSIGuard:   true,
		RSIPeriod:     14,
		RSIOverbought: 70,
		RSIOversold:   30,
		StrikeStep:    50,
		OTMOffset:     0,
		SellSide:      false,
		StopLossPct:   0.3,
		RewardRisk:    2.0,
		MinConfidence: 60,
		StartTime:     "09:30",
		EndTime:       "15:00",
		MinCandlesReq: 25,
	}
}

type personalEMAStrategy struct {
	mu  sync.RWMutex
	cfg PersonalEMAConfig
}

func newPersonalEMAStrategy() *personalEMAStrategy {
	s := &personalEMAStrategy{cfg: defaultPersonalEMAConfig()}
	s.loadFromDisk()
	return s
}

func (s *personalEMAStrategy) Key() string  { return "personal_ema" }
func (s *personalEMAStrategy) Name() string { return "Personal EMA Strategy" }
func (s *personalEMAStrategy) Description() string {
	return "5m intraday (09:30–15:00): EMA9/21 cross + VWAP + 1.5× volume, mapped to OI-confirmed CE/PE legs at 1:2 reward:risk."
}

func (s *personalEMAStrategy) MinCandles() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := s.cfg.MinCandlesReq
	floor := s.cfg.SlowEMA + 2
	if s.cfg.VolLookback+1 > floor {
		floor = s.cfg.VolLookback + 1
	}
	if n < floor {
		n = floor
	}
	return n
}

// ─── Configurable implementation ──────────────────────────────────────────────

func (s *personalEMAStrategy) Config() any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg
}

func (s *personalEMAStrategy) Defaults() any { return defaultPersonalEMAConfig() }

func (s *personalEMAStrategy) SetConfig(raw json.RawMessage) error {
	s.mu.RLock()
	merged := s.cfg
	s.mu.RUnlock()

	if err := json.Unmarshal(raw, &merged); err != nil {
		return fmt.Errorf("invalid personal_ema config: %w", err)
	}
	if err := validatePersonalEMAConfig(&merged); err != nil {
		return err
	}

	s.mu.Lock()
	s.cfg = merged
	s.mu.Unlock()
	s.saveToDisk()
	return nil
}

func validatePersonalEMAConfig(c *PersonalEMAConfig) error {
	if c.FastEMA < 1 || c.SlowEMA < 2 {
		return fmt.Errorf("EMA periods must be positive")
	}
	if c.FastEMA >= c.SlowEMA {
		return fmt.Errorf("fast_ema must be smaller than slow_ema")
	}
	if c.VolMult <= 0 {
		c.VolMult = 1.5
	}
	if c.VolLookback < 1 {
		c.VolLookback = 10
	}
	if c.RSIPeriod < 2 {
		c.RSIPeriod = 14
	}
	if c.RSIOverbought <= 0 || c.RSIOverbought > 100 {
		c.RSIOverbought = 70
	}
	if c.RSIOversold < 0 || c.RSIOversold >= c.RSIOverbought {
		c.RSIOversold = 30
	}
	if c.StrikeStep <= 0 {
		c.StrikeStep = 50
	}
	if c.OTMOffset < 0 {
		c.OTMOffset = 0
	}
	if c.StopLossPct <= 0 {
		c.StopLossPct = 0.3
	}
	if c.RewardRisk <= 0 {
		c.RewardRisk = 2.0
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

func personalEMAConfigPath() string {
	if dir := os.Getenv("STOCKWISE_DATA_DIR"); dir != "" {
		return filepath.Join(dir, "personal_ema_strategy.json")
	}
	return "personal_ema_strategy.json"
}

func (s *personalEMAStrategy) saveToDisk() {
	s.mu.RLock()
	cfg := s.cfg
	s.mu.RUnlock()
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(personalEMAConfigPath(), b, 0o644)
}

func (s *personalEMAStrategy) loadFromDisk() {
	b, err := os.ReadFile(personalEMAConfigPath())
	if err != nil {
		return
	}
	cfg := s.cfg
	if err := json.Unmarshal(b, &cfg); err != nil {
		return
	}
	if err := validatePersonalEMAConfig(&cfg); err != nil {
		return
	}
	s.cfg = cfg
}

// ─── evaluation ───────────────────────────────────────────────────────────────

func (s *personalEMAStrategy) Evaluate(symbol string, candles []data.Candle) *TradeCall {
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
	fast := ema(closes, c.FastEMA)
	slow := ema(closes, c.SlowEMA)
	prevFast, prevSlow := fast[n-2], slow[n-2]
	curFast, curSlow := fast[n-1], slow[n-1]
	price := closes[n-1]

	bullishCross := prevFast <= prevSlow && curFast > curSlow
	bearishCross := prevFast >= prevSlow && curFast < curSlow
	if !bullishCross && !bearishCross {
		return nil
	}

	// VWAP filter.
	if c.UseVWAPFilter {
		vwap := sessionVWAP(candles)
		if vwap > 0 {
			if bullishCross && price < vwap {
				return nil
			}
			if bearishCross && price > vwap {
				return nil
			}
		}
	}

	// RSI guard: don't chase a fresh long into overbought (RSI ≥ 70) or a fresh
	// short into oversold (RSI ≤ 30).
	if c.UseRSIGuard {
		r := rsi(closes, c.RSIPeriod)
		curRSI := r[len(r)-1]
		if bullishCross && curRSI >= c.RSIOverbought {
			return nil
		}
		if bearishCross && curRSI <= c.RSIOversold {
			return nil
		}
	}

	// Volume gate: signal candle volume ≥ VolMult × average of the previous
	// VolLookback candles (excluding the signal candle itself).
	avgVol := avgCandleVolume(candles, c.VolLookback)
	if avgVol <= 0 || float64(last.Volume) < c.VolMult*avgVol {
		return nil
	}

	// Confidence scales with EMA separation (momentum strength).
	sep := math.Abs(curFast-curSlow) / price * 100
	confidence := 60 + math.Min(sep*8, 30) // 60..90
	if confidence < c.MinConfidence {
		return nil
	}

	// Map the directional view to the options leg.
	var direction, optType, optAction string
	if bullishCross {
		direction = "BUY"
		if c.SellSide {
			optType, optAction = "PE", "SELL"
		} else {
			optType, optAction = "CE", "BUY"
		}
	} else {
		direction = "SELL"
		if c.SellSide {
			optType, optAction = "CE", "SELL"
		} else {
			optType, optAction = "PE", "BUY"
		}
	}

	strike := selectStrike(price, optType, c.StrikeStep, c.OTMOffset)

	// 1:RewardRisk on the underlying.
	stopDist := price * c.StopLossPct / 100
	var target, stop float64
	if direction == "BUY" {
		stop = price - stopDist
		target = price + stopDist*c.RewardRisk
	} else {
		stop = price + stopDist
		target = price - stopDist*c.RewardRisk
	}

	volX := float64(last.Volume) / avgVol
	reason := fmt.Sprintf(
		"EMA%d/%d %s cross + VWAP ok + vol %.1f× avg → %s %.0f %s; 1:%.1f R:R (stop %.2f, target %.2f). OI-gated by engine.",
		c.FastEMA, c.SlowEMA, map[bool]string{true: "bull", false: "bear"}[bullishCross],
		volX, optAction, strike, optType, c.RewardRisk, stop, target,
	)

	return &TradeCall{
		Symbol:       symbol,
		Direction:    direction,
		Strategy:     s.Name(),
		Price:        price,
		Target:       target,
		StopLoss:     stop,
		Confidence:   confidence,
		Reason:       reason,
		OptionType:   optType,
		OptionAction: optAction,
		Strike:       strike,
	}
}

// avgVolume returns the mean volume of the `lookback` candles immediately before
// the last (signal) candle. Returns 0 when there aren't enough bars.
func avgCandleVolume(candles []data.Candle, lookback int) float64 {
	n := len(candles)
	if n < lookback+1 || lookback < 1 {
		return 0
	}
	var sum float64
	for i := n - 1 - lookback; i < n-1; i++ {
		sum += float64(candles[i].Volume)
	}
	return sum / float64(lookback)
}
