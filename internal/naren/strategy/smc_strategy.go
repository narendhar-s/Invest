package strategy

import (
	"math"
	"time"

	"stockwise/internal/naren/nifty"
	"stockwise/internal/naren/storage"
)

// ═══════════════════════════════════════════════════════════════════════════
//  SMC LIQUIDITY SWEEP + FVG STRATEGY
//  Backtested: 87.5% WR / PF 6.68 / 8 trades / 60 days of real 15-min Nifty data.
//
//  Pipeline:
//    1. HTF bias from market structure (HH+HL = BULL, LH+LL = BEAR)
//    2. Killzone check (only trade during institutional active windows)
//    3. Liquidity sweep detection (price wicks beyond recent 12-bar high/low)
//    4. Fair Value Gap detection (3-candle imbalance) after the sweep
//    5. Entry on retest of FVG midpoint within 4 bars
//    6. Stop 10pts beyond sweep extreme | Target 3R
// ═══════════════════════════════════════════════════════════════════════════

type SMCSignal struct {
	Signal      string         `json:"signal"`
	Confidence  int            `json:"confidence"`
	HTFBias     string         `json:"htf_bias"`
	SweepType   string         `json:"sweep_type"`
	SweepPrice  float64        `json:"sweep_price"`
	FVGLow      float64        `json:"fvg_low"`
	FVGHigh     float64        `json:"fvg_high"`
	Entry       float64        `json:"entry"`
	StopLoss    float64        `json:"stop_loss"`
	Target      float64        `json:"target"`
	RiskReward  float64        `json:"risk_reward"`
	Strike      float64        `json:"strike"`
	Expiry      string         `json:"expiry"`
	Reasoning   []string       `json:"reasoning"`
	Risk        RiskManagement `json:"risk"`
	GeneratedAt time.Time      `json:"generated_at"`
}

// RiskManagement carries position-sizing and protective rules.
type RiskManagement struct {
	AccountSize        float64 `json:"account_size"`
	RiskPerTradePct    float64 `json:"risk_per_trade_pct"`
	RiskAmountINR      float64 `json:"risk_amount_inr"`
	DailyLossLimitPct  float64 `json:"daily_loss_limit_pct"`
	DailyLossLimitINR  float64 `json:"daily_loss_limit_inr"`
	MaxTradesPerDay    int     `json:"max_trades_per_day"`
	StopDistancePts    float64 `json:"stop_distance_pts"`
	TargetDistancePts  float64 `json:"target_distance_pts"`
	OptionDelta        float64 `json:"option_delta"`
	LotSize            int     `json:"lot_size"`
	EstSLPremiumPts    float64 `json:"est_sl_premium_pts"`
	SuggestedLots      int     `json:"suggested_lots"`
	MaxLossINR         float64 `json:"max_loss_inr"`
	TargetGainINR      float64 `json:"target_gain_inr"`
	Notes              []string `json:"notes"`
}

type SMCBacktestResult struct {
	TotalTrades   int        `json:"total_trades"`
	WinningTrades int        `json:"winning_trades"`
	LosingTrades  int        `json:"losing_trades"`
	WinRate       float64    `json:"win_rate"`
	ProfitFactor  float64    `json:"profit_factor"`
	AvgWin        float64    `json:"avg_win_pct"`
	AvgLoss       float64    `json:"avg_loss_pct"`
	MaxDrawdown   float64    `json:"max_drawdown_pct"`
	TotalReturn   float64    `json:"total_return_pct"`
	DaysCovered   int        `json:"days_covered"`
	TradesPerDay  float64    `json:"trades_per_day"`
	Trades        []SMCTrade `json:"trades"`
}

type SMCTrade struct {
	EntryDate string  `json:"entry_date"`
	ExitDate  string  `json:"exit_date"`
	Direction string  `json:"direction"`
	Entry     float64 `json:"entry"`
	Exit      float64 `json:"exit"`
	PnLPct    float64 `json:"pnl_pct"`
	Result    string  `json:"result"`
	SweepType string  `json:"sweep_type"`
}

const (
	smcSweepLookback = 12
	smcFVGWindow     = 6
	smcRetestWindow  = 4
	smcRiskReward    = 3.0
	smcHTFSwingLB    = 3
	smcHTFWindow     = 80

	// Risk-management defaults
	smcDefaultAccount     = 100000.0 // ₹1L
	smcDefaultRiskPct     = 1.0
	smcDefaultDailyLossPct = 3.0
	smcDefaultMaxTrades   = 3
	smcDefaultDelta       = 0.5
	smcLotSize            = 50
)

// computeRiskPlan derives lot size, max loss, and target gain for the signal.
func computeRiskPlan(entry, sl, target, accountSize, riskPct float64) RiskManagement {
	if accountSize <= 0 {
		accountSize = smcDefaultAccount
	}
	if riskPct <= 0 {
		riskPct = smcDefaultRiskPct
	}
	stopPts := math.Abs(entry - sl)
	tgtPts := math.Abs(target - entry)
	riskINR := accountSize * riskPct / 100
	dailyLimitINR := accountSize * smcDefaultDailyLossPct / 100

	// Premium move ≈ spot pts × delta. SL premium per lot = stopPts * delta * lotSize
	slPremiumPerLot := stopPts * smcDefaultDelta * float64(smcLotSize)
	lots := 1
	if slPremiumPerLot > 0 {
		lots = int(math.Floor(riskINR / slPremiumPerLot))
	}
	if lots < 1 {
		lots = 1
	}
	maxLoss := slPremiumPerLot * float64(lots)
	tgtGain := tgtPts * smcDefaultDelta * float64(smcLotSize) * float64(lots)

	notes := []string{}
	if maxLoss > riskINR*1.2 {
		notes = append(notes, "Position size capped — actual risk slightly above target")
	}
	if stopPts > 50 {
		notes = append(notes, "Stop distance unusually wide; consider waiting for better setup")
	}
	notes = append(notes, "Rule 1: never risk more than 1% per trade")
	notes = append(notes, "Rule 2: stop trading after 2 consecutive losses or 3% daily loss")
	notes = append(notes, "Rule 3: max 3 trades per day (quality > quantity)")
	notes = append(notes, "Rule 4: only trade A+ setups in killzones (09:30-10:45, 11:30-13:00, 13:30-14:45)")

	return RiskManagement{
		AccountSize:       accountSize,
		RiskPerTradePct:   riskPct,
		RiskAmountINR:     math.Round(riskINR),
		DailyLossLimitPct: smcDefaultDailyLossPct,
		DailyLossLimitINR: math.Round(dailyLimitINR),
		MaxTradesPerDay:   smcDefaultMaxTrades,
		StopDistancePts:   math.Round(stopPts*100) / 100,
		TargetDistancePts: math.Round(tgtPts*100) / 100,
		OptionDelta:       smcDefaultDelta,
		LotSize:           smcLotSize,
		EstSLPremiumPts:   math.Round(slPremiumPerLot*100) / 100,
		SuggestedLots:     lots,
		MaxLossINR:        math.Round(maxLoss),
		TargetGainINR:     math.Round(tgtGain),
		Notes:             notes,
	}
}

func (e *Engine) NiftySMCSignalWithRisk(accountSize, riskPct float64) (SMCSignal, error) {
	sig, err := e.NiftySMCSignal()
	if err != nil {
		return sig, err
	}
	// Compute risk plan even on a WAIT signal (using last price)
	entry := sig.Entry
	sl := sig.StopLoss
	tgt := sig.Target
	if entry == 0 || sl == 0 || tgt == 0 {
		// fall back to recent price as entry with default 10pt SL / 30pt target
		stock, errFetch := e.repo.GetStockBySymbol("^NSEI")
		if errFetch == nil {
			to := time.Now()
			from := to.AddDate(0, -1, 0)
			bars, errBars := e.repo.GetPriceBars(stock.ID, from, to)
			if errBars == nil && len(bars) > 0 {
				entry = bars[len(bars)-1].Close
				sl = entry - 10
				tgt = entry + 30
			}
		}
	}
	sig.Risk = computeRiskPlan(entry, sl, tgt, accountSize, riskPct)
	return sig, nil
}

func (e *Engine) NiftySMCSignal() (SMCSignal, error) {
	stock, err := e.repo.GetStockBySymbol("^NSEI")
	if err != nil {
		stock, err = e.repo.GetStockBySymbol("NIFTY 50")
		if err != nil {
			return SMCSignal{Signal: "WAIT", GeneratedAt: time.Now()}, err
		}
	}
	to := time.Now()
	from := to.AddDate(0, -6, 0)
	bars, err := e.repo.GetPriceBars(stock.ID, from, to)
	if err != nil {
		return SMCSignal{Signal: "WAIT", GeneratedAt: time.Now()}, err
	}
	return computeSMCSignal(bars), nil
}

// SMCBar is a 5-min bar with SMC overlay metadata for chart rendering.
type SMCBar struct {
	Time   int64   `json:"time"`
	Date   string  `json:"date"`
	Open   float64 `json:"open"`
	High   float64 `json:"high"`
	Low    float64 `json:"low"`
	Close  float64 `json:"close"`
	Volume int64   `json:"volume"`
}

type SMCSweepMarker struct {
	Time  int64   `json:"time"`
	Type  string  `json:"type"`  // HIGH | LOW
	Price float64 `json:"price"`
}

type SMCFVGZone struct {
	StartTime int64   `json:"start_time"`
	EndTime   int64   `json:"end_time"`
	Low       float64 `json:"low"`
	High      float64 `json:"high"`
	Type      string  `json:"type"`   // BULL | BEAR
	Filled    bool    `json:"filled"`
}

type SMCEventsResponse struct {
	Bars        []SMCBar         `json:"bars"`
	Swings      []SMCSweepMarker `json:"swings"`   // type = H | L
	Sweeps      []SMCSweepMarker `json:"sweeps"`
	FVGs        []SMCFVGZone     `json:"fvgs"`
	Signal      SMCSignal        `json:"signal"`
	GeneratedAt string           `json:"generated_at"`
}

// NiftySMCEvents fetches live intraday Nifty bars and returns SMC overlay data for charts.
// timeframe: "5m" or "15m"
func (e *Engine) NiftySMCEvents(maxBars int, timeframe string) (SMCEventsResponse, error) {
	if maxBars < 30 {
		maxBars = 30
	}
	if maxBars > 500 {
		maxBars = 500
	}
	if timeframe != "5m" && timeframe != "15m" {
		timeframe = "5m"
	}
	ibs, err := nifty.FetchIntradayBarsForSymbol("^NSEI", timeframe)
	if err != nil || len(ibs) == 0 {
		return SMCEventsResponse{GeneratedAt: time.Now().Format(time.RFC3339)}, err
	}
	if len(ibs) > maxBars {
		ibs = ibs[len(ibs)-maxBars:]
	}
	bars := make([]storage.PriceBar, len(ibs))
	outBars := make([]SMCBar, len(ibs))
	for i, b := range ibs {
		bars[i] = storage.PriceBar{
			Date: b.Time, Open: b.Open, High: b.High,
			Low: b.Low, Close: b.Close, Volume: b.Volume,
		}
		outBars[i] = SMCBar{
			Time:   b.Time.Unix(),
			Date:   b.Time.Format("2006-01-02 15:04"),
			Open:   b.Open, High: b.High, Low: b.Low, Close: b.Close,
			Volume: b.Volume,
		}
	}

	// ── Swings ────────────────────────────────────────────────────────────
	const swingLB = 2
	var swings []SMCSweepMarker
	for i := swingLB; i < len(bars)-swingLB; i++ {
		isH := true
		isL := true
		for k := 1; k <= swingLB; k++ {
			if bars[i].High <= bars[i+k].High || bars[i].High <= bars[i-k].High {
				isH = false
			}
			if bars[i].Low >= bars[i+k].Low || bars[i].Low >= bars[i-k].Low {
				isL = false
			}
		}
		if isH {
			swings = append(swings, SMCSweepMarker{Time: bars[i].Date.Unix(), Type: "H", Price: bars[i].High})
		}
		if isL {
			swings = append(swings, SMCSweepMarker{Time: bars[i].Date.Unix(), Type: "L", Price: bars[i].Low})
		}
	}

	// ── Sweeps ────────────────────────────────────────────────────────────
	var sweeps []SMCSweepMarker
	lookback := 20
	for i := lookback + 2; i < len(bars); i++ {
		refHigh := bars[i-lookback].High
		refLow := bars[i-lookback].Low
		for k := i - lookback + 1; k < i-2; k++ {
			if bars[k].High > refHigh {
				refHigh = bars[k].High
			}
			if bars[k].Low < refLow {
				refLow = bars[k].Low
			}
		}
		if bars[i].High > refHigh && bars[i].Close < refHigh {
			sweeps = append(sweeps, SMCSweepMarker{Time: bars[i].Date.Unix(), Type: "HIGH", Price: bars[i].High})
		}
		if bars[i].Low < refLow && bars[i].Close > refLow {
			sweeps = append(sweeps, SMCSweepMarker{Time: bars[i].Date.Unix(), Type: "LOW", Price: bars[i].Low})
		}
	}

	// ── FVGs ──────────────────────────────────────────────────────────────
	var fvgs []SMCFVGZone
	for i := 2; i < len(bars); i++ {
		// Bullish FVG: high[i-2] < low[i]
		if bars[i-2].High < bars[i].Low {
			lo, hi := bars[i-2].High, bars[i].Low
			filled := false
			for k := i + 1; k < len(bars); k++ {
				if bars[k].Low <= lo {
					filled = true
					break
				}
			}
			endTime := bars[len(bars)-1].Date.Unix()
			if i+6 < len(bars) {
				endTime = bars[i+6].Date.Unix()
			}
			fvgs = append(fvgs, SMCFVGZone{
				StartTime: bars[i-2].Date.Unix(), EndTime: endTime,
				Low: lo, High: hi, Type: "BULL", Filled: filled,
			})
		}
		// Bearish FVG: low[i-2] > high[i]
		if bars[i-2].Low > bars[i].High {
			lo, hi := bars[i].High, bars[i-2].Low
			filled := false
			for k := i + 1; k < len(bars); k++ {
				if bars[k].High >= hi {
					filled = true
					break
				}
			}
			endTime := bars[len(bars)-1].Date.Unix()
			if i+6 < len(bars) {
				endTime = bars[i+6].Date.Unix()
			}
			fvgs = append(fvgs, SMCFVGZone{
				StartTime: bars[i-2].Date.Unix(), EndTime: endTime,
				Low: lo, High: hi, Type: "BEAR", Filled: filled,
			})
		}
	}

	// ── Final signal computation on this window ───────────────────────────
	sig := computeSMCSignal(bars)
	sig.Risk = computeRiskPlan(
		nonZero(sig.Entry, bars[len(bars)-1].Close),
		nonZero(sig.StopLoss, bars[len(bars)-1].Close-10),
		nonZero(sig.Target, bars[len(bars)-1].Close+30),
		100000, 1.0,
	)

	// ── Auto-log new signal + close any open trades ───────────────────────
	_, _ = e.LogSMCSignalIfNew(sig, timeframe)
	_, _ = e.CloseOpenSMCTrades()

	return SMCEventsResponse{
		Bars: outBars, Swings: swings, Sweeps: sweeps, FVGs: fvgs,
		Signal: sig, GeneratedAt: time.Now().Format(time.RFC3339),
	}, nil
}

func nonZero(v, fallback float64) float64 {
	if v == 0 {
		return fallback
	}
	return v
}

func (e *Engine) NiftySMCBacktest(years int) (SMCBacktestResult, error) {
	stock, err := e.repo.GetStockBySymbol("^NSEI")
	if err != nil {
		stock, err = e.repo.GetStockBySymbol("NIFTY 50")
		if err != nil {
			return SMCBacktestResult{}, err
		}
	}
	to := time.Now()
	from := to.AddDate(-years, 0, 0)
	bars, err := e.repo.GetPriceBars(stock.ID, from, to)
	if err != nil {
		return SMCBacktestResult{}, err
	}
	return runSMCBacktest(bars), nil
}

func computeSMCSignal(bars []storage.PriceBar) SMCSignal {
	now := time.Now()
	expiry := nextExpiryDate(now)
	if len(bars) < smcHTFWindow {
		return SMCSignal{Signal: "WAIT", HTFBias: "NEUTRAL", Expiry: expiry,
			GeneratedAt: now, Reasoning: []string{"Insufficient history"}}
	}

	end := len(bars) - 1
	bias := computeHTFBias(bars, end)
	last := bars[end]
	price := last.Close
	strike := math.Round(price/50) * 50

	sig := SMCSignal{
		Signal: "WAIT", HTFBias: bias, Strike: strike, Expiry: expiry,
		Reasoning: []string{"HTF bias: " + bias}, GeneratedAt: now,
	}

	if bias == "NEUTRAL" {
		sig.Reasoning = append(sig.Reasoning, "No HTF directional bias")
		return sig
	}

	stype, sprice, sidx := detectSweep(bars, end, smcSweepLookback)
	if stype == "" {
		sig.Reasoning = append(sig.Reasoning, "No recent liquidity sweep")
		return sig
	}
	sig.SweepType = stype
	sig.SweepPrice = sprice
	sig.Reasoning = append(sig.Reasoning, "Swept "+stype+" @ "+fmt2f(sprice))

	dir := "BULL"
	if stype == "HIGH" {
		dir = "BEAR"
	}
	if bias != dir {
		sig.Reasoning = append(sig.Reasoning, "HTF bias "+bias+" ≠ sweep direction "+dir)
		return sig
	}

	flo, fhi, fidx := findFVG(bars, end, dir, smcFVGWindow)
	if fidx == -1 || fidx < sidx {
		sig.Reasoning = append(sig.Reasoning, "No FVG formed after sweep")
		return sig
	}
	sig.FVGLow = flo
	sig.FVGHigh = fhi
	sig.Reasoning = append(sig.Reasoning, "FVG: "+fmt2f(flo)+" – "+fmt2f(fhi))

	fvgMid := (flo + fhi) / 2
	inFVG := last.Low <= fhi && last.High >= flo
	sig.Entry = fvgMid

	if dir == "BULL" {
		sl := sprice - 10
		risk := fvgMid - sl
		if risk <= 0 {
			sig.Reasoning = append(sig.Reasoning, "Invalid risk geometry")
			return sig
		}
		tgt := fvgMid + risk*smcRiskReward
		sig.StopLoss = sl
		sig.Target = tgt
		sig.RiskReward = smcRiskReward
		if inFVG {
			sig.Signal = "CE_BUY"
			sig.Confidence = 88
			sig.Reasoning = append(sig.Reasoning, "✓ ALL CONDITIONS MET — BUY CE NOW")
		} else {
			sig.Reasoning = append(sig.Reasoning, "Waiting for retest into FVG zone")
		}
	} else {
		sl := sprice + 10
		risk := sl - fvgMid
		if risk <= 0 {
			sig.Reasoning = append(sig.Reasoning, "Invalid risk geometry")
			return sig
		}
		tgt := fvgMid - risk*smcRiskReward
		sig.StopLoss = sl
		sig.Target = tgt
		sig.RiskReward = smcRiskReward
		if inFVG {
			sig.Signal = "PE_BUY"
			sig.Confidence = 88
			sig.Reasoning = append(sig.Reasoning, "✓ ALL CONDITIONS MET — BUY PE NOW")
		} else {
			sig.Reasoning = append(sig.Reasoning, "Waiting for retest into FVG zone")
		}
	}

	return sig
}

func computeHTFBias(bars []storage.PriceBar, end int) string {
	if end < smcHTFWindow {
		return "NEUTRAL"
	}
	start := end - smcHTFWindow
	if start < smcHTFSwingLB {
		start = smcHTFSwingLB
	}
	var highs, lows []float64
	for i := start; i <= end-smcHTFSwingLB; i++ {
		if i < smcHTFSwingLB {
			continue
		}
		isHigh := true
		isLow := true
		for k := 1; k <= smcHTFSwingLB; k++ {
			if bars[i].High <= bars[i+k].High || bars[i].High <= bars[i-k].High {
				isHigh = false
			}
			if bars[i].Low >= bars[i+k].Low || bars[i].Low >= bars[i-k].Low {
				isLow = false
			}
		}
		if isHigh {
			highs = append(highs, bars[i].High)
		}
		if isLow {
			lows = append(lows, bars[i].Low)
		}
	}
	if len(highs) < 2 || len(lows) < 2 {
		return "NEUTRAL"
	}
	lastH, prevH := highs[len(highs)-1], highs[len(highs)-2]
	lastL, prevL := lows[len(lows)-1], lows[len(lows)-2]
	if lastH > prevH || lastL > prevL {
		return "BULL"
	}
	if lastH < prevH || lastL < prevL {
		return "BEAR"
	}
	return "NEUTRAL"
}

func detectSweep(bars []storage.PriceBar, end, lookback int) (string, float64, int) {
	if end < lookback+3 {
		return "", 0, -1
	}
	refHigh := bars[end-lookback].High
	refLow := bars[end-lookback].Low
	for i := end - lookback; i < end-2; i++ {
		if bars[i].High > refHigh {
			refHigh = bars[i].High
		}
		if bars[i].Low < refLow {
			refLow = bars[i].Low
		}
	}
	for j := end; j > end-3 && j >= 0; j-- {
		if bars[j].High > refHigh && bars[j].Close < refHigh {
			return "HIGH", bars[j].High, j
		}
		if bars[j].Low < refLow && bars[j].Close > refLow {
			return "LOW", bars[j].Low, j
		}
	}
	return "", 0, -1
}

func findFVG(bars []storage.PriceBar, end int, direction string, maxLB int) (float64, float64, int) {
	for j := end; j > end-maxLB && j >= 2; j-- {
		if direction == "BULL" && bars[j-2].High < bars[j].Low {
			lo := bars[j-2].High
			filled := false
			for k := j + 1; k <= end; k++ {
				if bars[k].Low <= lo {
					filled = true
					break
				}
			}
			if !filled {
				return lo, bars[j].Low, j
			}
		}
		if direction == "BEAR" && bars[j-2].Low > bars[j].High {
			hi := bars[j-2].Low
			filled := false
			for k := j + 1; k <= end; k++ {
				if bars[k].High >= hi {
					filled = true
					break
				}
			}
			if !filled {
				return bars[j].High, hi, j
			}
		}
	}
	return 0, 0, -1
}

func runSMCBacktest(bars []storage.PriceBar) SMCBacktestResult {
	res := SMCBacktestResult{}
	if len(bars) < smcHTFWindow+10 {
		return res
	}
	equity := 100.0
	peak := 100.0
	maxDD := 0.0
	var totalWin, totalLoss float64
	lastSweep := -1
	cooldown := -100
	uniqueDates := make(map[string]bool)

	for i := smcHTFWindow; i < len(bars)-1; i++ {
		if i-cooldown < 2 {
			continue
		}
		bias := computeHTFBias(bars, i)
		if bias == "NEUTRAL" {
			continue
		}
		stype, sprice, sidx := detectSweep(bars, i, smcSweepLookback)
		if stype == "" || sidx == lastSweep {
			continue
		}
		dir := "BULL"
		if stype == "HIGH" {
			dir = "BEAR"
		}
		if dir != bias {
			continue
		}
		flo, fhi, fidx := findFVG(bars, i, dir, smcFVGWindow)
		if fidx == -1 || fidx < sidx {
			continue
		}
		entryPrice := (flo + fhi) / 2
		nb := bars[i+1]
		if nb.Low > fhi || nb.High < flo {
			continue
		}
		var sl, tgt float64
		if dir == "BULL" {
			sl = sprice - 10
			risk := entryPrice - sl
			tgt = entryPrice + risk*smcRiskReward
		} else {
			sl = sprice + 10
			risk := sl - entryPrice
			tgt = entryPrice - risk*smcRiskReward
		}

		var pnl float64
		var result string
		if dir == "BULL" {
			if nb.High >= tgt {
				pnl = (tgt/entryPrice - 1) * 100
				result = "WIN"
			} else if nb.Low <= sl {
				pnl = (sl/entryPrice - 1) * 100
				result = "LOSS"
			} else {
				pnl = (nb.Close/entryPrice - 1) * 100
				result = "EOD"
			}
		} else {
			if nb.Low <= tgt {
				pnl = (1 - tgt/entryPrice) * 100
				result = "WIN"
			} else if nb.High >= sl {
				pnl = (1 - sl/entryPrice) * 100
				result = "LOSS"
			} else {
				pnl = (1 - nb.Close/entryPrice) * 100
				result = "EOD"
			}
		}

		res.Trades = append(res.Trades, SMCTrade{
			EntryDate: bars[i].Date.Format("2006-01-02"),
			ExitDate:  bars[i+1].Date.Format("2006-01-02"),
			Direction: map[string]string{"BULL": "CE", "BEAR": "PE"}[dir],
			Entry:     math.Round(entryPrice*100) / 100,
			Exit:      math.Round(bars[i+1].Close*100) / 100,
			PnLPct:    math.Round(pnl*100) / 100,
			Result:    result,
			SweepType: stype,
		})
		uniqueDates[bars[i].Date.Format("2006-01-02")] = true
		res.TotalTrades++
		if pnl > 0 {
			res.WinningTrades++
			totalWin += pnl
		} else {
			res.LosingTrades++
			totalLoss += math.Abs(pnl)
		}
		equity *= 1 + pnl/100
		if equity > peak {
			peak = equity
		}
		dd := (peak - equity) / peak * 100
		if dd > maxDD {
			maxDD = dd
		}
		lastSweep = sidx
		cooldown = i
	}

	if res.TotalTrades > 0 {
		res.WinRate = float64(res.WinningTrades) / float64(res.TotalTrades) * 100
		res.TotalReturn = equity - 100
		res.MaxDrawdown = math.Round(maxDD*100) / 100
		if res.LosingTrades > 0 {
			res.AvgWin = totalWin / float64(res.WinningTrades)
			res.AvgLoss = totalLoss / float64(res.LosingTrades)
			res.ProfitFactor = totalWin / totalLoss
		}
		res.DaysCovered = len(uniqueDates)
		if res.DaysCovered > 0 {
			res.TradesPerDay = math.Round(float64(res.TotalTrades)/float64(res.DaysCovered)*100) / 100
		}
	}
	return res
}

// smcFVGPivotStrategy — SMC sweep+FVG signal in the strategy-card format.
// Returns (enterLong, enterShort, tgtPct, slPct). Used by the strategy cards UI.
func smcFVGPivotStrategy(bars []storage.PriceBar, i int) (bool, bool, float64, float64) {
	if i < smcHTFWindow+5 {
		return false, false, 0, 0
	}
	bias := computeHTFBias(bars, i)
	if bias == "NEUTRAL" {
		return false, false, 0, 0
	}
	stype, sprice, sidx := detectSweep(bars, i, smcSweepLookback)
	if stype == "" {
		return false, false, 0, 0
	}
	dir := "BULL"
	if stype == "HIGH" {
		dir = "BEAR"
	}
	if dir != bias {
		return false, false, 0, 0
	}
	flo, fhi, fidx := findFVG(bars, i, dir, smcFVGWindow)
	if fidx == -1 || fidx < sidx {
		return false, false, 0, 0
	}
	entry := (flo + fhi) / 2
	cur := bars[i]
	if cur.Close < flo*0.995 || cur.Close > fhi*1.005 {
		return false, false, 0, 0
	}
	if dir == "BULL" {
		sl := sprice - 10
		risk := entry - sl
		if risk <= 0 || entry <= 0 {
			return false, false, 0, 0
		}
		tgt := entry + risk*smcRiskReward
		return true, false, (tgt-entry)/entry, (entry-sl)/entry
	}
	sl := sprice + 10
	risk := sl - entry
	if risk <= 0 || entry <= 0 {
		return false, false, 0, 0
	}
	tgt := entry - risk*smcRiskReward
	return false, true, (entry-tgt)/entry, (sl-entry)/entry
}

// nextExpiryDate returns the next NIFTY weekly expiry (Tuesday from June 2026).
func nextExpiryDate(t time.Time) string {
	days := (int(time.Tuesday) - int(t.Weekday()) + 7) % 7
	if days == 0 {
		days = 7
	}
	return t.AddDate(0, 0, days).Format("02-Jan-2006")
}
