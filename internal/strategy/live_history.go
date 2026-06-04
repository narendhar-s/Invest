package strategy

import (
	"time"

	"stockwise/internal/data"
)

// ReplayCall is a strategy signal produced while replaying historical candles,
// tagged with the candle time at which it fired so the chart can place a marker.
type ReplayCall struct {
	Time      int64   `json:"time"` // unix seconds (candle start)
	Direction string  `json:"direction"`
	Price     float64 `json:"price"`
	Strategy  string  `json:"strategy"`
	Reason    string  `json:"reason"`
}

// HistorySnapshot is the read-only post-close view of a symbol: the last session's
// candles, detected patterns, and the signals a strategy would have produced.
type HistorySnapshot struct {
	Symbol    string        `json:"symbol"`
	Interval  string        `json:"interval"`
	Candles   []data.Candle `json:"candles"`
	Patterns  []PatternHit  `json:"patterns"`
	Calls     []ReplayCall  `json:"calls"`
	Strategy  string        `json:"strategy"`
	Replayed  bool          `json:"replayed"`
}

// HistoryReplay loads the most recent historical candles for a symbol from the
// seed data source and (optionally) replays a strategy over them. It works even
// when the live engine is stopped — used to show last-session data after close.
// A non-zero from/to window pulls candles from Kite over that exact range (when
// Zerodha is connected) so the chart can render any selected date span;
// otherwise it falls back to the seed source's most-recent window.
func (e *LiveEngine) HistoryReplay(symbol, timeframe, strategyKey string, from, to time.Time) (HistorySnapshot, error) {
	if timeframe == "" {
		timeframe = "5m"
	}
	snap := HistorySnapshot{Symbol: symbol, Interval: timeframe}

	var bars []data.ChartBar
	var err error
	useRange := !from.IsZero() && !to.IsZero()
	if useRange && e.kite != nil && e.kite.IsConnected() {
		bars, err = e.kite.FetchHistoricalRange(symbol, data.KiteInterval(timeframe), from, to)
	} else if e.seedSource != nil {
		bars, err = e.seedSource.IntradayBars(symbol, timeframe)
	} else {
		return snap, errNoDataSource
	}
	if err != nil {
		return snap, err
	}
	// Use the actual fetched interval label (Yahoo has no 3m, so "3m" comes back
	// as 5m data) so ORB and other strategies compute their windows correctly.
	fetchedInterval := data.ActualFetchedInterval(timeframe)
	candles := make([]data.Candle, 0, len(bars))
	for _, b := range bars {
		candles = append(candles, data.Candle{
			Symbol: symbol, Interval: fetchedInterval, Start: b.Time,
			Open: b.Open, High: b.High, Low: b.Low, Close: b.Close,
			Volume: b.Volume, Closed: true,
		})
	}
	snap.Candles = candles
	snap.Patterns = DetectPatterns(candles)

	if strategyKey == "" {
		return snap, nil
	}
	strat, ok := Registry()[strategyKey]
	if !ok {
		return snap, errUnknownStrategy(strategyKey)
	}
	snap.Strategy = strategyKey
	snap.Replayed = true

	minN := strat.MinCandles()
	if minN < 2 {
		minN = 2
	}
	lastDir := ""
	for i := minN; i <= len(candles); i++ {
		window := candles[:i]
		call := strat.Evaluate(symbol, window)
		if call == nil {
			continue
		}
		// Collapse consecutive identical-direction signals to avoid marker spam.
		if call.Direction == lastDir {
			continue
		}
		lastDir = call.Direction
		snap.Calls = append(snap.Calls, ReplayCall{
			Time:      candles[i-1].Start.Unix(),
			Direction: call.Direction,
			Price:     call.Price,
			Strategy:  strategyKey,
			Reason:    call.Reason,
		})
	}
	return snap, nil
}
