package strategy

import (
	"time"

	"stockwise/internal/data"
)

// PersonalBacktestTrade is one simulated round-trip produced by replaying a strategy
// over historical candles. P&L is measured in underlying points (a directional
// proxy — option premium history isn't fetched here), which is the right sign
// and relative magnitude for a quick edge check on intraday signals.
type PersonalBacktestTrade struct {
	EntryTime    int64   `json:"entry_time"` // unix seconds
	ExitTime     int64   `json:"exit_time"`
	Direction    string  `json:"direction"` // view on underlying: BUY / SELL
	OptionType   string  `json:"option_type,omitempty"`
	OptionAction string  `json:"option_action,omitempty"`
	Strike       float64 `json:"strike,omitempty"`
	Entry        float64 `json:"entry"`
	Exit         float64 `json:"exit"`
	ExitReason   string  `json:"exit_reason"` // target / stop / eod
	PnLPoints    float64 `json:"pnl_points"`  // underlying points, signed for the position
	Win          bool    `json:"win"`
	Reason       string  `json:"reason"`
}

// PersonalBacktestResult summarises a strategy backtest over one symbol/timeframe.
type PersonalBacktestResult struct {
	Symbol       string                  `json:"symbol"`
	Interval     string                  `json:"interval"`
	Strategy     string                  `json:"strategy"`
	Trades       []PersonalBacktestTrade `json:"trades"`
	NumTrades    int             `json:"num_trades"`
	Wins         int             `json:"wins"`
	Losses       int             `json:"losses"`
	WinRate      float64         `json:"win_rate"`      // %
	NetPoints    float64         `json:"net_points"`    // sum of trade P&L (underlying points)
	GrossWin     float64         `json:"gross_win"`
	GrossLoss    float64         `json:"gross_loss"`
	ProfitFactor float64         `json:"profit_factor"` // grossWin / |grossLoss|
	AvgPoints    float64         `json:"avg_points"`
}

// BacktestStrategy replays a registered strategy over the most recent historical
// candles for a symbol and simulates each signal to its target or stop. Each
// signal opens a position (entry = signal price); subsequent candles are scanned
// intrabar for the target or stop, otherwise the position exits at the final
// close. Scanning resumes after each exit so trades never overlap. It works while
// the engine is stopped.
//
// When a non-zero from/to window is supplied and Zerodha is connected, candles
// are pulled directly from Kite's historical-data API over that exact range,
// which lets the user backtest an arbitrary date span. Otherwise it falls back
// to the most recent candles from the seed data source.
func (e *LiveEngine) BacktestStrategy(symbol, timeframe, strategyKey string, from, to time.Time) (PersonalBacktestResult, error) {
	if timeframe == "" {
		timeframe = "5m"
	}
	// Non-nil slice so JSON encodes "trades": [] (not null) for empty results.
	res := PersonalBacktestResult{
		Symbol: symbol, Interval: timeframe, Strategy: strategyKey,
		Trades: []PersonalBacktestTrade{},
	}

	if strategyKey == "" {
		return res, errUnknownStrategy("")
	}
	strat, ok := Registry()[strategyKey]
	if !ok {
		return res, errUnknownStrategy(strategyKey)
	}

	// Choose the candle source: an explicit date range pulls straight from Kite;
	// otherwise reuse the seed source's most-recent window.
	var bars []data.ChartBar
	var err error
	useRange := !from.IsZero() && !to.IsZero()
	if useRange && e.kite != nil && e.kite.IsConnected() {
		bars, err = e.kite.FetchHistoricalRange(symbol, data.KiteInterval(timeframe), from, to)
	} else if e.seedSource != nil {
		bars, err = e.seedSource.IntradayBars(symbol, timeframe)
	} else {
		return res, errNoDataSource
	}
	if err != nil {
		return res, err
	}
	fetchedInterval := data.ActualFetchedInterval(timeframe)
	candles := make([]data.Candle, 0, len(bars))
	for _, b := range bars {
		candles = append(candles, data.Candle{
			Symbol: symbol, Interval: fetchedInterval, Start: b.Time,
			Open: b.Open, High: b.High, Low: b.Low, Close: b.Close,
			Volume: b.Volume, Closed: true,
		})
	}

	minN := strat.MinCandles()
	if minN < 2 {
		minN = 2
	}

	i := minN
	for i <= len(candles) {
		call := strat.Evaluate(symbol, candles[:i])
		if call == nil || (call.Direction != "BUY" && call.Direction != "SELL") {
			i++
			continue
		}

		entryIdx := i - 1
		trade := simulateTrade(call, candles, entryIdx)
		res.Trades = append(res.Trades, trade)

		// Resume scanning after the exit candle so trades don't overlap.
		exitIdx := indexOfTime(candles, trade.ExitTime, entryIdx)
		if exitIdx <= entryIdx {
			exitIdx = entryIdx + 1
		}
		i = exitIdx + 1
	}

	summarise(&res)
	return res, nil
}

// simulateTrade walks candles forward from entryIdx, exiting at the first target
// or stop touch (intrabar) or at the final close.
func simulateTrade(call *TradeCall, candles []data.Candle, entryIdx int) PersonalBacktestTrade {
	entry := call.Price
	t := PersonalBacktestTrade{
		EntryTime:    candles[entryIdx].Start.Unix(),
		Direction:    call.Direction,
		OptionType:   call.OptionType,
		OptionAction: call.OptionAction,
		Strike:       call.Strike,
		Entry:        entry,
		Reason:       call.Reason,
	}

	target, stop := call.Target, call.StopLoss
	for j := entryIdx + 1; j < len(candles); j++ {
		c := candles[j]
		if call.Direction == "BUY" {
			// Stop checked first (conservative: assume the adverse level can hit).
			if c.Low <= stop {
				return closeTrade(t, c, stop, "stop")
			}
			if c.High >= target {
				return closeTrade(t, c, target, "target")
			}
		} else { // SELL
			if c.High >= stop {
				return closeTrade(t, c, stop, "stop")
			}
			if c.Low <= target {
				return closeTrade(t, c, target, "target")
			}
		}
	}
	// No level hit — exit at the last available close.
	last := candles[len(candles)-1]
	return closeTrade(t, last, last.Close, "eod")
}

func closeTrade(t PersonalBacktestTrade, c data.Candle, exit float64, reason string) PersonalBacktestTrade {
	t.ExitTime = c.Start.Unix()
	t.Exit = exit
	t.ExitReason = reason
	if t.Direction == "BUY" {
		t.PnLPoints = exit - t.Entry
	} else {
		t.PnLPoints = t.Entry - exit
	}
	t.Win = t.PnLPoints > 0
	return t
}

// indexOfTime returns the candle index whose start matches unix time ts, scanning
// from `from`. Returns -1 when not found.
func indexOfTime(candles []data.Candle, ts int64, from int) int {
	for j := from; j < len(candles); j++ {
		if candles[j].Start.Unix() == ts {
			return j
		}
	}
	return -1
}

func summarise(res *PersonalBacktestResult) {
	res.NumTrades = len(res.Trades)
	for _, t := range res.Trades {
		res.NetPoints += t.PnLPoints
		if t.PnLPoints > 0 {
			res.Wins++
			res.GrossWin += t.PnLPoints
		} else {
			res.Losses++
			res.GrossLoss += t.PnLPoints // negative
		}
	}
	if res.NumTrades > 0 {
		res.WinRate = float64(res.Wins) / float64(res.NumTrades) * 100
		res.AvgPoints = res.NetPoints / float64(res.NumTrades)
	}
	if res.GrossLoss != 0 {
		res.ProfitFactor = res.GrossWin / -res.GrossLoss
	}
}
