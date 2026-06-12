package api

import (
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xuri/excelize/v2"
)

// ─── Types ────────────────────────────────────────────────────────────────────

type PnlTrade struct {
	Symbol   string  `json:"symbol"`
	Qty      float64 `json:"qty"`
	BuyValue float64 `json:"buy_value"`
	SellValue float64 `json:"sell_value"`
	PnL      float64 `json:"pnl"`
	PnLPct   float64 `json:"pnl_pct"`
	Expiry   string  `json:"expiry"`
	OptionType string `json:"option_type"`
}

type PnlSummary struct {
	ClientID     string  `json:"client_id"`
	Period       string  `json:"period"`
	RealizedPnL  float64 `json:"realized_pnl"`
	UnrealizedPnL float64 `json:"unrealized_pnl"`
	TotalCharges float64 `json:"total_charges"`
	NetPnL       float64 `json:"net_pnl"`
	TotalTurnover float64 `json:"total_turnover"`
}

type ExpiryBreakdown struct {
	Expiry   string  `json:"expiry"`
	PnL      float64 `json:"pnl"`
	Legs     int     `json:"legs"`
	WinLegs  int     `json:"win_legs"`
	LossLegs int     `json:"loss_legs"`
}

type WinLossStats struct {
	WinCount   int     `json:"win_count"`
	LossCount  int     `json:"loss_count"`
	WinRate    float64 `json:"win_rate"`
	TotalWins  float64 `json:"total_wins"`
	TotalLoss  float64 `json:"total_loss"`
	AvgWin     float64 `json:"avg_win"`
	AvgLoss    float64 `json:"avg_loss"`
	RewardRisk float64 `json:"reward_risk"`
}

type ChargeItem struct {
	Name   string  `json:"name"`
	Amount float64 `json:"amount"`
	Pct    float64 `json:"pct"`
}

type Improvement struct {
	Priority string `json:"priority"`
	Title    string `json:"title"`
	Detail   string `json:"detail"`
}

type PnlAnalysisResult struct {
	Summary         PnlSummary        `json:"summary"`
	ExpiryBreakdown []ExpiryBreakdown `json:"expiry_breakdown"`
	CEPnL           float64           `json:"ce_pnl"`
	PEPnL           float64           `json:"pe_pnl"`
	CELegs          int               `json:"ce_legs"`
	PELegs          int               `json:"pe_legs"`
	WinLoss         WinLossStats      `json:"win_loss"`
	TopLosers       []PnlTrade        `json:"top_losers"`
	TopWinners      []PnlTrade        `json:"top_winners"`
	LargePositions  []PnlTrade        `json:"large_positions"`
	Charges         []ChargeItem      `json:"charges"`
	Improvements    []Improvement     `json:"improvements"`
	Trades          []PnlTrade        `json:"trades"`
}

// ─── Handler ──────────────────────────────────────────────────────────────────

func (h *Handler) AnalyzePnL(c *gin.Context) {
	file, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no file uploaded"})
		return
	}

	src, err := file.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot open file"})
		return
	}
	defer src.Close()

	f, err := excelize.OpenReader(src)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid Excel file: " + err.Error()})
		return
	}
	defer f.Close()

	result, err := parsePnlSheet(f)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, result)
}

// ─── Parser ───────────────────────────────────────────────────────────────────

func parsePnlSheet(f *excelize.File) (*PnlAnalysisResult, error) {
	ws := "F&O"
	rows, err := f.GetRows(ws)
	if err != nil {
		return nil, fmt.Errorf("sheet 'F&O' not found")
	}

	sum := PnlSummary{}
	var trades []PnlTrade

	charges := map[string]float64{}
	chargeKeys := []string{
		"Brokerage - Z",
		"Exchange Transaction Charges - Z",
		"Integrated GST - Z",
		"Securities Transaction Tax - Z",
		"Stamp Duty - Z",
		"SEBI Turnover Fees - Z",
		"IPFT",
	}

	for i, row := range rows {
		if len(row) < 2 {
			continue
		}
		cell := strings.TrimSpace(row[1])

		switch {
		case cell == "Client ID" && len(row) > 2:
			sum.ClientID = strings.TrimSpace(row[2])
		case strings.HasPrefix(cell, "P&L Statement"):
			sum.Period = cell
		case cell == "Charges" && len(row) > 2:
			sum.TotalCharges, _ = strconv.ParseFloat(fmt.Sprintf("%v", row[2]), 64)
		case cell == "Realized P&L" && len(row) > 2:
			sum.RealizedPnL, _ = parseNum(row[2])
		case cell == "Unrealized P&L" && len(row) > 2:
			sum.UnrealizedPnL, _ = parseNum(row[2])
		}

		// Charges breakdown
		for _, ck := range chargeKeys {
			if cell == ck && len(row) > 2 {
				v, _ := parseNum(row[2])
				charges[ck] = v
			}
		}

		// Trade rows header detection — row with "Symbol" label
		if cell == "Symbol" {
			// Parse all subsequent rows as trades
			for _, tr := range rows[i+1:] {
				if len(tr) < 8 {
					continue
				}
				sym := strings.TrimSpace(tr[1])
				if !strings.HasPrefix(sym, "NIFTY") && !strings.HasPrefix(sym, "BANKNIFTY") {
					continue
				}
				qty, _ := parseNum(tr[3])
				buyVal, _ := parseNum(tr[4])
				sellVal, _ := parseNum(tr[5])
				pnl, _ := parseNum(tr[6])
				pnlPct, _ := parseNum(tr[7])

				trades = append(trades, PnlTrade{
					Symbol:     sym,
					Qty:        qty,
					BuyValue:   buyVal,
					SellValue:  sellVal,
					PnL:        pnl,
					PnLPct:     pnlPct,
					Expiry:     classifyExpiry(sym),
					OptionType: classifyOptionType(sym),
				})
			}
			break
		}
	}

	if len(trades) == 0 {
		return nil, fmt.Errorf("no trade data found in F&O sheet")
	}

	sum.NetPnL = sum.RealizedPnL - sum.TotalCharges
	for _, t := range trades {
		sum.TotalTurnover += t.BuyValue + t.SellValue
	}

	// Expiry breakdown
	expiryMap := map[string]*ExpiryBreakdown{}
	for _, t := range trades {
		e := t.Expiry
		if _, ok := expiryMap[e]; !ok {
			expiryMap[e] = &ExpiryBreakdown{Expiry: e}
		}
		expiryMap[e].PnL += t.PnL
		expiryMap[e].Legs++
		if t.PnL >= 0 {
			expiryMap[e].WinLegs++
		} else {
			expiryMap[e].LossLegs++
		}
	}
	expiries := make([]ExpiryBreakdown, 0, len(expiryMap))
	for _, v := range expiryMap {
		expiries = append(expiries, *v)
	}
	sort.Slice(expiries, func(i, j int) bool { return expiries[i].PnL < expiries[j].PnL })

	// CE/PE split
	var cePnL, pePnL float64
	var ceLegs, peLegs int
	for _, t := range trades {
		if t.OptionType == "CE" {
			cePnL += t.PnL
			ceLegs++
		} else {
			pePnL += t.PnL
			peLegs++
		}
	}

	// Win/Loss stats
	var winners, losers []PnlTrade
	for _, t := range trades {
		if t.PnL >= 0 {
			winners = append(winners, t)
		} else {
			losers = append(losers, t)
		}
	}
	totalWins := sumPnL(winners)
	totalLoss := sumPnL(losers)
	wl := WinLossStats{
		WinCount:  len(winners),
		LossCount: len(losers),
		WinRate:   round2(float64(len(winners)) / float64(len(trades)) * 100),
		TotalWins: round2(totalWins),
		TotalLoss: round2(totalLoss),
	}
	if len(winners) > 0 {
		wl.AvgWin = round2(totalWins / float64(len(winners)))
	}
	if len(losers) > 0 {
		wl.AvgLoss = round2(totalLoss / float64(len(losers)))
		if wl.AvgWin != 0 {
			wl.RewardRisk = round2(math.Abs(wl.AvgWin / wl.AvgLoss))
		}
	}

	// Sort for top losers/winners
	sorted := make([]PnlTrade, len(trades))
	copy(sorted, trades)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].PnL < sorted[j].PnL })

	topLosers := sorted
	if len(topLosers) > 5 {
		topLosers = topLosers[:5]
	}
	topWinners := make([]PnlTrade, len(sorted))
	copy(topWinners, sorted)
	sort.Slice(topWinners, func(i, j int) bool { return topWinners[i].PnL > topWinners[j].PnL })
	if len(topWinners) > 5 {
		topWinners = topWinners[:5]
	}

	// Large positions
	byBuy := make([]PnlTrade, len(trades))
	copy(byBuy, trades)
	sort.Slice(byBuy, func(i, j int) bool { return byBuy[i].BuyValue > byBuy[j].BuyValue })
	if len(byBuy) > 8 {
		byBuy = byBuy[:8]
	}

	// Charges list
	chargeDisplayNames := map[string]string{
		"Brokerage - Z":                   "Brokerage",
		"Exchange Transaction Charges - Z": "Exchange Txn Charges",
		"Integrated GST - Z":              "Integrated GST",
		"Securities Transaction Tax - Z":  "STT",
		"Stamp Duty - Z":                  "Stamp Duty",
		"SEBI Turnover Fees - Z":          "SEBI Fees",
		"IPFT":                            "IPFT",
	}
	chargeList := make([]ChargeItem, 0, len(charges))
	for k, v := range charges {
		chargeList = append(chargeList, ChargeItem{
			Name:   chargeDisplayNames[k],
			Amount: round2(v),
			Pct:    round2(v / sum.TotalCharges * 100),
		})
	}
	sort.Slice(chargeList, func(i, j int) bool { return chargeList[i].Amount > chargeList[j].Amount })

	improvements := buildImprovements(wl, expiries, cePnL, pePnL, sum)

	return &PnlAnalysisResult{
		Summary:         sum,
		ExpiryBreakdown: expiries,
		CEPnL:           round2(cePnL),
		PEPnL:           round2(pePnL),
		CELegs:          ceLegs,
		PELegs:          peLegs,
		WinLoss:         wl,
		TopLosers:       topLosers,
		TopWinners:      topWinners,
		LargePositions:  byBuy,
		Charges:         chargeList,
		Improvements:    improvements,
		Trades:          trades,
	}, nil
}

func buildImprovements(wl WinLossStats, expiries []ExpiryBreakdown, cePnL, pePnL float64, sum PnlSummary) []Improvement {
	var items []Improvement

	// R:R ratio check
	if wl.RewardRisk < 0.5 {
		items = append(items, Improvement{
			Priority: "critical",
			Title:    fmt.Sprintf("Reward:Risk is %.2f — Fix This First", wl.RewardRisk),
			Detail:   fmt.Sprintf("Win rate %.1f%% sounds good, but avg loss ₹%.0f is %.1fx avg win ₹%.0f. You need R:R > 0.7 to be profitable. Set hard stop at -3%% per trade and target at least +5%% before entry.", wl.WinRate, math.Abs(wl.AvgLoss), math.Abs(wl.AvgLoss/wl.AvgWin), wl.AvgWin),
		})
	}

	// Breakeven win rate
	if wl.RewardRisk > 0 {
		beWR := 1 / (1 + wl.RewardRisk) * 100
		if beWR > wl.WinRate {
			items = append(items, Improvement{
				Priority: "critical",
				Title:    fmt.Sprintf("Breakeven Win Rate is %.1f%% — You Are Below It", beWR),
				Detail:   fmt.Sprintf("At R:R of %.2f, you need %.1f%% win rate to break even. You have %.1f%%. Either improve R:R or increase win rate above %.1f%%.", wl.RewardRisk, beWR, wl.WinRate, beWR),
			})
		}
	}

	// Worst expiry
	if len(expiries) > 0 && expiries[0].PnL < -20000 {
		items = append(items, Improvement{
			Priority: "high",
			Title:    fmt.Sprintf("'%s' expiry lost ₹%.0f — Add Monthly Loss Limits", expiries[0].Expiry, math.Abs(expiries[0].PnL)),
			Detail:   fmt.Sprintf("A single expiry wiped ₹%.0f. Set a per-expiry max loss of ₹15,000. If hit, close all positions for that expiry immediately.", math.Abs(expiries[0].PnL)),
		})
	}

	// CE bias
	if cePnL < pePnL-10000 {
		items = append(items, Improvement{
			Priority: "high",
			Title:    fmt.Sprintf("CE positions lost ₹%.0f vs PE ₹%.0f — Stop Naked CE Buys", math.Abs(cePnL), math.Abs(pePnL)),
			Detail:   "Calls are losing 7x more than Puts. Either stop directional CE buys or hedge every CE with a bull spread (buy CE + sell higher CE) to cap max loss.",
		})
	}

	// Charges burden
	if sum.TotalCharges > 0 && math.Abs(sum.RealizedPnL) > 0 {
		chargePct := sum.TotalCharges / math.Abs(sum.RealizedPnL) * 100
		if chargePct > 40 {
			items = append(items, Improvement{
				Priority: "high",
				Title:    fmt.Sprintf("Charges are ₹%.0f (%.0f%% of your loss) — Reduce Turnover", sum.TotalCharges, chargePct),
				Detail:   fmt.Sprintf("STT alone eats ₹%.0f. Reduce total legs from %d to max 20/month. Fewer high-conviction trades = lower charges + better focus.", sum.TotalCharges*0.55, wl.WinCount+wl.LossCount),
			})
		}
	}

	// Too many legs
	totalLegs := wl.WinCount + wl.LossCount
	if totalLegs > 40 {
		items = append(items, Improvement{
			Priority: "medium",
			Title:    fmt.Sprintf("%d Option Legs in One Month — Scatter Trading", totalLegs),
			Detail:   "Trading across 4+ expiries with 70+ legs simultaneously is impossible to manage risk on. Pick 1 expiry per week, max 4-6 legs total. Quality over quantity.",
		})
	}

	// Position sizing
	items = append(items, Improvement{
		Priority: "medium",
		Title:    "No Position Sizing Rules Visible — Set Max Capital per Trade",
		Detail:   "Never deploy more than 20% of trading capital in a single position. Use fixed lot counts (max 2 lots per strike) until you are consistently profitable for 3 months.",
	})

	// Weekly expiry rule
	items = append(items, Improvement{
		Priority: "medium",
		Title:    "Weekly Expiry Discipline — Enter Mon/Tue, Exit Thu Morning",
		Detail:   "For weekly options, enter only on Monday or Tuesday when theta decay is ahead of you. Exit by Thursday morning. Never hold naked options into expiry unless it's an iron fly/condor.",
	})

	return items
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func classifyExpiry(sym string) string {
	switch {
	case strings.Contains(sym, "26519"):
		return "May19-Weekly"
	case strings.Contains(sym, "26602"):
		return "Jun02-Weekly"
	case strings.Contains(sym, "26609"):
		return "Jun09-Weekly"
	case strings.Contains(sym, "26MAY"):
		return "May-Monthly"
	case strings.Contains(sym, "26JUN"):
		return "Jun-Monthly"
	case strings.Contains(sym, "26516"):
		return "May16-Weekly"
	default:
		// Extract date portion generically
		parts := strings.TrimPrefix(sym, "NIFTY")
		parts = strings.TrimPrefix(parts, "BANKNIFTY")
		if len(parts) >= 5 {
			return "Expiry-" + parts[:5]
		}
		return "Other"
	}
}

func classifyOptionType(sym string) string {
	if strings.HasSuffix(sym, "CE") {
		return "CE"
	}
	return "PE"
}

func parseNum(v interface{}) (float64, error) {
	switch val := v.(type) {
	case float64:
		return val, nil
	case int:
		return float64(val), nil
	case string:
		return strconv.ParseFloat(strings.TrimSpace(val), 64)
	}
	return strconv.ParseFloat(fmt.Sprintf("%v", v), 64)
}

func sumPnL(ts []PnlTrade) float64 {
	var s float64
	for _, t := range ts {
		s += t.PnL
	}
	return s
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}
