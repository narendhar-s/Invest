package strategy

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"stockwise/internal/data"
)

// ─── Personal Strategy ────────────────────────────────────────────────────────
//
// A fully configurable, systematic intraday options strategy. It derives a
// directional view on the underlying from a price trigger (EMA cross) with
// optional RSI and VWAP filters, then expresses that view on the *options* side
// per the configured bias:
//
//	bullish view  → BUY CE   (or SELL PE  when SellSide is on)
//	bearish view  → BUY PE   (or SELL CE  when SellSide is on)
//
// The chosen strike is ATM ± (OTMOffset × StrikeStep). Direction stays BUY/SELL
// on the underlying so the engine's OI-confirmation filter still gates the call:
// a bearish option-chain blocks bullish calls and vice-versa, which is exactly
// the "co-relate buy/sell with OI" requirement. Every knob below is editable from
// the frontend strategy editor and persisted to disk so it survives restarts.
//
// This is intended for intraday use on liquid index/F&O underlyings (e.g. Nifty
// 50 and large F&O stocks).

// PersonalConfig holds every tunable parameter of the Personal Strategy. Field
// json tags double as the keys the frontend editor renders.
type PersonalConfig struct {
	// Price trigger
	FastEMA int `json:"fast_ema"` // fast EMA period
	SlowEMA int `json:"slow_ema"` // slow EMA period

	// Optional momentum / mean filters
	UseRSIGuard   bool    `json:"use_rsi_guard"`  // block longs when overbought, shorts when oversold
	RSIPeriod     int     `json:"rsi_period"`     // RSI lookback
	RSIOverbought float64 `json:"rsi_overbought"` // above this, no fresh CE buy
	RSIOversold   float64 `json:"rsi_oversold"`   // below this, no fresh PE buy
	UseVWAPFilter bool    `json:"use_vwap_filter"` // longs only above VWAP, shorts only below

	// Options leg construction
	StrikeStep float64 `json:"strike_step"` // strike interval of the chain (e.g. 50 Nifty)
	OTMOffset  int     `json:"otm_offset"`  // strikes out-of-the-money (0 = ATM)
	SellSide   bool    `json:"sell_side"`   // false = buy premium; true = sell premium

	// Risk on the underlying move (premium SL/TP follow the same proxy)
	TargetPct   float64 `json:"target_pct"`    // profit target as % of underlying price
	StopLossPct float64 `json:"stop_loss_pct"` // stop as % of underlying price

	// Gating
	MinConfidence float64 `json:"min_confidence"` // suppress calls below this confidence
	StartTime     string  `json:"start_time"`     // intraday window open  "HH:MM"
	EndTime       string  `json:"end_time"`       // intraday window close "HH:MM"
	MinCandlesReq int     `json:"min_candles"`    // bars required before evaluating
}

// defaultPersonalConfig returns sensible balanced-risk defaults tuned for Nifty
// 50 / large F&O stocks on a 5-minute intraday timeframe.
func defaultPersonalConfig() PersonalConfig {
	return PersonalConfig{
		FastEMA:       9,
		SlowEMA:       21,
		UseRSIGuard:   true,
		RSIPeriod:     14,
		RSIOverbought: 75,
		RSIOversold:   25,
		UseVWAPFilter: true,
		StrikeStep:    50,
		OTMOffset:     0,
		SellSide:      false,
		TargetPct:     0.6,
		StopLossPct:   0.3,
		MinConfidence: 60,
		StartTime:     "09:30",
		EndTime:       "15:00",
		MinCandlesReq: 25,
	}
}

// personalStrategy is the registered, configurable LiveStrategy.
type personalStrategy struct {
	mu  sync.RWMutex
	cfg PersonalConfig
}

func newPersonalStrategy() *personalStrategy {
	s := &personalStrategy{cfg: defaultPersonalConfig()}
	s.loadFromDisk() // overlay any persisted edits
	return s
}

func (s *personalStrategy) Key() string  { return "personal" }
func (s *personalStrategy) Name() string { return "Personal Strategy" }
func (s *personalStrategy) Description() string {
	return "Configurable intraday options strategy: EMA trigger + RSI/VWAP filters, OI-confirmed, mapped to CE/PE buy or sell legs."
}

func (s *personalStrategy) MinCandles() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := s.cfg.MinCandlesReq
	if n < s.cfg.SlowEMA+2 {
		n = s.cfg.SlowEMA + 2
	}
	return n
}

// ─── Configurable implementation ──────────────────────────────────────────────

func (s *personalStrategy) Config() any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg
}

func (s *personalStrategy) Defaults() any { return defaultPersonalConfig() }

func (s *personalStrategy) SetConfig(raw json.RawMessage) error {
	// Start from current config so partial updates merge cleanly.
	s.mu.RLock()
	merged := s.cfg
	s.mu.RUnlock()

	if err := json.Unmarshal(raw, &merged); err != nil {
		return fmt.Errorf("invalid personal config: %w", err)
	}
	if err := validatePersonalConfig(&merged); err != nil {
		return err
	}

	s.mu.Lock()
	s.cfg = merged
	s.mu.Unlock()
	s.saveToDisk()
	return nil
}

// validatePersonalConfig clamps/validates values so a bad edit can never crash
// the live engine.
func validatePersonalConfig(c *PersonalConfig) error {
	if c.FastEMA < 1 || c.SlowEMA < 2 {
		return fmt.Errorf("EMA periods must be positive")
	}
	if c.FastEMA >= c.SlowEMA {
		return fmt.Errorf("fast_ema must be smaller than slow_ema")
	}
	if c.RSIPeriod < 2 {
		c.RSIPeriod = 14
	}
	if c.StrikeStep <= 0 {
		c.StrikeStep = 50
	}
	if c.OTMOffset < 0 {
		c.OTMOffset = 0
	}
	if c.TargetPct <= 0 {
		c.TargetPct = 0.6
	}
	if c.StopLossPct <= 0 {
		c.StopLossPct = 0.3
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

// personalConfigPath is where edits are stored so they outlive a restart.
func personalConfigPath() string {
	if dir := os.Getenv("STOCKWISE_DATA_DIR"); dir != "" {
		return filepath.Join(dir, "personal_strategy.json")
	}
	return "personal_strategy.json"
}

func (s *personalStrategy) saveToDisk() {
	s.mu.RLock()
	cfg := s.cfg
	s.mu.RUnlock()
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(personalConfigPath(), b, 0o644)
}

func (s *personalStrategy) loadFromDisk() {
	b, err := os.ReadFile(personalConfigPath())
	if err != nil {
		return
	}
	cfg := s.cfg
	if err := json.Unmarshal(b, &cfg); err != nil {
		return
	}
	if err := validatePersonalConfig(&cfg); err != nil {
		return
	}
	s.cfg = cfg
}

// ─── evaluation ───────────────────────────────────────────────────────────────

func (s *personalStrategy) Evaluate(symbol string, candles []data.Candle) *TradeCall {
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

	// Optional RSI guard.
	if c.UseRSIGuard {
		r := rsi(closes, c.RSIPeriod)
		cur := r[len(r)-1]
		if bullishCross && cur >= c.RSIOverbought {
			return nil // too hot to chase a long
		}
		if bearishCross && cur <= c.RSIOversold {
			return nil // too cold to chase a short
		}
	}

	// Optional VWAP filter.
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

	// Confidence: scaled by EMA separation (momentum strength).
	sep := math.Abs(curFast-curSlow) / price * 100 // % separation
	confidence := 60 + math.Min(sep*8, 30)         // 60..90
	if confidence < c.MinConfidence {
		return nil
	}

	// Build the options leg from the directional view.
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

	var target, stop float64
	if direction == "BUY" {
		target = price * (1 + c.TargetPct/100)
		stop = price * (1 - c.StopLossPct/100)
	} else {
		target = price * (1 - c.TargetPct/100)
		stop = price * (1 + c.StopLossPct/100)
	}

	trigger := fmt.Sprintf("EMA%d/%d %s cross", c.FastEMA, c.SlowEMA,
		map[bool]string{true: "bull", false: "bear"}[bullishCross])
	reason := fmt.Sprintf("%s → %s %.0f %s @ underlying %.2f", trigger, optAction, strike, optType, price)

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

// selectStrike returns the option strike: ATM (nearest step) shifted by offset
// strikes out-of-the-money. CE goes OTM upward, PE downward.
func selectStrike(spot float64, optType string, step float64, offset int) float64 {
	if step <= 0 {
		step = 50
	}
	atm := math.Round(spot/step) * step
	shift := float64(offset) * step
	if strings.EqualFold(optType, "CE") {
		return atm + shift
	}
	return atm - shift
}

// istLocation is the IST trading-session zone. Candle timestamps arrive in mixed
// zones — historical/seed bars are stamped UTC (yahoo.go, kite_market.go) while
// live ticks use the server's local clock — so the window check normalises the
// instant to IST before reading the wall-clock time. Falls back to a fixed +5:30
// offset if the tzdata name can't be loaded.
var istLocation = func() *time.Location {
	if loc, err := time.LoadLocation("Asia/Kolkata"); err == nil {
		return loc
	}
	return time.FixedZone("IST", 5*3600+30*60)
}()

// withinWindow reports whether t's IST clock time falls in [start, end]. Empty
// bounds are treated as open-ended.
func withinWindow(t time.Time, start, end string) bool {
	t = t.In(istLocation)
	mins := t.Hour()*60 + t.Minute()
	if start != "" {
		if sm, err := parseClock(start); err == nil && mins < sm {
			return false
		}
	}
	if end != "" {
		if em, err := parseClock(end); err == nil && mins > em {
			return false
		}
	}
	return true
}

// parseClock parses "HH:MM" into minutes-since-midnight.
func parseClock(s string) (int, error) {
	var h, m int
	if _, err := fmt.Sscanf(s, "%d:%d", &h, &m); err != nil {
		return 0, err
	}
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, fmt.Errorf("out of range")
	}
	return h*60 + m, nil
}
