package strategy

import (
	"fmt"
	"math"
	"sort"
	"time"

	"stockwise/internal/naren/nifty"
	"stockwise/internal/naren/storage"
)

// ═══════════════════════════════════════════════════════════════════════════
//   SMC TRADE JOURNAL & LEARNING
//
//   - Records every signal into the DB as an OPEN trade
//   - Polls live intraday bars to close OPEN trades when SL/TP/EOD is hit
//   - Computes performance stats and learning insights
// ═══════════════════════════════════════════════════════════════════════════

// LogSMCSignalIfNew inserts the signal as a new OPEN trade unless the same
// setup is already logged. Returns the trade id (0 if no new trade).
func (e *Engine) LogSMCSignalIfNew(sig SMCSignal, timeframe string) (uint, error) {
	if sig.Signal != "CE_BUY" && sig.Signal != "PE_BUY" {
		return 0, nil
	}
	dir := "CE"
	if sig.Signal == "PE_BUY" {
		dir = "PE"
	}
	// Dedup: same direction + sweep_price + entry within last 4 hours
	since := time.Now().Add(-4 * time.Hour)
	if existing, _ := e.repo.GetSMCTradeBySignature(timeframe, dir, sig.SweepPrice, sig.Entry, since); existing != nil {
		return 0, nil
	}
	now := time.Now()
	kz := killzoneFor(now)
	t := &storage.SMCTradeLog{
		GeneratedAt:   now,
		Timeframe:     timeframe,
		Direction:     dir,
		HTFBias:       sig.HTFBias,
		SweepType:     sig.SweepType,
		SweepPrice:    sig.SweepPrice,
		FVGLow:        sig.FVGLow,
		FVGHigh:       sig.FVGHigh,
		Entry:         sig.Entry,
		StopLoss:      sig.StopLoss,
		Target:        sig.Target,
		RiskReward:    sig.RiskReward,
		AccountSize:   sig.Risk.AccountSize,
		RiskPct:       sig.Risk.RiskPerTradePct,
		SuggestedLots: sig.Risk.SuggestedLots,
		MaxLossINR:    sig.Risk.MaxLossINR,
		TargetGainINR: sig.Risk.TargetGainINR,
		Status:        "OPEN",
		Killzone:      kz,
		DayOfWeek:     now.Weekday().String()[:3],
		HourBucket:    now.Hour(),
	}
	if err := e.repo.CreateSMCTrade(t); err != nil {
		return 0, err
	}
	return t.ID, nil
}

// CloseOpenSMCTrades scans every OPEN trade and closes it if SL/TP hit
// using the latest 5m bars since the trade was generated.
func (e *Engine) CloseOpenSMCTrades() (closed int, err error) {
	opens, err := e.repo.GetOpenSMCTrades()
	if err != nil || len(opens) == 0 {
		return 0, err
	}

	// Fetch latest 5m bars once
	ibs, ferr := nifty.FetchIntradayBarsForSymbol("^NSEI", "5m")
	if ferr != nil || len(ibs) == 0 {
		return 0, ferr
	}

	for i := range opens {
		t := &opens[i]
		barsAfter := barsAfterTime(ibs, t.GeneratedAt)
		if len(barsAfter) == 0 {
			continue
		}
		exitPrice, status, barsHeld := simulateExit(t, barsAfter)
		if status == "OPEN" {
			continue
		}
		// EOD check — if the trade's generated_at is older than today's session, force EOD
		genDay := t.GeneratedAt.Format("2006-01-02")
		latestDay := ibs[len(ibs)-1].Time.Format("2006-01-02")
		if status == "OPEN" && genDay != latestDay {
			exitPrice = barsAfter[len(barsAfter)-1].Close
			status = "EOD"
			barsHeld = len(barsAfter)
		}
		// Compute pnl
		pnlPct := 0.0
		if t.Direction == "CE" {
			pnlPct = (exitPrice/t.Entry - 1) * 100
		} else {
			pnlPct = (1 - exitPrice/t.Entry) * 100
		}
		// PnL in INR (premium approximation with delta=0.5)
		pnlINR := pnlPct / 100 * t.Entry * 0.5 * 50 * float64(t.SuggestedLots)
		now := time.Now()
		t.ExitPrice = exitPrice
		t.Status = status
		t.ClosedAt = &now
		t.PnLPct = math.Round(pnlPct*100) / 100
		t.PnLINR = math.Round(pnlINR)
		t.BarsHeld = barsHeld
		if err := e.repo.UpdateSMCTrade(t); err != nil {
			return closed, err
		}
		closed++
	}
	return closed, nil
}

// simulateExit walks the bars after entry and returns (exitPrice, status, barsHeld).
// Status: WIN | LOSS | EOD | OPEN (still running)
func simulateExit(t *storage.SMCTradeLog, bars []nifty.IntradayBar) (float64, string, int) {
	for i, b := range bars {
		if t.Direction == "CE" {
			if b.High >= t.Target {
				return t.Target, "WIN", i + 1
			}
			if b.Low <= t.StopLoss {
				return t.StopLoss, "LOSS", i + 1
			}
		} else {
			if b.Low <= t.Target {
				return t.Target, "WIN", i + 1
			}
			if b.High >= t.StopLoss {
				return t.StopLoss, "LOSS", i + 1
			}
		}
		// EOD exit at 15:00 of trade day
		if b.Time.Hour() >= 15 && b.Time.Format("2006-01-02") == t.GeneratedAt.Format("2006-01-02") {
			return b.Close, "EOD", i + 1
		}
	}
	return 0, "OPEN", 0
}

func barsAfterTime(bars []nifty.IntradayBar, t time.Time) []nifty.IntradayBar {
	out := []nifty.IntradayBar{}
	for _, b := range bars {
		if b.Time.After(t) {
			out = append(out, b)
		}
	}
	return out
}

func killzoneFor(t time.Time) string {
	h, m := t.Hour(), t.Minute()
	tot := h*100 + m
	if tot >= 930 && tot <= 1045 {
		return "KZ1"
	}
	if tot >= 1130 && tot <= 1300 {
		return "KZ2"
	}
	if tot >= 1330 && tot <= 1445 {
		return "KZ3"
	}
	return "OFF"
}

// ─── STATS & LEARNING ────────────────────────────────────────────────────────

type SMCJournalResponse struct {
	Overall       storage.SMCStats          `json:"overall"`
	ByTimeframe   map[string]storage.SMCStats `json:"by_timeframe"`
	ByDirection   map[string]storage.SMCStats `json:"by_direction"`
	ByKillzone    map[string]storage.SMCStats `json:"by_killzone"`
	BySweepType   map[string]storage.SMCStats `json:"by_sweep_type"`
	ByDayOfWeek   map[string]storage.SMCStats `json:"by_day_of_week"`
	Recent        []storage.SMCTradeLog     `json:"recent"`
	EquityCurve   []EquityPoint             `json:"equity_curve"`
	Insights      []string                  `json:"insights"`
	Suggestions   []ParamSuggestion         `json:"suggestions"`
	GeneratedAt   string                    `json:"generated_at"`
}

type EquityPoint struct {
	Date  string  `json:"date"`
	PnL   float64 `json:"pnl"`
	Equity float64 `json:"equity"`
}

type ParamSuggestion struct {
	Field   string `json:"field"`
	From    string `json:"from"`
	To      string `json:"to"`
	Reason  string `json:"reason"`
	Impact  string `json:"impact"`
}

// GetSMCJournal returns the full journal + learning analytics.
func (e *Engine) GetSMCJournal() (SMCJournalResponse, error) {
	// First, close any open trades that have resolved
	_, _ = e.CloseOpenSMCTrades()

	trades, err := e.repo.GetRecentSMCTrades(500)
	if err != nil {
		return SMCJournalResponse{}, err
	}

	resp := SMCJournalResponse{
		Overall:     statsFromTrades(trades),
		ByTimeframe: groupStats(trades, func(t storage.SMCTradeLog) string { return t.Timeframe }),
		ByDirection: groupStats(trades, func(t storage.SMCTradeLog) string { return t.Direction }),
		ByKillzone:  groupStats(trades, func(t storage.SMCTradeLog) string { return t.Killzone }),
		BySweepType: groupStats(trades, func(t storage.SMCTradeLog) string { return t.SweepType }),
		ByDayOfWeek: groupStats(trades, func(t storage.SMCTradeLog) string { return t.DayOfWeek }),
		Recent:      trades[:min(len(trades), 50)],
		EquityCurve: buildEquityCurve(trades),
		GeneratedAt: time.Now().Format(time.RFC3339),
	}
	resp.Insights, resp.Suggestions = deriveInsights(resp)
	return resp, nil
}

func statsFromTrades(trades []storage.SMCTradeLog) storage.SMCStats {
	s := storage.SMCStats{}
	var grossWin, grossLoss, totalPnL, totalINR float64
	for _, t := range trades {
		s.Total++
		switch t.Status {
		case "OPEN":
			s.Open++
		case "WIN":
			s.Wins++
			grossWin += t.PnLPct
		case "LOSS":
			s.Losses++
			grossLoss += math.Abs(t.PnLPct)
		case "EOD":
			s.EODs++
			if t.PnLPct > 0 {
				grossWin += t.PnLPct
				s.Wins++
			} else if t.PnLPct < 0 {
				grossLoss += math.Abs(t.PnLPct)
				s.Losses++
			}
		}
		totalPnL += t.PnLPct
		totalINR += t.PnLINR
	}
	closed := s.Total - s.Open
	if closed > 0 {
		s.WinRate = math.Round(float64(s.Wins)/float64(closed)*1000) / 10
	}
	if grossLoss > 0 {
		s.ProfitFactor = math.Round(grossWin/grossLoss*100) / 100
	}
	if s.Wins > 0 {
		s.AvgWinPct = math.Round(grossWin/float64(s.Wins)*100) / 100
	}
	if s.Losses > 0 {
		s.AvgLossPct = math.Round(grossLoss/float64(s.Losses)*100) / 100
	}
	s.TotalPnLPct = math.Round(totalPnL*100) / 100
	s.TotalPnLINR = math.Round(totalINR)
	return s
}

func groupStats(trades []storage.SMCTradeLog, keyFn func(storage.SMCTradeLog) string) map[string]storage.SMCStats {
	groups := map[string][]storage.SMCTradeLog{}
	for _, t := range trades {
		k := keyFn(t)
		if k == "" {
			k = "?"
		}
		groups[k] = append(groups[k], t)
	}
	out := map[string]storage.SMCStats{}
	for k, ts := range groups {
		out[k] = statsFromTrades(ts)
	}
	return out
}

func buildEquityCurve(trades []storage.SMCTradeLog) []EquityPoint {
	// Sort by generated_at ascending
	sorted := append([]storage.SMCTradeLog(nil), trades...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].GeneratedAt.Before(sorted[j].GeneratedAt) })
	out := []EquityPoint{}
	equity := 0.0
	for _, t := range sorted {
		if t.Status == "OPEN" {
			continue
		}
		equity += t.PnLPct
		out = append(out, EquityPoint{
			Date:   t.GeneratedAt.Format("2006-01-02 15:04"),
			PnL:    math.Round(t.PnLPct*100) / 100,
			Equity: math.Round(equity*100) / 100,
		})
	}
	return out
}

// deriveInsights returns human-readable learnings + actionable parameter suggestions.
func deriveInsights(r SMCJournalResponse) ([]string, []ParamSuggestion) {
	var ins []string
	var sug []ParamSuggestion

	if r.Overall.Total < 5 {
		ins = append(ins, fmt.Sprintf("Only %d trades logged so far — keep collecting data for meaningful insights.", r.Overall.Total))
		return ins, sug
	}

	// Timeframe comparison
	if a, ok5 := r.ByTimeframe["5m"]; ok5 {
		if b, ok15 := r.ByTimeframe["15m"]; ok15 {
			closed5 := a.Total - a.Open
			closed15 := b.Total - b.Open
			if closed5 >= 5 && closed15 >= 5 {
				if a.WinRate-b.WinRate > 8 {
					ins = append(ins, fmt.Sprintf("✅ 5m timeframe outperforms 15m by %.1f%% WR (%.1f%% vs %.1f%%) over %d / %d trades", a.WinRate-b.WinRate, a.WinRate, b.WinRate, closed5, closed15))
					sug = append(sug, ParamSuggestion{Field: "default_timeframe", From: "15m", To: "5m",
						Reason: "5m has higher win rate in your data", Impact: "+more high-quality entries"})
				} else if b.WinRate-a.WinRate > 8 {
					ins = append(ins, fmt.Sprintf("✅ 15m timeframe outperforms 5m by %.1f%% WR (%.1f%% vs %.1f%%) over %d / %d trades", b.WinRate-a.WinRate, b.WinRate, a.WinRate, closed15, closed5))
					sug = append(sug, ParamSuggestion{Field: "default_timeframe", From: "5m", To: "15m",
						Reason: "15m has higher win rate in your data", Impact: "+cleaner signals"})
				}
			}
		}
	}

	// Direction bias
	if ce, okC := r.ByDirection["CE"]; okC {
		if pe, okP := r.ByDirection["PE"]; okP {
			if ce.Total >= 5 && pe.Total >= 5 {
				if math.Abs(ce.WinRate-pe.WinRate) > 15 {
					winner := "CE"
					loser := "PE"
					if pe.WinRate > ce.WinRate {
						winner, loser = "PE", "CE"
					}
					ins = append(ins, fmt.Sprintf("⚠️ %s trades win %.1f%% but %s only %.1f%% — strong direction skew in your data", winner, math.Max(ce.WinRate, pe.WinRate), loser, math.Min(ce.WinRate, pe.WinRate)))
				}
			}
		}
	}

	// Killzone analysis
	worstKZ := ""
	worstWR := 200.0
	bestKZ := ""
	bestWR := -1.0
	for kz, s := range r.ByKillzone {
		if s.Total < 3 {
			continue
		}
		if s.WinRate < worstWR {
			worstWR = s.WinRate
			worstKZ = kz
		}
		if s.WinRate > bestWR {
			bestWR = s.WinRate
			bestKZ = kz
		}
	}
	if worstKZ != "" && worstKZ != bestKZ && bestWR-worstWR > 20 {
		ins = append(ins, fmt.Sprintf("📍 Killzone %s wins %.1f%% but %s only %.1f%% — consider disabling %s", bestKZ, bestWR, worstKZ, worstWR, worstKZ))
		sug = append(sug, ParamSuggestion{
			Field: "killzone_filter", From: "all 3 enabled", To: "disable " + worstKZ,
			Reason: fmt.Sprintf("%s only wins %.1f%% vs %s at %.1f%%", worstKZ, worstWR, bestKZ, bestWR),
			Impact: "+focus on higher-WR windows",
		})
	}

	// Day-of-week analysis
	for day, s := range r.ByDayOfWeek {
		if s.Total >= 3 && s.WinRate < 30 {
			ins = append(ins, fmt.Sprintf("📅 %s only wins %.1f%% (%d trades) — consider skipping this day", day, s.WinRate, s.Total))
		}
	}

	// Overall WR vs 80% target
	if r.Overall.Total >= 5 {
		if r.Overall.WinRate >= 80 {
			ins = append(ins, fmt.Sprintf("🎯 Live win rate %.1f%% MEETS the 80%% target — strategy is performing as designed", r.Overall.WinRate))
		} else if r.Overall.WinRate >= 60 {
			ins = append(ins, fmt.Sprintf("📈 Live win rate %.1f%% — below 80%% target but profitable. PF: %.2f", r.Overall.WinRate, r.Overall.ProfitFactor))
			sug = append(sug, ParamSuggestion{Field: "min_rr", From: "3.0", To: "4.0",
				Reason: "Increase R:R to maintain profitability while accepting lower WR",
				Impact: "+higher expectancy per trade"})
		} else {
			ins = append(ins, fmt.Sprintf("🚨 Live win rate %.1f%% well below 80%% — tighten setup filters", r.Overall.WinRate))
			sug = append(sug, ParamSuggestion{Field: "require_mss", From: "false", To: "true",
				Reason: "Add Market Structure Shift confirmation to filter weak setups",
				Impact: "Fewer but higher-quality signals"})
		}
	}

	if len(ins) == 0 {
		ins = append(ins, "Data looks balanced — no actionable insights detected yet.")
	}
	return ins, sug
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
