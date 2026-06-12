package data

import (
	"fmt"
	"math"
	"sync"
	"time"
)

// ─── OI Pulse ─────────────────────────────────────────────────────────────────
//
// OI Pulse turns the raw option-chain open-interest snapshot into a minute-by-
// minute read on likely market movement. Every poll it compares the current
// totals against the previous minute's reading and classifies the change using
// the four canonical price-vs-OI regimes:
//
//	Price ↑ + OI ↑  → Long Buildup     → bullish (fresh longs entering)
//	Price ↓ + OI ↑  → Short Buildup    → bearish (fresh shorts entering)
//	Price ↑ + OI ↓  → Short Covering   → bullish (shorts exiting, often a bounce)
//	Price ↓ + OI ↓  → Long Unwinding   → bearish (longs exiting, momentum fading)
//
// On top of the regime it folds in the shift in PCR and the side that OI is
// being added to (call writing = resistance/bearish, put writing = support/
// bullish) to produce a single composite verdict with a confidence score. The
// recent readings are kept in a small ring buffer per underlying so the UI can
// draw the pulse over time without persisting anything.

// OIPulseRow is one minute's reading and its classification.
type OIPulseRow struct {
	At          string  `json:"at"`   // IST clock "15:04"
	Unix        int64   `json:"unix"` // unix seconds of the reading
	Spot        float64 `json:"spot"`
	PCR         float64 `json:"pcr"`
	TotalCallOI int64   `json:"total_call_oi"`
	TotalPutOI  int64   `json:"total_put_oi"`
	TotalOI     int64   `json:"total_oi"`

	// Minute-over-minute deltas (zero on the very first reading).
	SpotChg   float64 `json:"spot_chg"`
	PCRChg    float64 `json:"pcr_chg"`
	CallOIChg int64   `json:"call_oi_chg"`
	PutOIChg  int64   `json:"put_oi_chg"`
	TotalChg  int64   `json:"total_oi_chg"`

	Regime string  `json:"regime"` // long_buildup / short_buildup / short_covering / long_unwinding / flat
	Signal string  `json:"signal"` // BULLISH / BEARISH / NEUTRAL
	Score  float64 `json:"score"`  // composite directional score (signed)
}

// OIPulse is the full pulse payload for one underlying: the latest reading, the
// derived market-movement verdict, the rule hits behind it, and recent history.
type OIPulse struct {
	Underlying string  `json:"underlying"`
	Spot       float64 `json:"spot"`
	Expiry     string  `json:"expiry"`
	PCR        float64 `json:"pcr"`
	MaxPain    float64 `json:"max_pain"`
	Support    float64 `json:"support"`
	Resistance float64 `json:"resistance"`
	Bias       string  `json:"bias"` // PCR-based chain bias (from OIAnalysis)

	Regime     string   `json:"regime"`     // latest minute regime
	Signal     string   `json:"signal"`     // BULLISH / BEARISH / NEUTRAL
	Verdict    string   `json:"verdict"`    // one-line market-movement read
	Confidence float64  `json:"confidence"` // 0..100
	Score      float64  `json:"score"`      // signed composite score
	Rules      []string `json:"rules"`      // human-readable rule hits

	HasPrev   bool               `json:"has_prev"`  // false until a second minute is seen
	History   []OIPulseRow       `json:"history"`   // committed minute readings, oldest first
	Decision  *OITradeDecision   `json:"decision"`  // primary call (option-buy) — kept for compatibility
	Decisions []*OITradeDecision `json:"decisions"` // one call per selected mode (option/futures buy/sell)
	AsOf      string             `json:"as_of"`
}

// pulseHistory holds the committed per-minute readings for each underlying.
var pulseHistory = struct {
	mu   sync.Mutex
	rows map[string][]OIPulseRow
}{rows: make(map[string][]OIPulseRow)}

const (
	pulseMaxRows     = 90               // ~90 minutes of readings kept per symbol
	pulseMinSpacing  = 45 * time.Second // commit at most one reading per ~minute
	pulseSpotEps     = 0.0              // treat any non-zero spot move as directional
	pulseOIFlatBand  = 0.001            // |ΔOI|/totalOI below this = "flat" OI
)

// OIPulseFor builds the OI Pulse for an underlying. It fetches the current option
// chain, compares it to the previous committed minute, classifies the regime,
// scores a composite verdict, and (when at least pulseMinSpacing has elapsed)
// commits the reading to the ring buffer.
func (k *KiteClient) OIPulseFor(appSymbol string, modes []string, maxLots int, rr float64) (*OIPulse, error) {
	if k == nil || !k.IsConnected() {
		return nil, fmt.Errorf("zerodha not connected")
	}
	oi, err := k.OptionChainOI(appSymbol)
	if err != nil {
		return nil, err
	}

	now := time.Now()
	totalOI := oi.TotalCallOI + oi.TotalPutOI

	cur := OIPulseRow{
		At:          now.In(istZone()).Format("15:04"),
		Unix:        now.Unix(),
		Spot:        oi.Spot,
		PCR:         oi.PCR,
		TotalCallOI: oi.TotalCallOI,
		TotalPutOI:  oi.TotalPutOI,
		TotalOI:     totalOI,
	}

	pulseHistory.mu.Lock()
	hist := pulseHistory.rows[oi.Underlying]
	var prev *OIPulseRow
	if len(hist) > 0 {
		prev = &hist[len(hist)-1]
	}

	hasPrev := prev != nil
	if hasPrev {
		cur.SpotChg = cur.Spot - prev.Spot
		cur.PCRChg = cur.PCR - prev.PCR
		cur.CallOIChg = cur.TotalCallOI - prev.TotalCallOI
		cur.PutOIChg = cur.TotalPutOI - prev.TotalPutOI
		cur.TotalChg = cur.TotalOI - prev.TotalOI
	}

	regime, signal, score, rules := classifyPulse(cur, totalOI, oi, hasPrev)
	cur.Regime = regime
	cur.Signal = signal
	cur.Score = score

	// Commit a new minute point only when enough time has passed (or it's the
	// first reading), so repeated polls within a minute don't spam the series.
	commit := !hasPrev || now.Sub(time.Unix(prev.Unix, 0)) >= pulseMinSpacing
	if commit {
		hist = append(hist, cur)
		if len(hist) > pulseMaxRows {
			hist = hist[len(hist)-pulseMaxRows:]
		}
		pulseHistory.rows[oi.Underlying] = hist
	}
	// Snapshot the history to return (copy so callers can't mutate the buffer).
	out := make([]OIPulseRow, len(hist))
	copy(out, hist)
	pulseHistory.mu.Unlock()

	confidence := pulseConfidence(score, cur, totalOI, hasPrev)
	verdict := pulseVerdict(regime, signal, oi, hasPrev)
	// One trade call per selected mode (option/futures · buy/sell).
	decisions := decideOITradeModes(oi, signal, regime, confidence, hasPrev, modes, maxLots, rr)
	for _, dec := range decisions {
		// Resolve the live, tradeable CE/PE contract for option modes (no-op for
		// futures), so each call carries its concrete leg + live premium.
		k.enrichDecisionLeg(appSymbol, oi, dec)
	}
	// Primary = the option-buy call when present, else the first call (kept in the
	// legacy Decision field for compatibility).
	var primary *OITradeDecision
	for _, dec := range decisions {
		if dec.Mode == ModeOptionBuy {
			primary = dec
			break
		}
	}
	if primary == nil && len(decisions) > 0 {
		primary = decisions[0]
	}

	return &OIPulse{
		Underlying: oi.Underlying,
		Spot:       oi.Spot,
		Expiry:     oi.Expiry,
		PCR:        oi.PCR,
		MaxPain:    oi.MaxPain,
		Support:    oi.Support,
		Resistance: oi.Resistance,
		Bias:       oi.Bias,
		Regime:     regime,
		Signal:     signal,
		Verdict:    verdict,
		Confidence: confidence,
		Score:      score,
		Rules:      rules,
		HasPrev:    hasPrev,
		History:    out,
		Decision:   primary,
		Decisions:  decisions,
		AsOf:       now.In(istZone()).Format("15:04:05"),
	}, nil
}

// classifyPulse applies the price-vs-OI regime rules plus PCR-shift and OI-side
// rules, returning the regime, the BULLISH/BEARISH/NEUTRAL signal, a signed
// composite score, and the human-readable rule hits behind the call.
func classifyPulse(cur OIPulseRow, totalOI int64, oi *OIAnalysis, hasPrev bool) (regime, signal string, score float64, rules []string) {
	if !hasPrev {
		return "flat", "NEUTRAL", 0, []string{"Baseline reading — deltas appear from the next minute."}
	}

	priceUp := cur.SpotChg > pulseSpotEps
	priceDown := cur.SpotChg < -pulseSpotEps
	// OI is "flat" when the total change is a negligible fraction of total OI.
	flatBand := int64(0)
	if totalOI > 0 {
		flatBand = int64(float64(totalOI) * pulseOIFlatBand)
	}
	oiUp := cur.TotalChg > flatBand
	oiDown := cur.TotalChg < -flatBand

	// ── Primary regime: price vs total OI ──
	switch {
	case priceUp && oiUp:
		regime, score = "long_buildup", 2
		rules = append(rules, "Price ↑ with OI ↑ → Long Buildup (fresh longs, bullish).")
	case priceDown && oiUp:
		regime, score = "short_buildup", -2
		rules = append(rules, "Price ↓ with OI ↑ → Short Buildup (fresh shorts, bearish).")
	case priceUp && oiDown:
		regime, score = "short_covering", 1
		rules = append(rules, "Price ↑ with OI ↓ → Short Covering (shorts exiting, bullish but can fade).")
	case priceDown && oiDown:
		regime, score = "long_unwinding", -1
		rules = append(rules, "Price ↓ with OI ↓ → Long Unwinding (longs exiting, bearish but weak).")
	default:
		regime, score = "flat", 0
		rules = append(rules, "Little net change in price/OI → no clear regime this minute.")
	}

	// ── PCR shift: rising PCR = put writing = supportive; falling = call writing ──
	if cur.PCRChg > 0.02 {
		score += 1
		rules = append(rules, fmt.Sprintf("PCR rising (%.2f→%.2f) → put writing, supportive.", cur.PCR-cur.PCRChg, cur.PCR))
	} else if cur.PCRChg < -0.02 {
		score -= 1
		rules = append(rules, fmt.Sprintf("PCR falling (%.2f→%.2f) → call writing, pressure.", cur.PCR-cur.PCRChg, cur.PCR))
	}

	// ── OI side being added to: net call adds = resistance/bearish, put adds = support/bullish ──
	if cur.CallOIChg > 0 && cur.CallOIChg > cur.PutOIChg {
		score -= 0.5
		rules = append(rules, "More fresh call OI than put OI → resistance building above.")
	} else if cur.PutOIChg > 0 && cur.PutOIChg > cur.CallOIChg {
		score += 0.5
		rules = append(rules, "More fresh put OI than call OI → support building below.")
	}

	// ── Spot vs max pain: a strong magnet for expiry-week drift ──
	if oi.MaxPain > 0 && oi.Spot > 0 {
		diff := (oi.Spot - oi.MaxPain) / oi.MaxPain * 100
		if diff > 0.5 {
			rules = append(rules, fmt.Sprintf("Spot %.0f above max pain %.0f → writers favour a pull lower into expiry.", oi.Spot, oi.MaxPain))
		} else if diff < -0.5 {
			rules = append(rules, fmt.Sprintf("Spot %.0f below max pain %.0f → writers favour a drift higher into expiry.", oi.Spot, oi.MaxPain))
		}
	}

	switch {
	case score >= 1.5:
		signal = "BULLISH"
	case score <= -1.5:
		signal = "BEARISH"
	default:
		signal = "NEUTRAL"
	}
	return regime, signal, score, rules
}

// pulseConfidence maps the composite score and the size of this minute's OI move
// into a 0..100 confidence. A bigger, more decisive OI shift raises confidence.
func pulseConfidence(score float64, cur OIPulseRow, totalOI int64, hasPrev bool) float64 {
	if !hasPrev {
		return 0
	}
	base := 45 + math.Min(math.Abs(score)*12, 35) // 45..80 from score magnitude
	// Add up to 15 for a decisive OI move (|ΔOI| as a fraction of total OI).
	if totalOI > 0 {
		frac := math.Abs(float64(cur.TotalChg)) / float64(totalOI)
		base += math.Min(frac*1500, 15)
	}
	if base > 95 {
		base = 95
	}
	return math.Round(base)
}

// pulseVerdict renders a one-line market-movement read from the regime and signal.
func pulseVerdict(regime, signal string, oi *OIAnalysis, hasPrev bool) string {
	if !hasPrev {
		return "Warming up — first minute baseline captured."
	}
	switch regime {
	case "long_buildup":
		return fmt.Sprintf("Bullish: longs building. Watch for continuation above %.0f.", oi.Resistance)
	case "short_buildup":
		return fmt.Sprintf("Bearish: shorts building. Watch for breakdown below %.0f.", oi.Support)
	case "short_covering":
		return "Bullish bounce: shorts covering — can fade if no fresh longs follow."
	case "long_unwinding":
		return "Bearish drift: longs unwinding — momentum fading rather than strong selling."
	default:
		if signal == "BULLISH" {
			return "Mildly bullish: OI tilt favours the upside."
		}
		if signal == "BEARISH" {
			return "Mildly bearish: OI tilt favours the downside."
		}
		return "Balanced: no decisive OI footprint this minute."
	}
}

// istZone returns the Asia/Kolkata location, falling back to a fixed +5:30.
func istZone() *time.Location {
	if loc, err := time.LoadLocation("Asia/Kolkata"); err == nil {
		return loc
	}
	return time.FixedZone("IST", 5*3600+30*60)
}
