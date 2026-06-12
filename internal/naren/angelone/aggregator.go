package angelone

// CandleAggregator builds 5-min OHLCV candles from live ticks.
// Thread-safe. Broadcasts completed candles to all subscribers.

import (
	"sync"
	"time"
)

// LiveCandle is a 5-min candle being built from ticks.
type LiveCandle struct {
	Time   time.Time // bar open time (truncated to 5m)
	Open   float64
	High   float64
	Low    float64
	Close  float64
	Volume int64
	Ticks  int
}

// CandleUpdate is pushed to subscribers.
type CandleUpdate struct {
	Token  string
	Candle LiveCandle
	Final  bool // true when candle closed (new period started)
}

// CandleHandler receives live candle updates.
type CandleHandler func(CandleUpdate)

// CandleAggregator aggregates ticks into fixed-period candles.
type CandleAggregator struct {
	period   time.Duration
	mu       sync.Mutex
	current  map[string]*LiveCandle // token → current bar
	subs     []CandleHandler
	subMu    sync.RWMutex
	history  map[string][]LiveCandle // last N completed candles
	maxHist  int
}

// NewCandleAggregator creates a new aggregator with the given period.
func NewCandleAggregator(period time.Duration, maxHistory int) *CandleAggregator {
	return &CandleAggregator{
		period:  period,
		current: make(map[string]*LiveCandle),
		history: make(map[string][]LiveCandle),
		maxHist: maxHistory,
	}
}

// Subscribe registers a handler for candle updates.
func (a *CandleAggregator) Subscribe(h CandleHandler) {
	a.subMu.Lock()
	a.subs = append(a.subs, h)
	a.subMu.Unlock()
}

// AddTick processes a single tick and updates/closes the current candle.
func (a *CandleAggregator) AddTick(t Tick) {
	a.mu.Lock()
	defer a.mu.Unlock()

	barTime := t.Time.Truncate(a.period)
	cur, exists := a.current[t.Token]

	if !exists || !cur.Time.Equal(barTime) {
		// Close the previous candle
		if exists && cur.Ticks > 0 {
			closed := *cur
			a.appendHistory(t.Token, closed)
			a.notify(CandleUpdate{Token: t.Token, Candle: closed, Final: true})
		}
		// Start new candle
		cur = &LiveCandle{
			Time:  barTime,
			Open:  t.LTP,
			High:  t.LTP,
			Low:   t.LTP,
			Close: t.LTP,
		}
		a.current[t.Token] = cur
	}

	// Update current candle
	if t.LTP > cur.High {
		cur.High = t.LTP
	}
	if t.LTP < cur.Low {
		cur.Low = t.LTP
	}
	cur.Close = t.LTP
	cur.Volume += t.Volume
	cur.Ticks++

	// Broadcast live update
	snapshot := *cur
	a.notify(CandleUpdate{Token: t.Token, Candle: snapshot, Final: false})
}

// History returns the last N completed candles for a token.
func (a *CandleAggregator) History(token string) []LiveCandle {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]LiveCandle{}, a.history[token]...)
}

// Current returns the live in-progress candle for a token (may be nil).
func (a *CandleAggregator) Current(token string) *LiveCandle {
	a.mu.Lock()
	defer a.mu.Unlock()
	if c, ok := a.current[token]; ok {
		cp := *c
		return &cp
	}
	return nil
}

func (a *CandleAggregator) appendHistory(token string, c LiveCandle) {
	h := a.history[token]
	h = append(h, c)
	if len(h) > a.maxHist {
		h = h[len(h)-a.maxHist:]
	}
	a.history[token] = h
}

func (a *CandleAggregator) notify(u CandleUpdate) {
	a.subMu.RLock()
	hs := a.subs
	a.subMu.RUnlock()
	for _, h := range hs {
		h(u)
	}
}
