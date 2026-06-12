package kite

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

// ─── Option chain ─────────────────────────────────────────────────────────────

// ChainStrike is one strike's CE+PE data from the live option chain.
type ChainStrike struct {
	Strike   float64
	CESymbol string
	PESymbol string
	CELTP    float64
	PELTP    float64
	CEOI     float64
	PEOI     float64
	CEIV     float64 // implied volatility placeholder (populated from quote if available)
}

// ChainSnapshot is a full option chain snapshot for NIFTY.
type ChainSnapshot struct {
	Spot    float64
	ATM     float64
	Strikes []ChainStrike
	// Aggregated metrics
	TotalCallOI float64
	TotalPutOI  float64
	PCR         float64 // Put-Call Ratio = TotalPutOI / TotalCallOI
	ATMCallLTP  float64
	ATMPutLTP   float64
}

// NiftyChain fetches a live option chain snapshot for the nearest NIFTY expiry.
// It queries ATM ± strikesEachSide strikes (e.g. 5 = 11 strikes total).
func (c *Client) NiftyChain(strikesEachSide int) (*ChainSnapshot, error) {
	// Get spot
	ltp, err := c.LTP(NiftySymbol)
	if err != nil {
		return nil, fmt.Errorf("fetching NIFTY spot: %w", err)
	}
	spot := ltp[NiftySymbol].LastPrice
	atm  := ATMStrike(spot)

	// Get active NIFTY options for nearest expiry
	opts, err := c.NiftyOptions()
	if err != nil {
		return nil, err
	}
	expiry := NearestExpiry(opts)
	if expiry == "" {
		return nil, fmt.Errorf("no active NIFTY expiry found")
	}

	// Build strike list
	strikes := make([]float64, 0, strikesEachSide*2+1)
	for i := -strikesEachSide; i <= strikesEachSide; i++ {
		strikes = append(strikes, atm+float64(i)*50)
	}

	// Build instrument keys: NFO:NIFTY...CE and NFO:NIFTY...PE
	var keys []string
	strikeMap := map[float64]*ChainStrike{}
	for _, s := range strikes {
		cs := &ChainStrike{Strike: s}
		for _, o := range opts {
			if o.Expiry != expiry || math.Abs(o.Strike-s) > 0.01 {
				continue
			}
			key := "NFO:" + o.TradingSymbol
			if o.InstrumentType == "CE" {
				cs.CESymbol = key
				keys = append(keys, key)
			} else {
				cs.PESymbol = key
				keys = append(keys, key)
			}
		}
		if cs.CESymbol != "" || cs.PESymbol != "" {
			strikeMap[s] = cs
		}
	}

	// Fetch quotes for all instruments at once
	if len(keys) > 0 {
		quotes, err := c.Quote(keys...)
		if err != nil {
			return nil, fmt.Errorf("fetching option chain quotes: %w", err)
		}
		for _, cs := range strikeMap {
			if cs.CESymbol != "" {
				if q, ok := quotes[cs.CESymbol]; ok {
					cs.CELTP = q.LastPrice
					cs.CEOI  = q.OI
				}
			}
			if cs.PESymbol != "" {
				if q, ok := quotes[cs.PESymbol]; ok {
					cs.PELTP = q.LastPrice
					cs.PEOI  = q.OI
				}
			}
		}
	}

	// Sort by strike
	sortedStrikes := make([]ChainStrike, 0, len(strikeMap))
	for _, cs := range strikeMap {
		sortedStrikes = append(sortedStrikes, *cs)
	}
	sort.Slice(sortedStrikes, func(i, j int) bool {
		return sortedStrikes[i].Strike < sortedStrikes[j].Strike
	})

	// Aggregate metrics
	snap := &ChainSnapshot{Spot: spot, ATM: atm, Strikes: sortedStrikes}
	for _, cs := range sortedStrikes {
		snap.TotalCallOI += cs.CEOI
		snap.TotalPutOI  += cs.PEOI
		if math.Abs(cs.Strike-atm) < 0.01 {
			snap.ATMCallLTP = cs.CELTP
			snap.ATMPutLTP  = cs.PELTP
		}
	}
	if snap.TotalCallOI > 0 {
		snap.PCR = snap.TotalPutOI / snap.TotalCallOI
	}
	return snap, nil
}

// PCRBias returns BULLISH, BEARISH, or NEUTRAL based on the Put-Call Ratio.
// PCR < 0.8 → too many calls → bearish (contrarian)
// PCR > 1.2 → too many puts → bullish (contrarian)
// This is the contrarian interpretation used by most NIFTY option traders.
func PCRBias(pcr float64) string {
	switch {
	case pcr < 0.7:
		return "BEARISH" // extreme call buying = market top forming
	case pcr < 0.85:
		return "MILDLY_BEARISH"
	case pcr > 1.3:
		return "BULLISH" // extreme put buying = market bottom forming
	case pcr > 1.1:
		return "MILDLY_BULLISH"
	default:
		return "NEUTRAL"
	}
}

// RealOptionLTP fetches the current live LTP for a specific option.
// Returns 0 if not found or market is closed.
func (c *Client) RealOptionLTP(expiry string, strike float64, optType string) (float64, string, error) {
	ins, err := c.FindOption(expiry, strike, strings.ToUpper(optType))
	if err != nil {
		return 0, "", err
	}
	if ins == nil {
		return 0, "", fmt.Errorf("option %s %.0f%s for %s not found in master",
			expiry, strike, optType, expiry)
	}
	key := "NFO:" + ins.TradingSymbol
	ltp, err := c.LTP(key)
	if err != nil {
		return 0, ins.TradingSymbol, err
	}
	d, ok := ltp[key]
	if !ok {
		return 0, ins.TradingSymbol, nil
	}
	return d.LastPrice, ins.TradingSymbol, nil
}
