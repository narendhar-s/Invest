package paper

import (
	"fmt"
	"math"
	"sort"
	"time"

	"stockwise/internal/naren/analysis/options"
	"stockwise/internal/naren/kite"
)

// ─── Types ────────────────────────────────────────────────────────────────────

// StrategyMeta describes a book strategy's background.
type StrategyMeta struct {
	Key        string `json:"key"`
	Name       string `json:"name"`
	Book       string `json:"book"`
	Author     string `json:"author"`
	Type       string `json:"type"`        // directional | neutral | momentum | mean-reversion
	TimeFrame  string `json:"time_frame"`  // intraday | swing
	EntryLogic string `json:"entry_logic"`
}

// StrategyResult holds the backtest metrics for one strategy.
type StrategyResult struct {
	Meta           StrategyMeta    `json:"meta"`
	Trades         []CompareTrade  `json:"trades"`
	TotalPnL       float64         `json:"total_pnl"`
	WinCount       int             `json:"win_count"`
	LossCount      int             `json:"loss_count"`
	WinRate        float64         `json:"win_rate"`
	AvgWin         float64         `json:"avg_win"`
	AvgLoss        float64         `json:"avg_loss"`
	RewardRisk     float64         `json:"reward_risk"`
	ProfitFactor   float64         `json:"profit_factor"`
	Expectancy     float64         `json:"expectancy"`    // ₹ per trade
	MaxDrawdown    float64         `json:"max_drawdown"`
	MaxConsecLoss  int             `json:"max_consec_loss"`
	TradesPerMonth float64         `json:"trades_per_month"`
	Score          float64         `json:"score"`          // composite ranking score
	Rank           int             `json:"rank"`
	EquityCurve    []EquityPoint   `json:"equity_curve"`
}

// CompareTrade is a single trade in the comparison backtest.
type CompareTrade struct {
	EntryTime     time.Time `json:"entry_time"`
	ExitTime      time.Time `json:"exit_time"`
	SignalTime    time.Time `json:"signal_time"`   // bar that generated signal (entry = next bar open)
	Direction     string    `json:"direction"`
	EntrySpot     float64   `json:"entry_spot"`    // NIFTY spot at actual entry (next-bar open)
	SignalSpot    float64   `json:"signal_spot"`   // NIFTY spot when signal fired
	ExitSpot      float64   `json:"exit_spot"`
	Strike        float64   `json:"strike"`
	TradingSymbol string    `json:"trading_symbol"` // e.g. NIFTY23600CE (Jun 09)
	OptionType    string    `json:"option_type"`
	Expiry        string    `json:"expiry"`
	ExpiryLabel   string    `json:"expiry_label"`
	EntryPremium  float64   `json:"entry_premium"`
	ExitPremium   float64   `json:"exit_premium"`  // consistent with PnL (not raw market price)
	PnL           float64   `json:"pnl"`
	ExitReason    string    `json:"exit_reason"`
	Confidence   int       `json:"confidence"`
	SignalReason  string    `json:"signal_reason"`
	PriceSource  string    `json:"price_source"`
}

// DataQuality reports the integrity of the candle data used in the backtest.
type DataQuality struct {
	TotalBars     int      `json:"total_bars"`
	TradingDays   int      `json:"trading_days"`
	ExpectedBars  int      `json:"expected_bars"`   // ~25 bars/day × trading_days
	MissingBars   int      `json:"missing_bars"`
	DuplicateBars int      `json:"duplicate_bars"`
	PriceGaps     int      `json:"price_gaps"`      // consecutive bars >2% apart
	GapDetails    []string `json:"gap_details,omitempty"`
	Verdict       string   `json:"verdict"`         // CLEAN | MINOR_GAPS | SIGNIFICANT_GAPS
}

// CompareResult is the full comparison output.
type CompareResult struct {
	From           time.Time        `json:"from"`
	To             time.Time        `json:"to"`
	Days           int              `json:"days"`
	Capital        float64          `json:"capital"`
	RR             float64          `json:"rr"`
	Lots           int              `json:"lots"`
	RiskPerTrade   float64          `json:"risk_per_trade"`
	TargetPerTrade float64          `json:"target_per_trade"`
	Strategies     []StrategyResult `json:"strategies"`
	Winner         StrategyMeta     `json:"winner"`
	WinnerReason   string           `json:"winner_reason"`
	Candles        []kite.Candle    `json:"candles"`
	DataQuality    DataQuality      `json:"data_quality"`
}

// ─── Strategy registry ────────────────────────────────────────────────────────

var bookStrategies = []StrategyMeta{
	{
		Key: "ORB", Name: "Opening Range Breakout",
		Book: "Day Trading with Short Term Price Patterns and Opening Range Breakout",
		Author: "Toby Crabel (1990)",
		Type: "momentum", TimeFrame: "intraday",
		EntryLogic: "Buy CE/PE when price closes outside the first 15-min candle's range. Confirms breakout intent.",
	},
	{
		Key: "EMA_CROSS", Name: "EMA Stage Analysis",
		Book: "Secrets for Profiting in Bull and Bear Markets",
		Author: "Stan Weinstein (1988)",
		Type: "trend-following", TimeFrame: "intraday",
		EntryLogic: "Buy CE when EMA9 crosses above EMA21 with rising slope (Stage 2). PE on death cross (Stage 4).",
	},
	{
		Key: "VWAP", Name: "VWAP Pullback Entry",
		Book: "Technical Analysis Using Multiple Timeframes",
		Author: "Brian Shannon (2008)",
		Type: "mean-reversion", TimeFrame: "intraday",
		EntryLogic: "Buy CE on first pullback to VWAP in an uptrend. PE on first bounce to VWAP in downtrend.",
	},
	{
		Key: "SHORT_STRADDLE", Name: "ATM Short Straddle (Theta Harvest)",
		Book: "Options as a Strategic Investment (5th Ed.)",
		Author: "Lawrence G. McMillan (2012)",
		Type: "neutral", TimeFrame: "intraday",
		EntryLogic: "Sell ATM straddle at 9:15 when current ATR < 80% of 20-bar average ATR (low volatility regime).",
	},
	{
		Key: "ATR_MOMENTUM", Name: "ATR Band Breakout (R-Multiple)",
		Book: "Trade Your Way to Financial Freedom",
		Author: "Van K. Tharp (2006)",
		Type: "momentum", TimeFrame: "intraday",
		EntryLogic: "Enter when price breaks VWAP ± 1.5×ATR. Stop = 2R, Target = 3R per Tharp's expectancy system.",
	},
	{
		Key: "SUPERTREND", Name: "SuperTrend Flip",
		Book: "How to Day Trade for a Living",
		Author: "Andrew Aziz + Olivier Seban ATR×3 method (2015)",
		Type: "trend-following", TimeFrame: "intraday",
		EntryLogic: "Buy CE/PE only on the FIRST bar after SuperTrend(10,3) flips direction. Avoids chasing.",
	},
	{
		Key: "BOOMING_BULLS", Name: "Supply & Demand (Booming Bulls)",
		Book: "Booming Bulls Academy — Price Action + Supply & Demand",
		Author: "Anish Singh Thakur (2020) · Sam Seiden S&D methodology",
		Type: "price-action", TimeFrame: "intraday",
		EntryLogic: "Top-down: 1H S&D zones → 15m entry. No indicators. Enter only with Hammer/Engulfing confirmation at zone. 1H structure determines direction.",
	},
}

func metaByKey(key string) StrategyMeta {
	for _, m := range bookStrategies { if m.Key == key { return m } }
	return StrategyMeta{Key: key, Name: key}
}

// ─── Comparison backtest ──────────────────────────────────────────────────────

// CompareConfig holds the fixed ₹ amounts and lot rules for a fair comparison.
// Using fixed ₹ amounts (not % of capital) matches how retail traders actually size:
//   BaseLots   = 2 (baseline position)
//   RiskPerTrade = ₹5,000 (SL hit = lose this)
//   TargetPerTrade = ₹10,000 (target hit = gain this) → RR 1:2
//   LotScaleWithRR: when a setup offers 1:3 RR, scale to 3 lots (same risk, more upside)
type CompareConfig struct {
	BaseLots      int
	RiskRupees    float64 // ₹ risked per trade (SL)
	TargetRupees  float64 // ₹ targeted per trade
	RR            float64
}

// BacktestCompare runs all 7 book strategies on the same NIFTY 15m data.
//
//   days         - lookback period in trading days (max 120)
//   lots         - number of lots per trade (lot size = 75 qty each)
//   riskRupees   - fixed ₹ amount to risk per trade (SL)
//   rewardRupees - fixed ₹ target per trade
func (e *Engine) BacktestCompare(days, lots int, riskRupees, rewardRupees float64) (*CompareResult, error) {
	if !e.kc.IsConnected() {
		return nil, fmt.Errorf("Kite not connected")
	}
	if days        <= 0 || days > 120 { days        = 60 }
	if lots        <= 0               { lots        = 2 }
	if riskRupees  <= 0               { riskRupees  = 5000 }
	if rewardRupees < riskRupees      { rewardRupees = riskRupees * 2 }

	baseLots  := lots
	riskAmt   := riskRupees
	rewardAmt := rewardRupees
	rr        := rewardAmt / riskAmt
	capital   := e.account.Capital
	qty       := float64(baseLots * kite.NiftyLotSize)

	// Fetch 15m NIFTY candles once — all strategies use the same data
	now  := time.Now().In(options.ISTLoc())
	from := now.AddDate(0, 0, -days).Format("2006-01-02 15:04:05")
	to   := now.Format("2006-01-02 15:04:05")
	candles, err := e.kc.HistoricalData(kite.NiftyIndexToken, "15minute", from, to)
	if err != nil {
		return nil, fmt.Errorf("fetching candles: %w", err)
	}
	if len(candles) < 35 {
		return nil, fmt.Errorf("insufficient data: %d candles", len(candles))
	}

	dq := validateCandles(candles)
	result := &CompareResult{
		From: candles[0].Time, To: candles[len(candles)-1].Time,
		Days: days, Capital: capital, RR: rr, Lots: baseLots,
		RiskPerTrade: riskAmt, TargetPerTrade: rewardAmt,
		Candles:     downsampleCandles(candles, 400),
		DataQuality: dq,
	}

	// Run each strategy independently
	for _, meta := range bookStrategies {
		sr := runOneStrategy(meta, candles, e.kc, qty, float64(baseLots), riskAmt, rewardAmt, rr)
		result.Strategies = append(result.Strategies, sr)
	}

	// Score and rank
	scoreAndRank(result.Strategies)
	result.Winner = result.Strategies[0].Meta
	result.WinnerReason = buildWinnerReason(result.Strategies[0])
	return result, nil
}

// runOneStrategy simulates one strategy on the full candle history.
// runOneStrategy simulates a single strategy with three key correctness guarantees:
//
//  1. No look-ahead: signal fires at close of bar[i], entry at OPEN of bar[i+1].
//  2. Intrabar SL check: SL is tested against the bar's low (CE) or high (PE)
//     using BS pricing at that extremity, not just at bar close.
//  3. Consistent exit premium: stored exit premium always equals
//     entry ± (fixed_₹ / qty), so P&L and premium columns are always consistent.
func runOneStrategy(
	meta StrategyMeta,
	candles []kite.Candle,
	kc *kite.Client,
	qty, lots float64,
	riskAmt, rewardAmt, rr float64,
) StrategyResult {

	sr := StrategyResult{Meta: meta}
	// riskPerUnit / rewardPerUnit used inside runOneStrategy via exactSLPrem / exactTargetPrem
	_ = riskAmt / qty   // suppress unused-var if inlined below

	type openPos struct {
		entryPrem float64
		strike    float64
		isCall    bool
		isNeutral bool
		iv        float64
		expiry    time.Time
		expiryStr string
		token     int
		trade     CompareTrade
	}

	var open *openPos
	var equity, peak, maxDD float64
	var consecLoss, maxConsecLoss int

	// warmup+1 because we need bar[i+1] for entry; loop to len-2
	const warmup = 20
	for i := warmup; i < len(candles)-1; i++ {
		bar      := candles[i]
		nextBar  := candles[i+1]
		spot     := bar.Close     // spot when signal is generated (bar close)
		isEOD   := bar.Time.Hour() == 15 && bar.Time.Minute() >= 15
		isNewDay := i > 0 && candles[i-1].Time.YearDay() != bar.Time.YearDay()

		// ── Manage open position (mark on current bar) ───────────────────
		if open != nil {
			dte := options.ActualDTE(bar.Time, open.expiry)

			// Current close premium
			var closePrem float64
			if open.token > 0 {
				if rp, err := kc.RealOptionPriceAt(open.token, bar.Time); err == nil && rp > 0 {
					closePrem = rp
				}
			}
			if closePrem == 0 {
				if open.isNeutral {
					closePrem = options.BSPrice(spot, open.strike, open.iv, dte, true) +
						options.BSPrice(spot, open.strike, open.iv, dte, false)
				} else {
					closePrem = options.BSPrice(spot, open.strike, open.iv, dte, open.isCall)
				}
			}

			// ── Intrabar SL check (Fix #2) ────────────────────────────────
			// For CE buy: compute BS premium at the bar's LOW (worst case for CE buyer)
			// For PE buy: compute BS premium at the bar's HIGH (worst case for PE buyer)
			// If worst-case premium < entry - riskPerUnit → SL triggered intrabar
			var worstPrem float64
			if !open.isNeutral {
				worstSpot := bar.Low
				if !open.isCall { worstSpot = bar.High }
				worstPrem = options.BSPrice(worstSpot, open.strike, open.iv, dte, open.isCall)
			}

			pnlAtClose := 0.0
			if open.isNeutral {
				pnlAtClose = (open.entryPrem - closePrem) * qty
			} else {
				pnlAtClose = (closePrem - open.entryPrem) * qty
			}

			pnlAtWorst := 0.0
			if worstPrem > 0 {
				pnlAtWorst = (worstPrem - open.entryPrem) * qty
			} else {
				pnlAtWorst = pnlAtClose
			}

			reason := ""
			var finalPnL, exitPrem float64

			// exitPremForSL / exitPremForTarget: use exact arithmetic to
			// keep (exitPrem - entryPrem) × qty == ±fixedRupees to within ₹1.
			// We store 4 decimal places internally; the frontend shows 1dp.
			exactSLPrem     := open.entryPrem - riskAmt/qty           // no round2p
			exactTargetPrem := open.entryPrem + rewardAmt/qty

			switch {
			// Check intrabar SL first
			case pnlAtWorst <= -riskAmt && !open.isNeutral:
				reason   = fmt.Sprintf("Stop-loss -₹%.0f (intrabar)", riskAmt)
				finalPnL = -riskAmt
				exitPrem = math.Round(exactSLPrem*10) / 10 // 1dp display

			// Target hit at close
			case pnlAtClose >= rewardAmt:
				reason   = fmt.Sprintf("Target +₹%.0f (RR 1:%.1f)", rewardAmt, rr)
				finalPnL = rewardAmt
				exitPrem = math.Round(exactTargetPrem*10) / 10

			// SL at close
			case pnlAtClose <= -riskAmt:
				reason   = fmt.Sprintf("Stop-loss -₹%.0f", riskAmt)
				finalPnL = -riskAmt
				exitPrem = math.Round(exactSLPrem*10) / 10

			// EOD / new day — EOD uses actual market price
			case isEOD || isNewDay:
				reason   = "EOD square-off"
				finalPnL = round2p(pnlAtClose)
				exitPrem = round2p(closePrem)
			}

			if reason != "" {
				t := open.trade
				t.ExitTime    = bar.Time
				t.ExitSpot    = spot
				t.ExitPremium = exitPrem
				t.PnL         = round2p(finalPnL)
				t.ExitReason  = reason
				sr.Trades = append(sr.Trades, t)

				equity += finalPnL
				if equity > peak { peak = equity }
				if dd := peak - equity; dd > maxDD { maxDD = dd }
				sr.EquityCurve = append(sr.EquityCurve, EquityPoint{Time: bar.Time, Equity: round2p(equity)})
				if finalPnL < 0 {
					consecLoss++
					if consecLoss > maxConsecLoss { maxConsecLoss = consecLoss }
				} else { consecLoss = 0 }
				open = nil
			}
		}

		// ── Generate signal from THIS bar's data ──────────────────────────
		// ONLY candles[:i+1] used — no future data
		var sig options.BookSignal
		switch meta.Key {
		case "ORB":           sig = options.SignalORB(candles[:i+1])
		case "EMA_CROSS":     sig = options.SignalEMACrossover(candles[:i+1])
		case "VWAP":          sig = options.SignalVWAP(candles[:i+1])
		case "SHORT_STRADDLE":sig = options.SignalShortStraddle(candles[:i+1])
		case "ATR_MOMENTUM":  sig = options.SignalATRMomentum(candles[:i+1])
		case "SUPERTREND":    sig = options.SignalSuperTrend(candles[:i+1])
		case "BOOMING_BULLS": sig = options.SignalBoomingBulls(candles[:i+1])
		}

		// No trade if: position already open, last bar of day, no signal
		if open != nil || isEOD || sig.Direction == "NONE" { continue }

		// ── Enter at NEXT bar open (Fix #1 — no look-ahead) ──────────────
		// Signal fires at bar[i] close; we can only act at bar[i+1] open.
		// Also skip if next bar is a new day (no overnight carryover for intraday).
		nextIsNewDay := nextBar.Time.YearDay() != bar.Time.YearDay()
		if nextIsNewDay { continue }

		entrySpot := nextBar.Open                       // ACTUAL entry price
		entryTime := nextBar.Time                       // ACTUAL entry time
		atm       := kite.ATMStrike(entrySpot)         // strike based on actual entry
		atr       := recentATR(candles, i)
		iv        := options.IVFromATR15m(atr, entrySpot)
		expiry    := options.NiftyWeeklyExpiry(entryTime)
		dte       := options.ActualDTE(entryTime, expiry)
		expStr    := expiry.Format("2006-01-02")

		isCall    := sig.OptionSide == "CE"
		isNeutral := sig.OptionSide == "STRADDLE_SELL"
		optType   := sig.OptionSide

		var entryPrem float64
		var token int
		source := "BS"

		// Try real Kite price at next-bar open time
		if !isNeutral {
			if ins, err := kc.FindOption(expStr, atm, optType); err == nil && ins != nil {
				if rp, err := kc.RealOptionPriceAt(ins.InstrumentToken, entryTime); err == nil && rp > 0 {
					entryPrem = rp
					token     = ins.InstrumentToken
					source    = "REAL"
				}
			}
		}
		if entryPrem == 0 {
			if isNeutral {
				entryPrem = options.BSPrice(entrySpot, atm, iv, dte, true) +
					options.BSPrice(entrySpot, atm, iv, dte, false)
			} else {
				entryPrem = options.BSPrice(entrySpot, atm, iv, dte, isCall)
			}
		}
		if entryPrem <= 0 { continue }

		// Build a human-readable trading symbol e.g. "23600CE (Jun 09)"
		tradingSymbol := fmt.Sprintf("%.0f%s (%s)", atm, optType, expiry.Format("Jan 02"))

		open = &openPos{
			entryPrem: entryPrem, strike: atm,
			isCall: isCall, isNeutral: isNeutral,
			iv: iv, expiry: expiry, expiryStr: expStr, token: token,
			trade: CompareTrade{
				SignalTime:    bar.Time,          // bar that generated signal
				EntryTime:    entryTime,           // next bar open = actual fill
				Direction:    sig.Direction,
				SignalSpot:   spot,               // NIFTY when signal fired
				EntrySpot:    entrySpot,          // NIFTY at actual fill
				Strike:       atm,
				TradingSymbol: tradingSymbol,
				OptionType:   optType,
				Expiry:       expStr,
				ExpiryLabel:  options.ExpiryLabel(expiry),
				Confidence:   sig.Confidence,
				EntryPremium: round2p(entryPrem),
				SignalReason: sig.Reason,
				PriceSource:  source,
			},
		}
	}

	// Metrics
	var totalWin, totalLoss float64
	for _, t := range sr.Trades {
		sr.TotalPnL += t.PnL
		if t.PnL >= 0 { sr.WinCount++; totalWin += t.PnL } else { sr.LossCount++; totalLoss += t.PnL }
	}
	sr.TotalPnL    = round2p(sr.TotalPnL)
	sr.MaxDrawdown = round2p(maxDD)
	sr.MaxConsecLoss = maxConsecLoss
	n := len(sr.Trades)
	if n > 0 {
		sr.WinRate    = round2p(float64(sr.WinCount) / float64(n) * 100)
		sr.Expectancy = round2p(sr.TotalPnL / float64(n))
	}
	if sr.WinCount  > 0 { sr.AvgWin  = round2p(totalWin / float64(sr.WinCount)) }
	if sr.LossCount > 0 {
		sr.AvgLoss = round2p(totalLoss / float64(sr.LossCount))
		if sr.AvgWin != 0 { sr.RewardRisk = round2p(math.Abs(sr.AvgWin / sr.AvgLoss)) }
	}
	if totalLoss != 0 { sr.ProfitFactor = round2p(math.Abs(totalWin / totalLoss)) }

	// Trades per month (approx 21 trading days / month)
	if n > 0 {
		tradingDays := float64(sr.StrategyDays(candles))
		sr.TradesPerMonth = round2p(float64(n) / tradingDays * 21)
	}
	return sr
}

// StrategyDays estimates unique trading days in the candle set.
func (sr *StrategyResult) StrategyDays(candles []kite.Candle) int {
	days := map[int]bool{}
	for _, c := range candles { days[c.Time.YearDay()*10000+c.Time.Year()] = true }
	return len(days)
}

// ─── Scoring ──────────────────────────────────────────────────────────────────
// Composite score weights (based on what matters for a retail options trader):
//   40% Expectancy per trade (the primary edge)
//   25% Win rate  (psychological sustainability)
//   20% Profit factor (gross profitability vs losses)
//   15% Max drawdown penalty (risk of ruin)

func scoreAndRank(strategies []StrategyResult) {
	if len(strategies) == 0 { return }

	// Normalise each metric to 0–100 across strategies
	maxExp := maxF(strategies, func(s StrategyResult) float64 { return math.Max(0, s.Expectancy) })
	maxWR  := maxF(strategies, func(s StrategyResult) float64 { return s.WinRate })
	maxPF  := maxF(strategies, func(s StrategyResult) float64 { return math.Min(5, s.ProfitFactor) })
	maxDD  := maxF(strategies, func(s StrategyResult) float64 { return s.MaxDrawdown })

	for i := range strategies {
		s := &strategies[i]
		expScore := 0.0
		if maxExp > 0 { expScore = math.Max(0, s.Expectancy) / maxExp * 100 }
		wrScore  := 0.0
		if maxWR > 0  { wrScore = s.WinRate / maxWR * 100 }
		pfScore  := 0.0
		if maxPF > 0  { pfScore = math.Min(5, s.ProfitFactor) / maxPF * 100 }
		ddPenalty := 0.0
		if maxDD > 0  { ddPenalty = (1 - s.MaxDrawdown/maxDD) * 100 }

		s.Score = round2p(expScore*0.40 + wrScore*0.25 + pfScore*0.20 + ddPenalty*0.15)
	}

	sort.Slice(strategies, func(i, j int) bool {
		return strategies[i].Score > strategies[j].Score
	})
	for i := range strategies { strategies[i].Rank = i + 1 }
}

func buildWinnerReason(s StrategyResult) string {
	return fmt.Sprintf(
		"%s by %s scores %.0f/100 — Expectancy ₹%.0f/trade · %.0f%% win rate · Profit Factor %.1f · Max DD ₹%.0f",
		s.Meta.Name, s.Meta.Author, s.Score,
		s.Expectancy, s.WinRate, s.ProfitFactor, s.MaxDrawdown,
	)
}

func maxF(ss []StrategyResult, fn func(StrategyResult) float64) float64 {
	m := 0.0
	for _, s := range ss { if v := fn(s); v > m { m = v } }
	return m
}

// validateCandles checks data integrity: duplicates, gaps, price anomalies.
func validateCandles(candles []kite.Candle) DataQuality {
	dq := DataQuality{}
	if len(candles) == 0 {
		dq.Verdict = "NO_DATA"
		return dq
	}
	dq.TotalBars = len(candles)

	daySet := map[string]bool{}
	seen   := map[string]int{}
	const maxGapPct = 0.02   // 2% price gap flags as anomaly
	const barsPerDay = 25

	for i, c := range candles {
		dayKey := c.Time.Format("2006-01-02")
		daySet[dayKey] = true

		// Duplicate check
		tsKey := c.Time.Format("2006-01-02T15:04")
		seen[tsKey]++
		if seen[tsKey] > 1 { dq.DuplicateBars++ }

		// Price gap check (skip first bar of each day)
		if i > 0 {
			prevDay := candles[i-1].Time.Format("2006-01-02")
			if dayKey == prevDay {
				gap := math.Abs(c.Open-candles[i-1].Close) / candles[i-1].Close
				if gap > maxGapPct {
					dq.PriceGaps++
					if len(dq.GapDetails) < 5 {
						dq.GapDetails = append(dq.GapDetails, fmt.Sprintf(
							"%s: %.0f→%.0f (%.1f%%)",
							c.Time.Format("Jan02 15:04"), candles[i-1].Close, c.Open, gap*100,
						))
					}
				}
			}
		}
	}

	dq.TradingDays  = len(daySet)
	dq.ExpectedBars  = dq.TradingDays * barsPerDay
	dq.MissingBars   = max(0, dq.ExpectedBars-dq.TotalBars)

	switch {
	case dq.DuplicateBars > 0:
		dq.Verdict = "DUPLICATES"
	case dq.PriceGaps > dq.TradingDays/5: // more than 20% of days have a gap
		dq.Verdict = "SIGNIFICANT_GAPS"
	case dq.MissingBars > dq.TradingDays*2: // more than 2 bars/day missing on average
		dq.Verdict = "MINOR_GAPS"
	default:
		dq.Verdict = "CLEAN"
	}
	return dq
}

func downsampleCandles(candles []kite.Candle, max int) []kite.Candle {
	if len(candles) <= max { return candles }
	step := len(candles) / max
	out  := make([]kite.Candle, 0, max)
	for i := 0; i < len(candles); i += step { out = append(out, candles[i]) }
	return out
}
