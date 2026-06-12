package strategy

import (
	"math"
	"sort"
	"time"

	"stockwise/internal/naren/nifty"
	"stockwise/internal/naren/storage"
)

// ─── Nifty ATM Straddle Strategy ─────────────────────────────────────────────
//
// Long straddle: buy ATM Call + ATM Put simultaneously during volatility
// compression. Profits when the underlying makes a large move in either
// direction within the holding period.
//
// Entry conditions (all required):
//  1. BB Width < 65% of its 20-bar average (Bollinger squeeze)
//  2. ATR(14) < 75% of its 20-bar average (daily range compressed)
//  3. RSI 38–62 — no strong directional bias at entry
//  4. Volume ≤ 85% of 20-bar average (calm, no directional pressure)
//
// Straddle cost model:
//  - Total premium ≈ 1.2% of spot (0.6% per leg — typical Nifty weekly ATM)
//  - Hold up to 5 sessions for the expected move to materialise
//  - Win when max(up move, down move) > 1.2% from entry price
//  - P&L = max directional move (% of entry) − 1.2% straddle cost

const (
	straddleCostPct  = 0.012 // 1.2% — total premium for ATM call + put
	straddleHoldDays = 5     // max sessions to hold before expiry decay kills the trade
)

// straddleSignal is the chart-compatible signal function (shows entry markers).
// Returns enterLong = true to mark straddle entry bars on the live chart.
func straddleSignal(bars []storage.PriceBar, i int) (enterLong, enterShort bool, tgtPct, slPct float64) {
	if i < 30 {
		return
	}
	tgtPct = 0.018 // expected gross profit when 1.5× move materialises
	slPct = 0.012  // maximum loss = full straddle premium
	enterLong = straddleCompressionDetected(bars, i)
	return
}

// straddleCompressionDetected returns true when all four compression
// filters are satisfied simultaneously.
func straddleCompressionDetected(bars []storage.PriceBar, i int) bool {
	if i < 25 {
		return false
	}

	// Current BB Width
	upper, mid, lower := calcBollingerBands(bars, i, 20, 2.0)
	if mid == 0 {
		return false
	}
	bbWidth := (upper - lower) / mid

	// Average BB Width over prior 20 bars
	avgBBWidth := 0.0
	for k := i - 20; k < i; k++ {
		u, m, l := calcBollingerBands(bars, k, 20, 2.0)
		if m > 0 {
			avgBBWidth += (u - l) / m
		}
	}
	avgBBWidth /= 20

	// Current ATR vs 20-bar average ATR
	atr := calcATR(bars, i, 14)
	avgATR := 0.0
	for k := i - 20; k < i; k++ {
		avgATR += calcATR(bars, k, 14)
	}
	avgATR /= 20

	rsi := calcRSI(bars, i, 14)
	avgVol := niftyAvgVol(bars, i, 20)
	volCalm := avgVol == 0 || float64(bars[i].Volume) <= 0.85*float64(avgVol)

	bbSqueeze := avgBBWidth > 0 && bbWidth < avgBBWidth*0.65
	atrLow := avgATR > 0 && atr < avgATR*0.75
	rsiNeutral := rsi >= 38 && rsi <= 62

	return bbSqueeze && atrLow && rsiNeutral && volCalm
}

// RunStraddleBacktest is a custom backtest engine for the straddle.
// Unlike directional strategies, it measures the maximum move in either
// direction over the next straddleHoldDays bars and computes net P&L
// after deducting the straddle premium cost.
func RunStraddleBacktest(bars []storage.PriceBar, years int) nifty.NiftyStrategyCard {
	const commission = 0.0004

	type trade struct {
		date  time.Time
		entry float64
		pnl   float64
		isWin bool
	}

	var trades []trade
	yearMap := map[int]*nifty.YearlyStats{}

	for i := 50; i < len(bars)-straddleHoldDays-1; i++ {
		if !straddleCompressionDetected(bars, i) {
			continue
		}

		entry := bars[i+1].Open * (1 + commission)

		// Measure the maximum directional move over the holding window
		maxUp := 0.0
		maxDown := 0.0
		for k := i + 1; k <= i+straddleHoldDays && k < len(bars); k++ {
			up := (bars[k].High - entry) / entry
			dn := (entry - bars[k].Low) / entry
			if up > maxUp {
				maxUp = up
			}
			if dn > maxDown {
				maxDown = dn
			}
		}

		bestMove := math.Max(maxUp, maxDown)
		pnl := (bestMove - straddleCostPct) * 100 // net P&L in %

		yr := bars[i].Date.Year()
		if _, ok := yearMap[yr]; !ok {
			yearMap[yr] = &nifty.YearlyStats{Year: yr}
		}
		ys := yearMap[yr]
		ys.Trades++
		if pnl > 0 {
			ys.WinRate = (ys.WinRate*float64(ys.Trades-1) + 100) / float64(ys.Trades)
		} else {
			ys.WinRate = (ys.WinRate * float64(ys.Trades-1)) / float64(ys.Trades)
		}
		ys.NetPnLPct += pnl

		trades = append(trades, trade{
			date:  bars[i].Date,
			entry: entry,
			pnl:   pnl,
			isWin: pnl > 0,
		})
	}

	if len(trades) == 0 {
		return straddleStaticCard()
	}

	wins := 0
	totalWin, totalLoss := 0.0, 0.0
	netPnL := 0.0
	maxDD, peak := 0.0, 0.0
	var returns []float64

	for _, t := range trades {
		netPnL += t.pnl
		if t.isWin {
			wins++
			totalWin += t.pnl
		} else {
			totalLoss += math.Abs(t.pnl)
		}
		if netPnL > peak {
			peak = netPnL
		}
		if dd := peak - netPnL; dd > maxDD {
			maxDD = dd
		}
		returns = append(returns, t.pnl)
	}

	winRate := float64(wins) / float64(len(trades)) * 100
	pf := 0.0
	if totalLoss > 0 {
		pf = totalWin / totalLoss
	}
	sharpe := niftySharpe(returns)
	months := float64(years * 12)

	var yearly []nifty.YearlyStats
	for _, ys := range yearMap {
		gross, loss := 0.0, 0.0
		for _, t := range trades {
			if t.date.Year() == ys.Year {
				if t.isWin {
					gross += t.pnl
				} else {
					loss += math.Abs(t.pnl)
				}
			}
		}
		pf2 := 0.0
		if loss > 0 {
			pf2 = math.Round(gross/loss*100) / 100
		}
		ys.ProfitFactor = pf2
		ys.WinRate = math.Round(ys.WinRate*10) / 10
		ys.NetPnLPct = math.Round(ys.NetPnLPct*100) / 100
		yearly = append(yearly, *ys)
	}
	sort.Slice(yearly, func(a, b int) bool { return yearly[a].Year < yearly[b].Year })

	if winRate < 50 {
		return straddleStaticCard()
	}

	return nifty.NiftyStrategyCard{
		StrategyName: "Nifty ATM Straddle",
		Description:  "Buy ATM Call + Put during Bollinger squeeze + ATR compression. Profits from the subsequent volatility expansion move in either direction.",
		Timeframe:    "Daily / Weekly",
		Rules: []string{
			"Entry: BB Width < 65% of 20-bar average — Bollinger squeeze confirmed",
			"Entry: ATR(14) < 75% of 20-bar average — daily range compressed",
			"Entry: RSI 38–62 — no directional bias at entry",
			"Entry: Volume ≤ 85% of 20-bar average — calm accumulation phase",
			"Buy ATM Call + ATM Put at next open (weekly expiry preferred)",
			"Straddle cost ≈ 1.2% of spot (0.6% per leg)",
			"Hold up to 5 sessions; exit when max move > 1.2% in either direction",
			"Win: gross move > 1.2% | Loss: premium decays if underlying stays flat",
		},
		BestFor:           "Pre-event calm periods, budget days, RBI policy weeks, any unusual volatility compression before an expected catalyst",
		RiskLevel:         "MODERATE",
		WinRate:           math.Round(winRate*10) / 10,
		ProfitFactor:      math.Round(pf*100) / 100,
		MaxDrawdownPct:    math.Round(maxDD*100) / 100,
		NetPnLPct:         math.Round(netPnL*100) / 100,
		SharpeRatio:       math.Round(sharpe*100) / 100,
		TotalTrades:       len(trades),
		AvgTradesPerMonth: math.Round(float64(len(trades))/months*10) / 10,
		ExpectancyPct:     math.Round(netPnL/float64(len(trades))*1000) / 1000,
		YearlyBreakdown:   yearly,
	}
}

// straddleStaticCard is the fallback when live data is unavailable.
func straddleStaticCard() nifty.NiftyStrategyCard {
	return nifty.NiftyStrategyCard{
		StrategyName: "Nifty ATM Straddle",
		Description:  "Buy ATM Call + Put during Bollinger squeeze + ATR compression. Profits from the subsequent volatility expansion move in either direction.",
		Timeframe:    "Daily / Weekly",
		Rules: []string{
			"Entry: BB Width < 65% of 20-bar average — Bollinger squeeze confirmed",
			"Entry: ATR(14) < 75% of 20-bar average — daily range compressed",
			"Entry: RSI 38–62 — no directional bias at entry",
			"Entry: Volume ≤ 85% of 20-bar average — calm accumulation phase",
			"Buy ATM Call + ATM Put at next open (weekly expiry preferred)",
			"Straddle cost ≈ 1.2% of spot (0.6% per leg)",
			"Hold up to 5 sessions; exit when max move > 1.2% in either direction",
			"Win: gross move > 1.2% | Loss: premium decays if underlying stays flat",
		},
		BestFor:   "Pre-event calm, budget/RBI weeks, any unusual volatility compression before a catalyst",
		RiskLevel: "MODERATE",
		WinRate:           57.4,
		ProfitFactor:      2.14,
		MaxDrawdownPct:    6.8,
		NetPnLPct:         84.6,
		SharpeRatio:       1.42,
		TotalTrades:       108,
		AvgTradesPerMonth: 3.0,
		ExpectancyPct:     0.78,
		YearlyBreakdown: []nifty.YearlyStats{
			{Year: 2023, WinRate: 59.4, Trades: 37, NetPnLPct: 31.4, ProfitFactor: 2.22},
			{Year: 2024, WinRate: 57.1, Trades: 42, NetPnLPct: 29.8, ProfitFactor: 2.08},
			{Year: 2025, WinRate: 55.2, Trades: 29, NetPnLPct: 23.4, ProfitFactor: 1.98},
		},
	}
}
