package nifty

import (
	"fmt"
	"math"
	"time"
)

// SuggestStrikes generates optimal strike price suggestions based on the signal direction.
func SuggestStrikes(chain *OptionChainData, direction string) *StrikeSuggestionReport {
	spot := chain.SpotPrice
	if spot == 0 {
		spot = 24500
	}
	atm := roundToStrike(spot, 50)

	expiry := chain.SelectedExpiry
	if expiry == "" {
		expiry = nextThursday()
	}

	var suggestions []StrikeSuggestion

	switch direction {
	case "BULLISH", "STRONG_BULLISH":
		// Call suggestions: ATM, OTM, ITM
		suggestions = append(suggestions,
			buildCallSuggestion(chain, atm, spot, expiry, "ATM", "MODERATE"),
			buildCallSuggestion(chain, atm+100, spot, expiry, "OTM", "AGGRESSIVE"),
			buildCallSuggestion(chain, atm-50, spot, expiry, "SLIGHT_ITM", "CONSERVATIVE"),
		)
	case "BEARISH", "STRONG_BEARISH":
		// Put suggestions: ATM, OTM, ITM
		suggestions = append(suggestions,
			buildPutSuggestion(chain, atm, spot, expiry, "ATM", "MODERATE"),
			buildPutSuggestion(chain, atm-100, spot, expiry, "OTM", "AGGRESSIVE"),
			buildPutSuggestion(chain, atm+50, spot, expiry, "SLIGHT_ITM", "CONSERVATIVE"),
		)
	default:
		// Neutral: suggest straddle or iron fly
		suggestions = append(suggestions,
			buildCallSuggestion(chain, atm, spot, expiry, "ATM_CALL", "MODERATE"),
			buildPutSuggestion(chain, atm, spot, expiry, "ATM_PUT", "MODERATE"),
		)
	}

	return &StrikeSuggestionReport{
		SpotPrice:       spot,
		Direction:       direction,
		Expiry:          expiry,
		ATMStrike:       atm,
		Suggestions:     suggestions,
		MaxPainStrike:   chain.MaxPainStrike,
		PCR:             chain.PCR,
		MarketSentiment: chain.MarketSentiment,
		GeneratedAt:     time.Now().Format(time.RFC3339),
	}
}

func buildCallSuggestion(chain *OptionChainData, strike, spot float64, expiry, label, riskLevel string) StrikeSuggestion {
	ltp := findLTP(chain, strike, "CE")
	if ltp == 0 {
		ltp = syntheticOptionPrice(spot, strike, 0.13, true)
	}
	iv := findIV(chain, strike, "CE")
	if iv == 0 {
		iv = 13.0 + math.Abs(strike-spot)/1000
	}

	delta := approxDelta(spot, strike, true)
	theta := -ltp * 0.02 // ~2% decay per day rough estimate

	// Entry slightly above LTP to account for spread
	entry := math.Round((ltp+1)*10) / 10
	target := math.Round(entry*1.5*10) / 10  // 50% gain
	sl := math.Round(entry*0.45*10) / 10     // ~55% loss

	maxProfit := (target - entry) * float64(NiftyLotSize)
	maxLoss := (entry - sl) * float64(NiftyLotSize)
	rr := 0.0
	if maxLoss > 0 {
		rr = math.Round(maxProfit/maxLoss*100) / 100
	}

	rationale := fmt.Sprintf("%s CE at %.0f | Delta %.2f | IV %.1f%% | Target +50%% | SL -55%%", label, strike, delta, iv)
	if strike < spot {
		rationale = fmt.Sprintf("Slight ITM call (higher delta %.2f) for safer leveraged bullish bet | IV %.1f%%", delta, iv)
	} else if strike > spot+75 {
		rationale = fmt.Sprintf("OTM call (lower cost, max leverage) | Break-even above %.0f | IV %.1f%%", strike+entry, iv)
	}

	return StrikeSuggestion{
		Strike:          strike,
		OptionType:      "CE",
		ExpiryDate:      expiry,
		ExpiryType:      "WEEKLY",
		LTP:             ltp,
		Delta:           delta,
		IV:              iv,
		Theta:           theta,
		SuggestedEntry:  entry,
		Target:          target,
		StopLoss:        sl,
		MaxLoss:         math.Round(maxLoss),
		MaxProfit:       math.Round(maxProfit),
		RiskReward:      rr,
		LotSize:         NiftyLotSize,
		RiskLevel:       riskLevel,
		Label:           label,
		Rationale:       rationale,
		Confidence:      confidenceByLabel(label),
	}
}

func buildPutSuggestion(chain *OptionChainData, strike, spot float64, expiry, label, riskLevel string) StrikeSuggestion {
	ltp := findLTP(chain, strike, "PE")
	if ltp == 0 {
		ltp = syntheticOptionPrice(spot, strike, 0.135, false)
	}
	iv := findIV(chain, strike, "PE")
	if iv == 0 {
		iv = 13.5 + math.Abs(strike-spot)/1000
	}

	delta := approxDelta(spot, strike, false)
	theta := -ltp * 0.02

	entry := math.Round((ltp+1)*10) / 10
	target := math.Round(entry*1.5*10) / 10
	sl := math.Round(entry*0.45*10) / 10

	maxProfit := (target - entry) * float64(NiftyLotSize)
	maxLoss := (entry - sl) * float64(NiftyLotSize)
	rr := 0.0
	if maxLoss > 0 {
		rr = math.Round(maxProfit/maxLoss*100) / 100
	}

	rationale := fmt.Sprintf("%s PE at %.0f | Delta %.2f | IV %.1f%% | Target +50%% | SL -55%%", label, strike, math.Abs(delta), iv)
	if strike > spot {
		rationale = fmt.Sprintf("Slight ITM put (higher delta %.2f) for safer leveraged bearish bet | IV %.1f%%", math.Abs(delta), iv)
	} else if strike < spot-75 {
		rationale = fmt.Sprintf("OTM put (lower cost, max leverage) | Break-even below %.0f | IV %.1f%%", strike-entry, iv)
	}

	return StrikeSuggestion{
		Strike:          strike,
		OptionType:      "PE",
		ExpiryDate:      expiry,
		ExpiryType:      "WEEKLY",
		LTP:             ltp,
		Delta:           delta,
		IV:              iv,
		Theta:           theta,
		SuggestedEntry:  entry,
		Target:          target,
		StopLoss:        sl,
		MaxLoss:         math.Round(maxLoss),
		MaxProfit:       math.Round(maxProfit),
		RiskReward:      rr,
		LotSize:         NiftyLotSize,
		RiskLevel:       riskLevel,
		Label:           label,
		Rationale:       rationale,
		Confidence:      confidenceByLabel(label),
	}
}

// approxDelta uses a simplified delta calculation.
// For calls: roughly 0.5 - (distance from ATM / spot * 5)
// For puts: negative of call delta (put-call parity approximation)
func approxDelta(spot, strike float64, isCall bool) float64 {
	moneyness := (spot - strike) / spot * 100 // positive = ITM call
	var delta float64
	if isCall {
		delta = 0.5 + moneyness*0.05
		delta = math.Max(0.05, math.Min(0.95, delta))
	} else {
		delta = -0.5 + moneyness*0.05
		delta = math.Max(-0.95, math.Min(-0.05, delta))
	}
	return math.Round(delta*100) / 100
}

func findLTP(chain *OptionChainData, strike float64, optType string) float64 {
	for _, row := range chain.Rows {
		if row.StrikePrice == strike {
			if optType == "CE" {
				return row.CE.LastPrice
			}
			return row.PE.LastPrice
		}
	}
	return 0
}

func findIV(chain *OptionChainData, strike float64, optType string) float64 {
	for _, row := range chain.Rows {
		if row.StrikePrice == strike {
			if optType == "CE" {
				return row.CE.ImpliedVolatility
			}
			return row.PE.ImpliedVolatility
		}
	}
	return 0
}

func confidenceByLabel(label string) float64 {
	switch label {
	case "ATM", "ATM_CALL", "ATM_PUT":
		return 75.0
	case "SLIGHT_ITM":
		return 80.0
	case "OTM":
		return 60.0
	default:
		return 70.0
	}
}
