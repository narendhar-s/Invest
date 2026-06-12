package strategy

import (
	"time"

	"stockwise/internal/data"
)

// CandleSnapshot is the initial payload for a chart: the closed-candle history
// for a symbol plus the patterns detected over that history.
type CandleSnapshot struct {
	Symbol   string         `json:"symbol"`
	Interval string         `json:"interval"`
	Candles  []data.Candle  `json:"candles"`
	Patterns []PatternHit   `json:"patterns"`
	Current  *data.Candle   `json:"current,omitempty"`
}

// SubscribeCandles returns a channel receiving closed and in-progress candle
// updates across all subscribed symbols. The caller filters by symbol.
func (e *LiveEngine) SubscribeCandles() chan data.Candle {
	ch := make(chan data.Candle, 256)
	e.candleMu.Lock()
	e.candleSubs[ch] = struct{}{}
	e.candleMu.Unlock()
	return ch
}

// UnsubscribeCandles removes and closes a candle subscriber channel.
func (e *LiveEngine) UnsubscribeCandles(ch chan data.Candle) {
	e.candleMu.Lock()
	if _, ok := e.candleSubs[ch]; ok {
		delete(e.candleSubs, ch)
		close(ch)
	}
	e.candleMu.Unlock()
}

func (e *LiveEngine) broadcastCandle(c data.Candle) {
	e.candleMu.RLock()
	for ch := range e.candleSubs {
		select {
		case ch <- c:
		default: // drop for slow subscribers
		}
	}
	e.candleMu.RUnlock()
}

// liveCandleLoop periodically broadcasts the in-progress (open) candle for every
// active symbol so charts update tick-by-tick without waiting for candle close.
func (e *LiveEngine) liveCandleLoop(agg *data.CandleAggregator, stopCh chan struct{}) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-stopCh:
			return
		case <-t.C:
			e.mu.RLock()
			syms := append([]string(nil), e.symbols...)
			e.mu.RUnlock()
			for _, sym := range syms {
				if cur, ok := agg.Current(e.canonicalSymbol(sym)); ok {
					e.broadcastCandle(cur)
				}
			}
		}
	}
}

// Snapshot returns the current closed-candle history for a symbol plus detected
// patterns and the in-progress candle, for initial chart rendering.
func (e *LiveEngine) Snapshot(symbol string) CandleSnapshot {
	key := e.canonicalSymbol(symbol)
	e.mu.RLock()
	candles := append([]data.Candle(nil), e.buffers[key]...)
	interval := e.timeframe
	agg := e.agg
	e.mu.RUnlock()

	snap := CandleSnapshot{
		Symbol:   symbol,
		Interval: interval,
		Candles:  candles,
		Patterns: DetectPatterns(candles),
	}
	if agg != nil {
		if cur, ok := agg.Current(key); ok {
			snap.Current = &cur
		}
	}
	return snap
}
