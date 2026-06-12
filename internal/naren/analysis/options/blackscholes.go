package options

import (
	"math"
	"time"
)

// India risk-free rate (RBI repo rate approximation).
const riskFreeRate = 0.065

// barsPerTradingDay is the number of 15-minute bars in an NSE session (9:15–15:30).
const barsPerTradingDay = 25

// ─── Expiry helpers ───────────────────────────────────────────────────────────

// NiftyWeeklyExpiry returns the next NSE weekly expiry (Tuesday) from barTime.
// NSE moved NIFTY weekly expiry from Thursday to Tuesday effective June 2024.
// If barTime is itself a Tuesday before 3:30 PM IST, that Tuesday is the expiry.
func NiftyWeeklyExpiry(barTime time.Time) time.Time {
	ist := ISTLoc()
	d := barTime.In(ist)
	// Days until next Tuesday (weekday = 2)
	daysUntil := (2 - int(d.Weekday()) + 7) % 7
	if daysUntil == 0 {
		// Today is Tuesday — check if market is still open
		close := time.Date(d.Year(), d.Month(), d.Day(), 15, 30, 0, 0, ist)
		if d.After(close) {
			daysUntil = 7 // roll to next Tuesday
		}
	}
	exp := d.AddDate(0, 0, daysUntil)
	return time.Date(exp.Year(), exp.Month(), exp.Day(), 0, 0, 0, 0, ist)
}

// ExpiryLabel returns a display string like "2026-06-09 (Weekly)" for an expiry.
func ExpiryLabel(expiry time.Time) string {
	ist := ISTLoc()
	e := expiry.In(ist)
	return e.Format("2006-01-02") + " (Weekly)"
}

// ActualDTE returns the number of calendar days from barTime to expiry (min 1).
func ActualDTE(barTime, expiry time.Time) int {
	ist := ISTLoc()
	d := int(expiry.In(ist).Sub(barTime.In(ist)).Hours()/24) + 1
	if d < 1 {
		return 1
	}
	if d > 45 {
		return 45
	}
	return d
}

// ISTLoc returns the Asia/Kolkata time zone, falling back to a fixed offset.
func ISTLoc() *time.Location {
	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		return time.FixedZone("IST", 5*3600+30*60)
	}
	return loc
}

// ─── IV estimation ────────────────────────────────────────────────────────────

// IVFromATR15m converts a 15-minute ATR reading into an annualised IV estimate.
//
// The key scaling:
//   - 15m ATR → daily ATR: multiply by √barsPerTradingDay (= √25 = 5)
//   - Daily ATR / Spot gives daily return std-dev
//   - Annualise: × √252
//   - Apply a small premium (~15%) over realised vol for implied vol
//
// Clamped to [12%, 35%] which covers the realistic NIFTY IV range.
func IVFromATR15m(atr15m, spot float64) float64 {
	if spot <= 0 {
		return 0.15
	}
	dailyATR := atr15m * math.Sqrt(float64(barsPerTradingDay))
	annualised := (dailyATR / spot) * math.Sqrt(252) * 1.15
	if annualised < 0.12 {
		return 0.12
	}
	if annualised > 0.35 {
		return 0.35
	}
	return annualised
}

// ─── Black-Scholes pricing ────────────────────────────────────────────────────

// BSPrice returns the European option premium (₹) using Black-Scholes.
//   spot    – index level
//   strike  – option strike
//   iv      – annualised implied volatility (decimal, e.g. 0.17 = 17%)
//   dte     – days to expiry (calendar days, min 1)
//   isCall  – true for CE, false for PE
func BSPrice(spot, strike, iv float64, dte int, isCall bool) float64 {
	T := float64(dte) / 365.0
	if T <= 0 {
		if isCall {
			return math.Max(0, spot-strike)
		}
		return math.Max(0, strike-spot)
	}
	d1 := (math.Log(spot/strike) + (riskFreeRate+0.5*iv*iv)*T) / (iv * math.Sqrt(T))
	d2 := d1 - iv*math.Sqrt(T)
	if isCall {
		return spot*normCDF(d1) - strike*math.Exp(-riskFreeRate*T)*normCDF(d2)
	}
	return strike*math.Exp(-riskFreeRate*T)*normCDF(-d2) - spot*normCDF(-d1)
}

// BSDelta returns the option delta.
func BSDelta(spot, strike, iv float64, dte int, isCall bool) float64 {
	T := float64(dte) / 365.0
	if T <= 0 {
		if isCall {
			if spot > strike {
				return 1
			}
			return 0
		}
		if spot < strike {
			return -1
		}
		return 0
	}
	d1 := (math.Log(spot/strike) + (riskFreeRate+0.5*iv*iv)*T) / (iv * math.Sqrt(T))
	if isCall {
		return normCDF(d1)
	}
	return normCDF(d1) - 1
}

// BSTheta returns daily time-decay (₹ per calendar day, negative value).
func BSTheta(spot, strike, iv float64, dte int, isCall bool) float64 {
	T := float64(dte) / 365.0
	if T <= 0 {
		return 0
	}
	d1 := (math.Log(spot/strike) + (riskFreeRate+0.5*iv*iv)*T) / (iv * math.Sqrt(T))
	d2 := d1 - iv*math.Sqrt(T)
	phi := normPDF(d1)
	if isCall {
		return (-spot*phi*iv/(2*math.Sqrt(T)) - riskFreeRate*strike*math.Exp(-riskFreeRate*T)*normCDF(d2)) / 365.0
	}
	return (-spot*phi*iv/(2*math.Sqrt(T)) + riskFreeRate*strike*math.Exp(-riskFreeRate*T)*normCDF(-d2)) / 365.0
}

// normCDF is the standard-normal cumulative distribution.
func normCDF(x float64) float64 { return 0.5 * math.Erfc(-x/math.Sqrt2) }

// normPDF is the standard-normal probability density.
func normPDF(x float64) float64 { return math.Exp(-0.5*x*x) / math.Sqrt(2*math.Pi) }
