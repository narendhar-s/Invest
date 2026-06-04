package data

import (
	"sync"
	"time"
)

// Candle is an OHLCV bar for a given interval. Closed=true once the interval
// has elapsed and no further ticks will be added.
type Candle struct {
	Symbol   string    `json:"symbol"`
	Interval string    `json:"interval"` // "1m","3m","5m","15m"
	Start    time.Time `json:"start"`
	Open     float64   `json:"open"`
	High     float64   `json:"high"`
	Low      float64   `json:"low"`
	Close    float64   `json:"close"`
	Volume   int64     `json:"volume"`
	Closed   bool      `json:"closed"`
}

// CandleAggregator folds a tick stream into fixed-interval OHLC candles and
// broadcasts closed candles to subscribers. One aggregator handles one interval.
type CandleAggregator struct {
	interval time.Duration
	label    string

	mu       sync.Mutex
	current  map[string]*Candle // symbol → in-progress candle
	lastVol  map[string]int64   // last cumulative volume seen per symbol

	subMu sync.RWMutex
	subs  map[chan Candle]struct{}
}

// NewCandleAggregator creates an aggregator for the given interval label.
func NewCandleAggregator(label string) *CandleAggregator {
	return &CandleAggregator{
		interval: intervalDuration(label),
		label:    label,
		current:  make(map[string]*Candle),
		lastVol:  make(map[string]int64),
		subs:     make(map[chan Candle]struct{}),
	}
}

func intervalDuration(label string) time.Duration {
	switch label {
	case "1m":
		return time.Minute
	case "3m":
		return 3 * time.Minute
	case "5m":
		return 5 * time.Minute
	case "15m":
		return 15 * time.Minute
	default:
		return 5 * time.Minute
	}
}

// Subscribe returns a channel that receives every closed candle.
func (a *CandleAggregator) Subscribe() chan Candle {
	ch := make(chan Candle, 128)
	a.subMu.Lock()
	a.subs[ch] = struct{}{}
	a.subMu.Unlock()
	return ch
}

// Unsubscribe removes and closes a subscriber channel.
func (a *CandleAggregator) Unsubscribe(ch chan Candle) {
	a.subMu.Lock()
	if _, ok := a.subs[ch]; ok {
		delete(a.subs, ch)
		close(ch)
	}
	a.subMu.Unlock()
}

// AddTick folds one tick into the current candle, closing+emitting the previous
// candle when the interval boundary is crossed.
func (a *CandleAggregator) AddTick(t Tick) {
	bucket := t.Timestamp.Truncate(a.interval)

	a.mu.Lock()
	cur := a.current[t.Symbol]

	// New bucket → close the previous candle and start a fresh one.
	if cur == nil || !cur.Start.Equal(bucket) {
		if cur != nil {
			cur.Closed = true
			closed := *cur
			a.mu.Unlock()
			a.broadcast(closed)
			a.mu.Lock()
		}
		cur = &Candle{
			Symbol:   t.Symbol,
			Interval: a.label,
			Start:    bucket,
			Open:     t.LastPrice,
			High:     t.LastPrice,
			Low:      t.LastPrice,
			Close:    t.LastPrice,
		}
		a.current[t.Symbol] = cur
	}

	if t.LastPrice > cur.High {
		cur.High = t.LastPrice
	}
	if t.LastPrice < cur.Low || cur.Low == 0 {
		cur.Low = t.LastPrice
	}
	cur.Close = t.LastPrice

	// Volume arrives cumulative for the day; record the per-candle delta.
	if prev, ok := a.lastVol[t.Symbol]; ok && t.Volume >= prev {
		cur.Volume += t.Volume - prev
	}
	a.lastVol[t.Symbol] = t.Volume
	a.mu.Unlock()
}

// Sweep closes any candle whose interval has fully elapsed even if no new tick
// arrived to trigger a boundary crossing. Call periodically (e.g. every second).
func (a *CandleAggregator) Sweep(now time.Time) {
	cutoff := now.Truncate(a.interval)
	var toEmit []Candle
	a.mu.Lock()
	for sym, cur := range a.current {
		if cur != nil && cur.Start.Before(cutoff) {
			cur.Closed = true
			toEmit = append(toEmit, *cur)
			delete(a.current, sym)
		}
	}
	a.mu.Unlock()
	for _, c := range toEmit {
		a.broadcast(c)
	}
}

// Current returns a snapshot of the in-progress candle for a symbol.
func (a *CandleAggregator) Current(symbol string) (Candle, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if c, ok := a.current[symbol]; ok && c != nil {
		return *c, true
	}
	return Candle{}, false
}

func (a *CandleAggregator) broadcast(c Candle) {
	a.subMu.RLock()
	for ch := range a.subs {
		select {
		case ch <- c:
		default: // drop for slow subscribers
		}
	}
	a.subMu.RUnlock()
}
