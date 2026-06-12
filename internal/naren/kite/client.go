// Package kite is a READ-ONLY Zerodha Kite Connect client.
//
// SAFETY CONTRACT: This package intentionally implements ONLY market-data
// endpoints (login, quotes, historical candles, instrument master). It does NOT
// and MUST NOT implement order placement, modification, or cancellation. The app
// uses Kite purely to analyse charts and feed a paper-trading simulator. No code
// path here can ever touch a real position.
package kite

import (
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ipv4Transport forces all Kite REST calls over IPv4. Zerodha's static-IP rule
// for order placement rejects rotating IPv6 privacy addresses; using IPv4 means
// orders originate from your (whitelistable) public IPv4 address.
var ipv4Transport = &http.Transport{
	DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		if network == "tcp" || network == "tcp6" {
			network = "tcp4"
		}
		return (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, addr)
	},
}

// Client is a read-only Kite Connect API client.
type Client struct {
	apiKey      string
	apiSecret   string
	redirectURL string

	mu          sync.RWMutex
	accessToken string
	userName    string
	loginTime   time.Time

	http *http.Client

	// instrument cache (refreshed daily)
	instrumentsMu   sync.RWMutex
	instrumentCache map[string][]Instrument // exchange -> instruments
	instrumentDate  string                  // yyyy-mm-dd of last fetch
}

// New constructs a read-only Kite client.
func New(apiKey, apiSecret, redirectURL string) *Client {
	return &Client{
		apiKey:          apiKey,
		apiSecret:       apiSecret,
		redirectURL:     redirectURL,
		http:            &http.Client{Timeout: 20 * time.Second, Transport: ipv4Transport},
		instrumentCache: map[string][]Instrument{},
	}
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

// LoginURL returns the Kite OAuth login URL the user must visit each morning.
func (c *Client) LoginURL() string {
	return fmt.Sprintf("%s?v=3&api_key=%s", LoginBaseURL, c.apiKey)
}

// GenerateSession exchanges a request_token (from the redirect) for an access
// token and stores it. The token is valid until ~7:30 AM IST the next day.
func (c *Client) GenerateSession(requestToken string) error {
	sum := sha256.Sum256([]byte(c.apiKey + requestToken + c.apiSecret))
	checksum := fmt.Sprintf("%x", sum)

	form := url.Values{}
	form.Set("api_key", c.apiKey)
	form.Set("request_token", requestToken)
	form.Set("checksum", checksum)

	req, err := http.NewRequest(http.MethodPost, BaseURL+"/session/token", strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("X-Kite-Version", "3")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("session request failed: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var sr sessionResponse
	if err := json.Unmarshal(body, &sr); err != nil {
		return fmt.Errorf("decoding session: %w (body: %s)", err, string(body))
	}
	if sr.Status != "success" || sr.Data.AccessToken == "" {
		return fmt.Errorf("kite login failed: %s", sr.Message)
	}

	c.mu.Lock()
	c.accessToken = sr.Data.AccessToken
	c.userName = sr.Data.UserName
	c.loginTime = time.Now()
	c.mu.Unlock()
	return nil
}

// SetAccessToken lets a token be injected directly (e.g. restored from disk).
func (c *Client) SetAccessToken(token string) {
	c.mu.Lock()
	c.accessToken = token
	c.loginTime = time.Now()
	c.mu.Unlock()
}

// AccessToken returns the current access token.
func (c *Client) AccessToken() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.accessToken
}

// IsConnected reports whether a usable access token is present.
func (c *Client) IsConnected() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.accessToken != ""
}

// Status returns connection details for the UI.
func (c *Client) Status() (connected bool, user string, since time.Time) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.accessToken != "", c.userName, c.loginTime
}

// ─── Authed request helper ────────────────────────────────────────────────────

func (c *Client) authHeader() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return fmt.Sprintf("token %s:%s", c.apiKey, c.accessToken)
}

func (c *Client) get(path string) ([]byte, error) {
	if !c.IsConnected() {
		return nil, fmt.Errorf("kite not connected — login required")
	}
	req, err := http.NewRequest(http.MethodGet, BaseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Kite-Version", "3")
	req.Header.Set("Authorization", c.authHeader())

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("kite session expired — please re-login (HTTP %d)", resp.StatusCode)
	}
	return body, nil
}

// ─── Market data (read-only) ──────────────────────────────────────────────────

// LTP returns last-traded prices for the given instruments (e.g. "NSE:NIFTY 50").
func (c *Client) LTP(instruments ...string) (map[string]LTPData, error) {
	q := url.Values{}
	for _, ins := range instruments {
		q.Add("i", ins)
	}
	body, err := c.get("/quote/ltp?" + q.Encode())
	if err != nil {
		return nil, err
	}
	var r ltpResponse
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, fmt.Errorf("decoding ltp: %w", err)
	}
	return r.Data, nil
}

// Quote returns full quotes (OHLC, volume, OI) for the given instruments.
func (c *Client) Quote(instruments ...string) (map[string]QuoteData, error) {
	q := url.Values{}
	for _, ins := range instruments {
		q.Add("i", ins)
	}
	body, err := c.get("/quote?" + q.Encode())
	if err != nil {
		return nil, err
	}
	var r quoteResponse
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, fmt.Errorf("decoding quote: %w", err)
	}
	return r.Data, nil
}

// HistoricalData fetches OHLCV candles for an instrument token.
// interval: minute, 3minute, 5minute, 15minute, 30minute, 60minute, day.
// from/to: "2006-01-02 15:04:05" in IST.
//
// If Kite's historical endpoint is unavailable (expired token, or the app's
// API key lacks the paid Historical Data subscription → HTTP 403), this
// transparently falls back to Yahoo Finance so charts and backtests keep
// working. See historical_fallback.go.
func (c *Client) HistoricalData(token int, interval, from, to string) ([]Candle, error) {
	candles, err := c.kiteHistorical(token, interval, from, to)
	if err == nil && len(candles) > 0 {
		return candles, nil
	}
	// Kite failed or returned nothing — try Yahoo as a fallback.
	if fb, ferr := yahooHistorical(c.http, token, interval, from, to); ferr == nil && len(fb) > 0 {
		return fb, nil
	}
	if err != nil {
		return nil, err
	}
	return candles, nil
}

// kiteHistorical is the raw Kite Connect historical-candles call.
func (c *Client) kiteHistorical(token int, interval, from, to string) ([]Candle, error) {
	q := url.Values{}
	q.Set("from", from)
	q.Set("to", to)
	path := fmt.Sprintf("/instruments/historical/%d/%s?%s", token, interval, q.Encode())
	body, err := c.get(path)
	if err != nil {
		return nil, err
	}
	var r historicalResponse
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, fmt.Errorf("decoding historical: %w", err)
	}
	if r.Status != "success" {
		return nil, fmt.Errorf("kite historical error: %s", r.Message)
	}
	candles := make([]Candle, 0, len(r.Data.Candles))
	for _, row := range r.Data.Candles {
		if len(row) < 6 {
			continue
		}
		ts, _ := time.Parse("2006-01-02T15:04:05-0700", asString(row[0]))
		candles = append(candles, Candle{
			Time:   ts,
			Open:   asFloat(row[1]),
			High:   asFloat(row[2]),
			Low:    asFloat(row[3]),
			Close:  asFloat(row[4]),
			Volume: int64(asFloat(row[5])),
		})
	}
	return candles, nil
}

// Instruments returns the instrument master for an exchange (e.g. "NFO"),
// cached for the trading day.
func (c *Client) Instruments(exchange string) ([]Instrument, error) {
	today := time.Now().Format("2006-01-02")

	c.instrumentsMu.RLock()
	if c.instrumentDate == today {
		if cached, ok := c.instrumentCache[exchange]; ok {
			c.instrumentsMu.RUnlock()
			return cached, nil
		}
	}
	c.instrumentsMu.RUnlock()

	body, err := c.get("/instruments/" + exchange)
	if err != nil {
		return nil, err
	}
	instruments, err := parseInstrumentsCSV(body)
	if err != nil {
		return nil, err
	}

	c.instrumentsMu.Lock()
	if c.instrumentDate != today {
		c.instrumentCache = map[string][]Instrument{}
		c.instrumentDate = today
	}
	c.instrumentCache[exchange] = instruments
	c.instrumentsMu.Unlock()
	return instruments, nil
}

// ─── CSV / type helpers ───────────────────────────────────────────────────────

func parseInstrumentsCSV(body []byte) ([]Instrument, error) {
	r := csv.NewReader(strings.NewReader(string(body)))
	rows, err := r.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("parsing instruments csv: %w", err)
	}
	if len(rows) < 2 {
		return nil, fmt.Errorf("empty instruments response")
	}
	// header: instrument_token,exchange_token,tradingsymbol,name,last_price,
	//         expiry,strike,tick_size,lot_size,instrument_type,segment,exchange
	out := make([]Instrument, 0, len(rows)-1)
	for _, row := range rows[1:] {
		if len(row) < 12 {
			continue
		}
		tok, _ := strconv.Atoi(row[0])
		strike, _ := strconv.ParseFloat(row[6], 64)
		lot, _ := strconv.Atoi(row[8])
		out = append(out, Instrument{
			InstrumentToken: tok,
			TradingSymbol:   row[2],
			Name:            row[3],
			Expiry:          row[5],
			Strike:          strike,
			LotSize:         lot,
			InstrumentType:  row[9],
			Segment:         row[10],
			Exchange:        row[11],
		})
	}
	return out, nil
}

func asString(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", v)
}

func asFloat(v interface{}) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case string:
		f, _ := strconv.ParseFloat(n, 64)
		return f
	}
	return 0
}
