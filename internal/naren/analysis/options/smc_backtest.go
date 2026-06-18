package options

import (
	"fmt"
	"time"

	"stockwise/internal/naren/kite"
)

// SMCBacktestTrade is one simulated SMC + FVG + VWAP options trade.
type SMCBacktestTrade struct {
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
	Confidence   int       `json:"confidence"`
	Reason       string    `json:"reason"` // TARGET | STOP | EOD
}

// SMCBacktestResult mirrors ScalpBacktestResult so the frontend can reuse the
// same backtest panel.
type SMCBacktestResult struct {
	Days         int                `json:"days"`
	Lots         int                `json:"lots"`
	RR           float64            `json:"rr"`
	Trades       int                `json:"trades"`
	Wins         int                `json:"wins"`
	Losses       int                `json:"losses"`
	WinRate      float64            `json:"win_rate"`
	TotalPnL     float64            `json:"total_pnl"`
	AvgPnL       float64            `json:"avg_pnl"`
	MaxDrawdown  float64            `json:"max_drawdown"`
	ProfitFactor float64            `json:"profit_factor"`
	Equity       []float64          `json:"equity"`
	TradeList    []SMCBacktestTrade `json:"trade_list"`
	Summary      string             `json:"summary"`
}

// SMCBacktest replays the live SMCAnalyze pipeline over historical 5-minute NIFTY
// candles, trading ATM weekly CE/PE. Entries are filled at the NEXT bar's open to
// avoid look-ahead; the spot stop/target follow the strategy's ATR rules
// (0.6×ATR stop, target = rr × that risk — 3.0 by default for the documented 1.8×ATR
// target). Each trade is squared off at end-of-day if neither level is touched.
//
// Option premiums use Black-Scholes with an ATR-implied IV held constant for the
// (short) life of each trade — the same approximation used by ScalpBacktest.
func SMCBacktest(candles []kite.Candle, lots int, rr float64) SMCBacktestResult {
	if lots <= 0 {
		lots = 2
	}
	if rr <= 0 {
		rr = 3.0 // 1.8×ATR target ÷ 0.6×ATR stop
	}
	qty := float64(lots * kite.NiftyLotSize)
	const stopATRMult = 0.6

	res := SMCBacktestResult{Lots: lots, RR: rr, Equity: []float64{}, TradeList: []SMCBacktestTrade{}}
	n := len(candles)
	if n < 130 {
		res.Summary = "Not enough 5-minute history to backtest (need ≥ 130 candles)."
		return res
	}

	cum := 0.0
	peak := 0.0
	grossWin, grossLoss := 0.0, 0.0

	i := 120
	for i < n-1 {
		rec, err := SMCAnalyze(candles[:i+1], false)
		if err != nil || rec == nil ||
			(rec.Strategy != StratDirectionalCE && rec.Strategy != StratDirectionalPE) {
			i++
			continue
		}
		isCE := rec.Strategy == StratDirectionalCE

		// Entry at next bar open (no look-ahead)
		e := i + 1
		entrySpot := candles[e].Open
		strike := kite.ATMStrike(entrySpot)

		// ATR-based spot stop/target on the 15-min HTF ATR (recomputed from the
		// aggregated bars up to the signal bar).
		bars15 := smcAgg5mTo15m(candles[:i+1])
		atr := recentATR14(bars15, len(bars15)-1)
		if atr <= 0 {
			i++
			continue
		}
		risk := stopATRMult * atr
		var stopSpot, targetSpot float64
		if isCE {
			stopSpot = entrySpot - risk
			targetSpot = entrySpot + rr*risk
		} else {
			stopSpot = entrySpot + risk
			targetSpot = entrySpot - rr*risk
		}

		// Option pricing inputs (held constant for the trade)
		iv := IVFromATR15m(atr, entrySpot)
		expiry := NiftyWeeklyExpiry(candles[e].Time)
		dte := ActualDTE(candles[e].Time, expiry)
		if dte < 1 {
			dte = 1
		}
		entryPrem := BSPrice(entrySpot, strike, iv, dte, isCE)

		// Walk forward to the exit
		exitIdx := e
		exitSpot := candles[e].Close
		reason := "EOD"
		for j := e; j < n; j++ {
			cj := candles[j]
			if isCE {
				if cj.Low <= stopSpot {
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
			if isEODBar(cj.Time) || j == n-1 {
				exitSpot, reason, exitIdx = cj.Close, "EOD", j
				break
			}
		}

		exitPrem := BSPrice(exitSpot, strike, iv, dte, isCE)
		pnl := round2((exitPrem - entryPrem) * qty)

		res.TradeList = append(res.TradeList, SMCBacktestTrade{
			EntryTime: candles[e].Time, ExitTime: candles[exitIdx].Time,
			Direction:  map[bool]string{true: "BULLISH", false: "BEARISH"}[isCE],
			OptionType: map[bool]string{true: "CE", false: "PE"}[isCE],
			Strike:     strike, EntrySpot: round2(entrySpot), ExitSpot: round2(exitSpot),
			EntryPremium: round2(entryPrem), ExitPremium: round2(exitPrem),
			PnL: pnl, Confidence: rec.Confidence, Reason: reason,
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
