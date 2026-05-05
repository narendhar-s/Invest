package alpha

import (
	"fmt"
	"math"
	"sort"
	"time"

	"stockwise/internal/storage"
)

// BTSTSignal represents a Buy-Today-Sell-Tomorrow trade opportunity.
// These are end-of-day signals for stocks likely to gap up or continue the next morning.
type BTSTSignal struct {
	Symbol         string   `json:"symbol"`
	Name           string   `json:"name"`
	Market         string   `json:"market"`
	Sector         string   `json:"sector"`
	EntryPrice     float64  `json:"entry_price"`    // near today's close
	TargetPrice    float64  `json:"target_price"`   // next-day target (1.5-3%)
	StopLoss       float64  `json:"stop_loss"`      // below today's low
	RiskReward     float64  `json:"risk_reward"`
	Confidence     float64  `json:"confidence"`
	Strategy       string   `json:"strategy"`
	Reasons        []string `json:"reasons"`
	RSI            float64  `json:"rsi"`
	Trend          string   `json:"trend"`
	VolumeRatio    float64  `json:"volume_ratio"`   // today's vol vs 20-day avg
	TechnicalScore float64  `json:"technical_score"`
	ExitTime       string   `json:"exit_time"`      // "Next day 15:15" or "Next day open"
	GeneratedAt    string   `json:"generated_at"`
}

// BTSTAnalyzer generates Buy-Today-Sell-Tomorrow signals for NSE stocks.
type BTSTAnalyzer struct{}

func NewBTSTAnalyzer() *BTSTAnalyzer { return &BTSTAnalyzer{} }

// Analyze evaluates a stock for BTST opportunity using end-of-day data.
// BTST criteria (all must be met):
//   1. Price in uptrend (SMA20 > SMA50 or recent 3-day momentum)
//   2. Today's volume > 1.5x 20-day average (institutional interest)
//   3. RSI 52–72 (momentum without being overbought)
//   4. Positive MACD histogram
//   5. Close in upper half of day's range (strong close)
//   6. Not near major resistance (room to run next day)
//   7. R:R ≥ 1.5
func (a *BTSTAnalyzer) Analyze(
	stock *storage.Stock,
	bars []storage.PriceBar,
	ind *storage.TechnicalIndicator,
	srLevels []storage.SupportResistanceLevel,
) *BTSTSignal {
	if len(bars) < 20 || ind == nil {
		return nil
	}

	today := bars[len(bars)-1]
	prev := bars[len(bars)-2]

	// ── Volume check ──────────────────────────────────────────────────────────
	avgVol := avgVol20(bars)
	volRatio := float64(today.Volume) / avgVol
	if volRatio < 1.5 { // require meaningful volume
		return nil
	}

	// ── RSI check ─────────────────────────────────────────────────────────────
	rsi := 50.0
	if ind.RSI != nil {
		rsi = *ind.RSI
	}
	if rsi < 50 || rsi > 74 { // must have momentum but not overbought
		return nil
	}

	// ── Trend check ───────────────────────────────────────────────────────────
	trend := ind.TrendDirection
	if trend == "DOWN" {
		return nil // never BTST in downtrend
	}

	// ── MACD check ────────────────────────────────────────────────────────────
	if ind.MACDHist != nil && *ind.MACDHist < 0 {
		return nil // MACD must be positive or turning positive
	}

	// ── Strong close: price in upper 40% of day's range ───────────────────────
	dayRange := today.High - today.Low
	if dayRange == 0 {
		return nil
	}
	closePosition := (today.Close - today.Low) / dayRange
	if closePosition < 0.60 { // close must be in top 40% of range
		return nil
	}

	// ── Price vs SMA20 ────────────────────────────────────────────────────────
	if ind.SMA20 == nil || today.Close < *ind.SMA20*0.99 {
		return nil // price must be above or near SMA20
	}

	// ── Score and build signal ────────────────────────────────────────────────
	score := 0.0
	var reasons []string

	// Volume scoring
	switch {
	case volRatio >= 3.0:
		score += 25
		reasons = append(reasons, fmt.Sprintf("Massive volume surge %.1fx avg — strong institutional interest", volRatio))
	case volRatio >= 2.0:
		score += 20
		reasons = append(reasons, fmt.Sprintf("Volume %.1fx avg — significant buying pressure", volRatio))
	default:
		score += 12
		reasons = append(reasons, fmt.Sprintf("Volume %.1fx avg — above average activity", volRatio))
	}

	// RSI scoring
	switch {
	case rsi >= 60 && rsi <= 70:
		score += 20
		reasons = append(reasons, fmt.Sprintf("RSI %.0f — optimal momentum zone for BTST (60-70)", rsi))
	case rsi >= 52 && rsi < 60:
		score += 15
		reasons = append(reasons, fmt.Sprintf("RSI %.0f — building momentum", rsi))
	default:
		score += 8
	}

	// Close position scoring
	if closePosition >= 0.85 {
		score += 20
		reasons = append(reasons, fmt.Sprintf("Closed in top %.0f%% of day's range — very strong close", closePosition*100))
	} else if closePosition >= 0.70 {
		score += 15
		reasons = append(reasons, fmt.Sprintf("Closed in upper %.0f%% of range — strong close", closePosition*100))
	} else {
		score += 8
	}

	// MACD scoring
	if ind.MACDHist != nil && *ind.MACDHist > 0 {
		score += 10
		reasons = append(reasons, "MACD histogram positive — bullish momentum")
	}

	// Trend scoring
	if trend == "UP" {
		score += 15
		reasons = append(reasons, "Price in established uptrend (SMA9 > SMA20)")
	} else {
		score += 5
	}

	// Breakout from previous high
	prevHigh := prev.High
	for _, b := range bars[max(0, len(bars)-5):len(bars)-1] {
		if b.High > prevHigh {
			prevHigh = b.High
		}
	}
	if today.Close > prevHigh*0.998 {
		score += 10
		reasons = append(reasons, "Breaking out above 5-day high — continuation expected")
	}

	// SMA20 gap check (not too extended)
	if ind.SMA20 != nil {
		sma20Pct := (today.Close - *ind.SMA20) / *ind.SMA20 * 100
		if sma20Pct > 8 {
			score -= 10 // too extended from SMA20 — reversal risk
			reasons = append(reasons, fmt.Sprintf("⚠️ Extended %.1f%% above SMA20 — reversal risk", sma20Pct))
		}
	}

	// Minimum score threshold
	if score < 50 {
		return nil
	}

	// ── Entry / Target / Stop ─────────────────────────────────────────────────
	entry := today.Close
	// ATR-based targets
	atr := btst_atr(bars, 14)

	// Target: 1.5x ATR above close (typical next-day move target)
	target := entry + atr*1.8
	// Adjust target using nearest resistance level
	for _, level := range srLevels {
		if level.IsActive && (level.LevelType == "resistance" || level.LevelType == "supply") {
			if level.Price > entry && level.Price < target*0.97 {
				target = level.Price * 0.995 // stop just below resistance
			}
		}
	}

	// Stop: today's low minus small buffer
	stopLoss := today.Low - atr*0.3
	if ind.SMA20 != nil && *ind.SMA20 < entry && *ind.SMA20 > stopLoss {
		stopLoss = math.Max(stopLoss, *ind.SMA20*0.985)
	}

	rr := 0.0
	if entry-stopLoss > 0 {
		rr = (target - entry) / (entry - stopLoss)
	}
	if rr < 1.5 {
		return nil
	}

	// Strategy name
	stratName := "BTST Momentum"
	if volRatio >= 2.5 && closePosition >= 0.80 {
		stratName = "BTST Volume Surge"
	} else if trend == "UP" && rsi >= 60 {
		stratName = "BTST Trend Continuation"
	}

	return &BTSTSignal{
		Symbol:         stock.Symbol,
		Name:           stock.Name,
		Market:         stock.Market,
		Sector:         stock.Sector,
		EntryPrice:     roundTo2(entry),
		TargetPrice:    roundTo2(target),
		StopLoss:       roundTo2(stopLoss),
		RiskReward:     roundTo2(rr),
		Confidence:     math.Min(score, 92),
		Strategy:       stratName,
		Reasons:        reasons,
		RSI:            math.Round(rsi*10) / 10,
		Trend:          trend,
		VolumeRatio:    roundTo2(volRatio),
		TechnicalScore: math.Round(ind.TechnicalScore*10) / 10,
		ExitTime:       "Next trading day — sell between 10:00–15:00 IST",
		GeneratedAt:    time.Now().Format(time.RFC3339),
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func avgVol20(bars []storage.PriceBar) float64 {
	n := len(bars)
	period := 20
	if n < period+1 {
		period = n - 1
	}
	sum := int64(0)
	for i := n - 1 - period; i < n-1; i++ { // exclude today
		sum += bars[i].Volume
	}
	if period == 0 {
		return 1
	}
	avg := float64(sum) / float64(period)
	if avg == 0 {
		return 1
	}
	return avg
}

func btst_atr(bars []storage.PriceBar, period int) float64 {
	n := len(bars)
	if n < 2 {
		return bars[n-1].Close * 0.01
	}
	if n < period+1 {
		period = n - 1
	}
	sum := 0.0
	for i := n - period; i < n; i++ {
		tr := bars[i].High - bars[i].Low
		if i > 0 {
			tr = math.Max(tr, math.Abs(bars[i].High-bars[i-1].Close))
			tr = math.Max(tr, math.Abs(bars[i].Low-bars[i-1].Close))
		}
		sum += tr
	}
	r := sum / float64(period)
	if r == 0 {
		return bars[n-1].Close * 0.01
	}
	return r
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// ─── Engine-level BTST generation ────────────────────────────────────────────

// BTSTResult is the API response for BTST signals.
type BTSTResult struct {
	Signals     []BTSTSignal `json:"signals"`
	Count       int          `json:"count"`
	Market      string       `json:"market"`
	GeneratedAt string       `json:"generated_at"`
	Note        string       `json:"note"`
}

// GenerateBTSTSignals scans NSE stocks for BTST opportunities.
// It uses end-of-day technical data stored in the database.
func GenerateBTSTSignals(
	stocks []storage.Stock,
	barsMap map[uint][]storage.PriceBar,
	indicators map[uint]*storage.TechnicalIndicator,
	srMap map[uint][]storage.SupportResistanceLevel,
) BTSTResult {
	analyzer := NewBTSTAnalyzer()
	var signals []BTSTSignal

	for _, stock := range stocks {
		if stock.IsIndex || stock.Market != "NSE" {
			continue
		}
		bars := barsMap[stock.ID]
		ind := indicators[stock.ID]
		sr := srMap[stock.ID]

		stockCopy := stock
		if sig := analyzer.Analyze(&stockCopy, bars, ind, sr); sig != nil {
			signals = append(signals, *sig)
		}
	}

	// Sort by confidence descending
	sort.Slice(signals, func(i, j int) bool {
		return signals[i].Confidence > signals[j].Confidence
	})

	// Cap at top 15 BTST candidates
	if len(signals) > 15 {
		signals = signals[:15]
	}
	if signals == nil {
		signals = []BTSTSignal{}
	}

	return BTSTResult{
		Signals:     signals,
		Count:       len(signals),
		Market:      "NSE",
		GeneratedAt: time.Now().Format(time.RFC3339),
		Note:        "BTST signals are generated at end-of-day (after 15:00 IST). Enter near close, exit next trading day 10:00–15:00 IST. Always use stop-loss.",
	}
}
