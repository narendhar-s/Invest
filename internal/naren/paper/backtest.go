package paper

import (
	"fmt"
	"math"
	"time"

	"stockwise/internal/naren/analysis/options"
	"stockwise/internal/naren/kite"
)

// BacktestTrade is one completed simulated trade.
type BacktestTrade struct {
	EntryTime    time.Time `json:"entry_time"`
	ExitTime     time.Time `json:"exit_time"`
	Strategy     string    `json:"strategy"`
	Direction    string    `json:"direction"`
	EntrySpot    float64   `json:"entry_spot"`
	ExitSpot     float64   `json:"exit_spot"`
	ATMStrike    float64   `json:"atm_strike"`
	Strike       float64   `json:"strike"`
	OptionType   string    `json:"option_type"`
	Expiry       string    `json:"expiry"`       // yyyy-mm-dd
	ExpiryLabel  string    `json:"expiry_label"` // "2026-06-09 (Weekly)"
	Confidence   int       `json:"confidence"`
	EntryPremium float64   `json:"entry_premium"`
	ExitPremium  float64   `json:"exit_premium"`
	IV           float64   `json:"iv"`            // % e.g. 16.9
	DTE          int       `json:"dte"`           // days to expiry at entry
	DeltaEntry   float64   `json:"delta_entry"`
	PnL          float64   `json:"pnl"`
	PnLPerLot    float64   `json:"pnl_per_lot"`
	ExitReason   string    `json:"exit_reason"`
	BarsHeld     int       `json:"bars_held"`
	PriceSource  string    `json:"price_source"`  // "REAL" | "BS"
	SignalBasis  []string  `json:"signal_basis"`
}

// EquityPoint is a cumulative PnL snapshot.
type EquityPoint struct {
	Time   time.Time `json:"time"`
	Equity float64   `json:"equity"`
	Trade  int       `json:"trade"` // trade index that caused this point (-1 = none)
}

// BarSignal is the per-bar classification for the chart overlay.
type BarSignal struct {
	Time     time.Time `json:"time"`
	Open     float64   `json:"open"`
	High     float64   `json:"high"`
	Low      float64   `json:"low"`
	Close    float64   `json:"close"`
	Volume   int64     `json:"volume"`
	EMA9     float64   `json:"ema9"`
	EMA21    float64   `json:"ema21"`
	Strategy string    `json:"strategy"`
	Regime   string    `json:"regime"`
	IsEntry  bool      `json:"is_entry"`
	IsExit   bool      `json:"is_exit"`
	EntryDir string    `json:"entry_dir"` // BULLISH | BEARISH | NEUTRAL
}

// BacktestResult is the full output.
type BacktestResult struct {
	From           time.Time      `json:"from"`
	To             time.Time      `json:"to"`
	Capital        float64        `json:"capital"`
	Lots           int            `json:"lots"`
	RR             float64        `json:"rr"`
	RiskPct        float64        `json:"risk_pct"`
	RiskPerTrade   float64        `json:"risk_per_trade"`
	TargetPerTrade float64        `json:"target_per_trade"`
	Trades         []BacktestTrade `json:"trades"`
	TotalPnL       float64        `json:"total_pnl"`
	WinCount       int            `json:"win_count"`
	LossCount      int            `json:"loss_count"`
	WinRate        float64        `json:"win_rate"`
	AvgWin         float64        `json:"avg_win"`
	AvgLoss        float64        `json:"avg_loss"`
	RewardRisk     float64        `json:"reward_risk"`
	MaxDrawdown    float64        `json:"max_drawdown"`
	Expectancy     float64        `json:"expectancy"`
	ProfitFactor   float64        `json:"profit_factor"`
	MaxConsecLoss  int            `json:"max_consec_loss"`
	EquityCurve    []EquityPoint  `json:"equity_curve"`
	BarSignals     []BarSignal    `json:"bar_signals"`
	RealPriceTrades int           `json:"real_price_trades"`
	BSPriceTrades   int           `json:"bs_price_trades"`
	PricingNote    string         `json:"pricing_note"`
}

// Backtest replays 15-minute NIFTY candles with accurate option pricing.
// For options still active in the NFO master, real Kite prices are used.
// For expired options (most of the backtest window), Black-Scholes is used
// with accurate DTE (days to next Tuesday expiry) and IV scaled from 15m ATR.
func (e *Engine) Backtest(days int, rr, riskPct float64, lots, confThreshold int) (*BacktestResult, error) {
	if !e.kc.IsConnected() {
		return nil, fmt.Errorf("Kite not connected — login required")
	}
	if days <= 0 || days > 180 { days = 60 }
	if rr <= 0     { rr = e.account.RR }
	if riskPct <= 0 { riskPct = e.account.RiskPct }
	if lots <= 0   { lots = e.account.Lots }
	if confThreshold <= 0 { confThreshold = e.account.ConfThreshold }

	now := time.Now().In(options.ISTLoc())
	from := now.AddDate(0, 0, -days)
	candles, err := e.kc.HistoricalData(
		kite.NiftyIndexToken, "15minute",
		from.Format("2006-01-02 15:04:05"), now.Format("2006-01-02 15:04:05"),
	)
	if err != nil {
		return nil, fmt.Errorf("fetching NIFTY 15m candles: %w", err)
	}
	if len(candles) < 35 {
		return nil, fmt.Errorf("too little data: need ≥35 candles, got %d (try a shorter lookback)", len(candles))
	}

	qty := float64(lots * kite.NiftyLotSize)
	riskAmt   := e.account.Capital * riskPct
	rewardAmt := riskAmt * rr

	res := &BacktestResult{
		From: candles[0].Time, To: candles[len(candles)-1].Time,
		Capital: e.account.Capital, Lots: lots, RR: rr, RiskPct: riskPct,
		RiskPerTrade: riskAmt, TargetPerTrade: rewardAmt,
	}

	// Pre-compute EMA series for the chart overlay
	closes := make([]float64, len(candles))
	for i, c := range candles { closes[i] = c.Close }
	ema9s  := computeEMASeries(closes, 9)
	ema21s := computeEMASeries(closes, 21)

	// Track open/close bar indices for chart markers
	type openTrade struct {
		bt          BacktestTrade
		entryPrem   float64
		strike      float64
		isCall      bool
		isBuy       bool
		isNeutral   bool
		iv          float64
		dte         int         // DTE at entry (for BS tracking)
		expiry      time.Time
		expiryStr   string
		entryBarIdx int
		realToken   int  // >0 means use real Kite prices
	}

	var open *openTrade
	var equity float64
	var peak, maxDD float64
	var consecLoss, maxConsecLoss int
	entryBarSet := map[int]bool{}
	exitBarSet  := map[int]string{}

	const warmup = 25
	for i := warmup; i < len(candles); i++ {
		bar   := candles[i]
		spot  := bar.Close
		isEOD := bar.Time.Hour() == 15 && bar.Time.Minute() >= 15
		isNewDay := i > 0 && candles[i-1].Time.YearDay() != bar.Time.YearDay()

		// ── Mark open position ────────────────────────────────────────────
		if open != nil {
			open.bt.BarsHeld++
			// Compute current option price
			var curPrem float64
			if open.realToken > 0 {
				// Attempt real price lookup; fall back to BS on failure
				if rp, err := e.kc.RealOptionPriceAt(open.realToken, bar.Time); err == nil && rp > 0 {
					curPrem = rp
				}
			}
			if curPrem == 0 {
				// BS mark with updated DTE
				barDTE := options.ActualDTE(bar.Time, open.expiry)
				if open.isNeutral {
					ce := options.BSPrice(spot, open.strike, open.iv, barDTE, true)
					pe := options.BSPrice(spot, open.strike, open.iv, barDTE, false)
					curPrem = ce + pe
				} else {
					curPrem = options.BSPrice(spot, open.strike, open.iv, barDTE, open.isCall)
				}
			}

			var pnl float64
			if open.isNeutral {
				pnl = (open.entryPrem - curPrem) * qty // short straddle profits from decay
			} else {
				if open.isBuy {
					pnl = (curPrem - open.entryPrem) * qty
				} else {
					pnl = (open.entryPrem - curPrem) * qty
				}
			}

			exitReason := ""
			finalPnL   := pnl
			switch {
			case pnl >= rewardAmt:
				exitReason = fmt.Sprintf("Target hit +₹%.0f (RR 1:%.1f)", rewardAmt, rr)
				finalPnL   = rewardAmt
			case pnl <= -riskAmt:
				exitReason = fmt.Sprintf("Stop-loss -₹%.0f", riskAmt)
				finalPnL   = -riskAmt
			case isEOD || isNewDay:
				exitReason = "EOD square-off"
				finalPnL   = pnl
			}

			if exitReason != "" {
				t := &open.bt
				t.ExitTime    = bar.Time
				t.ExitSpot    = spot
				t.ExitPremium = round2p(curPrem)
				t.PnL         = round2p(finalPnL)
				t.PnLPerLot   = round2p(finalPnL / float64(lots))
				t.ExitReason  = exitReason
				res.Trades = append(res.Trades, *t)

				equity += finalPnL
				if equity > peak { peak = equity }
				if dd := peak - equity; dd > maxDD { maxDD = dd }
				res.EquityCurve = append(res.EquityCurve, EquityPoint{
					Time: bar.Time, Equity: round2p(equity), Trade: len(res.Trades) - 1,
				})
				exitBarSet[i] = t.Direction
				if finalPnL < 0 {
					consecLoss++
					if consecLoss > maxConsecLoss { maxConsecLoss = consecLoss }
				} else {
					consecLoss = 0
				}
				open = nil
			}
		}

		// ── Generate signal ───────────────────────────────────────────────
		rec, err := options.Analyze(candles[:i+1], false)
		if err != nil { continue }

		bs := BarSignal{
			Time: bar.Time, Open: bar.Open, High: bar.High,
			Low: bar.Low, Close: bar.Close, Volume: bar.Volume,
			EMA9:     round2p(ema9s[i]),
			EMA21:    round2p(ema21s[i]),
			Strategy: string(rec.Strategy),
			Regime:   string(rec.Regime),
		}
		if exitBarSet[i] != "" {
			bs.IsExit   = true
			bs.EntryDir = exitBarSet[i]
		}

		// ── New entry ─────────────────────────────────────────────────────
		if open == nil && !isEOD && rec.Strategy != options.StratNone &&
			len(rec.Legs) > 0 && rec.Confidence >= confThreshold {

			atr15m := recentATR(candles, i)
			iv     := options.IVFromATR15m(atr15m, spot)
			expiry := options.NiftyWeeklyExpiry(bar.Time)
			dte    := options.ActualDTE(bar.Time, expiry)
			expiryStr := expiry.Format("2006-01-02")
			atm    := rec.ATMStrike

			var entryPrem float64
			var isCall, isBuy, isNeutral bool
			var optType string
			var realToken int
			priceSource := "BS"

			switch rec.Strategy {
			case options.StratDirectionalCE, options.StratORBCE:
				isCall, isBuy = true, true
				optType = "CE"
			case options.StratDirectionalPE, options.StratORBPE:
				isCall, isBuy = false, true
				optType = "PE"
			case options.StratIronCondor, options.StratIronFly, options.StratStraddle:
				isNeutral = true
				optType = "SELL STRADDLE"
			default:
				continue
			}

			// Try real price from Kite instruments master
			if optType != "SELL STRADDLE" {
				if ins, err := e.kc.FindOption(expiryStr, atm, optType); err == nil && ins != nil {
					if rp, err := e.kc.RealOptionPriceAt(ins.InstrumentToken, bar.Time); err == nil && rp > 0 {
						entryPrem  = rp
						realToken  = ins.InstrumentToken
						priceSource = "REAL"
					}
				}
			}

			// Fall back to Black-Scholes
			if entryPrem == 0 {
				if isNeutral {
					ce := options.BSPrice(spot, atm, iv, dte, true)
					pe := options.BSPrice(spot, atm, iv, dte, false)
					entryPrem = ce + pe
				} else {
					entryPrem = options.BSPrice(spot, atm, iv, dte, isCall)
				}
			}
			if entryPrem <= 0 { continue }

			delta := 0.0
			if !isNeutral {
				delta = options.BSDelta(spot, atm, iv, dte, isCall)
			}

			bt := BacktestTrade{
				EntryTime:    bar.Time,
				Strategy:     string(rec.Strategy),
				Direction:    rec.Direction,
				EntrySpot:    spot,
				ATMStrike:    atm,
				Strike:       atm,
				OptionType:   optType,
				Expiry:       expiryStr,
				ExpiryLabel:  options.ExpiryLabel(expiry),
				Confidence:   rec.Confidence,
				EntryPremium: round2p(entryPrem),
				IV:           round2p(iv * 100),
				DTE:          dte,
				DeltaEntry:   round2p(delta),
				PriceSource:  priceSource,
				SignalBasis:  rec.Reasoning,
			}

			open = &openTrade{
				bt: bt, entryPrem: entryPrem, strike: atm,
				isCall: isCall, isBuy: isBuy, isNeutral: isNeutral,
				iv: iv, dte: dte, expiry: expiry, expiryStr: expiryStr,
				entryBarIdx: i, realToken: realToken,
			}

			entryBarSet[i] = true
			bs.IsEntry   = true
			bs.EntryDir  = rec.Direction
		}

		res.BarSignals = append(res.BarSignals, bs)
	}

	// Mark entry bars
	for i := range res.BarSignals {
		if entryBarSet[i+warmup] {
			res.BarSignals[i].IsEntry = true
		}
	}

	// ── Summary metrics ───────────────────────────────────────────────────
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
	if n > 0 {
		res.WinRate    = round2p(float64(res.WinCount) / float64(n) * 100)
		res.Expectancy = round2p(res.TotalPnL / float64(n))
	}
	if res.WinCount  > 0 { res.AvgWin  = round2p(totalWin / float64(res.WinCount)) }
	if res.LossCount > 0 {
		res.AvgLoss = round2p(totalLoss / float64(res.LossCount))
		if res.AvgWin != 0 { res.RewardRisk = round2p(math.Abs(res.AvgWin / res.AvgLoss)) }
	}
	if totalLoss != 0 { res.ProfitFactor = round2p(math.Abs(totalWin / totalLoss)) }
	res.PricingNote = fmt.Sprintf(
		"%d trades: %d used real Kite prices, %d used Black-Scholes (IV from 15m ATR scaled to daily, DTE = actual calendar days to Tuesday expiry)",
		n, res.RealPriceTrades, res.BSPriceTrades,
	)
	return res, nil
}

// ─── helpers ──────────────────────────────────────────────────────────────────

func computeEMASeries(values []float64, period int) []float64 {
	out := make([]float64, len(values))
	if len(values) == 0 { return out }
	k := 2.0 / float64(period+1)
	out[0] = values[0]
	for i := 1; i < len(values); i++ {
		out[i] = values[i]*k + out[i-1]*(1-k)
	}
	return out
}

func barsUntilEOD(candles []kite.Candle, idx int) int {
	day := candles[idx].Time.YearDay()
	count := 0
	for j := idx + 1; j < len(candles); j++ {
		if candles[j].Time.YearDay() != day { break }
		count++
	}
	if count == 0 { return 1 }
	return count
}

func recentATR(candles []kite.Candle, idx int) float64 {
	period := 14
	start  := idx - period
	if start < 1 { start = 1 }
	var sum float64; var n int
	for i := start; i <= idx; i++ {
		h, l, pc := candles[i].High, candles[i].Low, candles[i-1].Close
		tr := math.Max(h-l, math.Max(math.Abs(h-pc), math.Abs(l-pc)))
		sum += tr; n++
	}
	if n == 0 { return 50 }
	return sum / float64(n)
}

func round2p(v float64) float64 { return math.Round(v*100) / 100 }
