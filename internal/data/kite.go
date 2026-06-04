package data

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	kiteAPIBase   = "https://api.kite.trade"
	kiteLoginBase = "https://kite.zerodha.com/connect/login"
)

// KiteQuote is a live price snapshot for one NSE symbol.
type KiteQuote struct {
	Symbol    string  `json:"symbol"`      // Yahoo-format, e.g. RELIANCE.NS
	LastPrice float64 `json:"last_price"`
	Open      float64 `json:"open"`
	High      float64 `json:"high"`
	Low       float64 `json:"low"`
	Close     float64 `json:"close"`      // previous day close
	Change    float64 `json:"change"`
	ChangePct float64 `json:"change_pct"`
	Volume    int64   `json:"volume"`
	Timestamp string  `json:"timestamp"`
}

// KiteClient handles Zerodha Kite Connect REST API interactions.
type KiteClient struct {
	apiKey      string
	apiSecret   string
	mu          sync.RWMutex
	accessToken string
	httpClient  *http.Client
}

func NewKiteClient(apiKey, apiSecret string) *KiteClient {
	return &KiteClient{
		apiKey:    apiKey,
		apiSecret: apiSecret,
		httpClient: &http.Client{Timeout: 15 * time.Second},
	}
}

// LoginURL returns the Zerodha OAuth login page URL.
func (k *KiteClient) LoginURL(redirectURL string) string {
	return fmt.Sprintf("%s?api_key=%s&v=3", kiteLoginBase, k.apiKey)
}

// IsConnected returns true when a valid access token is held.
func (k *KiteClient) IsConnected() bool {
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.accessToken != ""
}

// SetAccessToken stores an access token.
func (k *KiteClient) SetAccessToken(token string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.accessToken = token
}

// GetAccessToken returns the current token.
func (k *KiteClient) GetAccessToken() string {
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.accessToken
}

// ExchangeToken exchanges a Zerodha request_token for an access_token.
// Checksum = SHA-256(api_key + request_token + api_secret).
func (k *KiteClient) ExchangeToken(requestToken string) (string, error) {
	raw := k.apiKey + requestToken + k.apiSecret
	h := sha256.Sum256([]byte(raw))
	checksum := fmt.Sprintf("%x", h)

	form := url.Values{}
	form.Set("api_key", k.apiKey)
	form.Set("request_token", requestToken)
	form.Set("checksum", checksum)

	req, err := http.NewRequest("POST", kiteAPIBase+"/session/token",
		strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("X-Kite-Version", "3")
	req.Header.Set("Authorization", "token "+k.apiKey+":")

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("token exchange request: %w", err)
	}
	defer resp.Body.Close()

	var out struct {
		Status  string `json:"status"`
		Message string `json:"message"`
		Data    struct {
			AccessToken string `json:"access_token"`
			UserID      string `json:"user_id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("parsing token response: %w", err)
	}
	if out.Status != "success" {
		return "", fmt.Errorf("kite token exchange: %s", out.Message)
	}
	return out.Data.AccessToken, nil
}

// FetchLiveQuotes returns live quotes for a slice of Kite instrument keys (e.g. "NSE:RELIANCE").
func (k *KiteClient) FetchLiveQuotes(instruments []string) (map[string]KiteQuote, error) {
	token := k.GetAccessToken()
	if token == "" {
		return nil, fmt.Errorf("zerodha: not authenticated")
	}

	req, err := http.NewRequest("GET", kiteAPIBase+"/quote", nil)
	if err != nil {
		return nil, err
	}
	q := req.URL.Query()
	for _, inst := range instruments {
		q.Add("i", inst)
	}
	req.URL.RawQuery = q.Encode()
	k.setAuth(req, token)

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("kite quote fetch: %w", err)
	}
	defer resp.Body.Close()

	var out struct {
		Status  string                  `json:"status"`
		Message string                  `json:"message"`
		Data    map[string]kiteRawQuote `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("parsing kite quotes: %w", err)
	}
	if out.Status != "success" {
		// Access token may have expired
		if strings.Contains(out.Message, "token") || resp.StatusCode == 403 {
			k.SetAccessToken("")
		}
		return nil, fmt.Errorf("kite quote error: %s", out.Message)
	}

	quotes := make(map[string]KiteQuote, len(out.Data))
	for kiteKey, raw := range out.Data {
		prevClose := raw.OHLC.Close
		change := raw.LastPrice - prevClose
		changePct := 0.0
		if prevClose > 0 {
			changePct = (change / prevClose) * 100
		}
		ySymbol := kiteKeyToYahoo(kiteKey)
		quotes[ySymbol] = KiteQuote{
			Symbol:    ySymbol,
			LastPrice: raw.LastPrice,
			Open:      raw.OHLC.Open,
			High:      raw.OHLC.High,
			Low:       raw.OHLC.Low,
			Close:     prevClose,
			Change:    change,
			ChangePct: changePct,
			Volume:    raw.Volume,
			Timestamp: time.Now().Format(time.RFC3339),
		}
	}
	return quotes, nil
}

// YahooToKite converts a Yahoo Finance symbol to a Kite instrument key.
// RELIANCE.NS → NSE:RELIANCE,  SBIN.NS → NSE:SBIN
func YahooToKite(ySymbol string) string {
	if strings.HasSuffix(ySymbol, ".NS") {
		return "NSE:" + strings.TrimSuffix(ySymbol, ".NS")
	}
	if strings.HasSuffix(ySymbol, ".BO") {
		return "BSE:" + strings.TrimSuffix(ySymbol, ".BO")
	}
	return "" // US symbols not handled by Zerodha
}

func kiteKeyToYahoo(kiteKey string) string {
	parts := strings.SplitN(kiteKey, ":", 2)
	if len(parts) != 2 {
		return kiteKey
	}
	switch parts[0] {
	case "NSE":
		return parts[1] + ".NS"
	case "BSE":
		return parts[1] + ".BO"
	default:
		return parts[1]
	}
}

func (k *KiteClient) setAuth(req *http.Request, accessToken string) {
	req.Header.Set("X-Kite-Version", "3")
	req.Header.Set("Authorization", "token "+k.apiKey+":"+accessToken)
}

// kiteRawQuote is the raw Zerodha quote payload.
type kiteRawQuote struct {
	LastPrice float64  `json:"last_price"`
	Volume    int64    `json:"volume"`
	OHLC      kiteOHLC `json:"ohlc"`
}

type kiteOHLC struct {
	Open  float64 `json:"open"`
	High  float64 `json:"high"`
	Low   float64 `json:"low"`
	Close float64 `json:"close"` // previous close
}
