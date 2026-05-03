package portfolio

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"stockwise/internal/storage"
)

// ─── Zone constants ──────────────────────────────────────────────────────────

const (
	ZoneStrongAccumulate  = "strong_accumulate"
	ZonePartialAccumulate = "partial_accumulate"
	ZoneHold              = "hold"
	ZoneNoBuy             = "no_buy"
	ZoneProfitBooking     = "profit_booking"
	ZoneStopLoss          = "stop_loss"
)

const (
	RiskLow      = "LOW"
	RiskModerate = "MODERATE"
	RiskHigh     = "HIGH"
)

const (
	ActionAccumulate = "ACCUMULATE"
	ActionHold       = "HOLD"
	ActionReduce     = "REDUCE"
	ActionExit       = "EXIT"
)

// ─── Output types ─────────────────────────────────────────────────────────────

type HoldingMetrics struct {
	// Identity
	Symbol      string `json:"symbol"`
	YFSymbol    string `json:"yf_symbol"`
	DisplayName string `json:"display_name"`
	Market      string `json:"market"`
	Sector      string `json:"sector"`
	Currency    string `json:"currency"`

	// Position
	Quantity    float64 `json:"quantity"`
	AvgBuyPrice float64 `json:"avg_buy_price"`

	// Prices & P&L
	CurrentPrice  float64 `json:"current_price"`
	InvestedValue float64 `json:"invested_value"`
	CurrentValue  float64 `json:"current_value"`
	PnLAbs        float64 `json:"pnl_abs"`
	PnLPct        float64 `json:"pnl_pct"`

	// Portfolio weight
	PortfolioWeight float64 `json:"portfolio_weight"` // % of total portfolio by invested value

	// Technical (if available)
	RSI            float64 `json:"rsi"`
	Trend          string  `json:"trend"`
	TechnicalScore float64 `json:"technical_score"`
	MACDHist       float64 `json:"macd_hist"`
	VolumeSpike    bool    `json:"volume_spike"`
	LastBarDate    string  `json:"last_bar_date"`

	// Key S/R
	KeySupport    float64 `json:"key_support"`
	KeyResistance float64 `json:"key_resistance"`

	// Zone Analysis
	Zone       string  `json:"zone"`
	ZoneLow    float64 `json:"zone_low"`
	ZoneHigh   float64 `json:"zone_high"`
	ZoneReason string  `json:"zone_reason"`

	// Risk & Action
	RiskLevel    string `json:"risk_level"`
	Action       string `json:"action"`
	ActionReason string `json:"action_reason"`

	// Alert
	HasAlert     bool   `json:"has_alert"`
	AlertMessage string `json:"alert_message"`
}

type PortfolioSummary struct {
	TotalInvested    float64 `json:"total_invested_inr"`
	TotalCurrentINR  float64 `json:"total_current_inr"`
	TotalPnLINR      float64 `json:"total_pnl_inr"`
	TotalPnLPct      float64 `json:"total_pnl_pct"`
	TotalInvestedUS  float64 `json:"total_invested_usd"`
	TotalCurrentUSD  float64 `json:"total_current_usd"`
	TotalPnLUSD      float64 `json:"total_pnl_usd"`
	TotalPnLPctUSD   float64 `json:"total_pnl_pct_usd"`
	HoldingsCount    int     `json:"holdings_count"`
	GainersCount     int     `json:"gainers_count"`
	LosersCount      int     `json:"losers_count"`
	BestPerformer    string  `json:"best_performer"`
	WorstPerformer   string  `json:"worst_performer"`
}

type SectorAlloc struct {
	Sector          string  `json:"sector"`
	Market          string  `json:"market"`
	InvestedValue   float64 `json:"invested_value"`
	CurrentValue    float64 `json:"current_value"`
	AllocationPct   float64 `json:"allocation_pct"` // % of market total
	PnLPct          float64 `json:"pnl_pct"`
	StockCount      int     `json:"stock_count"`
	OverExposed     bool    `json:"over_exposed"`    // >30% allocation in sector
}

type Alert struct {
	Symbol   string `json:"symbol"`
	Type     string `json:"type"` // accumulation, profit_zone, stop_loss, drawdown, overbought
	Message  string `json:"message"`
	Severity string `json:"severity"` // info, warning, critical
}

type PortfolioData struct {
	Holdings        []HoldingMetrics `json:"holdings"`
	Summary         PortfolioSummary `json:"summary"`
	SectorBreakdown []SectorAlloc    `json:"sector_breakdown"`
	Alerts          []Alert          `json:"alerts"`
	GeneratedAt     string           `json:"generated_at"`
}

// ─── Engine ──────────────────────────────────────────────────────────────────

type Engine struct {
	repo *storage.Repository
}

func NewEngine(repo *storage.Repository) *Engine {
	return &Engine{repo: repo}
}

// Compute builds the full portfolio view for all holdings.
func (e *Engine) Compute() (*PortfolioData, error) {
	holdings, err := e.repo.GetAllPortfolioHoldings()
	if err != nil {
		return nil, err
	}

	metrics := make([]HoldingMetrics, 0, len(holdings))
	for _, h := range holdings {
		m := e.computeHolding(h)
		metrics = append(metrics, m)
	}

	// Calculate portfolio weights (requires total invested per market)
	totalINR, totalUSD := 0.0, 0.0
	for _, m := range metrics {
		if m.Currency == "USD" {
			totalUSD += m.InvestedValue
		} else {
			totalINR += m.InvestedValue
		}
	}
	for i := range metrics {
		if metrics[i].Currency == "USD" && totalUSD > 0 {
			metrics[i].PortfolioWeight = math.Round(metrics[i].InvestedValue/totalUSD*10000) / 100
		} else if totalINR > 0 {
			metrics[i].PortfolioWeight = math.Round(metrics[i].InvestedValue/totalINR*10000) / 100
		}
	}

	summary := buildSummary(metrics)
	sectors := buildSectorBreakdown(metrics)
	alerts := buildAlerts(metrics)

	return &PortfolioData{
		Holdings:        metrics,
		Summary:         summary,
		SectorBreakdown: sectors,
		Alerts:          alerts,
		GeneratedAt:     time.Now().Format(time.RFC3339),
	}, nil
}

func (e *Engine) computeHolding(h storage.PortfolioHolding) HoldingMetrics {
	m := HoldingMetrics{
		Symbol:      h.Symbol,
		YFSymbol:    h.YFSymbol,
		DisplayName: h.DisplayName,
		Market:      h.Market,
		Sector:      h.Sector,
		Currency:    h.Currency,
		Quantity:    h.Quantity,
		AvgBuyPrice: h.AvgBuyPrice,
	}

	m.InvestedValue = math.Round(h.Quantity*h.AvgBuyPrice*100) / 100

	// ── Fetch current price from DB ──────────────────────────────────────────
	stock, err := e.repo.GetStockBySymbol(h.YFSymbol)
	if err == nil {
		bars, _ := e.repo.GetLatestPriceBars(stock.ID, 1)
		if len(bars) > 0 {
			m.CurrentPrice = bars[0].Close
			m.LastBarDate = bars[0].Date.Format("2006-01-02")
		}

		// Technical indicators
		ind, _ := e.repo.GetLatestTechnicalIndicator(stock.ID)
		if ind != nil {
			if ind.RSI != nil {
				m.RSI = math.Round(*ind.RSI*10) / 10
			}
			if ind.MACDHist != nil {
				m.MACDHist = *ind.MACDHist
			}
			m.Trend = ind.TrendDirection
			m.TechnicalScore = ind.TechnicalScore
			m.VolumeSpike = ind.VolumeSpike
		}

		// S/R levels
		srLevels, _ := e.repo.GetSRLevels(stock.ID)
		m.KeySupport, m.KeyResistance = findKeyLevels(srLevels, m.CurrentPrice)
	}

	// ── P&L ──────────────────────────────────────────────────────────────────
	if m.CurrentPrice > 0 {
		m.CurrentValue = math.Round(h.Quantity*m.CurrentPrice*100) / 100
		m.PnLAbs = math.Round((m.CurrentValue-m.InvestedValue)*100) / 100
		if m.InvestedValue > 0 {
			m.PnLPct = math.Round((m.PnLAbs/m.InvestedValue)*10000) / 100
		}
	} else {
		// No price data — use invested value so portfolio total isn't understated
		m.CurrentValue = m.InvestedValue
	}

	// ── Zone Analysis ────────────────────────────────────────────────────────
	e.computeZone(&m)

	// ── Risk & Action ────────────────────────────────────────────────────────
	e.computeRiskAction(&m)

	// ── Alerts ───────────────────────────────────────────────────────────────
	e.checkAlerts(&m)

	return m
}

func (e *Engine) computeZone(m *HoldingMetrics) {
	avg := m.AvgBuyPrice
	cur := m.CurrentPrice

	if cur == 0 || avg == 0 {
		m.Zone = ZoneHold
		m.ZoneLow = avg * 0.90
		m.ZoneHigh = avg * 1.10
		m.ZoneReason = "No current price data — monitoring"
		return
	}

	pctFromAvg := (cur - avg) / avg

	// Key S/R anchors
	support := m.KeySupport
	if support == 0 {
		support = avg * 0.90 // fallback
	}
	resistance := m.KeyResistance
	if resistance == 0 {
		resistance = avg * 1.25 // fallback
	}

	// RSI adjustment
	rsiOversold := m.RSI > 0 && m.RSI < 35
	rsiOverbought := m.RSI > 0 && m.RSI > 68
	trendDown := m.Trend == "DOWN"

	switch {
	case cur < support*0.97 || pctFromAvg < -0.18:
		// Price broke below support OR down 18%+ from avg — structural break
		m.Zone = ZoneStopLoss
		m.ZoneLow = support * 0.85
		m.ZoneHigh = support * 1.01
		m.ZoneReason = fmt.Sprintf("%.1f%% below avg buy. Price broke below key support ₹%.2f. Capital at risk.", pctFromAvg*100, support)

	case pctFromAvg < -0.10 || (pctFromAvg < -0.06 && rsiOversold):
		// Deep pullback — strong accumulation zone
		m.Zone = ZoneStrongAccumulate
		m.ZoneLow = math.Max(support*0.97, avg*0.85)
		m.ZoneHigh = avg * 0.95
		m.ZoneReason = fmt.Sprintf("%.1f%% below avg — deep pullback near support. RSI: %.0f. High conviction buy zone.", pctFromAvg*100, m.RSI)

	case pctFromAvg < -0.04:
		// Moderate pullback
		m.Zone = ZonePartialAccumulate
		m.ZoneLow = avg * 0.93
		m.ZoneHigh = avg * 1.00
		m.ZoneReason = fmt.Sprintf("%.1f%% below avg — moderate pullback. Add in tranches if trend holds.", pctFromAvg*100)

	case pctFromAvg > 0.25 || cur > resistance*1.02:
		// Overextended above resistance — take profits
		m.Zone = ZoneProfitBooking
		m.ZoneLow = math.Max(avg*1.20, resistance*0.98)
		m.ZoneHigh = resistance * 1.08
		m.ZoneReason = fmt.Sprintf("+%.1f%% above avg. Near/above resistance ₹%.2f. Consider booking partial profits.", pctFromAvg*100, resistance)

	case pctFromAvg > 0.12 || rsiOverbought:
		// Extended — no new buys
		m.Zone = ZoneNoBuy
		m.ZoneLow = avg * 1.10
		m.ZoneHigh = resistance * 0.99
		m.ZoneReason = fmt.Sprintf("+%.1f%% above avg. RSI: %.0f. Overextended — hold existing, do not add here.", pctFromAvg*100, m.RSI)

	case trendDown && pctFromAvg < 0.05:
		// Downtrend near avg — cautious
		m.Zone = ZoneHold
		m.ZoneLow = support * 0.99
		m.ZoneHigh = avg * 1.05
		m.ZoneReason = fmt.Sprintf("Price %.1f%% from avg. Trend: DOWN. Hold and watch for reversal confirmation before adding.", pctFromAvg*100)

	default:
		// Consolidation / neutral
		m.Zone = ZoneHold
		m.ZoneLow = avg * 0.95
		m.ZoneHigh = avg * 1.12
		m.ZoneReason = fmt.Sprintf("Price %.1f%% from avg. In neutral zone — hold current position.", pctFromAvg*100)
	}
}

func (e *Engine) computeRiskAction(m *HoldingMetrics) {
	rsi := m.RSI
	trend := m.Trend

	// ── Risk Level ────────────────────────────────────────────────────────────
	highRiskFactors := 0
	if m.PnLPct < -15 {
		highRiskFactors++
	}
	if rsi > 75 {
		highRiskFactors++
	}
	if trend == "DOWN" {
		highRiskFactors++
	}
	if m.Zone == ZoneStopLoss {
		highRiskFactors += 2
	}

	lowRiskFactors := 0
	if m.PnLPct > 10 {
		lowRiskFactors++
	}
	if rsi >= 40 && rsi <= 62 {
		lowRiskFactors++
	}
	if trend == "UP" {
		lowRiskFactors++
	}
	if m.TechnicalScore >= 65 {
		lowRiskFactors++
	}

	switch {
	case highRiskFactors >= 2:
		m.RiskLevel = RiskHigh
	case lowRiskFactors >= 3:
		m.RiskLevel = RiskLow
	default:
		m.RiskLevel = RiskModerate
	}

	// ── Action ────────────────────────────────────────────────────────────────
	reasons := []string{}

	switch m.Zone {
	case ZoneStrongAccumulate:
		m.Action = ActionAccumulate
		reasons = append(reasons, fmt.Sprintf("Deep pullback (%.1f%% below avg) near support — add aggressively in tranches", m.PnLPct))
		if rsi < 40 {
			reasons = append(reasons, fmt.Sprintf("RSI oversold at %.0f", rsi))
		}
	case ZonePartialAccumulate:
		m.Action = ActionAccumulate
		reasons = append(reasons, fmt.Sprintf("%.1f%% below avg — partial accumulation zone, add 25-50%% of intended allocation", m.PnLPct))
	case ZoneProfitBooking:
		m.Action = ActionReduce
		reasons = append(reasons, fmt.Sprintf("+%.1f%% gain — near resistance, book 30-50%% profits", m.PnLPct))
		if rsi > 70 {
			reasons = append(reasons, fmt.Sprintf("RSI overbought at %.0f", rsi))
		}
	case ZoneStopLoss:
		m.Action = ActionExit
		reasons = append(reasons, fmt.Sprintf("%.1f%% loss — price broke below key support, exit to protect capital", m.PnLPct))
		if trend == "DOWN" {
			reasons = append(reasons, "Downtrend confirmed — no recovery signal")
		}
	case ZoneNoBuy:
		m.Action = ActionHold
		reasons = append(reasons, fmt.Sprintf("+%.1f%% above avg — overextended, hold but don't add", m.PnLPct))
	default: // hold
		if trend == "UP" && m.TechnicalScore >= 55 {
			m.Action = ActionHold
			reasons = append(reasons, fmt.Sprintf("Uptrend intact, hold with trailing SL near ₹%.2f", m.KeySupport))
		} else if trend == "DOWN" {
			m.Action = ActionHold
			reasons = append(reasons, "Downtrend — hold existing, await reversal before adding")
		} else {
			m.Action = ActionHold
			reasons = append(reasons, "Neutral — hold and monitor")
		}
	}

	m.ActionReason = strings.Join(reasons, ". ")
}

func (e *Engine) checkAlerts(m *HoldingMetrics) {
	alerts := []string{}

	if m.CurrentPrice > 0 {
		// Drawdown alert
		if m.PnLPct < -10 {
			alerts = append(alerts, fmt.Sprintf("⚠️ %.1f%% drawdown from avg cost", m.PnLPct))
		}
		// Strong buy zone
		if m.Zone == ZoneStrongAccumulate {
			alerts = append(alerts, fmt.Sprintf("🟢 STRONG ACCUMULATION ZONE — cur ₹%.2f, zone ₹%.2f–₹%.2f", m.CurrentPrice, m.ZoneLow, m.ZoneHigh))
		}
		// Stop loss zone
		if m.Zone == ZoneStopLoss {
			alerts = append(alerts, fmt.Sprintf("🔴 STOP LOSS TRIGGERED — review position immediately"))
		}
		// Profit booking
		if m.Zone == ZoneProfitBooking {
			alerts = append(alerts, fmt.Sprintf("💰 PROFIT ZONE — +%.1f%% gain, consider booking 30-50%%", m.PnLPct))
		}
		// RSI overbought
		if m.RSI > 75 {
			alerts = append(alerts, fmt.Sprintf("🔥 RSI overbought at %.0f — momentum may reverse", m.RSI))
		}
		// RSI oversold
		if m.RSI < 30 && m.RSI > 0 {
			alerts = append(alerts, fmt.Sprintf("📉 RSI oversold at %.0f — potential reversal", m.RSI))
		}
	}

	if len(alerts) > 0 {
		m.HasAlert = true
		m.AlertMessage = strings.Join(alerts, " | ")
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func findKeyLevels(levels []storage.SupportResistanceLevel, currentPrice float64) (support, resistance float64) {
	if currentPrice == 0 {
		return 0, 0
	}
	bestSupportDiff := math.MaxFloat64
	bestResDiff := math.MaxFloat64

	for _, l := range levels {
		if !l.IsActive {
			continue
		}
		diff := math.Abs(l.Price - currentPrice)

		if (l.LevelType == "support" || l.LevelType == "accumulation") && l.Price < currentPrice {
			if diff < bestSupportDiff {
				bestSupportDiff = diff
				support = l.Price
			}
		}
		if (l.LevelType == "resistance" || l.LevelType == "supply") && l.Price > currentPrice {
			if diff < bestResDiff {
				bestResDiff = diff
				resistance = l.Price
			}
		}
	}
	return support, resistance
}

func buildSummary(metrics []HoldingMetrics) PortfolioSummary {
	s := PortfolioSummary{HoldingsCount: len(metrics)}
	var bestPnL, worstPnL float64
	bestPnL = -math.MaxFloat64
	worstPnL = math.MaxFloat64

	for _, m := range metrics {
		if m.Currency == "USD" {
			s.TotalInvestedUS += m.InvestedValue
			s.TotalCurrentUSD += m.CurrentValue
		} else {
			s.TotalInvested += m.InvestedValue
			s.TotalCurrentINR += m.CurrentValue
		}
		if m.CurrentPrice > 0 {
			if m.PnLPct > bestPnL {
				bestPnL = m.PnLPct
				s.BestPerformer = fmt.Sprintf("%s (+%.1f%%)", m.Symbol, m.PnLPct)
			}
			if m.PnLPct < worstPnL {
				worstPnL = m.PnLPct
				s.WorstPerformer = fmt.Sprintf("%s (%.1f%%)", m.Symbol, m.PnLPct)
			}
			if m.PnLPct >= 0 {
				s.GainersCount++
			} else {
				s.LosersCount++
			}
		}
	}

	s.TotalPnLINR = math.Round((s.TotalCurrentINR-s.TotalInvested)*100) / 100
	if s.TotalInvested > 0 {
		s.TotalPnLPct = math.Round((s.TotalPnLINR/s.TotalInvested)*10000) / 100
	}
	s.TotalPnLUSD = math.Round((s.TotalCurrentUSD-s.TotalInvestedUS)*100) / 100
	if s.TotalInvestedUS > 0 {
		s.TotalPnLPctUSD = math.Round((s.TotalPnLUSD/s.TotalInvestedUS)*10000) / 100
	}
	return s
}

func buildSectorBreakdown(metrics []HoldingMetrics) []SectorAlloc {
	type key struct{ sector, market string }
	byKey := map[key]*SectorAlloc{}

	totals := map[string]float64{"NSE": 0, "US": 0}
	for _, m := range metrics {
		totals[m.Market] += m.InvestedValue
	}

	for _, m := range metrics {
		k := key{m.Sector, m.Market}
		if _, ok := byKey[k]; !ok {
			byKey[k] = &SectorAlloc{Sector: m.Sector, Market: m.Market}
		}
		sa := byKey[k]
		sa.InvestedValue += m.InvestedValue
		if m.CurrentPrice > 0 {
			sa.CurrentValue += m.CurrentValue
		} else {
			// No price data — use invested value to avoid -100% distortion
			sa.CurrentValue += m.InvestedValue
		}
		sa.StockCount++
	}

	result := make([]SectorAlloc, 0, len(byKey))
	for _, sa := range byKey {
		if sa.InvestedValue > 0 {
			if totals[sa.Market] > 0 {
				sa.AllocationPct = math.Round(sa.InvestedValue/totals[sa.Market]*10000) / 100
			}
			if sa.InvestedValue > 0 {
				sa.PnLPct = math.Round((sa.CurrentValue-sa.InvestedValue)/sa.InvestedValue*10000) / 100
			}
			sa.OverExposed = sa.AllocationPct > 30
		}
		result = append(result, *sa)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Market != result[j].Market {
			return result[i].Market < result[j].Market
		}
		return result[i].AllocationPct > result[j].AllocationPct
	})
	return result
}

func buildAlerts(metrics []HoldingMetrics) []Alert {
	var alerts []Alert
	for _, m := range metrics {
		if !m.HasAlert {
			continue
		}
		severity := "info"
		aType := "general"
		if m.Zone == ZoneStopLoss {
			severity = "critical"
			aType = "stop_loss"
		} else if m.Zone == ZoneStrongAccumulate {
			severity = "info"
			aType = "accumulation"
		} else if m.Zone == ZoneProfitBooking {
			severity = "warning"
			aType = "profit_zone"
		} else if m.PnLPct < -10 {
			severity = "warning"
			aType = "drawdown"
		}
		alerts = append(alerts, Alert{
			Symbol:   m.Symbol,
			Type:     aType,
			Message:  m.AlertMessage,
			Severity: severity,
		})
	}
	return alerts
}
