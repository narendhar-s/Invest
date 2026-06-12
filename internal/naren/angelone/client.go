// Package angelone provides a client for Angel One SmartAPI.
// Docs: https://smartapi.angelbroking.com/docs
package angelone

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/pquerna/otp/totp"
)

// ─── Constants ────────────────────────────────────────────────────────────────

const (
	baseURL   = "https://apiconnect.angelbroking.com"
	loginPath = "/rest/auth/angelbroking/user/v1/loginByPassword"
	histPath  = "/rest/secure/angelbroking/historical/v1/getCandleData"
	chainPath = "/rest/secure/angelbroking/market/v1/optionchain"
	quotePath = "/rest/secure/angelbroking/market/v1/quote/"

	// Angel One token IDs for indices (NSE segment = exchange type 1)
	TokenNIFTY     = "26000"
	TokenBANKNIFTY = "26009"
	ExchangeNSE    = "NSE"
)

// ─── Config ───────────────────────────────────────────────────────────────────

// Config holds Angel One SmartAPI credentials from config.yaml
type Config struct {
	Enabled    bool   `mapstructure:"enabled"`
	APIKey     string `mapstructure:"api_key"`
	ClientID   string `mapstructure:"client_id"`
	Password   string `mapstructure:"password"`
	TOTPSecret string `mapstructure:"totp_secret"`
}

// ─── Client ───────────────────────────────────────────────────────────────────

// Client is a thread-safe Angel One SmartAPI client.
type Client struct {
	cfg       Config
	mu        sync.RWMutex
	jwtToken  string
	feedToken string   // used for SmartStream WebSocket auth
	tokenExp  time.Time
	http      *http.Client
}

// NewClient creates a new Angel One client from config.
func NewClient(cfg Config) *Client {
	return &Client{
		cfg:  cfg,
		http: &http.Client{Timeout: 15 * time.Second},
	}
}

// IsEnabled returns whether Angel One is configured and enabled.
func (c *Client) IsEnabled() bool { return c.cfg.Enabled && c.cfg.APIKey != "" }

// FeedToken returns the SmartStream feed token (call after EnsureAuth).
func (c *Client) FeedToken() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.feedToken
}

// JWTToken returns the current JWT token.
func (c *Client) JWTToken() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.jwtToken
}

// APIKey returns the configured API key (needed for SmartStream header).
func (c *Client) APIKey() string { return c.cfg.APIKey }

// EnsureAuth authenticates if needed (token missing or < 1 hour remaining).
func (c *Client) EnsureAuth() error {
	c.mu.RLock()
	valid := c.jwtToken != "" && time.Now().Add(time.Hour).Before(c.tokenExp)
	c.mu.RUnlock()
	if valid {
		return nil
	}
	return c.login()
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

func (c *Client) login() error {
	totpCode, err := totp.GenerateCode(c.cfg.TOTPSecret, time.Now())
	if err != nil {
		return fmt.Errorf("angelone: generate totp: %w", err)
	}

	payload, _ := json.Marshal(map[string]string{
		"clientcode": c.cfg.ClientID,
		"password":   c.cfg.Password,
		"totp":       totpCode,
	})

	req, err := http.NewRequest("POST", baseURL+loginPath, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	c.setBaseHeaders(req)

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("angelone: login request: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var result struct {
		Status  bool   `json:"status"`
		Message string `json:"message"`
		Data    struct {
			JwtToken     string `json:"jwtToken"`
			FeedToken    string `json:"feedToken"`
			RefreshToken string `json:"refreshToken"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return fmt.Errorf("angelone: login decode: %w (body: %s)", err, string(body))
	}
	if !result.Status {
		return fmt.Errorf("angelone: login failed: %s", result.Message)
	}

	c.mu.Lock()
	c.jwtToken = result.Data.JwtToken
	c.feedToken = result.Data.FeedToken
	c.tokenExp = time.Now().Add(24 * time.Hour)
	c.mu.Unlock()
	return nil
}

// ─── Historical Candles ───────────────────────────────────────────────────────

// Candle represents one OHLCV bar.
type Candle struct {
	Time   time.Time
	Open   float64
	High   float64
	Low    float64
	Close  float64
	Volume int64
}

// Interval maps our shorthand to Angel One's interval strings.
var Interval = map[string]string{
	"1m":  "ONE_MINUTE",
	"3m":  "THREE_MINUTE",
	"5m":  "FIVE_MINUTE",
	"10m": "TEN_MINUTE",
	"15m": "FIFTEEN_MINUTE",
	"30m": "THIRTY_MINUTE",
	"1h":  "ONE_HOUR",
	"1d":  "ONE_DAY",
}

// FetchCandles returns historical OHLCV bars for the given token.
// token: "26000" (NIFTY), "26009" (BANKNIFTY)
// interval: "5m", "15m", "1d" etc.
// from/to: time range
func (c *Client) FetchCandles(token, exchange, interval string, from, to time.Time) ([]Candle, error) {
	if err := c.EnsureAuth(); err != nil {
		return nil, err
	}

	angelInterval, ok := Interval[interval]
	if !ok {
		return nil, fmt.Errorf("angelone: unknown interval %q", interval)
	}

	ist := time.FixedZone("IST", 5*3600+30*60)
	payload, _ := json.Marshal(map[string]string{
		"exchange":    exchange,
		"symboltoken": token,
		"interval":    angelInterval,
		"fromdate":    from.In(ist).Format("2006-01-02 15:04"),
		"todate":      to.In(ist).Format("2006-01-02 15:04"),
	})

	req, err := http.NewRequest("POST", baseURL+histPath, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	c.setAuthHeaders(req)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("angelone: fetch candles: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var result struct {
		Status  bool            `json:"status"`
		Message string          `json:"message"`
		Data    [][]interface{} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("angelone: candle decode: %w", err)
	}
	if !result.Status {
		return nil, fmt.Errorf("angelone: candle error: %s", result.Message)
	}

	candles := make([]Candle, 0, len(result.Data))
	for _, row := range result.Data {
		if len(row) < 6 {
			continue
		}
		tsStr, ok := row[0].(string)
		if !ok {
			continue
		}
		ts, err := time.Parse("2006-01-02T15:04:05-07:00", tsStr)
		if err != nil {
			ts, err = time.Parse(time.RFC3339, tsStr)
			if err != nil {
				continue
			}
		}
		candle := Candle{Time: ts}
		if v, ok := row[1].(float64); ok {
			candle.Open = v
		}
		if v, ok := row[2].(float64); ok {
			candle.High = v
		}
		if v, ok := row[3].(float64); ok {
			candle.Low = v
		}
		if v, ok := row[4].(float64); ok {
			candle.Close = v
		}
		if v, ok := row[5].(float64); ok {
			candle.Volume = int64(v)
		}
		candles = append(candles, candle)
	}
	return candles, nil
}

// FetchNIFTY fetches NIFTY candles via nearest Futures contract (NFO).
// interval: "5m", "15m", "1h", "1d". Supports up to 30 days for 5m, 60+ for others.
func (c *Client) FetchNIFTY(interval string, days int) ([]Candle, error) {
	fut := NearestNIFTYFutures()
	ist := time.FixedZone("IST", 5*3600+30*60)
	now := time.Now().In(ist)
	from := now.AddDate(0, 0, -days)
	from = time.Date(from.Year(), from.Month(), from.Day(), 9, 15, 0, 0, ist)
	return c.FetchCandles(fut.Token, fut.Exchange, interval, from, now)
}

// FetchNIFTY5m fetches last N days of NIFTY 5-min candles.
func (c *Client) FetchNIFTY5m(days int) ([]Candle, error) {
	return c.FetchNIFTY("5m", days)
}

// ─── Option Chain ─────────────────────────────────────────────────────────────

// OptionStrike holds key fields for one CE or PE strike.
type OptionStrike struct {
	StrikePrice float64 `json:"strikePrice"`
	ExpiryDate  string  `json:"expiryDate"`
	CE          *OptionLeg `json:"CE,omitempty"`
	PE          *OptionLeg `json:"PE,omitempty"`
}

// OptionLeg holds live quote data for one CE or PE.
type OptionLeg struct {
	LTP           float64 `json:"ltp"`
	OI            int64   `json:"openInterest"`
	ChangeInOI    int64   `json:"changeinOpenInterest"`
	Volume        int64   `json:"totalTradedVolume"`
	BidQty        int64   `json:"bidQty"`
	BidPrice      float64 `json:"bidPrice"`
	AskQty        int64   `json:"askQty"`
	AskPrice      float64 `json:"askPrice"`
	ImpliedVolatility float64 `json:"impliedVolatility"`
	Token         string  `json:"token"`
}

// OptionChainResult is what we return to the frontend.
type OptionChainResult struct {
	Expiry      string         `json:"expiry"`
	UnderlyingLTP float64     `json:"underlyingLTP"`
	ATM         float64        `json:"atm"`
	Strikes     []OptionStrike `json:"strikes"`
}

// FetchOptionChain fetches live option chain for NIFTY.
func (c *Client) FetchOptionChain(expiry string, strikeCount int) (*OptionChainResult, error) {
	if err := c.EnsureAuth(); err != nil {
		return nil, err
	}

	url := fmt.Sprintf("%s%s?name=NIFTY&expirydate=%s", baseURL, chainPath, expiry)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	c.setAuthHeaders(req)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("angelone: option chain: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	// Angel One returns a nested structure; parse generically
	var raw struct {
		Status  bool                     `json:"status"`
		Message string                   `json:"message"`
		Data    struct {
			Fetched   []map[string]interface{} `json:"fetched"`
			UnderlyingLTP float64              `json:"Underlying"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("angelone: option chain decode: %w", err)
	}
	if !raw.Status {
		return nil, fmt.Errorf("angelone: option chain: %s", raw.Message)
	}

	result := &OptionChainResult{
		Expiry:        expiry,
		UnderlyingLTP: raw.Data.UnderlyingLTP,
	}

	// Find ATM (nearest to underlying LTP)
	atm := roundToStrike(raw.Data.UnderlyingLTP, 50)
	result.ATM = atm

	// Parse strikes — show ATM ± strikeCount
	strikesMap := map[float64]*OptionStrike{}
	for _, row := range raw.Data.Fetched {
		sp, _ := row["strikePrice"].(float64)
		if sp < atm-float64(strikeCount)*50 || sp > atm+float64(strikeCount)*50 {
			continue
		}
		os, exists := strikesMap[sp]
		if !exists {
			os = &OptionStrike{StrikePrice: sp, ExpiryDate: expiry}
			strikesMap[sp] = os
		}
		optType, _ := row["optionType"].(string)
		leg := parseOptionLeg(row)
		if optType == "CE" {
			os.CE = leg
		} else if optType == "PE" {
			os.PE = leg
		}
	}

	for _, s := range strikesMap {
		result.Strikes = append(result.Strikes, *s)
	}
	return result, nil
}

// ─── Live Quote ───────────────────────────────────────────────────────────────

// QuoteResult holds the live price for a token.
type QuoteResult struct {
	Token  string  `json:"token"`
	LTP    float64 `json:"ltp"`
	Open   float64 `json:"open"`
	High   float64 `json:"high"`
	Low    float64 `json:"low"`
	Close  float64 `json:"close"`
	Volume int64   `json:"volume"`
}

// FetchQuote returns the live quote for a single token.
func (c *Client) FetchQuote(exchange, token string) (*QuoteResult, error) {
	if err := c.EnsureAuth(); err != nil {
		return nil, err
	}

	payload, _ := json.Marshal(map[string]interface{}{
		"mode": "FULL",
		"exchangeTokens": map[string][]string{
			exchange: {token},
		},
	})

	req, err := http.NewRequest("POST", baseURL+quotePath, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	c.setAuthHeaders(req)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("angelone: quote: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var raw struct {
		Status bool `json:"status"`
		Data   struct {
			Fetched []map[string]interface{} `json:"fetched"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	if !raw.Status || len(raw.Data.Fetched) == 0 {
		return nil, fmt.Errorf("angelone: quote empty")
	}

	row := raw.Data.Fetched[0]
	q := &QuoteResult{Token: token}
	if v, ok := row["ltp"].(float64); ok {
		q.LTP = v
	}
	if v, ok := row["open"].(float64); ok {
		q.Open = v
	}
	if v, ok := row["high"].(float64); ok {
		q.High = v
	}
	if v, ok := row["low"].(float64); ok {
		q.Low = v
	}
	if v, ok := row["close"].(float64); ok {
		q.Close = v
	}
	if v, ok := row["tradedQty"].(float64); ok {
		q.Volume = int64(v)
	}
	return q, nil
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func (c *Client) setBaseHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-UserType", "USER")
	req.Header.Set("X-SourceID", "WEB")
	req.Header.Set("X-ClientLocalIP", "127.0.0.1")
	req.Header.Set("X-ClientPublicIP", "127.0.0.1")
	req.Header.Set("X-MACAddress", "AA:BB:CC:DD:EE:FF")
	req.Header.Set("X-PrivateKey", c.cfg.APIKey)
}

func (c *Client) setAuthHeaders(req *http.Request) {
	c.setBaseHeaders(req)
	c.mu.RLock()
	req.Header.Set("Authorization", "Bearer "+c.jwtToken)
	c.mu.RUnlock()
}

func roundToStrike(price, step float64) float64 {
	return float64(int((price+step/2)/step)) * step
}

func parseOptionLeg(row map[string]interface{}) *OptionLeg {
	leg := &OptionLeg{}
	if v, ok := row["ltp"].(float64); ok {
		leg.LTP = v
	}
	if v, ok := row["openInterest"].(float64); ok {
		leg.OI = int64(v)
	}
	if v, ok := row["changeinOpenInterest"].(float64); ok {
		leg.ChangeInOI = int64(v)
	}
	if v, ok := row["totalTradedVolume"].(float64); ok {
		leg.Volume = int64(v)
	}
	if v, ok := row["bidQty"].(float64); ok {
		leg.BidQty = int64(v)
	}
	if v, ok := row["bidPrice"].(float64); ok {
		leg.BidPrice = v
	}
	if v, ok := row["askQty"].(float64); ok {
		leg.AskQty = int64(v)
	}
	if v, ok := row["askPrice"].(float64); ok {
		leg.AskPrice = v
	}
	if v, ok := row["impliedVolatility"].(float64); ok {
		leg.ImpliedVolatility = v
	}
	if v, ok := row["token"].(string); ok {
		leg.Token = v
	}
	return leg
}
