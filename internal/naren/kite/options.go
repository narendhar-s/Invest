package kite

import (
	"fmt"
	"math"
	"sort"
	"time"
)

// OptionLeg is a resolved option contract.
type OptionLeg struct {
	TradingSymbol   string  `json:"trading_symbol"`
	QuoteKey        string  `json:"quote_key"`
	InstrumentToken int     `json:"instrument_token"`
	Strike          float64 `json:"strike"`
	OptionType      string  `json:"option_type"` // CE | PE
	Expiry          string  `json:"expiry"`      // yyyy-mm-dd
	LotSize         int     `json:"lot_size"`
}

// ATMStrike rounds spot to the nearest 50-point NIFTY strike.
func ATMStrike(spot float64) float64 { return math.Round(spot/50) * 50 }

// NiftyOptions returns all NIFTY options from the NFO instrument master.
func (c *Client) NiftyOptions() ([]Instrument, error) {
	all, err := c.Instruments("NFO")
	if err != nil {
		return nil, err
	}
	var opts []Instrument
	for _, in := range all {
		if in.Name == "NIFTY" && (in.InstrumentType == "CE" || in.InstrumentType == "PE") {
			opts = append(opts, in)
		}
	}
	if len(opts) == 0 {
		return nil, fmt.Errorf("no NIFTY options found in instrument master")
	}
	return opts, nil
}

// NearestExpiry returns the nearest unexpired expiry date (yyyy-mm-dd) from a list of options.
func NearestExpiry(opts []Instrument) string {
	today := time.Now().Format("2006-01-02")
	set := map[string]bool{}
	for _, o := range opts {
		if o.Expiry >= today {
			set[o.Expiry] = true
		}
	}
	if len(set) == 0 {
		return ""
	}
	dates := make([]string, 0, len(set))
	for d := range set {
		dates = append(dates, d)
	}
	sort.Strings(dates)
	return dates[0]
}

// FindOption finds a NIFTY option instrument by expiry date, strike and type.
// Returns nil, nil if not found (e.g. expired option no longer in master).
func (c *Client) FindOption(expiryDate string, strike float64, optType string) (*Instrument, error) {
	opts, err := c.NiftyOptions()
	if err != nil {
		return nil, err
	}
	for _, o := range opts {
		if o.Expiry == expiryDate && o.InstrumentType == optType && math.Abs(o.Strike-strike) < 0.01 {
			cp := o
			return &cp, nil
		}
	}
	return nil, nil // not found — expired or not listed
}

// RealOptionPriceAt fetches the actual option premium at a specific bar time.
// Returns the open price of the 15-minute bar that contains barTime.
// Returns 0, nil when the bar can't be found (data gap, pre-listing, etc.).
func (c *Client) RealOptionPriceAt(token int, barTime time.Time) (float64, error) {
	// Fetch a 30-min window around the target bar
	from := barTime.Add(-30 * time.Minute).Format("2006-01-02 15:04:05")
	to := barTime.Add(30 * time.Minute).Format("2006-01-02 15:04:05")
	candles, err := c.HistoricalData(token, "15minute", from, to)
	if err != nil {
		return 0, err
	}
	// Find the candle whose interval contains barTime
	for i, bar := range candles {
		nextTime := barTime.Add(16 * time.Minute)
		if i+1 < len(candles) {
			nextTime = candles[i+1].Time
		}
		if !bar.Time.After(barTime) && barTime.Before(nextTime) {
			if bar.Open > 0 {
				return bar.Open, nil
			}
			return bar.Close, nil
		}
	}
	// Fall back to nearest candle
	if len(candles) > 0 {
		return candles[0].Open, nil
	}
	return 0, nil
}

// ResolveLeg finds the option instrument for a given strike/type/expiry.
// If expiry is empty, the nearest available expiry is used.
func (c *Client) ResolveLeg(strike float64, optionType, expiry string) (*OptionLeg, error) {
	opts, err := c.NiftyOptions()
	if err != nil {
		return nil, err
	}
	if expiry == "" {
		expiry = NearestExpiry(opts)
	}
	for _, o := range opts {
		if o.Expiry == expiry && o.InstrumentType == optionType && math.Abs(o.Strike-strike) < 0.01 {
			return &OptionLeg{
				TradingSymbol:   o.TradingSymbol,
				QuoteKey:        "NFO:" + o.TradingSymbol,
				InstrumentToken: o.InstrumentToken,
				Strike:          o.Strike,
				OptionType:      o.InstrumentType,
				Expiry:          o.Expiry,
				LotSize:         o.LotSize,
			}, nil
		}
	}
	return nil, fmt.Errorf("no %s option at strike %.0f for expiry %s", optionType, strike, expiry)
}

// LegPremium fetches the current LTP for an option leg.
func (c *Client) LegPremium(leg *OptionLeg) (float64, error) {
	ltp, err := c.LTP(leg.QuoteKey)
	if err != nil {
		return 0, err
	}
	d, ok := ltp[leg.QuoteKey]
	if !ok {
		return 0, fmt.Errorf("no quote for %s", leg.QuoteKey)
	}
	return d.LastPrice, nil
}
