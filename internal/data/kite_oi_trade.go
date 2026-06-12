package data

import (
	"fmt"
	"math"
	"strings"
)

// ─── OI-driven option trade decision ──────────────────────────────────────────
//
// This turns the OI Pulse read into one concrete, actionable Nifty (or any index)
// option trade call: whether to trade a Call (CE) or Put (PE), and which strike —
// ITM, ATM, or OTM — with the entry/target/stop reasoning behind it.
//
// The framework follows how consistently profitable index-option traders actually
// select instruments intraday, rather than the "buy cheap OTM lottery" habit that
// loses to theta and IV crush:
//
//	Direction  — from the OI regime/signal:
//	             bullish footprint  → Call (CE);  bearish footprint → Put (PE).
//	Buy vs sell — directional conviction is taken by BUYING the option (defined
//	             risk = premium). When the regime is range-bound, a premium-
//	             SELLING alternative at the dominant OI wall is offered as a note.
//	Moneyness  — driven by conviction, because delta/theta trade off with distance:
//	             STRONG trend (fresh buildup, high confidence) → 1-strike ITM
//	                 (delta ≈ 0.6–0.7; intrinsic value cushions theta — best for
//	                 riding a trend).
//	             MODERATE conviction → ATM (delta ≈ 0.5, best gamma; the standard
//	                 momentum choice).
//	             OTM is never the default — it is only flagged for a fast scalp on
//	                 an explosive breakout, with a theta warning.
//
// Targets and stops are anchored to live OI walls: a Call targets the call-OI
// resistance / max-pain magnet and stops below put-OI support; a Put mirrors it.

// Trade modes the user can opt into via the multi-select. Each selected mode
// yields its own trade call (when the OI direction supports it).
const (
	ModeOptionBuy   = "option_buy"   // buy CE (bullish) / buy PE (bearish)
	ModeOptionSell  = "option_sell"  // sell PE at support / sell CE at resistance (premium)
	ModeFuturesBuy  = "futures_buy"  // long the future (bullish only)
	ModeFuturesSell = "futures_sell" // short the future (bearish only)
)

// allModes is the default set when the caller specifies none.
var allModes = []string{ModeOptionBuy, ModeOptionSell, ModeFuturesBuy, ModeFuturesSell}

func modeLabel(mode string) string {
	switch mode {
	case ModeOptionBuy:
		return "Option Buy"
	case ModeOptionSell:
		return "Option Sell"
	case ModeFuturesBuy:
		return "Futures Buy"
	case ModeFuturesSell:
		return "Futures Sell"
	}
	return mode
}

// OITradeDecision is one concrete trade call derived from the OI read, for a
// single requested mode (option buy/sell or futures buy/sell).
type OITradeDecision struct {
	Mode       string `json:"mode"`       // option_buy / option_sell / futures_buy / futures_sell
	ModeLabel  string `json:"mode_label"` // human label for the card
	Instrument string `json:"instrument"` // OPTION / FUTURES

	Action     string  `json:"action"`      // "BUY CE" / "SELL PE" / "BUY FUT" / "NO TRADE" / "WAIT"
	OptionType string  `json:"option_type"` // CE / PE ("" when no trade)
	Side       string  `json:"side"`        // BUY / SELL of the premium
	Moneyness  string  `json:"moneyness"`   // ITM / ATM / OTM ("" when no trade)
	Strike     float64 `json:"strike"`      // chosen option strike
	ATMStrike  float64 `json:"atm_strike"`  // nearest at-the-money strike
	StrikeStep float64 `json:"strike_step"` // inferred chain step (Nifty 50, BankNifty 100, …)

	Conviction string  `json:"conviction"`  // STRONG / MODERATE / NONE
	Confidence float64 `json:"confidence"`  // 0..100 (mirrors the pulse confidence)

	Entry      string `json:"entry"`       // entry guidance (underlying terms)
	TargetNote string `json:"target_note"` // target anchored to an OI level
	StopNote   string `json:"stop_note"`   // stop anchored to an OI level

	// ── Risk:reward + position sizing (configurable from the UI) ──
	RR          float64 `json:"rr"`           // configured reward:risk multiple (e.g. 2.0 = 1:2)
	EntryPrice  float64 `json:"entry_price"`  // underlying entry reference (≈ spot)
	StopPrice   float64 `json:"stop_price"`   // underlying stop level (OI wall)
	TargetPrice float64 `json:"target_price"` // underlying target = entry ± RR×risk
	MaxLots     int     `json:"max_lots"`     // user-selected lot cap from the dropdown
	Lots        int     `json:"lots"`         // lots this live call will use (≤ MaxLots)
	Qty         int     `json:"qty"`          // total units = Lots × LotSize
	TotalCost   float64 `json:"total_cost"`   // premium × qty (debit to buy, or credit collected)

	// ── Live tradeable option leg (resolved via Kite when an option trade is live) ──
	// These let the UI show the concrete CE/PE contract side-by-side with the
	// index-level call above. Empty/zero when there is no trade or resolution failed.
	TradingSymbol  string  `json:"tradingsymbol"`   // e.g. NIFTY26JUN23400CE
	OptionExchange string  `json:"option_exchange"` // NFO / BFO
	Expiry         string  `json:"expiry"`          // chosen contract expiry YYYY-MM-DD
	LotSize        int     `json:"lot_size"`        // live contract lot size from Kite
	Premium        float64 `json:"premium"`         // live option LTP at the chosen strike
	CostPerLot     float64 `json:"cost_per_lot"`    // premium × lot size (capital for 1 lot)
	ApproxDelta    float64 `json:"approx_delta"`    // rough delta for the moneyness (premium-move gauge)

	Rationale string   `json:"rationale"` // one-line why
	Notes     []string `json:"notes"`     // moneyness logic, premium alt, cautions
}

// approxDeltaFor returns a rough option delta for the chosen moneyness. It is
// only a gauge so the trader can sense how the premium will move versus the
// underlying (ITM ≈ 0.65, ATM ≈ 0.5, OTM ≈ 0.35).
func approxDeltaFor(moneyness string) float64 {
	switch moneyness {
	case "ITM":
		return 0.65
	case "OTM":
		return 0.35
	default:
		return 0.5
	}
}

// enrichDecisionLeg fills the live, tradeable option contract on the decision so
// the UI can show the concrete CE/PE leg side-by-side with the index-level call.
// It resolves the exact symbol/expiry/lot via Kite, reads the live premium from
// the OI chain rows, and computes per-lot capital. No-op when there is no option
// trade or resolution fails (the index-level call still stands).
func (k *KiteClient) enrichDecisionLeg(appSymbol string, oi *OIAnalysis, d *OITradeDecision) {
	if d == nil || d.OptionType == "" || d.Strike <= 0 {
		return
	}
	leg, err := k.ResolveOption(appSymbol, d.OptionType, d.Strike)
	if err != nil || leg == nil {
		return
	}
	d.Strike = leg.Strike
	d.TradingSymbol = leg.TradingSymbol
	d.OptionExchange = leg.Exchange
	d.Expiry = leg.Expiry
	d.LotSize = leg.LotSize
	d.ApproxDelta = approxDeltaFor(d.Moneyness)

	// Live premium: match the resolved strike in the OI chain rows.
	for _, r := range oi.Rows {
		if math.Abs(r.Strike-leg.Strike) < 1e-6 {
			if d.OptionType == "CE" {
				d.Premium = r.CallLTP
			} else {
				d.Premium = r.PutLTP
			}
			break
		}
	}
	if d.Premium > 0 && d.LotSize > 0 {
		d.CostPerLot = d.Premium * float64(d.LotSize)
	}
	// Position sizing capped by the user's max-lots selection.
	if d.Lots > 0 && d.LotSize > 0 {
		d.Qty = d.Lots * d.LotSize
	}
	if d.Premium > 0 && d.Qty > 0 {
		d.TotalCost = d.Premium * float64(d.Qty)
	}

	d.Notes = append(d.Notes, fmt.Sprintf(
		"Tradeable leg: %s:%s (exp %s), lot %d. Live premium ≈ ₹%.2f → ₹%.0f per lot.",
		leg.Exchange, leg.TradingSymbol, leg.Expiry, leg.LotSize, d.Premium, d.CostPerLot))
	if d.Qty > 0 {
		verb := "Debit to buy"
		if d.Side == "SELL" {
			verb = "Credit collected"
		}
		d.Notes = append(d.Notes, fmt.Sprintf(
			"Sizing: %d lot(s) × %d = %d qty (capped at your %d-lot max). %s ≈ ₹%s.",
			d.Lots, d.LotSize, d.Qty, d.MaxLots, verb, humanINR(d.TotalCost)))
	}
	d.Notes = append(d.Notes, fmt.Sprintf(
		"Index-vs-option: the underlying entry/target/stop above are the spot view; on this %s leg premium moves ≈ ₹%.2f per 1-pt index move (~%.2f delta).",
		d.Moneyness, d.ApproxDelta, d.ApproxDelta))
}

// humanINR formats a rupee amount with Indian-style grouping (no decimals).
func humanINR(v float64) string {
	n := int64(math.Round(v))
	neg := n < 0
	if neg {
		n = -n
	}
	s := fmt.Sprintf("%d", n)
	if len(s) > 3 {
		head := s[:len(s)-3]
		tail := s[len(s)-3:]
		var parts []string
		for len(head) > 2 {
			parts = append([]string{head[len(head)-2:]}, parts...)
			head = head[:len(head)-2]
		}
		parts = append([]string{head}, parts...)
		s = strings.Join(parts, ",") + "," + tail
	}
	if neg {
		s = "-" + s
	}
	return s
}

// applyDirectionalRR sets the numeric entry/stop/target on a directional leg
// (option buy or futures) using the configured reward:risk multiple. The stop is
// the nearest OI wall opposing the trade; the target is entry ± RR × risk. It
// also records the lot cap (the live call uses at most the user-selected lots).
func applyDirectionalRR(d *OITradeDecision, oi *OIAnalysis, bullish bool, step, rr float64, maxLots int) {
	d.RR = rr
	d.MaxLots = maxLots
	d.Lots = maxLots // take at most the user-selected lots
	d.EntryPrice = oi.Spot

	var stop float64
	if bullish {
		stop = oi.Support
		if stop <= 0 || stop >= oi.Spot {
			stop = oi.Spot - 1.5*step
		}
		if risk := d.EntryPrice - stop; risk > 0 {
			d.TargetPrice = d.EntryPrice + rr*risk
		}
	} else {
		stop = oi.Resistance
		if stop <= 0 || stop <= oi.Spot {
			stop = oi.Spot + 1.5*step
		}
		if risk := stop - d.EntryPrice; risk > 0 {
			d.TargetPrice = d.EntryPrice - rr*risk
		}
	}
	d.StopPrice = stop

	if d.TargetPrice > 0 && d.EntryPrice > 0 {
		risk := math.Abs(d.EntryPrice - d.StopPrice)
		d.Notes = append(d.Notes, fmt.Sprintf(
			"R:R 1:%.1f → entry ≈ %.0f, stop %.0f (risk %.0f pts), target %.0f.",
			rr, d.EntryPrice, d.StopPrice, risk, d.TargetPrice))
	}
}

// inferStrikeStep finds the chain's strike interval from the row spacing so the
// decision works across indices (Nifty 50, FinNifty 50, BankNifty 100, Sensex 100).
func inferStrikeStep(rows []OptionChainRow) float64 {
	if len(rows) < 2 {
		return 50
	}
	minGap := math.MaxFloat64
	for i := 1; i < len(rows); i++ {
		g := math.Abs(rows[i].Strike - rows[i-1].Strike)
		if g > 0 && g < minGap {
			minGap = g
		}
	}
	if minGap == math.MaxFloat64 || minGap <= 0 {
		return 50
	}
	return minGap
}

// strikeFor returns the strike for the given option type + moneyness relative to
// ATM. For a Call: ITM is below spot, OTM above. For a Put: ITM is above spot,
// OTM below.
func strikeFor(optType, moneyness string, atm, step float64) float64 {
	switch optType {
	case "CE":
		switch moneyness {
		case "ITM":
			return atm - step
		case "OTM":
			return atm + step
		default:
			return atm
		}
	case "PE":
		switch moneyness {
		case "ITM":
			return atm + step
		case "OTM":
			return atm - step
		default:
			return atm
		}
	}
	return atm
}

// decideOITradeModes builds one trade call per requested mode. Modes the OI
// direction can't support (e.g. futures-buy on a bearish footprint) still return
// a card explaining why they're inactive, so the multi-select maps 1:1 to cards.
func decideOITradeModes(oi *OIAnalysis, signal, regime string, confidence float64, hasPrev bool, modes []string, maxLots int, rr float64) []*OITradeDecision {
	if maxLots < 1 {
		maxLots = 1
	}
	if rr <= 0 {
		rr = 2.0
	}
	want := map[string]bool{}
	for _, m := range modes {
		want[strings.ToLower(strings.TrimSpace(m))] = true
	}
	if len(want) == 0 {
		for _, m := range allModes {
			want[m] = true
		}
	}

	var out []*OITradeDecision
	for _, mode := range allModes { // stable order
		if !want[mode] {
			continue
		}
		var d *OITradeDecision
		switch mode {
		case ModeOptionBuy:
			d = decideOITrade(oi, signal, regime, confidence, hasPrev, maxLots, rr)
		case ModeOptionSell:
			d = decideOptionSell(oi, signal, regime, confidence, hasPrev, maxLots, rr)
		case ModeFuturesBuy:
			d = decideFutures(oi, signal, confidence, hasPrev, "BUY", maxLots, rr)
		case ModeFuturesSell:
			d = decideFutures(oi, signal, confidence, hasPrev, "SELL", maxLots, rr)
		}
		if d != nil {
			// A nil slice marshals to JSON `null`, which crashes the UI when it
			// reads `notes.length`/`.map`. Inactive cards (WAIT / NO TRADE) never
			// append notes, so normalise to an empty slice here.
			if d.Notes == nil {
				d.Notes = []string{}
			}
			out = append(out, d)
		}
	}
	return out
}

// decideOITrade builds the concrete option-BUY call from the OI analysis and the
// pulse signal/regime/confidence.
func decideOITrade(oi *OIAnalysis, signal, regime string, confidence float64, hasPrev bool, maxLots int, rr float64) *OITradeDecision {
	step := inferStrikeStep(oi.Rows)
	atm := step
	if step > 0 {
		atm = math.Round(oi.Spot/step) * step
	}

	d := &OITradeDecision{
		Mode:       ModeOptionBuy,
		ModeLabel:  modeLabel(ModeOptionBuy),
		Instrument: "OPTION",
		ATMStrike:  atm,
		StrikeStep: step,
		Confidence: confidence,
		Side:       "BUY",
		Conviction: "NONE",
	}

	const minConf = 55.0
	const strongConf = 75.0

	if !hasPrev {
		d.Action = "WAIT"
		d.Rationale = "Baseline minute captured — wait one more OI update before committing."
		return d
	}

	if signal == "NEUTRAL" || confidence < minConf {
		d.Action = "NO TRADE"
		d.Rationale = "OI footprint is mixed or weak — no directional edge. Stay flat until a regime forms."
		addRangeAlternative(d, oi, regime)
		return d
	}

	bullish := signal == "BULLISH"
	if bullish {
		d.OptionType = "CE"
	} else {
		d.OptionType = "PE"
	}

	// Conviction → moneyness. A clean fresh buildup at high confidence is the only
	// case that warrants ITM (max delta to ride the trend); otherwise ATM.
	freshTrend := regime == "long_buildup" || regime == "short_buildup"
	switch {
	case confidence >= strongConf && freshTrend:
		d.Conviction = "STRONG"
		d.Moneyness = "ITM"
		d.Notes = append(d.Notes, "Moneyness ITM: strong fresh-buildup trend — ~0.6–0.7 delta and intrinsic value cushion theta while you ride it.")
	case confidence >= strongConf:
		d.Conviction = "STRONG"
		d.Moneyness = "ATM"
		d.Notes = append(d.Notes, "Moneyness ATM: high confidence but not a fresh trend buildup — ATM gives ~0.5 delta and the best gamma.")
	default:
		d.Conviction = "MODERATE"
		d.Moneyness = "ATM"
		d.Notes = append(d.Notes, "Moneyness ATM: moderate conviction — stay at-the-money; avoid OTM (theta/IV decay eats cheap options).")
	}

	d.Strike = strikeFor(d.OptionType, d.Moneyness, atm, step)
	d.Action = fmt.Sprintf("BUY %s %.0f %s", d.OptionType, d.Strike, d.Moneyness)

	// Targets/stops anchored to OI walls.
	if bullish {
		res := oi.Resistance
		if res <= oi.Spot {
			res = atm + 2*step
		}
		d.TargetNote = fmt.Sprintf("Underlying target ≈ call-OI resistance %.0f (then max pain %.0f).", res, oi.MaxPain)
		sup := oi.Support
		if sup >= oi.Spot {
			sup = atm - 1.5*step
		}
		d.StopNote = fmt.Sprintf("Exit if underlying breaks below put-OI support %.0f.", sup)
		d.Entry = fmt.Sprintf("Enter on the next 5m close holding above %.0f; don't chase if spot is already at %.0f.", atm, res)
	} else {
		sup := oi.Support
		if sup >= oi.Spot {
			sup = atm - 2*step
		}
		d.TargetNote = fmt.Sprintf("Underlying target ≈ put-OI support %.0f (then max pain %.0f).", sup, oi.MaxPain)
		res := oi.Resistance
		if res <= oi.Spot {
			res = atm + 1.5*step
		}
		d.StopNote = fmt.Sprintf("Exit if underlying reclaims above call-OI resistance %.0f.", res)
		d.Entry = fmt.Sprintf("Enter on the next 5m close holding below %.0f; don't chase if spot is already at %.0f.", atm, sup)
	}

	d.Rationale = fmt.Sprintf("%s OI footprint → buy %s; %s conviction sets %s strike %.0f.",
		map[bool]string{true: "Bullish", false: "Bearish"}[bullish],
		d.OptionType, d.Conviction, d.Moneyness, d.Strike)

	// Numeric R:R target/stop on the underlying + lot cap.
	applyDirectionalRR(d, oi, bullish, step, rr, maxLots)

	// Caution for the "can fade" regimes.
	if regime == "short_covering" {
		d.Notes = append(d.Notes, "Caution: this leg is short-covering — book quickly if fresh longs don't follow.")
	}
	if regime == "long_unwinding" {
		d.Notes = append(d.Notes, "Caution: this leg is long-unwinding (weak selling) — momentum, not a hard trend; keep size light.")
	}

	addRangeAlternative(d, oi, regime)
	d.Notes = append(d.Notes, "Size per current index lot (verify the live lot size on your broker — NSE rebased index lots in 2026).")
	return d
}

// decideOptionSell builds a premium-SELLING option call: write the OTM option on
// the side OI says price won't breach — sell PE at put-OI support on a bullish/
// supportive footprint, sell CE at call-OI resistance on a bearish one. This is
// the option-seller (theta) mode that consistently profitable writers use.
func decideOptionSell(oi *OIAnalysis, signal, regime string, confidence float64, hasPrev bool, maxLots int, rr float64) *OITradeDecision {
	step := inferStrikeStep(oi.Rows)
	atm := step
	if step > 0 {
		atm = math.Round(oi.Spot/step) * step
	}

	d := &OITradeDecision{
		Mode:       ModeOptionSell,
		ModeLabel:  modeLabel(ModeOptionSell),
		Instrument: "OPTION",
		ATMStrike:  atm,
		StrikeStep: step,
		Confidence: confidence,
		Side:       "SELL",
		Conviction: "NONE",
		Moneyness:  "OTM",
		RR:         rr,
		MaxLots:    maxLots,
	}

	const minConf = 55.0

	if !hasPrev {
		d.Action = "WAIT"
		d.Rationale = "Baseline minute captured — wait one more OI update before writing premium."
		return d
	}
	if signal == "NEUTRAL" || confidence < minConf {
		d.Action = "NO TRADE"
		d.Rationale = "No decisive footprint — writing premium here risks a whipsaw through your short strike."
		return d
	}

	bullish := signal == "BULLISH"
	if bullish {
		// Bullish/supportive → sell the put at the put-OI support wall.
		d.OptionType = "PE"
		sup := oi.Support
		if sup <= 0 || sup >= oi.Spot {
			sup = atm - step
		}
		d.Strike = sup
		d.Conviction = convictionFor(confidence)
		d.Action = fmt.Sprintf("SELL PE %.0f (OTM)", d.Strike)
		d.TargetNote = fmt.Sprintf("Premium decays while spot holds above support %.0f; book at ~50%% of premium.", sup)
		d.StopNote = fmt.Sprintf("Exit/roll if underlying breaks below %.0f (support gives way).", sup)
		d.Entry = fmt.Sprintf("Write the %.0f put while spot stays above it; collect theta into expiry.", sup)
		d.Rationale = fmt.Sprintf("Supportive OI → sell the %.0f put at the put-OI wall to harvest premium.", sup)
	} else {
		// Bearish → sell the call at the call-OI resistance wall.
		d.OptionType = "CE"
		res := oi.Resistance
		if res <= 0 || res <= oi.Spot {
			res = atm + step
		}
		d.Strike = res
		d.Conviction = convictionFor(confidence)
		d.Action = fmt.Sprintf("SELL CE %.0f (OTM)", d.Strike)
		d.TargetNote = fmt.Sprintf("Premium decays while spot stays below resistance %.0f; book at ~50%% of premium.", res)
		d.StopNote = fmt.Sprintf("Exit/roll if underlying reclaims above %.0f (resistance breaks).", res)
		d.Entry = fmt.Sprintf("Write the %.0f call while spot stays below it; collect theta into expiry.", res)
		d.Rationale = fmt.Sprintf("Capping OI → sell the %.0f call at the call-OI wall to harvest premium.", res)
	}

	// Lot cap (premium-sell credit is sized in enrichDecisionLeg once lot size is known).
	d.Lots = maxLots
	d.EntryPrice = oi.Spot
	d.StopPrice = d.Strike // the short strike / wall is the line in the sand
	d.Notes = append(d.Notes, "Option-sell = defined-reward / higher-risk: margin required, losses run if the wall breaks. Pair with a hedge if running naked.")
	return d
}

// decideFutures builds a directional futures call. A futures-buy only fires on a
// bullish footprint and a futures-sell only on a bearish one; otherwise the card
// reports no setup so the user knows that selected mode is idle this minute.
func decideFutures(oi *OIAnalysis, signal string, confidence float64, hasPrev bool, side string, maxLots int, rr float64) *OITradeDecision {
	step := inferStrikeStep(oi.Rows)
	mode := ModeFuturesBuy
	if side == "SELL" {
		mode = ModeFuturesSell
	}

	d := &OITradeDecision{
		Mode:       mode,
		ModeLabel:  modeLabel(mode),
		Instrument: "FUTURES",
		StrikeStep: step,
		Confidence: confidence,
		Side:       side,
		Conviction: "NONE",
		RR:         rr,
		MaxLots:    maxLots,
	}

	const minConf = 55.0

	if !hasPrev {
		d.Action = "WAIT"
		d.Rationale = "Baseline minute captured — wait one more OI update before taking a futures position."
		return d
	}
	if signal == "NEUTRAL" || confidence < minConf {
		d.Action = "NO TRADE"
		d.Rationale = "No directional edge in the OI footprint — stay flat in futures."
		return d
	}

	bullish := signal == "BULLISH"
	if side == "BUY" && !bullish {
		d.Action = "NO TRADE"
		d.Rationale = "Futures-buy needs a bullish OI footprint; current signal is bearish — don't go long here."
		return d
	}
	if side == "SELL" && bullish {
		d.Action = "NO TRADE"
		d.Rationale = "Futures-sell needs a bearish OI footprint; current signal is bullish — don't short here."
		return d
	}

	d.Conviction = convictionFor(confidence)
	if side == "BUY" {
		d.Action = "BUY FUT (long)"
		res := oi.Resistance
		if res <= oi.Spot {
			res = oi.Spot + 2*step
		}
		sup := oi.Support
		if sup >= oi.Spot {
			sup = oi.Spot - 1.5*step
		}
		d.Entry = fmt.Sprintf("Go long the near-month future on a 5m close holding above %.0f.", oi.Spot)
		d.TargetNote = fmt.Sprintf("Target call-OI resistance %.0f (then max pain %.0f).", res, oi.MaxPain)
		d.StopNote = fmt.Sprintf("Stop below put-OI support %.0f.", sup)
		d.Rationale = fmt.Sprintf("Bullish OI footprint → long the future; %s conviction.", d.Conviction)
	} else {
		d.Action = "SELL FUT (short)"
		sup := oi.Support
		if sup >= oi.Spot {
			sup = oi.Spot - 2*step
		}
		res := oi.Resistance
		if res <= oi.Spot {
			res = oi.Spot + 1.5*step
		}
		d.Entry = fmt.Sprintf("Short the near-month future on a 5m close holding below %.0f.", oi.Spot)
		d.TargetNote = fmt.Sprintf("Target put-OI support %.0f (then max pain %.0f).", sup, oi.MaxPain)
		d.StopNote = fmt.Sprintf("Stop above call-OI resistance %.0f.", res)
		d.Rationale = fmt.Sprintf("Bearish OI footprint → short the future; %s conviction.", d.Conviction)
	}
	// Numeric R:R target/stop on the underlying + lot cap.
	applyDirectionalRR(d, oi, bullish, step, rr, maxLots)
	d.Notes = append(d.Notes, "Futures = full directional exposure (no theta, but mark-to-market margin and overnight gap risk). Keep a hard stop.")
	d.Notes = append(d.Notes, fmt.Sprintf("Take at most %d future lot(s) (your cap). Verify the live future lot size on your broker — NSE rebased index lots in 2026.", maxLots))
	return d
}

// convictionFor maps a confidence score to a conviction label.
func convictionFor(confidence float64) string {
	if confidence >= 75 {
		return "STRONG"
	}
	return "MODERATE"
}

// addRangeAlternative appends the premium-selling alternative used by income
// traders when the regime is range-bound: sell the option at the heavy OI wall
// that price is unlikely to breach (put wall = support, call wall = resistance).
func addRangeAlternative(d *OITradeDecision, oi *OIAnalysis, regime string) {
	if oi.Support <= 0 && oi.Resistance <= 0 {
		return
	}
	switch regime {
	case "short_covering", "flat":
		if oi.Support > 0 {
			d.Notes = append(d.Notes, fmt.Sprintf("Premium alt: SELL PE at support %.0f (OTM put) to collect theta while support holds.", oi.Support))
		}
	case "long_unwinding":
		if oi.Resistance > 0 {
			d.Notes = append(d.Notes, fmt.Sprintf("Premium alt: SELL CE at resistance %.0f (OTM call) to collect theta while resistance caps.", oi.Resistance))
		}
	}
}
