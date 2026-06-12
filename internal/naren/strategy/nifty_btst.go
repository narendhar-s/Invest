package strategy

import (
	"fmt"
	"math"
	"sync"
	"time"

	"stockwise/internal/naren/nifty"
	"stockwise/internal/naren/storage"
)

// btst cache — avoids hammering Yahoo Finance on every page load
var (
	btstCache     *nifty.NiftyBTSTSignal
	btstCacheTime time.Time
	btstMu        sync.Mutex
	btstCacheTTL  = 4 * time.Minute
)

// GetNiftyBTSTSignal fetches live Nifty 50 daily bars from Yahoo Finance and
// scores today's bar against 8 BTST criteria. The result is valid for entry
// before 15:30 IST today; exit is next trading day.
func (e *Engine) GetNiftyBTSTSignal() (*nifty.NiftyBTSTSignal, error) {
	btstMu.Lock()
	if btstCache != nil && time.Since(btstCacheTime) < btstCacheTTL {
		cached := *btstCache
		btstMu.Unlock()
		return &cached, nil
	}
	btstMu.Unlock()
	ibs, err := nifty.FetchDailyBars(90)
	if err != nil {
		return nil, fmt.Errorf("BTST fetch: %w", err)
	}
	if len(ibs) < 30 {
		return nil, fmt.Errorf("insufficient daily bars (%d)", len(ibs))
	}

	// Convert to storage.PriceBar so we can reuse existing indicator helpers
	bars := make([]storage.PriceBar, len(ibs))
	for i, b := range ibs {
		bars[i] = storage.PriceBar{
			Date:   b.Time,
			Open:   b.Open,
			High:   b.High,
			Low:    b.Low,
			Close:  b.Close,
			Volume: b.Volume,
		}
	}

	n := len(bars) - 1
	today := bars[n]
	prev := bars[n-1]

	// ── Indicators ──────────────────────────────────────────────────────────
	e9 := calcEMA(bars, n, 9)
	e21 := calcEMA(bars, n, 21)
	s50 := calcSMA(bars, n, 50)
	rsi := calcRSI(bars, n, 14)
	atr := calcATR(bars, n, 14)

	// MACD histogram: EMA12 - EMA26
	macdHist := 0.0
	if n >= 26 {
		macdHist = calcEMA(bars, n, 12) - calcEMA(bars, n, 26)
	}

	// Volume ratio (today vs 20-day avg)
	volRatio := 0.0
	if today.Volume > 0 && n >= 20 {
		var sumVol float64
		for j := n - 20; j < n; j++ {
			sumVol += float64(bars[j].Volume)
		}
		if sumVol > 0 {
			volRatio = float64(today.Volume) / (sumVol / 20)
		}
	}

	// Close position within day's range (0-100)
	dayRange := today.High - today.Low
	closePos := 0.0
	if dayRange > 0 {
		closePos = (today.Close - today.Low) / dayRange * 100
	}

	// 3-bar momentum
	mom3Pct := 0.0
	if n >= 3 {
		mom3Pct = (today.Close - bars[n-3].Close) / bars[n-3].Close * 100
	}

	change := today.Close - prev.Close
	changePct := 0.0
	if prev.Close > 0 {
		changePct = change / prev.Close * 100
	}

	// ── Market status ────────────────────────────────────────────────────────
	ist := time.FixedZone("IST", 5*3600+30*60)
	now := time.Now().In(ist)
	h, m := now.Hour(), now.Minute()
	mins := h*60 + m
	marketOpen := mins >= 9*60+15 && mins < 15*60+30
	marketStatus := "CLOSED"
	if marketOpen {
		marketStatus = "OPEN"
	}

	// ── Criteria scoring ─────────────────────────────────────────────────────
	type criterion struct {
		label  string
		value  string
		met    bool
		weight int
	}

	criteria := []criterion{
		{
			label:  "EMA Trend (EMA9 > EMA21)",
			value:  fmt.Sprintf("EMA9 %.0f vs EMA21 %.0f", e9, e21),
			met:    e9 > e21,
			weight: 2,
		},
		{
			label:  "Price Above SMA50",
			value:  fmt.Sprintf("Close %.0f vs SMA50 %.0f", today.Close, s50),
			met:    s50 > 0 && today.Close > s50,
			weight: 1,
		},
		{
			label:  "RSI Momentum Zone (52–72)",
			value:  fmt.Sprintf("RSI %.1f", rsi),
			met:    rsi >= 52 && rsi <= 72,
			weight: 2,
		},
		{
			label:  "MACD Positive",
			value:  fmt.Sprintf("Histogram %+.1f", macdHist),
			met:    macdHist > 0,
			weight: 1,
		},
		{
			label:  "Strong Close (upper 55%+ of range)",
			value:  fmt.Sprintf("Close at %.0f%% of range", closePos),
			met:    closePos >= 55,
			weight: 2,
		},
		{
			label:  "Volume Confirmation (≥ 1.0x avg)",
			value:  fmt.Sprintf("%.2fx 20-day avg", volRatio),
			met:    volRatio == 0 || volRatio >= 1.0, // 0 = market still open
			weight: 1,
		},
		{
			label:  "Bullish Day Candle",
			value:  fmt.Sprintf("O:%.0f → C:%.0f", today.Open, today.Close),
			met:    today.Close > today.Open,
			weight: 1,
		},
		{
			label:  "3-Bar Momentum Positive",
			value:  fmt.Sprintf("%+.2f%%", mom3Pct),
			met:    mom3Pct > 0,
			weight: 1,
		},
	}

	// Compute total score (each met criterion adds weight; unmet subtracts weight for key ones)
	score := 0
	for _, c := range criteria {
		if c.met {
			score += c.weight
		} else if c.weight >= 2 {
			// Key criteria that fail drag score down
			score -= c.weight
		}
	}

	// ── Signal decision ──────────────────────────────────────────────────────
	signal := "NEUTRAL"
	confidence := 50.0
	strategy := "BTST Momentum"

	// Hard veto: if trend and RSI both against us, it's AVOID regardless
	trendUp := e9 > e21
	rsiOK := rsi >= 45 && rsi <= 75

	if score >= 5 && trendUp && rsiOK {
		signal = "BUY"
		confidence = math.Min(92, 55+float64(score)*4)
		if volRatio >= 1.5 {
			strategy = "BTST Volume Surge"
		} else {
			strategy = "BTST Trend Continuation"
		}
	} else if score <= -2 || (!trendUp && rsi < 45) {
		signal = "AVOID"
		confidence = math.Min(90, 55+math.Abs(float64(score))*4)
	} else {
		signal = "NEUTRAL"
		confidence = 50
	}

	// ── Entry / Target / SL ──────────────────────────────────────────────────
	entry := math.Round(today.Close*1.001*10) / 10  // 0.1% above close for slippage
	target := math.Round(today.Close*1.015*10) / 10 // 1.5% target next day
	sl := math.Round(today.Low*0.998*10) / 10        // just below today's low
	if atr > 0 && sl < today.Close-atr {
		sl = math.Round((today.Close-atr)*10) / 10 // ATR-based SL fallback
	}
	rr := 0.0
	if entry-sl > 0 {
		rr = math.Round((target-entry)/(entry-sl)*100) / 100
	}

	// ── Build output ─────────────────────────────────────────────────────────
	btCriteria := make([]nifty.BTSTCriterion, len(criteria))
	for i, c := range criteria {
		btCriteria[i] = nifty.BTSTCriterion{
			Label:  c.label,
			Value:  c.value,
			Met:    c.met,
			Weight: c.weight,
		}
	}

	note := "Enter within last 30 min (15:00–15:25 IST). Exit next day between 10:00–15:15 IST."
	if signal == "AVOID" {
		note = "Multiple bearish conditions active. Skip BTST today. Wait for a setup with EMA9 > EMA21 and RSI 52–72."
	} else if signal == "NEUTRAL" {
		note = "Mixed signals. BTST is possible but low conviction. If RSI crosses 52 and close stays firm, entry near 15:20 IST is acceptable."
	}

	result := &nifty.NiftyBTSTSignal{
		Date:          today.Date.Format("2006-01-02"),
		SpotPrice:     today.Close,
		Open:          today.Open,
		High:          today.High,
		Low:           today.Low,
		Change:        math.Round(change*100) / 100,
		ChangePct:     math.Round(changePct*100) / 100,
		Signal:        signal,
		Confidence:    math.Round(confidence*10) / 10,
		Score:         score,
		EntryPrice:    entry,
		TargetPrice:   target,
		StopLoss:      sl,
		RiskReward:    rr,
		EMA9:          math.Round(e9*100) / 100,
		EMA21:         math.Round(e21*100) / 100,
		SMA50:         math.Round(s50*100) / 100,
		RSI:           math.Round(rsi*10) / 10,
		ATR:           math.Round(atr*10) / 10,
		MACDHist:      math.Round(macdHist*100) / 100,
		VolumeRatio:   math.Round(volRatio*100) / 100,
		ClosePosition: math.Round(closePos*10) / 10,
		Criteria:      btCriteria,
		Strategy:      strategy,
		MarketStatus:  marketStatus,
		EntryWindow:   "15:00 – 15:25 IST (today)",
		ExitWindow:    "10:00 – 15:15 IST (tomorrow)",
		GeneratedAt:   now.Format(time.RFC3339),
		Note:          note,
	}

	btstMu.Lock()
	btstCache = result
	btstCacheTime = time.Now()
	btstMu.Unlock()

	return result, nil
}
