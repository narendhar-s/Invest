package strategy

// ═══════════════════════════════════════════════════════════════════════════
//  NIFTY EXPIRY DAY STRATEGY ENGINE
//
//  Produces live, time-aware trade suggestions for every Tuesday expiry (NIFTY, June 2026+).
//
//  Setups generated (based on live NSE option chain):
//    1. Iron Fly       — Sell ATM straddle, buy ±100pt wings  (primary)
//    2. Short Straddle — Sell ATM CE + PE, no hedge           (aggressive)
//    3. ORB CE/PE Buy  — Opening Range Breakout gamma play    (directional)
//    4. Max Pain Play  — Directional CE/PE buy toward max pain (momentum)
//
//  For each leg the engine outputs:
//    • Live LTP, suggested entry, target, stop
//    • P&L per lot (₹) and for 1/2/5 lots
//    • Breakeven levels on spot
//    • Time phase: IDEAL | GOOD | LATE | AVOID
// ═══════════════════════════════════════════════════════════════════════════

import (
	"fmt"
	"math"
	"time"

	"stockwise/internal/naren/nifty"
)

const (
	niftyLotSize  = 75
	ironFlyWidth  = 100.0 // pts each side for Iron Fly wings
	strikePitch   = 50.0
)

// ─── Types ────────────────────────────────────────────────────────────────────

type ExpiryLeg struct {
	Action     string  `json:"action"`      // BUY | SELL
	OptionType string  `json:"option_type"` // CE | PE
	Strike     float64 `json:"strike"`
	LTP        float64 `json:"ltp"`           // current live premium
	EntryPrice float64 `json:"entry_price"`   // suggested entry
	Target     float64 `json:"target"`        // premium target (for buy legs)
	Stop       float64 `json:"stop"`          // premium stop
	LotSize    int     `json:"lot_size"`
	IV         float64 `json:"iv"`
	OI         float64 `json:"oi"`
	PnLTarget  float64 `json:"pnl_target"`  // ₹ per lot at target
	PnLStop    float64 `json:"pnl_stop"`    // ₹ per lot at stop (negative = loss)
	Label      string  `json:"label"`       // ATM | OTM+1 | OTM+2 | WING
	Direction  string  `json:"direction"`   // BULL | BEAR (for buy legs only)
}

type ExpirySetup struct {
	Name          string      `json:"name"`
	Type          string      `json:"type"`          // SPREAD | STRADDLE | DIRECTIONAL
	Side          string      `json:"side"`          // SELL_PREMIUM | BUY_PREMIUM
	Description   string      `json:"description"`
	Legs          []ExpiryLeg `json:"legs"`
	NetPremium    float64     `json:"net_premium"`     // collected (+) or paid (-)
	MaxProfit     float64     `json:"max_profit_inr"`  // ₹ per set (1 lot each leg)
	MaxLoss       float64     `json:"max_loss_inr"`    // ₹ per set
	BreakevenUp   float64     `json:"breakeven_up"`    // spot level
	BreakevenDown float64     `json:"breakeven_down"`  // spot level
	RiskReward    float64     `json:"risk_reward"`
	Confidence    int         `json:"confidence"`
	Phase         string      `json:"phase"`     // IDEAL | GOOD | LATE | AVOID
	PhaseReason   string      `json:"phase_reason"`
	Rules         []string    `json:"rules"`
	PnLScenarios  []PnLScenario `json:"pnl_scenarios"`
	Priority      int         `json:"priority"` // 1 = best setup right now
}

type PnLScenario struct {
	Label     string  `json:"label"`     // "At target", "Breakeven", "At stop"
	SpotMove  string  `json:"spot_move"` // "+50 pts", "-100 pts"
	PnLINR    float64 `json:"pnl_inr"`   // ₹ per set
	PnLPct    float64 `json:"pnl_pct"`   // % on margin
}

type ORBState struct {
	Active    bool    `json:"active"`
	HighLevel float64 `json:"high_level"`
	LowLevel  float64 `json:"low_level"`
	RangeSize float64 `json:"range_size"`
	Status    string  `json:"status"` // WAITING | LONG_TRIGGER | SHORT_TRIGGER | EXPIRED
}

type ExpiryDaySignal struct {
	IsExpiryDay   bool          `json:"is_expiry_day"`
	ExpiryType    string        `json:"expiry_type"`   // WEEKLY | MONTHLY | NOT_EXPIRY
	DaysToExpiry  int           `json:"days_to_expiry"`
	NextExpiry    string        `json:"next_expiry"`
	SpotPrice     float64       `json:"spot_price"`
	ATMStrike     float64       `json:"atm_strike"`
	MaxPainStrike float64       `json:"max_pain_strike"`
	SpotVsMaxPain float64       `json:"spot_vs_max_pain"` // pts difference
	VIX           float64       `json:"vix"`
	PCR           float64       `json:"pcr"`
	Sentiment     string        `json:"market_sentiment"`
	TimePhase     string        `json:"time_phase"`
	TimePhaseDesc string        `json:"time_phase_desc"`
	MinutesToClose int          `json:"minutes_to_close"` // until 15:15
	ORB           ORBState      `json:"orb"`
	Setups        []ExpirySetup `json:"setups"`
	Warnings      []string      `json:"warnings"`
	Summary       string        `json:"summary"`
	GeneratedAt   string        `json:"generated_at"`
}

// ─── Engine entry point ───────────────────────────────────────────────────────

var nseClient = nifty.NewNSEClient()

func (e *Engine) ExpiryDaySignal() (*ExpiryDaySignal, error) {
	now := time.Now().In(ist())

	chain, err := nseClient.FetchOptionChain("")
	vix := nseClient.FetchVIX()

	if err != nil || chain == nil {
		return &ExpiryDaySignal{
			IsExpiryDay: isExpiryDay(now),
			GeneratedAt: now.Format(time.RFC3339),
			Warnings:    []string{"Could not fetch live option chain — using estimated data"},
		}, nil
	}

	sig := buildExpirySignal(chain, vix, now)
	return sig, nil
}

func ist() *time.Location {
	loc, _ := time.LoadLocation("Asia/Kolkata")
	if loc == nil {
		return time.UTC
	}
	return loc
}

// ─── Core builder ─────────────────────────────────────────────────────────────

func buildExpirySignal(chain *nifty.OptionChainData, vix float64, now time.Time) *ExpiryDaySignal {
	phase, phaseDesc := timePhase(now)
	isExpiry := isExpiryDay(now)
	expiryType := "NOT_EXPIRY"
	if isExpiry {
		expiryType = "WEEKLY"
		if isMonthlyExpiry(now) {
			expiryType = "MONTHLY"
		}
	}

	nextExp := chain.SelectedExpiry
	daysToExpiry := daysUntilThursday(now)

	spot := chain.SpotPrice
	atm := chain.ATMStrike
	maxPain := chain.MaxPainStrike

	sig := &ExpiryDaySignal{
		IsExpiryDay:   isExpiry,
		ExpiryType:    expiryType,
		DaysToExpiry:  daysToExpiry,
		NextExpiry:    nextExp,
		SpotPrice:     spot,
		ATMStrike:     atm,
		MaxPainStrike: maxPain,
		SpotVsMaxPain: math.Round((spot-maxPain)*100) / 100,
		VIX:           vix,
		PCR:           chain.PCR,
		Sentiment:     chain.MarketSentiment,
		TimePhase:     phase,
		TimePhaseDesc: phaseDesc,
		MinutesToClose: minutesUntilClose(now),
		ORB:           buildORB(chain, now),
		GeneratedAt:   now.Format(time.RFC3339),
	}

	// Build setups
	setups := []ExpirySetup{}

	if isExpiry || daysToExpiry <= 1 {
		// Iron Fly (primary seller setup)
		if fly := buildIronFly(chain, phase); fly != nil {
			setups = append(setups, *fly)
		}
		// Short Straddle (aggressive)
		if strangle := buildShortStraddle(chain, phase); strangle != nil {
			setups = append(setups, *strangle)
		}
	}

	// Max Pain directional play (always show)
	if mp := buildMaxPainPlay(chain, phase); mp != nil {
		setups = append(setups, *mp)
	}

	// ORB breakout buy (only in ORB window)
	if orb := buildORBSetup(chain, phase, now); orb != nil {
		setups = append(setups, *orb)
	}

	// Assign priority
	for i := range setups {
		setups[i].Priority = i + 1
	}
	sig.Setups = setups
	sig.Warnings = buildWarnings(chain, vix, phase, isExpiry, now)
	sig.Summary = buildSummary(sig)
	return sig
}

// ─── Setup builders ───────────────────────────────────────────────────────────

func buildIronFly(chain *nifty.OptionChainData, phase string) *ExpirySetup {
	atm := chain.ATMStrike
	spot := chain.SpotPrice

	atmCE := findOption(chain, atm, "CE")
	atmPE := findOption(chain, atm, "PE")
	wingCE := findOption(chain, atm+ironFlyWidth, "CE")
	wingPE := findOption(chain, atm-ironFlyWidth, "PE")

	if atmCE == nil || atmPE == nil || wingCE == nil || wingPE == nil {
		return nil
	}

	// Net premium collected = sell ATM - buy wings
	netPremium := (atmCE.LastPrice + atmPE.LastPrice) - (wingCE.LastPrice + wingPE.LastPrice)
	if netPremium <= 0 {
		netPremium = (atmCE.LastPrice + atmPE.LastPrice) * 0.7 // estimate
	}

	maxProfit := netPremium * float64(niftyLotSize)
	maxLoss := (ironFlyWidth - netPremium) * float64(niftyLotSize)
	breakevenUp := atm + netPremium
	breakevenDown := atm - netPremium

	// 50% profit target
	targetPremium := netPremium * 0.5
	targetProfitINR := targetPremium * float64(niftyLotSize)
	stopLossINR := maxLoss * 0.6 // stop at 60% of max loss

	setupPhase, phaseReason := flyPhase(phase, spot, atm, chain.MaxPainStrike)

	legs := []ExpiryLeg{
		makeLeg("SELL", "CE", atm, atmCE.LastPrice, 0, 0, atmCE.ImpliedVolatility, atmCE.OpenInterest, "ATM"),
		makeLeg("SELL", "PE", atm, atmPE.LastPrice, 0, 0, atmPE.ImpliedVolatility, atmPE.OpenInterest, "ATM"),
		makeLeg("BUY", "CE", atm+ironFlyWidth, wingCE.LastPrice, 0, 0, wingCE.ImpliedVolatility, wingCE.OpenInterest, "WING"),
		makeLeg("BUY", "PE", atm-ironFlyWidth, wingPE.LastPrice, 0, 0, wingPE.ImpliedVolatility, wingPE.OpenInterest, "WING"),
	}

	// Compute per-leg P&L
	for i, l := range legs {
		if l.Action == "SELL" {
			legs[i].PnLTarget = l.LTP * 0.5 * float64(niftyLotSize)  // 50% decay = profit
			legs[i].PnLStop = -l.LTP * 1.0 * float64(niftyLotSize)   // doubles = loss
		} else {
			legs[i].PnLTarget = -l.LTP * float64(niftyLotSize) // wings expire worthless
			legs[i].PnLStop = 0
		}
	}

	scenarios := []PnLScenario{
		{Label: "Max profit (spot pins ATM)", SpotMove: "0 pts", PnLINR: maxProfit, PnLPct: p2(maxProfit / (ironFlyWidth * float64(niftyLotSize)) * 100)},
		{Label: "50% target hit", SpotMove: "±" + fmt.Sprintf("%.0f", netPremium*0.3) + " pts", PnLINR: p2(targetProfitINR), PnLPct: p2(targetProfitINR / (ironFlyWidth * float64(niftyLotSize)) * 100)},
		{Label: "Breakeven", SpotMove: fmt.Sprintf("±%.0f pts", netPremium), PnLINR: 0, PnLPct: 0},
		{Label: "Max loss (spot at wing)", SpotMove: fmt.Sprintf("±%.0f pts", ironFlyWidth), PnLINR: -maxLoss, PnLPct: -p2(maxLoss / (ironFlyWidth * float64(niftyLotSize)) * 100)},
	}

	return &ExpirySetup{
		Name:          "Iron Fly",
		Type:          "SPREAD",
		Side:          "SELL_PREMIUM",
		Description:   fmt.Sprintf("Sell %g ATM straddle, buy %g/%g wings. Net credit: %.1f pts. Theta works for you.", atm, atm+ironFlyWidth, atm-ironFlyWidth, netPremium),
		Legs:          legs,
		NetPremium:    p2(netPremium),
		MaxProfit:     p2(maxProfit),
		MaxLoss:       p2(maxLoss),
		BreakevenUp:   p2(breakevenUp),
		BreakevenDown: p2(breakevenDown),
		RiskReward:    p2(maxLoss / maxProfit),
		Confidence:    flyConfidence(phase, chain.PCR),
		Phase:         setupPhase,
		PhaseReason:   phaseReason,
		Rules: []string{
			fmt.Sprintf("Enter between 9:30–11:00 AM when VIX is stable"),
			fmt.Sprintf("Exit at 50%% profit (₹%.0f collected)", targetProfitINR),
			fmt.Sprintf("Stop if spot breaches %.0f or %.0f (± %.0f pts from ATM)", breakevenDown-20, breakevenUp+20, netPremium+20),
			"Hard exit at 3:00 PM regardless of P&L",
			fmt.Sprintf("Max loss per set: ₹%.0f — do NOT let it exceed this", stopLossINR),
		},
		PnLScenarios: scenarios,
	}
}

func buildShortStraddle(chain *nifty.OptionChainData, phase string) *ExpirySetup {
	atm := chain.ATMStrike

	atmCE := findOption(chain, atm, "CE")
	atmPE := findOption(chain, atm, "PE")
	if atmCE == nil || atmPE == nil {
		return nil
	}

	totalPremium := atmCE.LastPrice + atmPE.LastPrice
	maxProfit := totalPremium * float64(niftyLotSize)
	breakevenUp := atm + totalPremium
	breakevenDown := atm - totalPremium

	setupPhase := "GOOD"
	if phase == "AVOID" || phase == "CLOSE" {
		setupPhase = "AVOID"
	} else if phase == "ORB_WINDOW" || phase == "PRE_OPEN" {
		setupPhase = "LATE"
	}

	legs := []ExpiryLeg{
		makeLeg("SELL", "CE", atm, atmCE.LastPrice, 0, 0, atmCE.ImpliedVolatility, atmCE.OpenInterest, "ATM"),
		makeLeg("SELL", "PE", atm, atmPE.LastPrice, 0, 0, atmPE.ImpliedVolatility, atmPE.OpenInterest, "ATM"),
	}

	scenarios := []PnLScenario{
		{Label: "Max profit (pins ATM)", SpotMove: "0 pts", PnLINR: p2(maxProfit), PnLPct: p2(maxProfit / (totalPremium * 2 * float64(niftyLotSize)) * 100)},
		{Label: "50% profit target", SpotMove: "±minimal", PnLINR: p2(maxProfit * 0.5), PnLPct: 50},
		{Label: "Breakeven up", SpotMove: fmt.Sprintf("+%.0f pts", totalPremium), PnLINR: 0, PnLPct: 0},
		{Label: "Breakeven down", SpotMove: fmt.Sprintf("-%.0f pts", totalPremium), PnLINR: 0, PnLPct: 0},
		{Label: "Big move (1.5% spot)", SpotMove: fmt.Sprintf("±%.0f pts", chain.SpotPrice*0.015), PnLINR: p2(-chain.SpotPrice * 0.005 * float64(niftyLotSize)), PnLPct: -30},
	}

	return &ExpirySetup{
		Name:          "Short Straddle",
		Type:          "STRADDLE",
		Side:          "SELL_PREMIUM",
		Description:   fmt.Sprintf("Sell %g CE + %g PE. Collect %.1f pts total. UNLIMITED RISK — use only with hedge or active management.", atm, atm, totalPremium),
		Legs:          legs,
		NetPremium:    p2(totalPremium),
		MaxProfit:     p2(maxProfit),
		MaxLoss:       -1, // unlimited
		BreakevenUp:   p2(breakevenUp),
		BreakevenDown: p2(breakevenDown),
		RiskReward:    0, // unlimited risk
		Confidence:    55,
		Phase:         setupPhase,
		PhaseReason:   "Best in 10:00–12:00 window when IV starts to crush",
		Rules: []string{
			"⚠️ UNLIMITED RISK — only for experienced traders",
			"Exit at 50% of premium collected",
			fmt.Sprintf("Convert to Iron Fly if spot moves >%.0f pts from ATM", totalPremium*0.5),
			"Stop: adjust if either leg doubles",
			"Hard exit at 2:30 PM",
		},
		PnLScenarios: scenarios,
	}
}

func buildMaxPainPlay(chain *nifty.OptionChainData, phase string) *ExpirySetup {
	spot := chain.SpotPrice
	maxPain := chain.MaxPainStrike
	diff := maxPain - spot

	if math.Abs(diff) < 30 {
		return nil // spot already near max pain, no directional edge
	}

	var dir, optType string
	var targetStrike float64

	if diff > 0 {
		// spot below max pain → bullish bias, buy CE
		dir = "BULL"
		optType = "CE"
		targetStrike = chain.ATMStrike + strikePitch // OTM+1 CE
	} else {
		// spot above max pain → bearish bias, buy PE
		dir = "BEAR"
		optType = "PE"
		targetStrike = chain.ATMStrike - strikePitch // OTM+1 PE
	}

	opt := findOption(chain, targetStrike, optType)
	if opt == nil {
		opt = findOption(chain, chain.ATMStrike, optType)
	}
	if opt == nil {
		return nil
	}

	ltp := opt.LastPrice
	if ltp < 5 {
		ltp = 5
	}
	entry := ltp
	target := p2(entry * 1.6) // +60% premium target
	stop := p2(entry * 0.65)  // –35% stop

	profitPerLot := (target - entry) * float64(niftyLotSize)
	lossPerLot := (stop - entry) * float64(niftyLotSize)

	setupPhase := "GOOD"
	if phase == "AVOID" || phase == "CLOSE" {
		setupPhase = "AVOID"
	} else if math.Abs(diff) > 150 {
		setupPhase = "IDEAL"
	}

	label := "OTM+1"
	dirLabel := "Bullish"
	if dir == "BEAR" {
		dirLabel = "Bearish"
	}

	legs := []ExpiryLeg{{
		Action:     "BUY",
		OptionType: optType,
		Strike:     targetStrike,
		LTP:        p2(ltp),
		EntryPrice: p2(entry),
		Target:     p2(target),
		Stop:       p2(stop),
		LotSize:    niftyLotSize,
		IV:         opt.ImpliedVolatility,
		OI:         opt.OpenInterest,
		PnLTarget:  p2(profitPerLot),
		PnLStop:    p2(lossPerLot),
		Label:      label,
		Direction:  dir,
	}}

	scenarios := []PnLScenario{
		{Label: fmt.Sprintf("Target hit (+60%% premium)"), SpotMove: fmt.Sprintf("%+.0f pts toward max pain", diff*0.6), PnLINR: p2(profitPerLot), PnLPct: 60},
		{Label: "Breakeven", SpotMove: "0 pts", PnLINR: 0, PnLPct: 0},
		{Label: "Stop hit (–35% premium)", SpotMove: "Wrong direction", PnLINR: p2(lossPerLot), PnLPct: -35},
	}

	return &ExpirySetup{
		Name:          fmt.Sprintf("Max Pain %s Play", dirLabel),
		Type:          "DIRECTIONAL",
		Side:          "BUY_PREMIUM",
		Description:   fmt.Sprintf("Spot (%.0f) is %.0f pts %s max pain (%.0f). Market tends to gravitate toward max pain on expiry. Buy %g %s.", spot, math.Abs(diff), map[string]string{"BULL": "below", "BEAR": "above"}[dir], maxPain, targetStrike, optType),
		Legs:          legs,
		NetPremium:    -p2(entry),
		MaxProfit:     p2(profitPerLot),
		MaxLoss:       p2(math.Abs(lossPerLot)),
		BreakevenUp:   p2(spot + entry),
		BreakevenDown: p2(spot - entry),
		RiskReward:    p2(profitPerLot / math.Abs(lossPerLot)),
		Confidence:    maxPainConfidence(diff, chain.PCR, dir),
		Phase:         setupPhase,
		PhaseReason:   "Strongest in 10:00–13:00 when max pain pull is active",
		Rules: []string{
			fmt.Sprintf("Buy %g %s at market (LTP: ₹%.1f)", targetStrike, optType, ltp),
			fmt.Sprintf("Target: ₹%.1f (%.0f%% gain, ₹%.0f/lot)", target, 60.0, profitPerLot),
			fmt.Sprintf("Stop: ₹%.1f (%.0f%% loss, ₹%.0f/lot)", stop, 35.0, math.Abs(lossPerLot)),
			"Exit by 1:30 PM if target not hit (theta destroys value)",
			fmt.Sprintf("Spot must stay %s of %.0f for this trade to work", map[string]string{"BULL": "above", "BEAR": "below"}[dir], spot),
		},
		PnLScenarios: scenarios,
	}
}

func buildORBSetup(chain *nifty.OptionChainData, phase string, now time.Time) *ExpirySetup {
	if phase != "ORB_WINDOW" && phase != "PRIME_TIME" {
		return nil
	}

	spot := chain.SpotPrice
	atm := chain.ATMStrike

	// Use 0.4% of spot as proxy for OR range (typical first 15-min range)
	orRange := spot * 0.004
	orHigh := spot + orRange
	orLow := spot - orRange

	// OTM+1 for ORB (higher gamma, lower cost)
	ceStrike := atm + strikePitch
	peStrike := atm - strikePitch

	ceOpt := findOption(chain, ceStrike, "CE")
	peOpt := findOption(chain, peStrike, "PE")
	if ceOpt == nil || peOpt == nil {
		return nil
	}

	ceLTP := math.Max(ceOpt.LastPrice, 5)
	peLTP := math.Max(peOpt.LastPrice, 5)
	ceTarget := p2(ceLTP * 2.0) // 100% gain on gamma burst
	ceStop := p2(ceLTP * 0.60)
	peTarget := p2(peLTP * 2.0)
	peStop := p2(peLTP * 0.60)

	ceProfitLot := (ceTarget - ceLTP) * float64(niftyLotSize)
	ceLossLot := (ceStop - ceLTP) * float64(niftyLotSize)
	peProfitLot := (peTarget - peLTP) * float64(niftyLotSize)
	peLossLot := (peStop - peLTP) * float64(niftyLotSize)

	setupPhase := "IDEAL"
	if phase == "PRIME_TIME" {
		setupPhase = "GOOD"
	}

	legs := []ExpiryLeg{
		{
			Action: "BUY", OptionType: "CE", Strike: ceStrike,
			LTP: p2(ceLTP), EntryPrice: p2(ceLTP), Target: ceTarget, Stop: ceStop,
			LotSize: niftyLotSize, IV: ceOpt.ImpliedVolatility, OI: ceOpt.OpenInterest,
			PnLTarget: p2(ceProfitLot), PnLStop: p2(ceLossLot), Label: "OTM+1", Direction: "BULL",
		},
		{
			Action: "BUY", OptionType: "PE", Strike: peStrike,
			LTP: p2(peLTP), EntryPrice: p2(peLTP), Target: peTarget, Stop: peStop,
			LotSize: niftyLotSize, IV: peOpt.ImpliedVolatility, OI: peOpt.OpenInterest,
			PnLTarget: p2(peProfitLot), PnLStop: p2(peLossLot), Label: "OTM+1", Direction: "BEAR",
		},
	}

	scenarios := []PnLScenario{
		{Label: "CE target (breakout up)", SpotMove: fmt.Sprintf("+%.0f pts", orRange*2), PnLINR: p2(ceProfitLot), PnLPct: 100},
		{Label: "PE target (breakout down)", SpotMove: fmt.Sprintf("-%.0f pts", orRange*2), PnLINR: p2(peProfitLot), PnLPct: 100},
		{Label: "Both stopped out (choppy)", SpotMove: "Sideways", PnLINR: p2(ceLossLot + peLossLot), PnLPct: -40},
	}

	return &ExpirySetup{
		Name:          "ORB Gamma Buy",
		Type:          "DIRECTIONAL",
		Side:          "BUY_PREMIUM",
		Description:   fmt.Sprintf("First 15-min range: %.0f – %.0f. Buy OTM CE on breakout above %.0f OR OTM PE on breakdown below %.0f. High gamma = explosive moves.", orLow, orHigh, orHigh, orLow),
		Legs:          legs,
		NetPremium:    -p2(ceLTP + peLTP),
		MaxProfit:     p2(math.Max(ceProfitLot, peProfitLot)),
		MaxLoss:       p2(math.Abs(ceLossLot) + math.Abs(peLossLot)),
		BreakevenUp:   p2(orHigh + ceLTP),
		BreakevenDown: p2(orLow - peLTP),
		RiskReward:    p2(math.Max(ceProfitLot, peProfitLot) / math.Abs(ceLossLot+peLossLot)),
		Confidence:    62,
		Phase:         setupPhase,
		PhaseReason:   "Only trade CE if price breaks above OR high, or PE if breaks below OR low. Never both.",
		Rules: []string{
			fmt.Sprintf("Wait for breakout: CE above %.0f OR PE below %.0f", orHigh, orLow),
			"Do NOT enter both legs — pick direction on breakout only",
			fmt.Sprintf("CE entry: %.0f CE @ ₹%.1f | Target ₹%.1f | Stop ₹%.1f", ceStrike, ceLTP, ceTarget, ceStop),
			fmt.Sprintf("PE entry: %.0f PE @ ₹%.1f | Target ₹%.1f | Stop ₹%.1f", peStrike, peLTP, peTarget, peStop),
			"Exit by 11:30 AM if no breakout — theta kills value after that",
		},
		PnLScenarios: scenarios,
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func findOption(chain *nifty.OptionChainData, strike float64, optType string) *nifty.OptionData {
	for _, row := range chain.Rows {
		if row.StrikePrice == strike {
			if optType == "CE" {
				return &row.CE
			}
			return &row.PE
		}
	}
	return nil
}

func makeLeg(action, optType string, strike, ltp, target, stop, iv, oi float64, label string) ExpiryLeg {
	return ExpiryLeg{
		Action:     action,
		OptionType: optType,
		Strike:     strike,
		LTP:        p2(ltp),
		EntryPrice: p2(ltp),
		Target:     p2(target),
		Stop:       p2(stop),
		LotSize:    niftyLotSize,
		IV:         p2(iv),
		OI:         p2(oi),
		Label:      label,
	}
}

func timePhase(now time.Time) (phase, desc string) {
	h, m := now.Hour(), now.Minute()
	total := h*60 + m
	switch {
	case total < 9*60+15:
		return "PRE_OPEN", "Pre-market — observe, no trades"
	case total < 9*60+30:
		return "ORB_WINDOW", "First 15 min — identify opening range for ORB setup"
	case total < 11*60+30:
		return "PRIME_TIME", "Best window — all setups valid"
	case total < 13*60+0:
		return "GOOD_TIME", "Good time — Iron Fly and Max Pain plays still valid"
	case total < 14*60+0:
		return "LATE", "Late session — target 50% profit, no new positions"
	case total < 15*60+15:
		return "AVOID", "Final hour — only close existing positions"
	default:
		return "CLOSE", "Market closed"
	}
}

func minutesUntilClose(now time.Time) int {
	closeTime := time.Date(now.Year(), now.Month(), now.Day(), 15, 15, 0, 0, now.Location())
	d := int(closeTime.Sub(now).Minutes())
	if d < 0 {
		return 0
	}
	return d
}

// niftyExpiryWeekday is Tuesday from June 2026 onwards.
const niftyExpiryWeekday = time.Tuesday

func isExpiryDay(now time.Time) bool {
	return now.Weekday() == niftyExpiryWeekday
}

func isMonthlyExpiry(now time.Time) bool {
	// Last Tuesday of month
	next := now.AddDate(0, 0, 7)
	return next.Month() != now.Month()
}

func daysUntilThursday(now time.Time) int {
	d := (int(niftyExpiryWeekday) - int(now.Weekday()) + 7) % 7
	if d == 0 && now.Hour() >= 15 {
		d = 7
	}
	return d
}

func buildORB(chain *nifty.OptionChainData, now time.Time) ORBState {
	spot := chain.SpotPrice
	orRange := spot * 0.004
	return ORBState{
		Active:    now.Hour() == 9 && now.Minute() < 30,
		HighLevel: p2(spot + orRange),
		LowLevel:  p2(spot - orRange),
		RangeSize: p2(orRange * 2),
		Status:    "WAITING",
	}
}

func flyPhase(phase string, spot, atm, maxPain float64) (string, string) {
	distFromATM := math.Abs(spot - atm)
	switch {
	case phase == "PRIME_TIME" && distFromATM < 50:
		return "IDEAL", "Spot near ATM — maximum theta collection"
	case phase == "PRIME_TIME" || phase == "GOOD_TIME":
		return "GOOD", "Good time window for Iron Fly"
	case phase == "ORB_WINDOW":
		return "LATE", "Wait for opening range to settle (9:30 AM)"
	case phase == "LATE":
		return "LATE", "Only manage open Iron Fly positions"
	default:
		return "AVOID", "Too early or too late for new Iron Fly"
	}
}

func flyConfidence(phase string, pcr float64) int {
	base := 72
	if phase == "PRIME_TIME" {
		base += 5
	}
	if pcr >= 1.1 && pcr <= 1.4 {
		base += 3 // neutral PCR = good for delta-neutral
	}
	if base > 85 {
		base = 85
	}
	return base
}

func maxPainConfidence(diff, pcr float64, dir string) int {
	base := 58
	if math.Abs(diff) > 100 {
		base += 8
	}
	if math.Abs(diff) > 200 {
		base += 5
	}
	if dir == "BULL" && pcr > 1.2 {
		base += 5
	}
	if dir == "BEAR" && pcr < 0.9 {
		base += 5
	}
	if base > 82 {
		base = 82
	}
	return base
}

func buildWarnings(chain *nifty.OptionChainData, vix float64, phase string, isExpiry bool, now time.Time) []string {
	var w []string
	if !isExpiry {
		w = append(w, fmt.Sprintf("⚠️ Today is NOT expiry day. Next NIFTY expiry (Tuesday): %s (%d days away)", chain.SelectedExpiry, daysUntilThursday(now)))
	}
	if vix > 20 {
		w = append(w, fmt.Sprintf("⚠️ VIX is HIGH (%.1f) — avoid selling premium, premiums are elevated but big moves possible", vix))
	}
	if vix < 11 {
		w = append(w, fmt.Sprintf("⚠️ VIX is very LOW (%.1f) — premiums are thin, Iron Fly credit will be small", vix))
	}
	if phase == "AVOID" || phase == "CLOSE" {
		w = append(w, "⛔ After 2:00 PM — do NOT enter new positions. Only close/manage existing ones.")
	}
	if chain.PCR > 1.5 {
		w = append(w, fmt.Sprintf("⚠️ PCR extremely high (%.2f) — market may be overly put-heavy, reversal risk", chain.PCR))
	}
	if chain.PCR < 0.6 {
		w = append(w, fmt.Sprintf("⚠️ PCR very low (%.2f) — market may be overly call-heavy, sharp selloff risk", chain.PCR))
	}
	spotDiff := math.Abs(chain.SpotPrice - chain.MaxPainStrike)
	if spotDiff > 300 {
		w = append(w, fmt.Sprintf("⚠️ Spot (%.0f) is far from max pain (%.0f) — expect large intraday move toward %.0f", chain.SpotPrice, chain.MaxPainStrike, chain.MaxPainStrike))
	}
	return w
}

func buildSummary(sig *ExpiryDaySignal) string {
	if !sig.IsExpiryDay {
		return fmt.Sprintf("Next %s expiry in %d days. Max pain at %.0f. Pre-trade planning mode.", sig.ExpiryType, sig.DaysToExpiry, sig.MaxPainStrike)
	}
	direction := "Neutral"
	if sig.SpotVsMaxPain > 50 {
		direction = "Bearish (spot above max pain, expect pull-down)"
	} else if sig.SpotVsMaxPain < -50 {
		direction = "Bullish (spot below max pain, expect push-up)"
	}
	return fmt.Sprintf("EXPIRY DAY — %s. Spot %.0f vs Max Pain %.0f (%s). %s. VIX %.1f. %d mins to close.",
		sig.ExpiryType, sig.SpotPrice, sig.MaxPainStrike, direction, sig.TimePhaseDesc, sig.VIX, sig.MinutesToClose)
}

func p2(v float64) float64 {
	if math.IsInf(v, 0) || math.IsNaN(v) {
		return 0
	}
	return math.Round(v*100) / 100
}
