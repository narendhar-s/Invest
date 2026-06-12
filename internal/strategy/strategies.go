package strategy

import (
	"encoding/json"
	"fmt"
	"os"

	"stockwise/internal/data"
)

// forcedTestCall returns a synthetic BUY call when STOCKWISE_FORCE_SIGNAL=1, so
// the live feed + alert sound can be exercised on the next candle without waiting
// for a real setup. It is a TEST hook only — unset the env var (and rebuild) to
// disable. Returns nil when the flag is off or there are no candles.
func forcedTestCall(symbol, strategyName string, candles []data.Candle) *TradeCall {
	if os.Getenv("STOCKWISE_FORCE_SIGNAL") != "1" || len(candles) == 0 {
		return nil
	}
	price := candles[len(candles)-1].Close
	return &TradeCall{
		Symbol: symbol, Direction: "BUY", Strategy: strategyName,
		Price: price, Target: price * 1.005, StopLoss: price * 0.997,
		Confidence: 99,
		Reason:     "FORCED TEST SIGNAL (STOCKWISE_FORCE_SIGNAL=1) — unset the env var to disable",
	}
}

// TradeCall is a single actionable call produced by a live strategy.
//
// Direction is always the view on the *underlying* (BUY = bullish, SELL =
// bearish) — this is what the consensus engine and the OI-confirmation filter
// reason about. The optional Option* fields express how that view is taken on
// the options side: which option to trade (CE/PE), whether to buy or sell the
// premium, and at which strike. Strategies that trade the cash/underlying leave
// these empty.
type TradeCall struct {
	Symbol     string  `json:"symbol"`
	Direction  string  `json:"direction"` // BUY / SELL (view on the underlying)
	Strategy   string  `json:"strategy"`
	Price      float64 `json:"price"`
	Target     float64 `json:"target"`
	StopLoss   float64 `json:"stop_loss"`
	Confidence float64 `json:"confidence"`
	Reason     string  `json:"reason"`

	// Options leg (optional). Populated by options strategies such as Personal.
	OptionType   string  `json:"option_type,omitempty"`   // CE / PE
	OptionAction string  `json:"option_action,omitempty"` // BUY / SELL of the premium
	Strike       float64 `json:"strike,omitempty"`        // chosen option strike
}

// LiveStrategy evaluates a rolling window of closed candles for one symbol and
// returns a TradeCall, or nil when there is no high-probability setup.
type LiveStrategy interface {
	Key() string
	Name() string
	Description() string
	MinCandles() int
	Evaluate(symbol string, candles []data.Candle) *TradeCall
}

// StrategyMeta is the dropdown-friendly descriptor surfaced to the frontend.
type StrategyMeta struct {
	Key          string `json:"key"`
	Name         string `json:"name"`
	Description  string `json:"description"`
	Configurable bool   `json:"configurable"` // true when the strategy exposes an editable config
}

// Configurable is implemented by strategies whose behaviour is driven by an
// editable config object. The frontend strategy editor reads Config(), renders
// a form, and writes the edited object back via SetConfig(). Defaults() lets the
// UI offer a "reset" and seed a form before any save.
type Configurable interface {
	Config() any
	Defaults() any
	SetConfig(raw json.RawMessage) error
}

// registry holds all registered live strategies. Populated by init() in this
// and other files via Register(). registryOrder preserves registration order so
// the UI dropdown is deterministic.
var (
	registry      = map[string]LiveStrategy{}
	registryOrder []string
)

// Register adds a strategy to the global registry. Call from an init() in any
// file to make a new strategy available — that is the only wiring needed.
func Register(s LiveStrategy) {
	if _, exists := registry[s.Key()]; !exists {
		registryOrder = append(registryOrder, s.Key())
	}
	registry[s.Key()] = s
}

func init() {
	Register(&emaCrossover{})
	Register(&rsiReversal{})
	Register(&vwapScalp{})
	Register(newPersonalStrategy())
	Register(newTripleAxiomStrategy())
	Register(newPersonalEMAStrategy())
	Register(newUncleORBStrategy())
}

// Registry returns the map of all available live strategies keyed by Key().
func Registry() map[string]LiveStrategy {
	return registry
}

// Get returns a single registered strategy by key.
func Get(key string) (LiveStrategy, bool) {
	s, ok := registry[key]
	return s, ok
}

func errUnknownStrategy(key string) error {
	return fmt.Errorf("unknown strategy: %s", key)
}

// errNoDataSource indicates no seed/historical data source is configured.
var errNoDataSource = fmt.Errorf("no historical data source configured")

// AvailableStrategies returns dropdown metadata for the UI in registration order.
func AvailableStrategies() []StrategyMeta {
	out := make([]StrategyMeta, 0, len(registryOrder))
	for _, key := range registryOrder {
		s := registry[key]
		_, cfg := s.(Configurable)
		out = append(out, StrategyMeta{Key: s.Key(), Name: s.Name(), Description: s.Description(), Configurable: cfg})
	}
	return out
}

// ─── EMA crossover ──────────────────────────────────────────────────────────────

type emaCrossover struct{}

func (s *emaCrossover) Key() string         { return "ema_crossover" }
func (s *emaCrossover) Name() string        { return "EMA 9/21 Crossover" }
func (s *emaCrossover) Description() string { return "Buys when EMA9 crosses above EMA21, sells on the reverse cross." }
func (s *emaCrossover) MinCandles() int     { return 25 }

func (s *emaCrossover) Evaluate(symbol string, candles []data.Candle) *TradeCall {
	if len(candles) < s.MinCandles() {
		return nil
	}
	closes := closesOf(candles)
	fast := ema(closes, 9)
	slow := ema(closes, 21)
	n := len(closes)
	prevFast, prevSlow := fast[n-2], slow[n-2]
	curFast, curSlow := fast[n-1], slow[n-1]
	price := closes[n-1]

	switch {
	case prevFast <= prevSlow && curFast > curSlow:
		return &TradeCall{
			Symbol: symbol, Direction: "BUY", Strategy: s.Name(),
			Price: price, Target: price * 1.006, StopLoss: price * 0.997,
			Confidence: 68, Reason: "EMA9 crossed above EMA21 — bullish momentum",
		}
	case prevFast >= prevSlow && curFast < curSlow:
		return &TradeCall{
			Symbol: symbol, Direction: "SELL", Strategy: s.Name(),
			Price: price, Target: price * 0.994, StopLoss: price * 1.003,
			Confidence: 66, Reason: "EMA9 crossed below EMA21 — bearish momentum",
		}
	}
	return nil
}

// ─── RSI reversal ────────────────────────────────────────────────────────────────

type rsiReversal struct{}

func (s *rsiReversal) Key() string         { return "rsi_reversal" }
func (s *rsiReversal) Name() string        { return "RSI Reversal" }
func (s *rsiReversal) Description() string { return "Buys oversold (RSI<30 turning up), sells overbought (RSI>70 turning down)." }
func (s *rsiReversal) MinCandles() int     { return 20 }

func (s *rsiReversal) Evaluate(symbol string, candles []data.Candle) *TradeCall {
	if len(candles) < s.MinCandles() {
		return nil
	}
	closes := closesOf(candles)
	r := rsi(closes, 14)
	n := len(r)
	prev, cur := r[n-2], r[n-1]
	price := closes[len(closes)-1]

	switch {
	case prev < 30 && cur >= 30:
		return &TradeCall{
			Symbol: symbol, Direction: "BUY", Strategy: s.Name(),
			Price: price, Target: price * 1.008, StopLoss: price * 0.996,
			Confidence: 64, Reason: fmt.Sprintf("RSI bounced from oversold (%.0f→%.0f)", prev, cur),
		}
	case prev > 70 && cur <= 70:
		return &TradeCall{
			Symbol: symbol, Direction: "SELL", Strategy: s.Name(),
			Price: price, Target: price * 0.992, StopLoss: price * 1.004,
			Confidence: 62, Reason: fmt.Sprintf("RSI rolled over from overbought (%.0f→%.0f)", prev, cur),
		}
	}
	return nil
}

// ─── VWAP scalp ──────────────────────────────────────────────────────────────────

type vwapScalp struct{}

func (s *vwapScalp) Key() string         { return "vwap_scalp" }
func (s *vwapScalp) Name() string        { return "VWAP Scalp" }
func (s *vwapScalp) Description() string { return "Scalps reclaims/rejections of the intraday VWAP with momentum confirmation." }
func (s *vwapScalp) MinCandles() int     { return 15 }

func (s *vwapScalp) Evaluate(symbol string, candles []data.Candle) *TradeCall {
	if tc := forcedTestCall(symbol, s.Name(), candles); tc != nil {
		return tc
	}
	if len(candles) < s.MinCandles() {
		return nil
	}
	vwap := sessionVWAP(candles)
	n := len(candles)
	prev := candles[n-2]
	cur := candles[n-1]
	price := cur.Close

	switch {
	case prev.Close <= vwap && cur.Close > vwap && cur.Close > cur.Open:
		return &TradeCall{
			Symbol: symbol, Direction: "BUY", Strategy: s.Name(),
			Price: price, Target: price * 1.005, StopLoss: vwap * 0.998,
			Confidence: 60, Reason: "Price reclaimed VWAP on an up candle — long scalp",
		}
	case prev.Close >= vwap && cur.Close < vwap && cur.Close < cur.Open:
		return &TradeCall{
			Symbol: symbol, Direction: "SELL", Strategy: s.Name(),
			Price: price, Target: price * 0.995, StopLoss: vwap * 1.002,
			Confidence: 58, Reason: "Price lost VWAP on a down candle — short scalp",
		}
	}
	return nil
}

// ─── indicator helpers ──────────────────────────────────────────────────────────

func closesOf(candles []data.Candle) []float64 {
	out := make([]float64, len(candles))
	for i, c := range candles {
		out[i] = c.Close
	}
	return out
}

// ema returns the exponential moving average series aligned to the input.
func ema(values []float64, period int) []float64 {
	out := make([]float64, len(values))
	if len(values) == 0 {
		return out
	}
	k := 2.0 / float64(period+1)
	out[0] = values[0]
	for i := 1; i < len(values); i++ {
		out[i] = values[i]*k + out[i-1]*(1-k)
	}
	return out
}

// rsi returns the Wilder RSI series aligned to the input (early values ~50).
func rsi(values []float64, period int) []float64 {
	out := make([]float64, len(values))
	for i := range out {
		out[i] = 50
	}
	if len(values) <= period {
		return out
	}
	var gain, loss float64
	for i := 1; i <= period; i++ {
		ch := values[i] - values[i-1]
		if ch >= 0 {
			gain += ch
		} else {
			loss -= ch
		}
	}
	avgGain := gain / float64(period)
	avgLoss := loss / float64(period)
	for i := period + 1; i < len(values); i++ {
		ch := values[i] - values[i-1]
		g, l := 0.0, 0.0
		if ch >= 0 {
			g = ch
		} else {
			l = -ch
		}
		avgGain = (avgGain*float64(period-1) + g) / float64(period)
		avgLoss = (avgLoss*float64(period-1) + l) / float64(period)
		if avgLoss == 0 {
			out[i] = 100
			continue
		}
		rs := avgGain / avgLoss
		out[i] = 100 - (100 / (1 + rs))
	}
	return out
}

// sessionVWAP computes a volume-weighted average price over the candle window.
func sessionVWAP(candles []data.Candle) float64 {
	var pv, vol float64
	for _, c := range candles {
		typical := (c.High + c.Low + c.Close) / 3
		v := float64(c.Volume)
		if v <= 0 {
			v = 1
		}
		pv += typical * v
		vol += v
	}
	if vol == 0 {
		return 0
	}
	return pv / vol
}
