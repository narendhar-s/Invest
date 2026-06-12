package nifty

import (
	"fmt"
	"math"
	"time"
)

// StockLotSizes maps Yahoo Finance symbols to their NSE F&O lot sizes.
var StockLotSizes = map[string]int{
	"^NSEI":         75,
	"HDFCBANK.NS":   550,
	"SBIN.NS":       1500,
	"INFY.NS":       400,
	"RELIANCE.NS":   250,
	"TATAMOTORS.NS": 1425,
	"ITC.NS":        3200,
	"SUNPHARMA.NS":  350,
	"TATASTEEL.NS":  5500,
	"NTPC.NS":       3000,
	"DLF.NS":        825,
	"MUTHOOTFIN.NS": 300,
}

// strikeIntervalForSpot returns the NSE standard strike interval for a given spot price.
func strikeIntervalForSpot(symbol string, spot float64) float64 {
	if symbol == "^NSEI" {
		return 50
	}
	switch {
	case spot < 100:
		return 2.5
	case spot < 250:
		return 5
	case spot < 500:
		return 10
	case spot < 1000:
		return 20
	case spot < 2500:
		return 50
	default:
		return 100
	}
}

// atr14 computes a 14-bar Average True Range from OHLCV price bars.
// The bars slice uses storage.PriceBar fields (Open/High/Low/Close/Volume).
// We accept a duck-typed interface to avoid a circular import: caller passes
// pre-converted []PriceBarLite.
type PriceBarLite struct {
	Open, High, Low, Close float64
}

func atr14(bars []PriceBarLite) float64 {
	n := len(bars)
	if n < 2 {
		return 0
	}
	lookback := 14
	if n-1 < lookback {
		lookback = n - 1
	}
	var sum float64
	for i := n - lookback; i < n; i++ {
		hl := bars[i].High - bars[i].Low
		hc := math.Abs(bars[i].High - bars[i-1].Close)
		lc := math.Abs(bars[i].Low - bars[i-1].Close)
		tr := math.Max(hl, math.Max(hc, lc))
		sum += tr
	}
	return sum / float64(lookback)
}

// impliedVolFromATR converts ATR to an annualised implied-vol proxy.
func impliedVolFromATR(atrVal, spot float64) float64 {
	if spot == 0 {
		return 0.18
	}
	dailyVol := atrVal / spot
	annualVol := dailyVol * math.Sqrt(252)
	// Clamp: real NSE stocks rarely go below 12% or above 120% IV
	if annualVol < 0.12 {
		return 0.12
	}
	if annualVol > 1.20 {
		return 1.20
	}
	return annualVol
}

// SuggestStrikesForSpot generates CE and PE strike suggestions for any stock
// without needing a live option chain — uses ATR-derived IV instead.
//
// direction: "BUY" → CE suggestions only; "SELL" → PE only; anything else → both.
func SuggestStrikesForSpot(symbol string, spot float64, direction string,
	targetPct, stopPct float64, bars []PriceBarLite) *StrikeSuggestionReport {

	atrVal := atr14(bars)
	iv := impliedVolFromATR(atrVal, spot)

	interval := strikeIntervalForSpot(symbol, spot)
	atm := roundToStrike(spot, interval)
	expiry := nextThursday()

	lotSize := NiftyLotSize
	if ls, ok := StockLotSizes[symbol]; ok {
		lotSize = ls
	}

	var suggestions []StrikeSuggestion

	if direction != "SELL" {
		// Call suggestions: ITM → ATM → OTM
		for _, cfg := range []struct {
			strike float64
			label  string
			risk   string
		}{
			{atm - interval, "ITM", "CONSERVATIVE"},
			{atm, "ATM", "MODERATE"},
			{atm + interval, "OTM", "AGGRESSIVE"},
		} {
			suggestions = append(suggestions,
				buildStockCallSuggestion(cfg.strike, spot, iv, expiry, cfg.label, cfg.risk, targetPct, stopPct, lotSize))
		}
	}

	if direction != "BUY" {
		// Put suggestions: OTM → ATM → ITM
		for _, cfg := range []struct {
			strike float64
			label  string
			risk   string
		}{
			{atm - interval, "OTM", "AGGRESSIVE"},
			{atm, "ATM", "MODERATE"},
			{atm + interval, "ITM", "CONSERVATIVE"},
		} {
			suggestions = append(suggestions,
				buildStockPutSuggestion(cfg.strike, spot, iv, expiry, cfg.label, cfg.risk, targetPct, stopPct, lotSize))
		}
	}

	mapDirection := "NEUTRAL"
	switch direction {
	case "BUY":
		mapDirection = "BULLISH"
	case "SELL":
		mapDirection = "BEARISH"
	}

	return &StrikeSuggestionReport{
		SpotPrice:   spot,
		Direction:   mapDirection,
		Expiry:      expiry,
		ATMStrike:   atm,
		Suggestions: suggestions,
		GeneratedAt: time.Now().Format(time.RFC3339),
	}
}

func buildStockCallSuggestion(strike, spot, iv float64, expiry, label, riskLevel string,
	targetPct, stopPct float64, lotSize int) StrikeSuggestion {

	ltp := syntheticOptionPrice(spot, strike, iv, true)
	delta := approxDelta(spot, strike, true)

	entry := math.Round((ltp+0.5)*10) / 10

	// At target: option moves by delta × (targetPct × spot)
	targetMove := delta * (targetPct * spot)
	targetPremium := math.Round(math.Max(entry+targetMove, entry*1.1)*10) / 10

	// At SL: option decays; use 50% stop of premium as floor
	slMove := delta * (stopPct * spot)
	slPremium := math.Round(math.Max(entry-slMove, entry*0.35)*10) / 10

	maxProfit := (targetPremium - entry) * float64(lotSize)
	maxLoss := (entry - slPremium) * float64(lotSize)
	rr := 0.0
	if maxLoss > 0 {
		rr = math.Round(maxProfit/maxLoss*100) / 100
	}

	ivPct := iv * 100
	rationale := fmt.Sprintf("%s CE ₹%.0f | Δ %.2f | IV %.0f%% | Target ₹%.1f | SL ₹%.1f", label, strike, delta, ivPct, targetPremium, slPremium)

	return StrikeSuggestion{
		Strike:         strike,
		OptionType:     "CE",
		ExpiryDate:     expiry,
		ExpiryType:     "WEEKLY",
		LTP:            ltp,
		Delta:          delta,
		IV:             ivPct,
		Theta:          -ltp * 0.02,
		SuggestedEntry: entry,
		Target:         targetPremium,
		StopLoss:       slPremium,
		MaxProfit:      math.Round(maxProfit),
		MaxLoss:        math.Round(maxLoss),
		RiskReward:     rr,
		LotSize:        lotSize,
		RiskLevel:      riskLevel,
		Label:          label,
		Rationale:      rationale,
		Confidence:     confidenceByLabel(label),
	}
}

func buildStockPutSuggestion(strike, spot, iv float64, expiry, label, riskLevel string,
	targetPct, stopPct float64, lotSize int) StrikeSuggestion {

	ltp := syntheticOptionPrice(spot, strike, iv, false)
	delta := approxDelta(spot, strike, false) // negative

	entry := math.Round((ltp+0.5)*10) / 10

	// Put gains when stock falls; delta is negative so multiply by -1
	targetMove := math.Abs(delta) * (targetPct * spot)
	targetPremium := math.Round(math.Max(entry+targetMove, entry*1.1)*10) / 10

	slMove := math.Abs(delta) * (stopPct * spot)
	slPremium := math.Round(math.Max(entry-slMove, entry*0.35)*10) / 10

	maxProfit := (targetPremium - entry) * float64(lotSize)
	maxLoss := (entry - slPremium) * float64(lotSize)
	rr := 0.0
	if maxLoss > 0 {
		rr = math.Round(maxProfit/maxLoss*100) / 100
	}

	ivPct := iv * 100
	rationale := fmt.Sprintf("%s PE ₹%.0f | Δ %.2f | IV %.0f%% | Target ₹%.1f | SL ₹%.1f", label, strike, math.Abs(delta), ivPct, targetPremium, slPremium)

	return StrikeSuggestion{
		Strike:         strike,
		OptionType:     "PE",
		ExpiryDate:     expiry,
		ExpiryType:     "WEEKLY",
		LTP:            ltp,
		Delta:          delta,
		IV:             ivPct,
		Theta:          -ltp * 0.02,
		SuggestedEntry: entry,
		Target:         targetPremium,
		StopLoss:       slPremium,
		MaxProfit:      math.Round(maxProfit),
		MaxLoss:        math.Round(maxLoss),
		RiskReward:     rr,
		LotSize:        lotSize,
		RiskLevel:      riskLevel,
		Label:          label,
		Rationale:      rationale,
		Confidence:     confidenceByLabel(label),
	}
}
