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

// ─── Uncle-ORB Pattern ────────────────────────────────────────────────────────
//
// A faithful Go port of the "ORB Scanner" Streamlit app (orb_app.py). It is a
// richer Opening Range Breakout than the bare `orb` strategy: a breakout is only
// taken when it also clears a stack of quality filters, and — crucially — if the
// breakout bar fails the filters, the setup stays *pending* while price holds
// beyond the opening range, and the signal fires on the first later bar where
// every filter passes (the "continuation" improvement documented in the app).
//
// Per the app's own rules:
//
//	Opening range : first OpeningMinutes of the session set OR High / OR Low /
//	                OR Width (= High − Low).
//	Filters       : trend (close vs EMA + session VWAP), volume (≥ VolMult ×
//	                rolling average), liquidity (close × volume ≥ LiqMinValue),
//	                volatility quality (intraday ATR ratio ≥ MinATRRatio),
//	                OR-width validity (≥ ORMinPctATR and not below ORTooTightPct
//	                of intraday ATR), and a last-entry-time cutoff.
//	Entry  (BUY)  : max(OR High, signal-bar High).
//	Stop   (BUY)  : Entry − StopMult × OR Width      (0.5 ORB).
//	T1     (BUY)  : Entry + T1Mult  × OR Width        (1.0 ORB) — primary target.
//	T2     (BUY)  : Entry + T2Mult  × OR Width        (1.5 ORB) — surfaced in note.
//	(SELL mirrors all of the above.)
//
// Note on the ATR reference: the Streamlit app measures OR width and the
// volatility-quality ratio against the *daily* ATR, which it pulls from a
// separate daily feed. The live engine evaluates a rolling window of intraday
// candles only, so this port uses the intraday ATR (and its session average) as
// the volatility reference. The defaults below are tuned for that intraday
// reference rather than copied verbatim from the daily-ATR app.
//
// Direction is BUY/SELL on the underlying so the engine's consensus and
// OI-confirmation filters still gate the call. The engine owns execution and
// exits; this strategy emits the entry, stop, and primary target.

// UncleORBConfig holds every tunable parameter. JSON tags double as the keys the
// frontend strategy editor renders.
type UncleORBConfig struct {
	// Opening range
	OpeningMinutes int `json:"opening_minutes"` // length of the opening range (15)

	// Trend / momentum filter
	EntryEMALen int `json:"entry_ema_len"` // EMA the close must clear (21)

	// Volume + liquidity
	VolLen      int     `json:"vol_len"`       // rolling volume-average window (20)
	VolMult     float64 `json:"vol_mult"`      // breakout bar volume ≥ avg × this (1.20)
	LiqMinValue float64 `json:"liq_min_value"` // min close × volume on the signal bar (20m)

	// Volatility quality (intraday ATR)
	ATRLength   int     `json:"atr_len"`       // intraday ATR window (14)
	MinATRRatio float64 `json:"min_atr_ratio"` // skip if ATR(now)/ATR(session avg) below this (0.70)

	// Opening-range width validity (× intraday ATR)
	ORMinPctATR   float64 `json:"or_min_pct_atr"`   // OR width must be ≥ this × ATR (0.50)
	ORTooTightPct float64 `json:"or_too_tight_pct"` // reject if OR width < this × ATR (0.30)

	// Trade geometry (× OR width)
	StopMult float64 `json:"stop_mult"` // stop distance     (0.50)
	T1Mult   float64 `json:"t1_mult"`   // primary target    (1.00)
	T2Mult   float64 `json:"t2_mult"`   // stretch target    (1.50)

	// Gating
	MinConfidence float64 `json:"min_confidence"` // suppress calls below this confidence
	LastEntry     string  `json:"last_entry"`     // no new entries after this "HH:MM" (15:00)
	MinCandlesReq int     `json:"min_candles"`    // bars required before evaluating
}

// defaultUncleORBConfig returns the app-derived defaults (tuned for the intraday
// ATR reference — see the package note above).
func defaultUncleORBConfig() UncleORBConfig {
	return UncleORBConfig{
		OpeningMinutes: 15,
		EntryEMALen:    21,
		VolLen:         20,
		VolMult:        1.20,
		LiqMinValue:    20000000,
		ATRLength:      14,
		MinATRRatio:    0.70,
		ORMinPctATR:    0.50,
		ORTooTightPct:  0.30,
		StopMult:       0.50,
		T1Mult:         1.00,
		T2Mult:         1.50,
		MinConfidence:  60,
		LastEntry:      "15:00",
		MinCandlesReq:  8,
	}
}

// uncleORBStrategy is the registered, configurable LiveStrategy.
type uncleORBStrategy struct {
	mu  sync.RWMutex
	cfg UncleORBConfig
}

func newUncleORBStrategy() *uncleORBStrategy {
	s := &uncleORBStrategy{cfg: defaultUncleORBConfig()}
	s.loadFromDisk()
	return s
}

func (s *uncleORBStrategy) Key() string  { return "uncle_orb" }
func (s *uncleORBStrategy) Name() string { return "Uncle-ORB Pattern" }
func (s *uncleORBStrategy) Description() string {
	return "Opening Range Breakout with trend (EMA+VWAP), volume, liquidity, ATR-quality and OR-width filters; breakouts that fail filters stay pending and fire on the first qualifying bar. Stop 0.5×ORB, targets 1.0/1.5×ORB."
}

func (s *uncleORBStrategy) MinCandles() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := s.cfg.MinCandlesReq
	floor := s.cfg.EntryEMALen + 2
	if s.cfg.ATRLength+2 > floor {
		floor = s.cfg.ATRLength + 2
	}
	if n < floor {
		n = floor
	}
	return n
}

// ─── Configurable implementation ──────────────────────────────────────────────

func (s *uncleORBStrategy) Config() any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg
}

func (s *uncleORBStrategy) Defaults() any { return defaultUncleORBConfig() }

func (s *uncleORBStrategy) SetConfig(raw json.RawMessage) error {
	s.mu.RLock()
	merged := s.cfg
	s.mu.RUnlock()

	if err := json.Unmarshal(raw, &merged); err != nil {
		return fmt.Errorf("invalid uncle_orb config: %w", err)
	}
	if err := validateUncleORBConfig(&merged); err != nil {
		return err
	}

	s.mu.Lock()
	s.cfg = merged
	s.mu.Unlock()
	s.saveToDisk()
	return nil
}

// validateUncleORBConfig clamps values so a bad edit can never crash the engine.
func validateUncleORBConfig(c *UncleORBConfig) error {
	if c.OpeningMinutes < 1 {
		return fmt.Errorf("opening_minutes must be positive")
	}
	if c.EntryEMALen < 1 {
		return fmt.Errorf("entry_ema_len must be positive")
	}
	if c.VolLen < 1 {
		c.VolLen = 20
	}
	if c.VolMult < 0 {
		c.VolMult = 0
	}
	if c.LiqMinValue < 0 {
		c.LiqMinValue = 0
	}
	if c.ATRLength < 1 {
		c.ATRLength = 14
	}
	if c.MinATRRatio < 0 {
		c.MinATRRatio = 0
	}
	if c.ORMinPctATR < 0 {
		c.ORMinPctATR = 0
	}
	if c.ORTooTightPct < 0 {
		c.ORTooTightPct = 0
	}
	if c.StopMult <= 0 {
		return fmt.Errorf("stop_mult must be positive")
	}
	if c.T1Mult <= 0 {
		c.T1Mult = 1.0
	}
	if c.T2Mult <= 0 {
		c.T2Mult = 1.5
	}
	if c.MinConfidence < 0 {
		c.MinConfidence = 0
	}
	if c.MinCandlesReq < 5 {
		c.MinCandlesReq = 5
	}
	if _, err := parseClock(c.LastEntry); c.LastEntry != "" && err != nil {
		return fmt.Errorf("invalid last_entry, expected HH:MM")
	}
	return nil
}

// ─── persistence ──────────────────────────────────────────────────────────────

func uncleORBConfigPath() string {
	if dir := os.Getenv("STOCKWISE_DATA_DIR"); dir != "" {
		return filepath.Join(dir, "uncle_orb_strategy.json")
	}
	return "uncle_orb_strategy.json"
}

func (s *uncleORBStrategy) saveToDisk() {
	s.mu.RLock()
	cfg := s.cfg
	s.mu.RUnlock()
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(uncleORBConfigPath(), b, 0o644)
}

func (s *uncleORBStrategy) loadFromDisk() {
	b, err := os.ReadFile(uncleORBConfigPath())
	if err != nil {
		return
	}
	cfg := s.cfg
	if err := json.Unmarshal(b, &cfg); err != nil {
		return
	}
	if err := validateUncleORBConfig(&cfg); err != nil {
		return
	}
	s.cfg = cfg
}

// ─── evaluation ───────────────────────────────────────────────────────────────

func (s *uncleORBStrategy) Evaluate(symbol string, candles []data.Candle) *TradeCall {
	s.mu.RLock()
	c := s.cfg
	s.mu.RUnlock()

	if len(candles) < s.MinCandles() {
		return nil
	}

	day := todaysCandles(candles)
	perCandle := intervalMinutes(day[len(day)-1].Interval)
	rangeCandles := c.OpeningMinutes / perCandle
	if rangeCandles < 1 {
		rangeCandles = 1
	}
	// Need the full opening range plus at least two candles after it (one to
	// confirm a prior state, one to be the current trigger bar).
	if len(day) <= rangeCandles+1 {
		return nil
	}

	// ── Opening range ──
	orHigh, orLow := day[0].High, day[0].Low
	for i := 1; i < rangeCandles; i++ {
		if day[i].High > orHigh {
			orHigh = day[i].High
		}
		if day[i].Low < orLow {
			orLow = day[i].Low
		}
	}
	orWidth := orHigh - orLow
	if orWidth <= 0 {
		return nil
	}

	// ── Per-bar indicator series over the session ──
	n := len(day)
	closes := closesOf(day)
	emaEntry := ema(closes, c.EntryEMALen)
	vwap := runningSessionVWAP(day)
	volAvg := rollingVolAvg(day, c.VolLen)
	atrIntra := atr(day, c.ATRLength) // Wilder ATR aligned to `day`

	// Session-average ATR up to each bar, for the volatility-quality ratio.
	atrAvg := make([]float64, n)
	var atrSum float64
	for i := 0; i < n; i++ {
		atrSum += atrIntra[i]
		atrAvg[i] = atrSum / float64(i+1)
	}

	orMin := c.ORMinPctATR
	orTight := c.ORTooTightPct

	// filtersOK reports whether every quality filter passes for a long/short at
	// bar i (mirrors addfiltersandsignals in orb_app.py).
	filtersOK := func(i int, long bool) bool {
		bar := day[i]
		atrRef := atrIntra[i]
		if atrRef <= 0 {
			return false
		}
		// OR-width validity (against intraday ATR).
		orRatio := orWidth / atrRef
		if orRatio < orMin || orRatio < orTight {
			return false
		}
		// Volatility quality: recent ATR vs session-average ATR.
		if atrAvg[i] <= 0 || atrIntra[i]/atrAvg[i] < c.MinATRRatio {
			return false
		}
		// Volume confirmation.
		if volAvg[i] <= 0 || float64(bar.Volume) < volAvg[i]*c.VolMult {
			return false
		}
		// Liquidity.
		if bar.Close*float64(bar.Volume) < c.LiqMinValue {
			return false
		}
		// Last-entry-time cutoff.
		if c.LastEntry != "" && !withinWindow(bar.Start, "", c.LastEntry) {
			return false
		}
		// Trend alignment: close beyond both EMA and session VWAP.
		if long {
			return bar.Close > emaEntry[i] && bar.Close > vwap[i]
		}
		return bar.Close < emaEntry[i] && bar.Close < vwap[i]
	}

	// ── Pending-breakout state machine over the post-OR bars ──
	// qualifying[i] is true when, at bar i, a breakout is active in some
	// direction AND that bar's filters pass. We emit on the first qualifying bar
	// (edge trigger) so the call fires once per setup, not on every later bar.
	type qstate struct {
		ok  bool
		dir string // "BUY" / "SELL"
	}
	qual := make([]qstate, n)

	longActive, shortActive := false, false
	for i := rangeCandles; i < n; i++ {
		prev := day[i-1]
		cur := day[i]

		// Breakout detection on the close.
		if prev.Close <= orHigh && cur.Close > orHigh {
			longActive, shortActive = true, false
		} else if prev.Close >= orLow && cur.Close < orLow {
			shortActive, longActive = true, false
		}
		// Setup invalidated if price closes back inside the opening range.
		if longActive && cur.Close <= orHigh {
			longActive = false
		}
		if shortActive && cur.Close >= orLow {
			shortActive = false
		}

		switch {
		case longActive && filtersOK(i, true):
			qual[i] = qstate{ok: true, dir: "BUY"}
		case shortActive && filtersOK(i, false):
			qual[i] = qstate{ok: true, dir: "SELL"}
		}
	}

	last := qual[n-1]
	if !last.ok {
		return nil
	}
	// Edge trigger: only fire if the previous bar was not already qualifying in
	// the same direction (first qualifying bar of this setup).
	if qual[n-2].ok && qual[n-2].dir == last.dir {
		return nil
	}

	cur := day[n-1]
	var entry, stop, t1, t2 float64
	if last.dir == "BUY" {
		entry = math.Max(orHigh, cur.High)
		stop = entry - c.StopMult*orWidth
		t1 = entry + c.T1Mult*orWidth
		t2 = entry + c.T2Mult*orWidth
	} else {
		entry = math.Min(orLow, cur.Low)
		stop = entry + c.StopMult*orWidth
		t1 = entry - c.T1Mult*orWidth
		t2 = entry - c.T2Mult*orWidth
	}

	// Confidence: base ORB conviction, lifted by how strongly the signal bar's
	// volume beat its average (capped).
	volStrength := 0.0
	if volAvg[n-1] > 0 {
		volStrength = float64(cur.Volume) / volAvg[n-1]
	}
	confidence := 64 + math.Min((volStrength-1)*20, 24) // 64..88
	if confidence < c.MinConfidence {
		return nil
	}

	reason := fmt.Sprintf(
		"%s breakout of opening range [%.2f–%.2f] (width %.2f); filters passed (trend/vol/liq/ATR). Entry %.2f, stop %.2f (%.2g×ORB), T1 %.2f (%.2g×ORB), T2 %.2f (%.2g×ORB)",
		map[string]string{"BUY": "Long", "SELL": "Short"}[last.dir],
		orLow, orHigh, orWidth, entry, stop, c.StopMult, t1, c.T1Mult, t2, c.T2Mult,
	)

	return &TradeCall{
		Symbol:     symbol,
		Direction:  last.dir,
		Strategy:   s.Name(),
		Price:      entry,
		Target:     t1,
		StopLoss:   stop,
		Confidence: confidence,
		Reason:     reason,
	}
}

// ─── series helpers ───────────────────────────────────────────────────────────

// runningSessionVWAP returns the cumulative session VWAP up to and including each
// bar (typical-price × volume, running). Mirrors vwapseries() in orb_app.py.
func runningSessionVWAP(candles []data.Candle) []float64 {
	out := make([]float64, len(candles))
	var pv, vol float64
	for i, cd := range candles {
		typical := (cd.High + cd.Low + cd.Close) / 3
		v := float64(cd.Volume)
		if v < 0 {
			v = 0
		}
		pv += typical * v
		vol += v
		if vol > 0 {
			out[i] = pv / vol
		} else {
			out[i] = typical
		}
	}
	return out
}

// rollingVolAvg returns the trailing simple moving average of volume aligned to
// the input (min_periods=1, like the pandas rolling mean in orb_app.py).
func rollingVolAvg(candles []data.Candle, window int) []float64 {
	out := make([]float64, len(candles))
	if window < 1 {
		window = 1
	}
	for i := range candles {
		start := i - window + 1
		if start < 0 {
			start = 0
		}
		var sum float64
		for j := start; j <= i; j++ {
			sum += float64(candles[j].Volume)
		}
		out[i] = sum / float64(i-start+1)
	}
	return out
}
