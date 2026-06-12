package paper

import (
	"fmt"
	"math"
	"time"

	"stockwise/internal/naren/analysis/options"
	"stockwise/internal/naren/kite"
)

// BacktestDaily runs a 1-year backtest on daily NIFTY candles.
// Signal fires at EOD of bar N → entry at open of bar N+1.
// Option pricing hierarchy:
//  1. Real Kite daily OHLCV for option instrument (most accurate)
//  2. Black-Scholes with daily ATR (fallback)
//
// For SL/target determination within a day, we use the option's daily H/L:
//   - CE buy SL hit if option low < entry - riskPerUnit
//   - CE buy target hit if option high > entry + rewardPerUnit
func (e *Engine) BacktestDaily(days int, rr, riskPct float64, lots, confThreshold int) (*BacktestResult, error) {
	if !e.kc.IsConnected() {
		return nil, fmt.Errorf("Kite not connected — login required")
	}
	if days <= 0 || days > 365 { days = 365 }
	if rr <= 0     { rr = e.account.RR }
	if riskPct <= 0 { riskPct = e.account.RiskPct }
	if lots <= 0   { lots = e.account.Lots }
	if confThreshold <= 0 { confThreshold = e.account.ConfThreshold }

	now  := time.Now().In(options.ISTLoc())
	from := now.AddDate(0, 0, -days)

	// Daily NIFTY candles (Kite supports years of day-interval data)
	candles, err := e.kc.HistoricalData(
		kite.NiftyIndexToken, "day",
		from.Format("2006-01-02 09:00:00"), now.Format("2006-01-02 15:30:00"),
	)
	if err != nil {
		return nil, fmt.Errorf("fetching daily NIFTY candles: %w", err)
	}
	if len(candles) < 60 {
		return nil, fmt.Errorf("insufficient data: need ≥60 daily candles, got %d", len(candles))
	}

	qty      := float64(lots * kite.NiftyLotSize)
	riskAmt  := e.account.Capital * riskPct
	rewardAmt := riskAmt * rr

	// Pre-compute daily EMA series for chart overlay
	closes := make([]float64, len(candles))
	for i, c := range candles { closes[i] = c.Close }
	ema20s := computeEMASeries(closes, 20)
	ema50s := computeEMASeries(closes, 50)

	res := &BacktestResult{
		From: candles[0].Time, To: candles[len(candles)-1].Time,
		Capital: e.account.Capital, Lots: lots, RR: rr, RiskPct: riskPct,
		RiskPerTrade: riskAmt, TargetPerTrade: rewardAmt,
	}

	type openTrade struct {
		bt          BacktestTrade
		entryPrem   float64
		strike      float64
		isCall      bool
		isNeutral   bool
		iv          float64
		expiry      time.Time
		expiryStr   string
		realToken   int
		// Daily risk/reward per option unit
		riskPerUnit   float64
		rewardPerUnit float64
	}

	var open *openTrade
	var equity float64
	var peak, maxDD float64
	var consecLoss, maxConsecLoss int

	const warmup = 55
	for i := warmup; i < len(candles)-1; i++ {
		bar  := candles[i]
		next := candles[i+1] // entry bar = next day

		// Signal fires at close of bar i; entry at open of bar i+1
		rec, err := options.AnalyzeDaily(candles[:i+1], false)
		if err != nil { continue }

		// Build BarSignal with daily EMA
		bs := BarSignal{
			Time: bar.Time, Open: bar.Open, High: bar.High,
			Low: bar.Low, Close: bar.Close, Volume: bar.Volume,
			EMA9:     round2p(ema20s[i]),
			EMA21:    round2p(ema50s[i]),
			Strategy: string(rec.Strategy), Regime: string(rec.Regime),
		}
		res.BarSignals = append(res.BarSignals, bs)

		// ── Manage open position ─────────────────────────────────────────
		if open != nil {
			// Check if SL or target hit within the day using option H/L
			hitSL, hitTarget, optH, optL, optClose := false, false, 0.0, 0.0, 0.0
			if open.realToken > 0 {
				h, l, cl, ok := e.dailyOptionHLC(open.realToken, next.Time)
				if ok {
					optH, optL, optClose = h, l, cl
					if open.isCall {
						hitSL     = (optL > 0) && (optL <= open.entryPrem-open.riskPerUnit)
						hitTarget = (optH > 0) && (optH >= open.entryPrem+open.rewardPerUnit)
					} else {
						hitSL     = (optL > 0) && (optL <= open.entryPrem-open.riskPerUnit)
						hitTarget = (optH > 0) && (optH >= open.entryPrem+open.rewardPerUnit)
					}
				}
			}

			// Fallback: BS-based daily mark
			if optClose == 0 {
				dte := options.ActualDTE(next.Time, open.expiry)
				optClose = options.BSPrice(next.Close, open.strike, open.iv, dte, open.isCall)
			}

			var exitPnL float64
			var exitReason string
			var exitPremium float64

			switch {
			case hitTarget:
				exitPremium = open.entryPrem + open.rewardPerUnit
				exitPnL     = rewardAmt
				exitReason  = fmt.Sprintf("Target hit +₹%.0f (intraday)", rewardAmt)
			case hitSL:
				exitPremium = open.entryPrem - open.riskPerUnit
				exitPnL     = -riskAmt
				exitReason  = fmt.Sprintf("Stop-loss -₹%.0f (intraday)", riskAmt)
			default:
				exitPremium = optClose
				if open.isNeutral {
					dte := options.ActualDTE(next.Time, open.expiry)
					ce  := options.BSPrice(next.Close, open.strike, open.iv, dte, true)
					pe  := options.BSPrice(next.Close, open.strike, open.iv, dte, false)
					curCredit := ce + pe
					exitPnL  = (open.entryPrem - curCredit) * qty
				} else {
					exitPnL = (optClose - open.entryPrem) * qty
					if exitPnL > rewardAmt { exitPnL = rewardAmt }
					if exitPnL < -riskAmt  { exitPnL = -riskAmt }
				}
				exitReason = "EOD close"
			}

			t := &open.bt
			t.ExitTime    = next.Time
			t.ExitSpot    = next.Close
			t.ExitPremium = round2p(exitPremium)
			t.PnL         = round2p(exitPnL)
			t.PnLPerLot   = round2p(exitPnL / float64(lots))
			t.ExitReason  = exitReason
			t.BarsHeld    = 1
			res.Trades = append(res.Trades, *t)

			equity += exitPnL
			if equity > peak { peak = equity }
			if dd := peak - equity; dd > maxDD { maxDD = dd }
			res.EquityCurve = append(res.EquityCurve, EquityPoint{
				Time: next.Time, Equity: round2p(equity), Trade: len(res.Trades) - 1,
			})
			if exitPnL < 0 {
				consecLoss++
				if consecLoss > maxConsecLoss { maxConsecLoss = consecLoss }
			} else {
				consecLoss = 0
			}
			open = nil
			_ = optH; _ = optL
		}

		// ── Enter new trade ───────────────────────────────────────────────
		if rec.Strategy == options.StratNone || len(rec.Legs) == 0 ||
			rec.Confidence < confThreshold || i+1 >= len(candles) {
			continue
		}

		atr    := dailyOptionATR(candles, i)
		iv     := options.IVFromDailyATR(atr, next.Open)
		expiry := options.NextTuesdayFromDate(next.Time)
		dte    := options.ActualDTE(next.Time, expiry)
		atm    := kite.ATMStrike(next.Open)
		expStr := expiry.Format("2006-01-02")

		var isCall, isNeutral bool
		var optType string
		switch rec.Strategy {
		case options.StratDirectionalCE:
			isCall, optType = true, "CE"
		case options.StratDirectionalPE:
			isCall, optType = false, "PE"
		case options.StratIronCondor, options.StratIronFly, options.StratStraddle:
			isNeutral, optType = true, "SELL STRADDLE"
		default:
			continue
		}

		var entryPrem float64
		var realToken int
		priceSource := "BS"

		if !isNeutral {
			if ins, err := e.kc.FindOption(expStr, atm, optType); err == nil && ins != nil {
				if rp, err := e.kc.RealOptionPriceAt(ins.InstrumentToken, next.Time); err == nil && rp > 0 {
					entryPrem  = rp
					realToken  = ins.InstrumentToken
					priceSource = "REAL"
				}
			}
		}
		if entryPrem == 0 {
			if isNeutral {
				entryPrem = options.BSPrice(next.Open, atm, iv, dte, true) +
					options.BSPrice(next.Open, atm, iv, dte, false)
			} else {
				entryPrem = options.BSPrice(next.Open, atm, iv, dte, isCall)
			}
		}
		if entryPrem <= 0 { continue }

		delta := 0.0
		if !isNeutral {
			delta = options.BSDelta(next.Open, atm, iv, dte, isCall)
		}

		// Risk/reward per option unit
		riskPerUnit   := riskAmt / qty
		rewardPerUnit := rewardAmt / qty

		open = &openTrade{
			bt: BacktestTrade{
				EntryTime:    next.Time,
				Strategy:     string(rec.Strategy),
				Direction:    rec.Direction,
				EntrySpot:    next.Open,
				ATMStrike:    atm,
				Strike:       atm,
				OptionType:   optType,
				Expiry:       expStr,
				ExpiryLabel:  options.ExpiryLabel(expiry),
				Confidence:   rec.Confidence,
				EntryPremium: round2p(entryPrem),
				IV:           round2p(iv * 100),
				DTE:          dte,
				DeltaEntry:   round2p(delta),
				PriceSource:  priceSource,
				SignalBasis:  rec.Reasoning,
			},
			entryPrem: entryPrem, strike: atm,
			isCall: isCall, isNeutral: isNeutral,
			iv: iv, expiry: expiry, expiryStr: expStr,
			realToken: realToken,
			riskPerUnit: riskPerUnit, rewardPerUnit: rewardPerUnit,
		}

		// Mark entry bar in bar signals
		if len(res.BarSignals) > 0 {
			res.BarSignals[len(res.BarSignals)-1].IsEntry  = true
			res.BarSignals[len(res.BarSignals)-1].EntryDir = rec.Direction
		}
	}

	// ── Summary metrics ────────────────────────────────────────────────────
	var totalWin, totalLoss float64
	for _, t := range res.Trades {
		res.TotalPnL += t.PnL
		if t.PnL >= 0 { res.WinCount++; totalWin += t.PnL } else { res.LossCount++; totalLoss += t.PnL }
		if t.PriceSource == "REAL" { res.RealPriceTrades++ } else { res.BSPriceTrades++ }
	}
	res.TotalPnL    = round2p(res.TotalPnL)
	res.MaxDrawdown = round2p(maxDD)
	res.MaxConsecLoss = maxConsecLoss
	n := len(res.Trades)
	if n > 0 { res.WinRate = round2p(float64(res.WinCount) / float64(n) * 100); res.Expectancy = round2p(res.TotalPnL / float64(n)) }
	if res.WinCount  > 0 { res.AvgWin  = round2p(totalWin / float64(res.WinCount)) }
	if res.LossCount > 0 {
		res.AvgLoss = round2p(totalLoss / float64(res.LossCount))
		if res.AvgWin != 0 { res.RewardRisk = round2p(math.Abs(res.AvgWin / res.AvgLoss)) }
	}
	if totalLoss != 0 { res.ProfitFactor = round2p(math.Abs(totalWin / totalLoss)) }
	res.PricingNote = fmt.Sprintf(
		"%d trades: %d real Kite daily prices, %d Black-Scholes (daily ATR IV, actual DTE to Tuesday expiry). Entry=next-day open, SL/Target=intraday H/L, EOD=daily close.",
		n, res.RealPriceTrades, res.BSPriceTrades,
	)
	return res, nil
}

// dailyOptionHLC fetches the High, Low and Close of an option instrument for a given date.
func (e *Engine) dailyOptionHLC(token int, date time.Time) (high, low, close float64, ok bool) {
	dateStr := date.Format("2006-01-02")
	candles, err := e.kc.HistoricalData(token, "day",
		dateStr+" 09:00:00", dateStr+" 15:30:00")
	if err != nil || len(candles) == 0 {
		return 0, 0, 0, false
	}
	return candles[0].High, candles[0].Low, candles[0].Close, true
}

// dailyOptionATR computes ATR(14) from daily NIFTY candles at position i.
func dailyOptionATR(candles []kite.Candle, i int) float64 {
	period := 14
	start  := i - period
	if start < 1 { start = 1 }
	var sum float64; var n int
	for j := start; j <= i; j++ {
		h, l, pc := candles[j].High, candles[j].Low, candles[j-1].Close
		tr := math.Max(h-l, math.Max(math.Abs(h-pc), math.Abs(l-pc)))
		sum += tr; n++
	}
	if n == 0 { return 200 }
	return sum / float64(n)
}

// ─── NSE Bhavcopy instrument database ─────────────────────────────────────────
