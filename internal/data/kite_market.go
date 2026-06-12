package data

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"

	"stockwise/pkg/logger"
)

// Zerodha rejects plain MARKET orders for F&O via the API. A requested MARKET
// order on NFO is sent as a LIMIT priced this far past the current LTP (above
// for BUY, below for SELL), emulating Zerodha's ~3% market protection.
const (
	nfoMarketProtectionPct = 0.03
	nfoTickSize            = 0.05
)

func roundToNfoTick(p float64) float64 {
	return math.Round(p/nfoTickSize) * nfoTickSize
}

// ─── Instrument token resolution ──────────────────────────────────────────────
//
// The Kite Ticker WebSocket subscribes by numeric instrument_token, not by the
// "NSE:RELIANCE" string used by the REST quote API. We download the instrument
// dump once and cache the symbol→token map.

type instrumentCache struct {
	mu      sync.RWMutex
	byToken map[uint32]string // token → tradingsymbol (e.g. RELIANCE)
	bySym   map[string]uint32 // tradingsymbol → token
	loaded  time.Time
}

var kiteInstruments = &instrumentCache{
	byToken: make(map[uint32]string),
	bySym:   make(map[string]uint32),
}

// LoadInstruments downloads the NSE and BSE instrument dumps and caches token
// mappings. Safe to call repeatedly; it refreshes at most once every 12h.
//
// Both exchanges are loaded because some tracked indices live on BSE (e.g.
// SENSEX), which is absent from the NSE dump. To avoid tradingsymbol collisions
// between NSE and BSE equities, only index-spot symbols are kept from BSE; NSE
// contributes its full EQ + index-spot set.
func (k *KiteClient) LoadInstruments() error {
	kiteInstruments.mu.RLock()
	fresh := time.Since(kiteInstruments.loaded) < 12*time.Hour && len(kiteInstruments.bySym) > 0
	kiteInstruments.mu.RUnlock()
	if fresh {
		return nil
	}

	token := k.GetAccessToken()
	if token == "" {
		return fmt.Errorf("zerodha: not authenticated")
	}

	byToken := make(map[uint32]string, 4096)
	bySym := make(map[string]uint32, 4096)

	// NSE: keep EQ instruments plus index spots.
	if err := k.loadExchangeInstruments(token, "NSE", false, byToken, bySym); err != nil {
		return err
	}
	// BSE: keep index spots only (SENSEX etc.); skip equities to avoid collisions.
	if err := k.loadExchangeInstruments(token, "BSE", true, byToken, bySym); err != nil {
		// BSE is best-effort: a failure here shouldn't break NSE streaming.
		logger.Warn("BSE instrument dump failed; SENSEX/BSE indices unavailable", zap.Error(err))
	}

	if len(bySym) == 0 {
		return fmt.Errorf("empty instrument dump")
	}

	kiteInstruments.mu.Lock()
	kiteInstruments.byToken = byToken
	kiteInstruments.bySym = bySym
	kiteInstruments.loaded = time.Now()
	kiteInstruments.mu.Unlock()
	return nil
}

// loadExchangeInstruments fetches one exchange's instrument dump and merges the
// kept rows into byToken/bySym. When indexSpotsOnly is true, only index-spot
// tradingsymbols are kept (used for BSE to avoid equity symbol collisions).
func (k *KiteClient) loadExchangeInstruments(
	token, exchange string,
	indexSpotsOnly bool,
	byToken map[uint32]string,
	bySym map[string]uint32,
) error {
	req, err := http.NewRequest("GET", kiteAPIBase+"/instruments/"+exchange, nil)
	if err != nil {
		return err
	}
	k.setAuth(req, token)

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("instrument dump fetch (%s): %w", exchange, err)
	}
	defer resp.Body.Close()

	r := csv.NewReader(resp.Body)
	rows, err := r.ReadAll()
	if err != nil {
		return fmt.Errorf("parsing instrument dump (%s): %w", exchange, err)
	}
	if len(rows) < 2 {
		return fmt.Errorf("empty instrument dump (%s)", exchange)
	}

	// Header: instrument_token,exchange_token,tradingsymbol,name,...,instrument_type,segment,exchange
	header := rows[0]
	idxToken, idxSym, idxType := -1, -1, -1
	for i, col := range header {
		switch strings.TrimSpace(col) {
		case "instrument_token":
			idxToken = i
		case "tradingsymbol":
			idxSym = i
		case "instrument_type":
			idxType = i
		}
	}
	if idxToken < 0 || idxSym < 0 {
		return fmt.Errorf("unexpected instrument dump columns (%s)", exchange)
	}

	kept := 0
	for _, row := range rows[1:] {
		if len(row) <= idxToken || len(row) <= idxSym {
			continue
		}
		symName := strings.TrimSpace(row[idxSym])
		isIndexSpot := indexSpotSymbols[symName]
		if indexSpotsOnly {
			if !isIndexSpot {
				continue
			}
		} else {
			// Keep cash-equity instruments (EQ) plus index spots; skip F&O etc.
			if idxType >= 0 && idxType < len(row) && row[idxType] != "EQ" && !isIndexSpot {
				continue
			}
		}
		tk, err := strconv.ParseUint(strings.TrimSpace(row[idxToken]), 10, 32)
		if err != nil {
			continue
		}
		byToken[uint32(tk)] = symName
		bySym[symName] = uint32(tk)
		kept++
	}
	logger.Info("kite instruments loaded", zap.String("exchange", exchange), zap.Int("kept", kept))
	return nil
}

// TokenForSymbol resolves a Yahoo-format symbol (RELIANCE.NS) or an index
// alias (^NSEI, NIFTY, BANKNIFTY…) to a Kite instrument token. Returns 0 if
// unknown.
func (k *KiteClient) TokenForSymbol(yahooSymbol string) uint32 {
	trading := strings.TrimSuffix(strings.TrimSuffix(yahooSymbol, ".NS"), ".BO")
	if spot, ok := indexAliasToSpot(yahooSymbol); ok {
		trading = spot
	}
	kiteInstruments.mu.RLock()
	defer kiteInstruments.mu.RUnlock()
	if tk := kiteInstruments.bySym[trading]; tk != 0 {
		return tk
	}
	// Forgiving fallback: a leading "^" denotes an index alias, but a stock
	// symbol mistakenly given that prefix (e.g. "^ITC") is not an index. Retry
	// the bare tradingsymbol so such inputs self-heal instead of silently
	// dropping from the ticker.
	if strings.HasPrefix(trading, "^") {
		return kiteInstruments.bySym[strings.TrimPrefix(trading, "^")]
	}
	return 0
}

// SymbolForToken returns the Yahoo-format symbol for a Kite instrument token.
func (k *KiteClient) SymbolForToken(token uint32) string {
	kiteInstruments.mu.RLock()
	defer kiteInstruments.mu.RUnlock()
	sym, ok := kiteInstruments.byToken[token]
	if !ok {
		return ""
	}
	// Index spot tradingsymbols ("NIFTY 50") map back to their app alias ("^NSEI")
	// so index ticks fold into candles under the same key the engine tracks.
	if app, ok := indexSpotToAppSymbol(sym); ok {
		return app
	}
	return sym + ".NS"
}

// ─── Historical candles ────────────────────────────────────────────────────────

// FetchHistorical pulls OHLCV candles from Kite's historical-data API.
// interval: "minute","3minute","5minute","15minute","day".
func (k *KiteClient) FetchHistorical(yahooSymbol, interval string, from, to time.Time) ([]ChartBar, error) {
	token := k.GetAccessToken()
	if token == "" {
		return nil, fmt.Errorf("zerodha: not authenticated")
	}
	if err := k.LoadInstruments(); err != nil {
		return nil, err
	}
	instToken := k.TokenForSymbol(yahooSymbol)
	if instToken == 0 {
		return nil, fmt.Errorf("zerodha: no instrument token for %s", yahooSymbol)
	}

	endpoint := fmt.Sprintf("%s/instruments/historical/%d/%s", kiteAPIBase, instToken, interval)
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	q := req.URL.Query()
	q.Set("from", from.Format("2006-01-02 15:04:05"))
	q.Set("to", to.Format("2006-01-02 15:04:05"))
	req.URL.RawQuery = q.Encode()
	k.setAuth(req, token)

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("kite historical fetch: %w", err)
	}
	defer resp.Body.Close()

	var out struct {
		Status string `json:"status"`
		Data   struct {
			Candles [][]interface{} `json:"candles"`
		} `json:"data"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("parsing kite historical: %w", err)
	}
	if out.Status != "success" {
		return nil, fmt.Errorf("kite historical error: %s", out.Message)
	}

	bars := make([]ChartBar, 0, len(out.Data.Candles))
	for _, c := range out.Data.Candles {
		// [timestamp, open, high, low, close, volume]
		if len(c) < 6 {
			continue
		}
		ts, _ := c[0].(string)
		t, _ := time.Parse("2006-01-02T15:04:05-0700", ts)
		bar := ChartBar{
			Time:   t.UTC(),
			Open:   asFloat(c[1]),
			High:   asFloat(c[2]),
			Low:    asFloat(c[3]),
			Close:  asFloat(c[4]),
			Volume: int64(asFloat(c[5])),
		}
		bar.AdjClose = bar.Close
		bars = append(bars, bar)
	}
	return bars, nil
}

// kiteIntervalMaxDays is the per-request candle span Kite allows for each
// historical interval. Requests wider than this must be split into chunks.
func kiteIntervalMaxDays(interval string) int {
	switch interval {
	case "minute":
		return 60
	case "3minute", "5minute", "10minute":
		return 100
	case "15minute", "30minute":
		return 200
	case "60minute", "hour":
		return 400
	default: // day, week, etc.
		return 2000
	}
}

// FetchHistoricalRange pulls candles over an arbitrary [from,to] window,
// transparently splitting the request into Kite's per-interval maximum spans and
// concatenating the results. Use this instead of FetchHistorical when the window
// may exceed a single request's limit (e.g. multi-month backtests).
func (k *KiteClient) FetchHistoricalRange(yahooSymbol, interval string, from, to time.Time) ([]ChartBar, error) {
	maxSpan := time.Duration(kiteIntervalMaxDays(interval)) * 24 * time.Hour
	var all []ChartBar
	for start := from; start.Before(to); {
		end := start.Add(maxSpan)
		if end.After(to) {
			end = to
		}
		bars, err := k.FetchHistorical(yahooSymbol, interval, start, end)
		if err != nil {
			// Surface the error only if we have nothing; partial data is still useful.
			if len(all) == 0 {
				return nil, err
			}
			break
		}
		all = append(all, bars...)
		start = end.Add(time.Second)
	}
	return all, nil
}

func asFloat(v interface{}) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case json.Number:
		f, _ := n.Float64()
		return f
	case string:
		f, _ := strconv.ParseFloat(n, 64)
		return f
	}
	return 0
}

// ─── Order placement (LIVE mode) ────────────────────────────────────────────────

// OrderRequest describes a market/limit order for Kite.
type OrderRequest struct {
	Symbol          string  // Yahoo-format equity (RELIANCE.NS) or option tradingsymbol
	Exchange        string  // NSE (default) / NFO / BFO — set for option orders
	TransactionType string  // BUY / SELL
	Quantity        int     // shares (equity) or lots × lot_size (options)
	Product         string  // MIS (intraday) / CNC (delivery)
	OrderType       string  // MARKET / LIMIT
	Price           float64 // for LIMIT
	Variety         string  // regular / amo
}

// PlaceOrder submits an order through Kite Connect and returns the order_id.
func (k *KiteClient) PlaceOrder(o OrderRequest) (string, error) {
	token := k.GetAccessToken()
	if token == "" {
		return "", fmt.Errorf("zerodha: not authenticated")
	}
	exchange := o.Exchange
	if exchange == "" {
		exchange = "NSE"
	}
	// Equity symbols carry Yahoo suffixes; option tradingsymbols do not.
	trading := o.Symbol
	if exchange == "NSE" || exchange == "BSE" {
		trading = strings.TrimSuffix(strings.TrimSuffix(o.Symbol, ".NS"), ".BO")
	}
	if o.Variety == "" {
		o.Variety = "regular"
	}
	if o.Product == "" {
		o.Product = "MIS"
	}
	if o.OrderType == "" {
		o.OrderType = "MARKET"
	}

	// Zerodha does NOT accept plain MARKET orders for F&O via the API. Convert a
	// requested MARKET order on NFO into a protective LIMIT priced past the LTP.
	orderType := strings.ToUpper(o.OrderType)
	price := o.Price
	if orderType == "MARKET" && strings.EqualFold(exchange, "NFO") {
		inst := exchange + ":" + trading
		quotes, err := k.FetchLiveQuotes([]string{inst})
		if err != nil {
			return "", fmt.Errorf("fetching LTP to build protective limit for %s: %w", inst, err)
		}
		// FetchLiveQuotes re-keys NFO instruments by their bare tradingsymbol.
		ltp := quotes[trading].LastPrice
		if ltp <= 0 {
			return "", fmt.Errorf("no live LTP for %s — cannot build protective limit order", inst)
		}
		if strings.EqualFold(o.TransactionType, "BUY") {
			price = roundToNfoTick(ltp * (1 + nfoMarketProtectionPct))
		} else {
			price = roundToNfoTick(ltp * (1 - nfoMarketProtectionPct))
		}
		orderType = "LIMIT"
	}

	form := url.Values{}
	form.Set("tradingsymbol", trading)
	form.Set("exchange", exchange)
	form.Set("transaction_type", strings.ToUpper(o.TransactionType))
	form.Set("quantity", strconv.Itoa(o.Quantity))
	form.Set("product", o.Product)
	form.Set("order_type", orderType)
	form.Set("validity", "DAY")
	if orderType == "LIMIT" && price > 0 {
		form.Set("price", strconv.FormatFloat(price, 'f', 2, 64))
	}

	endpoint := fmt.Sprintf("%s/orders/%s", kiteAPIBase, o.Variety)
	req, err := http.NewRequest("POST", endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	k.setAuth(req, token)

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("kite place order: %w", err)
	}
	defer resp.Body.Close()

	var out struct {
		Status  string `json:"status"`
		Message string `json:"message"`
		Data    struct {
			OrderID string `json:"order_id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("parsing order response: %w", err)
	}
	if out.Status != "success" {
		return "", fmt.Errorf("kite order rejected: %s", out.Message)
	}
	return out.Data.OrderID, nil
}
