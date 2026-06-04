package data

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ─── Index registry ───────────────────────────────────────────────────────────
//
// Maps app-facing index symbols (Yahoo-style ^NSEI or friendly NIFTY) to the
// Kite spot tradingsymbol, the F&O underlying "name", and the options exchange.

type indexInfo struct {
	Spot     string // Kite spot tradingsymbol, e.g. "NIFTY 50"
	SpotExch string // spot exchange, e.g. "NSE" / "BSE"
	FNOName  string // F&O underlying name, e.g. "NIFTY"
	OptExch  string // options exchange, e.g. "NFO" / "BFO"
}

var indexRegistry = map[string]indexInfo{
	"^NSEI":     {"NIFTY 50", "NSE", "NIFTY", "NFO"},
	"NIFTY":     {"NIFTY 50", "NSE", "NIFTY", "NFO"},
	"NIFTY50":   {"NIFTY 50", "NSE", "NIFTY", "NFO"},
	"^NSEBANK":  {"NIFTY BANK", "NSE", "BANKNIFTY", "NFO"},
	"BANKNIFTY": {"NIFTY BANK", "NSE", "BANKNIFTY", "NFO"},
	"FINNIFTY":  {"NIFTY FIN SERVICE", "NSE", "FINNIFTY", "NFO"},
	"^NSEFIN":   {"NIFTY FIN SERVICE", "NSE", "FINNIFTY", "NFO"},
	"SENSEX":    {"SENSEX", "BSE", "SENSEX", "BFO"},
	"^BSESN":    {"SENSEX", "BSE", "SENSEX", "BFO"},
}

// indexSpotSymbols is the set of spot tradingsymbols kept by the instrument
// loader so index tokens are available for ticker subscription.
var indexSpotSymbols = func() map[string]bool {
	m := make(map[string]bool)
	for _, info := range indexRegistry {
		m[info.Spot] = true
	}
	return m
}()

// indexSpotToApp maps a Kite spot tradingsymbol ("NIFTY 50") back to the
// canonical app (Yahoo-style) symbol ("^NSEI") used everywhere else. It is the
// inverse of indexAliasToSpot. Without it, SymbolForToken would label index
// ticks "NIFTY 50.NS", so the live engine (which tracks "^NSEI") would never see
// the in-progress candle and the chart would stop updating after start.
var indexSpotToApp = map[string]string{
	"NIFTY 50":          "^NSEI",
	"NIFTY BANK":        "^NSEBANK",
	"NIFTY FIN SERVICE": "FINNIFTY",
	"SENSEX":            "SENSEX",
}

func indexSpotToAppSymbol(spot string) (string, bool) {
	s, ok := indexSpotToApp[strings.TrimSpace(spot)]
	return s, ok
}

func lookupIndex(appSymbol string) (indexInfo, bool) {
	info, ok := indexRegistry[strings.ToUpper(strings.TrimSpace(appSymbol))]
	return info, ok
}

func indexAliasToSpot(appSymbol string) (string, bool) {
	if info, ok := lookupIndex(appSymbol); ok {
		return info.Spot, true
	}
	return "", false
}

// IsIndex reports whether the app symbol is a tracked index.
func IsIndex(appSymbol string) bool {
	_, ok := lookupIndex(appSymbol)
	return ok
}

// ─── Option-instrument cache ────────────────────────────────────────────────────

type optInstrument struct {
	tradingsymbol string
	exchange      string
	strike        float64
	expiry        time.Time
	optType       string // CE / PE
	lotSize       int     // contract lot size
}

type optChainCache struct {
	mu     sync.RWMutex
	byName map[string][]optInstrument // F&O underlying name → instruments
	loaded map[string]time.Time
}

var kiteOptions = &optChainCache{
	byName: make(map[string][]optInstrument),
	loaded: make(map[string]time.Time),
}

// loadOptionInstruments downloads the option instrument dump for the given
// options exchange (NFO/BFO) and caches CE/PE rows for the underlying name.
// Refreshes at most once every 12h per underlying.
func (k *KiteClient) loadOptionInstruments(fnoName, optExch string) ([]optInstrument, error) {
	kiteOptions.mu.RLock()
	cached := kiteOptions.byName[fnoName]
	fresh := time.Since(kiteOptions.loaded[fnoName]) < 12*time.Hour && len(cached) > 0
	kiteOptions.mu.RUnlock()
	if fresh {
		return cached, nil
	}

	token := k.GetAccessToken()
	if token == "" {
		return nil, fmt.Errorf("zerodha: not authenticated")
	}

	req, err := http.NewRequest("GET", kiteAPIBase+"/instruments/"+optExch, nil)
	if err != nil {
		return nil, err
	}
	k.setAuth(req, token)
	resp, err := k.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("option instrument dump fetch: %w", err)
	}
	defer resp.Body.Close()

	rows, err := csv.NewReader(resp.Body).ReadAll()
	if err != nil {
		return nil, fmt.Errorf("parsing option dump: %w", err)
	}
	if len(rows) < 2 {
		return nil, fmt.Errorf("empty option dump")
	}

	// header: instrument_token,exchange_token,tradingsymbol,name,last_price,
	//         expiry,strike,tick_size,lot_size,instrument_type,segment,exchange
	h := rows[0]
	col := func(name string) int {
		for i, c := range h {
			if strings.TrimSpace(c) == name {
				return i
			}
		}
		return -1
	}
	iSym, iName, iExpiry := col("tradingsymbol"), col("name"), col("expiry")
	iStrike, iType, iExch := col("strike"), col("instrument_type"), col("exchange")
	iLot := col("lot_size")
	if iSym < 0 || iName < 0 || iStrike < 0 || iType < 0 || iExpiry < 0 {
		return nil, fmt.Errorf("unexpected option dump columns")
	}

	var insts []optInstrument
	for _, r := range rows[1:] {
		if len(r) <= iType {
			continue
		}
		if strings.TrimSpace(r[iName]) != fnoName {
			continue
		}
		t := strings.TrimSpace(r[iType])
		if t != "CE" && t != "PE" {
			continue
		}
		strike, _ := strconv.ParseFloat(strings.TrimSpace(r[iStrike]), 64)
		expiry, _ := time.Parse("2006-01-02", strings.TrimSpace(r[iExpiry]))
		exch := optExch
		if iExch >= 0 && iExch < len(r) {
			exch = strings.TrimSpace(r[iExch])
		}
		lot := 0
		if iLot >= 0 && iLot < len(r) {
			lot, _ = strconv.Atoi(strings.TrimSpace(r[iLot]))
		}
		insts = append(insts, optInstrument{
			tradingsymbol: strings.TrimSpace(r[iSym]),
			exchange:      exch,
			strike:        strike,
			expiry:        expiry,
			optType:       t,
			lotSize:       lot,
		})
	}

	kiteOptions.mu.Lock()
	kiteOptions.byName[fnoName] = insts
	kiteOptions.loaded[fnoName] = time.Now()
	kiteOptions.mu.Unlock()
	return insts, nil
}

// ─── OI analysis ─────────────────────────────────────────────────────────────

// OptionChainRow is the OI/LTP snapshot for one strike. The *ChgOI fields hold
// the change in open interest since the previous snapshot (minute-over-minute),
// used to locate fresh support/resistance from live OI buildup.
type OptionChainRow struct {
	Strike    float64 `json:"strike"`
	CallOI    int64   `json:"call_oi"`
	PutOI     int64   `json:"put_oi"`
	CallChgOI int64   `json:"call_chg_oi"`
	PutChgOI  int64   `json:"put_chg_oi"`
	CallLTP   float64 `json:"call_ltp"`
	PutLTP    float64 `json:"put_ltp"`
}

// OIAnalysis summarises option-chain open interest for an underlying.
type OIAnalysis struct {
	Underlying  string           `json:"underlying"`
	Spot        float64          `json:"spot"`
	Expiry      string           `json:"expiry"`
	PCR         float64          `json:"pcr"`
	MaxPain     float64          `json:"max_pain"`
	Support     float64          `json:"support"`    // strike with max put OI
	Resistance  float64          `json:"resistance"` // strike with max call OI
	// Change-based levels, derived from the largest fresh OI buildup since the
	// previous snapshot. ChgSupport = biggest put-OI addition at/below spot;
	// ChgResistance = biggest call-OI addition at/above spot.
	ChgSupport    float64        `json:"chg_support"`
	ChgResistance float64        `json:"chg_resistance"`
	HasChange     bool           `json:"has_change"` // false on the first snapshot
	TotalCallOI int64            `json:"total_call_oi"`
	TotalPutOI  int64            `json:"total_put_oi"`
	Bias        string           `json:"bias"` // bullish / bearish / neutral
	Rows        []OptionChainRow `json:"rows"`
	AsOf        string           `json:"as_of"`
}

// oiSnapshot is the previous OI reading for one underlying, kept so the next
// fetch can compute per-strike OI change.
type oiSnapshot struct {
	call map[float64]int64
	put  map[float64]int64
	at   time.Time
}

var oiHistory = struct {
	mu   sync.Mutex
	last map[string]oiSnapshot // F&O underlying name → previous snapshot
}{last: make(map[string]oiSnapshot)}

// maxStrikesPerSide bounds how many strikes around ATM we query, to respect the
// Kite /quote instrument cap and keep max-pain meaningful.
const maxStrikesPerSide = 20

// OptionLeg is a resolved, tradable option contract for the nearest expiry.
type OptionLeg struct {
	TradingSymbol string  `json:"tradingsymbol"`
	Exchange      string  `json:"exchange"` // NFO / BFO
	Strike        float64 `json:"strike"`
	Expiry        string  `json:"expiry"` // YYYY-MM-DD
	OptType       string  `json:"opt_type"` // CE / PE
	LotSize       int     `json:"lot_size"`
}

// ResolveOption maps an underlying app symbol + option type (CE/PE) + desired
// strike to a concrete tradable contract on the nearest non-expired expiry. The
// instrument whose strike is closest to the requested strike wins, so callers can
// pass an ATM/OTM strike that may not land exactly on a listed strike.
func (k *KiteClient) ResolveOption(appSymbol, optType string, strike float64) (*OptionLeg, error) {
	optType = strings.ToUpper(strings.TrimSpace(optType))
	if optType != "CE" && optType != "PE" {
		return nil, fmt.Errorf("invalid option type %q", optType)
	}

	info, ok := lookupIndex(appSymbol)
	if !ok {
		trading := strings.TrimSuffix(strings.TrimSuffix(appSymbol, ".NS"), ".BO")
		info = indexInfo{Spot: trading, SpotExch: "NSE", FNOName: trading, OptExch: "NFO"}
	}

	insts, err := k.loadOptionInstruments(info.FNOName, info.OptExch)
	if err != nil {
		return nil, err
	}
	if len(insts) == 0 {
		return nil, fmt.Errorf("no option instruments for %s", info.FNOName)
	}

	// Nearest non-expired expiry.
	today := time.Now().Truncate(24 * time.Hour)
	var expiry time.Time
	for _, in := range insts {
		if in.expiry.Before(today) {
			continue
		}
		if expiry.IsZero() || in.expiry.Before(expiry) {
			expiry = in.expiry
		}
	}
	if expiry.IsZero() {
		return nil, fmt.Errorf("no upcoming expiry for %s", info.FNOName)
	}

	// Closest strike of the requested type on that expiry.
	var best *optInstrument
	bestDist := math.MaxFloat64
	for i := range insts {
		in := &insts[i]
		if in.optType != optType || !in.expiry.Equal(expiry) {
			continue
		}
		if d := math.Abs(in.strike - strike); d < bestDist {
			bestDist, best = d, in
		}
	}
	if best == nil {
		return nil, fmt.Errorf("no %s contract near %.0f for %s", optType, strike, info.FNOName)
	}

	return &OptionLeg{
		TradingSymbol: best.tradingsymbol,
		Exchange:      best.exchange,
		Strike:        best.strike,
		Expiry:        expiry.Format("2006-01-02"),
		OptType:       best.optType,
		LotSize:       best.lotSize,
	}, nil
}

// OptionChainOI builds an OI analysis for an index (or F&O underlying) symbol.
func (k *KiteClient) OptionChainOI(appSymbol string) (*OIAnalysis, error) {
	info, ok := lookupIndex(appSymbol)
	if !ok {
		// Treat a plain equity symbol as its own F&O underlying name (NSE → NFO).
		trading := strings.TrimSuffix(strings.TrimSuffix(appSymbol, ".NS"), ".BO")
		info = indexInfo{Spot: trading, SpotExch: "NSE", FNOName: trading, OptExch: "NFO"}
	}

	insts, err := k.loadOptionInstruments(info.FNOName, info.OptExch)
	if err != nil {
		return nil, err
	}
	if len(insts) == 0 {
		return nil, fmt.Errorf("no option instruments for %s", info.FNOName)
	}

	// Nearest non-expired expiry.
	today := time.Now().Truncate(24 * time.Hour)
	var expiry time.Time
	for _, in := range insts {
		if in.expiry.Before(today) {
			continue
		}
		if expiry.IsZero() || in.expiry.Before(expiry) {
			expiry = in.expiry
		}
	}
	if expiry.IsZero() {
		return nil, fmt.Errorf("no upcoming expiry for %s", info.FNOName)
	}

	// Spot LTP.
	spotKey := info.SpotExch + ":" + info.Spot
	spot := k.fetchSpotLTP(spotKey)

	// Collect strikes for that expiry.
	type pair struct{ ce, pe *optInstrument }
	byStrike := map[float64]*pair{}
	var strikes []float64
	for i := range insts {
		in := insts[i]
		if !in.expiry.Equal(expiry) {
			continue
		}
		p := byStrike[in.strike]
		if p == nil {
			p = &pair{}
			byStrike[in.strike] = p
			strikes = append(strikes, in.strike)
		}
		if in.optType == "CE" {
			p.ce = &insts[i]
		} else {
			p.pe = &insts[i]
		}
	}
	sort.Float64s(strikes)
	if len(strikes) == 0 {
		return nil, fmt.Errorf("no strikes for %s expiry %s", info.FNOName, expiry.Format("2006-01-02"))
	}

	// Window strikes around ATM (or the middle if spot unknown).
	atmIdx := len(strikes) / 2
	if spot > 0 {
		best := math.MaxFloat64
		for i, s := range strikes {
			if d := math.Abs(s - spot); d < best {
				best, atmIdx = d, i
			}
		}
	}
	lo := atmIdx - maxStrikesPerSide
	if lo < 0 {
		lo = 0
	}
	hi := atmIdx + maxStrikesPerSide
	if hi > len(strikes) {
		hi = len(strikes)
	}
	window := strikes[lo:hi]

	// Build instrument keys and fetch OI/LTP.
	var keys []string
	keyToStrike := map[string]struct {
		strike float64
		isCall bool
	}{}
	for _, s := range window {
		p := byStrike[s]
		if p.ce != nil {
			key := p.ce.exchange + ":" + p.ce.tradingsymbol
			keys = append(keys, key)
			keyToStrike[key] = struct {
				strike float64
				isCall bool
			}{s, true}
		}
		if p.pe != nil {
			key := p.pe.exchange + ":" + p.pe.tradingsymbol
			keys = append(keys, key)
			keyToStrike[key] = struct {
				strike float64
				isCall bool
			}{s, false}
		}
	}

	oiData, err := k.fetchOI(keys)
	if err != nil {
		return nil, err
	}

	rowByStrike := map[float64]*OptionChainRow{}
	for key, q := range oiData {
		meta, ok := keyToStrike[key]
		if !ok {
			continue
		}
		row := rowByStrike[meta.strike]
		if row == nil {
			row = &OptionChainRow{Strike: meta.strike}
			rowByStrike[meta.strike] = row
		}
		if meta.isCall {
			row.CallOI = q.OI
			row.CallLTP = q.LastPrice
		} else {
			row.PutOI = q.OI
			row.PutLTP = q.LastPrice
		}
	}

	analysis := &OIAnalysis{
		Underlying: info.FNOName,
		Spot:       spot,
		Expiry:     expiry.Format("2006-01-02"),
		AsOf:       time.Now().Format(time.RFC3339),
	}
	var maxCallOI, maxPutOI int64
	for _, s := range window {
		row := rowByStrike[s]
		if row == nil {
			continue
		}
		analysis.Rows = append(analysis.Rows, *row)
		analysis.TotalCallOI += row.CallOI
		analysis.TotalPutOI += row.PutOI
		if row.CallOI > maxCallOI {
			maxCallOI = row.CallOI
			analysis.Resistance = s
		}
		if row.PutOI > maxPutOI {
			maxPutOI = row.PutOI
			analysis.Support = s
		}
	}
	sort.Slice(analysis.Rows, func(i, j int) bool { return analysis.Rows[i].Strike < analysis.Rows[j].Strike })

	// Per-strike OI change vs the previous snapshot, and change-based S/R.
	computeOIChange(analysis, spot)

	if analysis.TotalCallOI > 0 {
		analysis.PCR = float64(analysis.TotalPutOI) / float64(analysis.TotalCallOI)
	}
	analysis.MaxPain = maxPain(analysis.Rows)
	analysis.Bias = oiBias(analysis.PCR)
	return analysis, nil
}

// computeOIChange fills CallChgOI/PutChgOI for each row by diffing against the
// previous snapshot for this underlying, then derives change-based support and
// resistance from the largest fresh OI buildup. The current reading is stored as
// the new baseline. On the first call (no prior snapshot) HasChange stays false.
func computeOIChange(a *OIAnalysis, spot float64) {
	key := a.Underlying

	oiHistory.mu.Lock()
	prev, hadPrev := oiHistory.last[key]
	curCall := make(map[float64]int64, len(a.Rows))
	curPut := make(map[float64]int64, len(a.Rows))
	for i := range a.Rows {
		r := &a.Rows[i]
		curCall[r.Strike] = r.CallOI
		curPut[r.Strike] = r.PutOI
		if hadPrev {
			r.CallChgOI = r.CallOI - prev.call[r.Strike]
			r.PutChgOI = r.PutOI - prev.put[r.Strike]
		}
	}
	oiHistory.last[key] = oiSnapshot{call: curCall, put: curPut, at: time.Now()}
	oiHistory.mu.Unlock()

	a.HasChange = hadPrev
	if !hadPrev {
		return
	}

	// Support builds where puts are being added at/below spot; resistance where
	// calls are being added at/above spot. Largest fresh addition wins.
	var bestPutAdd, bestCallAdd int64
	for _, r := range a.Rows {
		atOrBelow := spot <= 0 || r.Strike <= spot
		atOrAbove := spot <= 0 || r.Strike >= spot
		if atOrBelow && r.PutChgOI > bestPutAdd {
			bestPutAdd = r.PutChgOI
			a.ChgSupport = r.Strike
		}
		if atOrAbove && r.CallChgOI > bestCallAdd {
			bestCallAdd = r.CallChgOI
			a.ChgResistance = r.Strike
		}
	}
	// Fall back to absolute-OI levels when no fresh buildup is present yet.
	if a.ChgSupport == 0 {
		a.ChgSupport = a.Support
	}
	if a.ChgResistance == 0 {
		a.ChgResistance = a.Resistance
	}
}

// maxPain returns the strike that minimises total payout to option writers.
func maxPain(rows []OptionChainRow) float64 {
	if len(rows) == 0 {
		return 0
	}
	best := math.MaxFloat64
	bestStrike := rows[0].Strike
	for _, candidate := range rows {
		var pain float64
		for _, r := range rows {
			if candidate.Strike > r.Strike {
				pain += float64(r.CallOI) * (candidate.Strike - r.Strike)
			}
			if candidate.Strike < r.Strike {
				pain += float64(r.PutOI) * (r.Strike - candidate.Strike)
			}
		}
		if pain < best {
			best = pain
			bestStrike = candidate.Strike
		}
	}
	return bestStrike
}

func oiBias(pcr float64) string {
	switch {
	case pcr == 0:
		return "neutral"
	case pcr >= 1.3:
		return "bullish"
	case pcr <= 0.7:
		return "bearish"
	default:
		return "neutral"
	}
}

// OIConfirms reports whether the OI bias supports a trade in the given
// direction. BUY needs a non-bearish chain; SELL needs a non-bullish chain.
func (a *OIAnalysis) OIConfirms(direction string) bool {
	if a == nil {
		return true // no data → don't block
	}
	switch strings.ToUpper(direction) {
	case "BUY":
		return a.Bias != "bearish"
	case "SELL":
		return a.Bias != "bullish"
	default:
		return true
	}
}

// ─── raw quote helpers ─────────────────────────────────────────────────────────

type oiQuote struct {
	LastPrice float64
	OI        int64
}

// fetchOI queries /quote for OI + LTP, chunking to respect instrument caps.
func (k *KiteClient) fetchOI(keys []string) (map[string]oiQuote, error) {
	token := k.GetAccessToken()
	if token == "" {
		return nil, fmt.Errorf("zerodha: not authenticated")
	}
	out := make(map[string]oiQuote, len(keys))
	const chunk = 200
	for i := 0; i < len(keys); i += chunk {
		end := i + chunk
		if end > len(keys) {
			end = len(keys)
		}
		if err := k.fetchOIChunk(keys[i:end], token, out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (k *KiteClient) fetchOIChunk(keys []string, token string, out map[string]oiQuote) error {
	req, err := http.NewRequest("GET", kiteAPIBase+"/quote", nil)
	if err != nil {
		return err
	}
	q := req.URL.Query()
	for _, key := range keys {
		q.Add("i", key)
	}
	req.URL.RawQuery = q.Encode()
	k.setAuth(req, token)

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("kite oi quote fetch: %w", err)
	}
	defer resp.Body.Close()

	var parsed struct {
		Status string `json:"status"`
		Data   map[string]struct {
			LastPrice float64 `json:"last_price"`
			OI        float64 `json:"oi"`
		} `json:"data"`
		Message string `json:"message"`
	}
	if err := decodeJSON(resp, &parsed); err != nil {
		return fmt.Errorf("parsing oi quote: %w", err)
	}
	if parsed.Status != "success" {
		return fmt.Errorf("kite oi quote error: %s", parsed.Message)
	}
	for key, v := range parsed.Data {
		out[key] = oiQuote{LastPrice: v.LastPrice, OI: int64(v.OI)}
	}
	return nil
}

// fetchSpotLTP returns the spot last price for a single Kite key, 0 on error.
func (k *KiteClient) fetchSpotLTP(spotKey string) float64 {
	token := k.GetAccessToken()
	if token == "" {
		return 0
	}
	req, err := http.NewRequest("GET", kiteAPIBase+"/quote/ltp", nil)
	if err != nil {
		return 0
	}
	q := req.URL.Query()
	q.Add("i", spotKey)
	req.URL.RawQuery = q.Encode()
	k.setAuth(req, token)

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return 0
	}
	defer resp.Body.Close()

	var parsed struct {
		Data map[string]struct {
			LastPrice float64 `json:"last_price"`
		} `json:"data"`
	}
	if decodeJSON(resp, &parsed) != nil {
		return 0
	}
	for _, v := range parsed.Data {
		return v.LastPrice
	}
	return 0
}

// decodeJSON decodes an HTTP response body into v.
func decodeJSON(resp *http.Response, v interface{}) error {
	return json.NewDecoder(resp.Body).Decode(v)
}
