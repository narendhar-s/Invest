package strategy

import (
	"math"
	"time"

	"stockwise/internal/storage"
)

// BacktestConfig holds parameters for a backtest run.
type BacktestConfig struct {
	InitialCapital float64
	CommissionPct  float64 // e.g. 0.001 = 0.1%
	SlippagePct    float64 // e.g. 0.0005 = 0.05%
	PositionSizePct float64 // fraction of capital per trade, e.g. 0.1 = 10%
}

// BacktestTrade represents a single completed trade in a backtest.
type BacktestTrade struct {
	EntryDate  time.Time
	ExitDate   time.Time
	EntryPrice float64
	ExitPrice  float64
	Quantity   int
	PnL        float64
	PnLPct     float64
	IsWin      bool
}

// BacktestResult holds the output of a backtest.
type BacktestResult struct {
	StrategyName  string
	Symbol        string
	StartDate     time.Time
	EndDate       time.Time
	TotalTrades   int
	WinningTrades int
	LosingTrades  int
	WinRate       float64
	GrossProfit   float64
	GrossLoss     float64
	ProfitFactor  float64
	MaxDrawdown   float64
	NetPnL        float64
	NetPnLPct     float64
	SharpeRatio   float64
	AvgWin        float64
	AvgLoss       float64
	Trades        []BacktestTrade
}

// StrategyFunc is the signature for a strategy's signal generation function.
// Returns: (shouldEnterLong bool, shouldEnterShort bool, targetPct float64, stopPct float64)
type StrategyFunc func(bars []storage.PriceBar, currentIdx int) (enterLong, enterShort bool, targetPct, stopPct float64)

// Runner executes backtests.
type Runner struct {
	cfg BacktestConfig
}

func NewRunner(cfg BacktestConfig) *Runner {
	return &Runner{cfg: cfg}
}

// Run backtests a strategy function against historical bars.
func (r *Runner) Run(strategyName, symbol string, bars []storage.PriceBar, fn StrategyFunc) BacktestResult {
	if len(bars) < 50 {
		return BacktestResult{StrategyName: strategyName, Symbol: symbol}
	}

	result := BacktestResult{
		StrategyName: strategyName,
		Symbol:       symbol,
		StartDate:    bars[0].Date,
		EndDate:      bars[len(bars)-1].Date,
	}

	capital := r.cfg.InitialCapital
	equity := []float64{capital}
	peak := capital

	inTrade := false
	var currentTrade BacktestTrade

	for i := 50; i < len(bars); i++ {
		bar := bars[i]

		if inTrade {
			// Check exit conditions
			currentPrice := bar.Close

			hitTarget := currentTrade.EntryPrice > 0 &&
				currentPrice >= currentTrade.ExitPrice
			hitStop := currentPrice <= currentTrade.EntryPrice*(1-(currentTrade.ExitPrice/currentTrade.EntryPrice-1)*2)

			shouldExit := hitTarget || hitStop || i == len(bars)-1

			if shouldExit {
				exitPrice := currentPrice * (1 - r.cfg.SlippagePct)
				commission := exitPrice * float64(currentTrade.Quantity) * r.cfg.CommissionPct

				pnl := (exitPrice-currentTrade.EntryPrice)*float64(currentTrade.Quantity) - commission
				pnlPct := (exitPrice - currentTrade.EntryPrice) / currentTrade.EntryPrice * 100

				currentTrade.ExitDate = bar.Date
				currentTrade.ExitPrice = exitPrice
				currentTrade.PnL = pnl
				currentTrade.PnLPct = pnlPct
				currentTrade.IsWin = pnl > 0

				capital += pnl
				equity = append(equity, capital)

				if capital > peak {
					peak = capital
				}

				result.Trades = append(result.Trades, currentTrade)
				result.TotalTrades++
				if currentTrade.IsWin {
					result.WinningTrades++
					result.GrossProfit += pnl
				} else {
					result.LosingTrades++
					result.GrossLoss += math.Abs(pnl)
				}

				inTrade = false
			}
			continue
		}

		// Check entry signal
		enterLong, _, targetPct, stopPct := fn(bars[:i+1], i)

		if enterLong && capital > 0 {
			entryPrice := bar.Close * (1 + r.cfg.SlippagePct)
			commission := entryPrice * r.cfg.CommissionPct
			positionSize := capital * r.cfg.PositionSizePct
			quantity := int(positionSize / entryPrice)

			if quantity < 1 {
				continue
			}

			totalCost := entryPrice*float64(quantity) + commission
			if totalCost > capital {
				continue
			}

			capital -= totalCost

			currentTrade = BacktestTrade{
				EntryDate:  bar.Date,
				EntryPrice: entryPrice,
				Quantity:   quantity,
				ExitPrice:  entryPrice * (1 + targetPct),
			}
			_ = stopPct
			inTrade = true
		}
	}

	// Calculate metrics
	if result.TotalTrades > 0 {
		result.WinRate = float64(result.WinningTrades) / float64(result.TotalTrades) * 100
		if result.GrossLoss > 0 {
			result.ProfitFactor = result.GrossProfit / result.GrossLoss
		}
		if result.WinningTrades > 0 {
			result.AvgWin = result.GrossProfit / float64(result.WinningTrades)
		}
		if result.LosingTrades > 0 {
			result.AvgLoss = result.GrossLoss / float64(result.LosingTrades)
		}
		result.NetPnL = capital + r.currentEquity(result.Trades) - r.cfg.InitialCapital
		result.NetPnLPct = result.NetPnL / r.cfg.InitialCapital * 100
		result.MaxDrawdown = r.computeMaxDrawdown(equity)
		result.SharpeRatio = r.computeSharpe(result.Trades)
	}

	return result
}

func (r *Runner) currentEquity(trades []BacktestTrade) float64 {
	total := 0.0
	for _, t := range trades {
		total += t.PnL
	}
	return total
}

func (r *Runner) computeMaxDrawdown(equity []float64) float64 {
	if len(equity) == 0 {
		return 0
	}
	peak := equity[0]
	maxDD := 0.0
	for _, e := range equity {
		if e > peak {
			peak = e
		}
		dd := (peak - e) / peak * 100
		if dd > maxDD {
			maxDD = dd
		}
	}
	return maxDD
}

func (r *Runner) computeSharpe(trades []BacktestTrade) float64 {
	if len(trades) < 2 {
		return 0
	}
	returns := make([]float64, len(trades))
	mean := 0.0
	for i, t := range trades {
		returns[i] = t.PnLPct
		mean += t.PnLPct
	}
	mean /= float64(len(trades))

	variance := 0.0
	for _, r := range returns {
		diff := r - mean
		variance += diff * diff
	}
	variance /= float64(len(trades) - 1)
	stdDev := math.Sqrt(variance)

	if stdDev == 0 {
		return 0
	}

	// Annualized Sharpe (assuming ~252 trading days, risk-free ≈ 0)
	return (mean / stdDev) * math.Sqrt(252)
}

// ToStorageModel converts a BacktestResult to a StrategyResult for DB storage.
func (r *Runner) ToStorageModel(res BacktestResult) storage.StrategyResult {
	return storage.StrategyResult{
		StrategyName:  res.StrategyName,
		Symbol:        res.Symbol,
		StartDate:     res.StartDate,
		EndDate:       res.EndDate,
		TotalTrades:   res.TotalTrades,
		WinningTrades: res.WinningTrades,
		LosingTrades:  res.LosingTrades,
		WinRate:       res.WinRate,
		ProfitFactor:  res.ProfitFactor,
		MaxDrawdown:   res.MaxDrawdown,
		NetPnL:        res.NetPnL,
		NetPnLPct:     res.NetPnLPct,
		SharpeRatio:   res.SharpeRatio,
		AvgWin:        res.AvgWin,
		AvgLoss:       res.AvgLoss,
	}
}

// ─── Built-in Strategy Functions ─────────────────────────────────────────────

// RSIMACDStrategy is a simple RSI + MACD crossover strategy for backtesting.
func RSIMACDStrategy(bars []storage.PriceBar, idx int) (enterLong, enterShort bool, targetPct, stopPct float64) {
	if idx < 35 {
		return false, false, 0, 0
	}

	closes := make([]float64, idx+1)
	for i, b := range bars[:idx+1] {
		closes[i] = b.Close
	}

	// Simple RSI check (last value)
	rsiValues := computeRSISlice(closes, 14)
	if len(rsiValues) == 0 {
		return false, false, 0, 0
	}
	rsi := rsiValues[len(rsiValues)-1]

	// MACD check
	macd, signal := computeMACDSlice(closes, 12, 26, 9)
	if len(macd) == 0 || len(signal) == 0 {
		return false, false, 0, 0
	}

	lastMACD := macd[len(macd)-1]
	lastSignal := signal[len(signal)-1]
	prevMACD := macd[len(macd)-2]
	prevSignal := signal[len(signal)-2]

	// MACD bullish crossover + RSI not overbought
	if prevMACD < prevSignal && lastMACD > lastSignal && rsi < 70 && rsi > 30 {
		return true, false, 0.08, 0.04 // 8% target, 4% stop
	}

	return false, false, 0, 0
}

// ORBStrategy backtests the Opening Range Breakout on daily data.
func ORBStrategy(bars []storage.PriceBar, idx int) (enterLong, enterShort bool, targetPct, stopPct float64) {
	if idx < 5 {
		return false, false, 0, 0
	}

	// Use 5-bar range as ORB proxy
	orbSlice := bars[idx-4 : idx]
	orbHigh := orbSlice[0].High
	for _, b := range orbSlice[1:] {
		if b.High > orbHigh {
			orbHigh = b.High
		}
	}

	currentClose := bars[idx].Close
	avgVol := int64(0)
	for _, b := range orbSlice {
		avgVol += b.Volume
	}
	avgVol /= int64(len(orbSlice))

	isVolumeSpike := bars[idx].Volume > avgVol*2

	if currentClose > orbHigh && isVolumeSpike {
		return true, false, 0.06, 0.03 // 6% target, 3% stop
	}

	return false, false, 0, 0
}

// Minimal RSI slice computation for backtest (avoids dependency on full analyzer)
func computeRSISlice(closes []float64, period int) []float64 {
	n := len(closes)
	if n < period+1 {
		return nil
	}
	result := make([]float64, n)
	avgGain, avgLoss := 0.0, 0.0
	for i := 1; i <= period; i++ {
		change := closes[i] - closes[i-1]
		if change > 0 {
			avgGain += change
		} else {
			avgLoss += -change
		}
	}
	avgGain /= float64(period)
	avgLoss /= float64(period)

	if avgLoss == 0 {
		result[period] = 100
	} else {
		result[period] = 100 - 100/(1+avgGain/avgLoss)
	}

	for i := period + 1; i < n; i++ {
		change := closes[i] - closes[i-1]
		gain, loss := 0.0, 0.0
		if change > 0 {
			gain = change
		} else {
			loss = -change
		}
		avgGain = (avgGain*float64(period-1) + gain) / float64(period)
		avgLoss = (avgLoss*float64(period-1) + loss) / float64(period)
		if avgLoss == 0 {
			result[i] = 100
		} else {
			result[i] = 100 - 100/(1+avgGain/avgLoss)
		}
	}
	return result
}

func computeMACDSlice(closes []float64, fast, slow, signal int) ([]float64, []float64) {
	emaFn := func(data []float64, period int) []float64 {
		n := len(data)
		res := make([]float64, n)
		if period > n {
			return res
		}
		k := 2.0 / float64(period+1)
		sum := 0.0
		for i := 0; i < period; i++ {
			sum += data[i]
		}
		res[period-1] = sum / float64(period)
		for i := period; i < n; i++ {
			res[i] = data[i]*k + res[i-1]*(1-k)
		}
		return res
	}

	emaFast := emaFn(closes, fast)
	emaSlow := emaFn(closes, slow)
	n := len(closes)
	macdLine := make([]float64, n)
	for i := slow - 1; i < n; i++ {
		macdLine[i] = emaFast[i] - emaSlow[i]
	}
	signalLine := emaFn(macdLine, signal)
	return macdLine, signalLine
}
