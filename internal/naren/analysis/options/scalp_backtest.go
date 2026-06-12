package options

import (
	"fmt"
	"math"
	"time"

	"stockwise/internal/naren/kite"
)

// ScalpBacktestTrade is one simulated scalp trade.
type ScalpBacktestTrade struct {
	EntryTime    time.Time `json:"entry_time"`
	ExitTime     time.Time `json:"exit_time"`
	Direction    string    `json:"direction"`   // BULLISH | BEARISH
	OptionType   string    `json:"option_type"` // CE | PE
	Strike       float64   `json:"strike"`
	EntrySpot    float64   `json:"entry_spot"`
	ExitSpot     float64   `json:"exit_spot"`
	EntryPremium float64   `json:"entry_premium"`
	ExitPremium  float64   `json:"exit_premium"`
	PnL          float64   `json:"pnl"`
	Reason       string    `json:"reason"` // TARGET | STOP | EOD
}

// ScalpBacktestResult is the full backtest report.
type ScalpBacktestResult struct {
	Days         int                  `json:"days"`
	Lots         int                  `json:"lots"`
	RR           float64              `json:"rr"`
	Trades       int                  `json:"trades"`
	Wins         int                  `json:"wins"`
	Losses       int                  `json:"losses"`
	WinRate      float64              `json:"win_rate"`
	TotalPnL     float64              `json:"total_pnl"`
	AvgPnL       float64              `json:"avg_pnl"`
	MaxDrawdown  float64              `json:"max_drawdown"`
	ProfitFactor float64              `json:"profit_factor"`
	Equity       []float64            `json:"equity"` // cumulative ₹ P&L after each trade
	TradeList    []ScalpBacktestTrade `json:"trade_list"`
	Summary      string               `json:"summary"`
}

// ScalpBacktest simulates the EMA50/200 + Stochastic 1-minute scalp on NIFTY,
// trading ATM CE/PE. Entries fire on the confirming candle (filled at the next
// bar's open to avoid look-ahead); the protective stop is the recent swing
// low/high (±2 pt buffer) and the target is `rr` × that risk (1.5 by default).
// Each trade is squared off at end-of-day if neither level is touched.
//
// Option premiums are priced with Black-Scholes using an ATR-implied IV held
// constant for the (very short) life of each trade — a reasonable approximation
// for an intraday scalp where theta is negligible and delta/gamma dominate.
func ScalpBacktest(candles []kite.Candle, lots int, rr float64) ScalpBacktestResult {
	if lots <= 0 {
		lots = 2
	}
	if rr <= 0 {
		rr = 1.5
	}
	qty := float64(lots * kite.NiftyLotSize)
	const swingLB = 20
	const buffer = 2.0

	res := ScalpBacktestResult{Lots: lots, RR: rr, Equity: []float64{}, TradeList: []ScalpBacktestTrade{}}
	n := len(candles)
	if n < 210 {
		res.Summary = "Not enough 1-minute history to backtest (need ≥ 210 candles)."
		return res
	}

	closes := make([]float64, n)
	highs := make([]float64, n)
	lows := make([]float64, n)
	for i, c := range candles {
		closes[i] = c.Close
		highs[i] = c.High
		lows[i] = c.Low
	}
	ema50 := emaSeries(closes, 50)
	ema200 := emaSeries(closes, 200)

	cum := 0.0
	peak := 0.0
	grossWin, grossLoss := 0.0, 0.0

	i := 200
	for i < n-1 {
		spot := closes[i]
		bull := spot > ema50[i] && spot > ema200[i]
		bear := spot < ema50[i] && spot < ema200[i]
		kPrev := stochK(highs, lows, closes, i-1, 14, 3)
		kNow := stochK(highs, lows, closes, i, 14, 3)
		long := bull && kPrev <= 20 && kNow > 20
		short := bear && kPrev >= 80 && kNow < 80
		if !long && !short {
			i++
			continue
		}

		// Entry at next bar open (no look-ahead)
		e := i + 1
		entrySpot := candles[e].Open
		strike := kite.ATMStrike(entrySpot)
		isCE := long

		// Swing stop over the lookback ending at the signal bar
		lo, hi := scalpSwing(highs[:i+1], lows[:i+1], swingLB)
		var stopSpot, targetSpot float64
		if long {
			stopSpot = lo - buffer
			risk := entrySpot - stopSpot
			targetSpot = entrySpot + rr*risk
		} else {
			stopSpot = hi + buffer
			risk := stopSpot - entrySpot
			targetSpot = entrySpot - rr*risk
		}

		// Option pricing inputs (held constant for the trade)
		atr := scalpATR(candles, i, 14)
		iv := IVFromATR15m(atr, entrySpot)
		expiry := NiftyWeeklyExpiry(candles[e].Time)
		dte := ActualDTE(candles[e].Time, expiry)
		if dte < 1 {
			dte = 1 // keep ATM time-value meaningful for the intraday hold
		}
		entryPrem := BSPrice(entrySpot, strike, iv, dte, isCE)

		// Walk forward to the exit
		exitIdx := e
		exitSpot := candles[e].Close
		reason := "EOD"
		for j := e; j < n; j++ {
			cj := candles[j]
			if long {
				if cj.Low <= stopSpot { // stop checked first (conservative)
					exitSpot, reason, exitIdx = stopSpot, "STOP", j
					break
				}
				if cj.High >= targetSpot {
					exitSpot, reason, exitIdx = targetSpot, "TARGET", j
					break
				}
			} else {
				if cj.High >= stopSpot {
					exitSpot, reason, exitIdx = stopSpot, "STOP", j
					break
				}
				if cj.Low <= targetSpot {
					exitSpot, reason, exitIdx = targetSpot, "TARGET", j
					break
				}
			}
			// End-of-day square-off (15:20 IST or last candle)
			if isEODBar(cj.Time) || j == n-1 {
				exitSpot, reason, exitIdx = cj.Close, "EOD", j
				break
			}
		}

		exitPrem := BSPrice(exitSpot, strike, iv, dte, isCE)
		pnl := round2(((exitPrem - entryPrem) * qty))

		res.TradeList = append(res.TradeList, ScalpBacktestTrade{
			EntryTime: candles[e].Time, ExitTime: candles[exitIdx].Time,
			Direction:  map[bool]string{true: "BULLISH", false: "BEARISH"}[long],
			OptionType: map[bool]string{true: "CE", false: "PE"}[isCE],
			Strike:     strike, EntrySpot: round2(entrySpot), ExitSpot: round2(exitSpot),
			EntryPremium: round2(entryPrem), ExitPremium: round2(exitPrem),
			PnL: pnl, Reason: reason,
		})

		res.Trades++
		if pnl >= 0 {
			res.Wins++
			grossWin += pnl
		} else {
			res.Losses++
			grossLoss += -pnl
		}
		cum = round2(cum + pnl)
		res.Equity = append(res.Equity, cum)
		if cum > peak {
			peak = cum
		}
		if dd := peak - cum; dd > res.MaxDrawdown {
			res.MaxDrawdown = round2(dd)
		}

		i = exitIdx + 1 // no overlapping trades
	}

	res.TotalPnL = round2(cum)
	if res.Trades > 0 {
		res.WinRate = round2(float64(res.Wins) / float64(res.Trades) * 100)
		res.AvgPnL = round2(cum / float64(res.Trades))
	}
	if grossLoss > 0 {
		res.ProfitFactor = round2(grossWin / grossLoss)
	}
	res.Summary = fmt.Sprintf("%d trades · %.1f%% win · ₹%.0f net · PF %.2f · maxDD ₹%.0f",
		res.Trades, res.WinRate, res.TotalPnL, res.ProfitFactor, res.MaxDrawdown)
	return res
}

// emaSeries returns the EMA value at every index (same recurrence as ema()).
func emaSeries(values []float64, period int) []float64 {
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

// scalpATR is a simple 14-bar ATR ending at index i (1-minute bars).
func scalpATR(candles []kite.Candle, i, period int) float64 {
	start := i - period + 1
	if start < 1 {
		start = 1
	}
	var sum float64
	cnt := 0
	for k := start; k <= i; k++ {
		h, l, pc := candles[k].High, candles[k].Low, candles[k-1].Close
		tr := math.Max(h-l, math.Max(math.Abs(h-pc), math.Abs(l-pc)))
		sum += tr
		cnt++
	}
	if cnt == 0 {
		return 0
	}
	return sum / float64(cnt)
}

// isEODBar reports whether a candle time is at/after the 15:20 IST square-off.
func isEODBar(t time.Time) bool {
	ist, _ := time.LoadLocation("Asia/Kolkata")
	lt := t.In(ist)
	return lt.Hour() > 15 || (lt.Hour() == 15 && lt.Minute() >= 20)
}
