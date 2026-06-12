package kite

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/pquerna/otp/totp"
)

// ZerodhaCredentials holds the login credentials needed for automated daily
// token refresh. Stored in config.yaml under kite.zerodha_*.
// NEVER expose these in logs or API responses.
type ZerodhaCredentials struct {
	UserID     string // Zerodha client ID, e.g. "VGT549"
	Password   string // Zerodha login password
	TOTPSecret string // TOTP seed from the 2FA setup QR code
}

// AutoRefresh exchanges Zerodha credentials for a fresh Kite access token.
//
// Flow (no browser required):
//  1. GET login page → session cookies (Cloudflare + kf_session)
//  2. POST credentials → get request_id
//  3. Generate TOTP → POST to 2FA endpoint → get redirect with request_token
//  4. Exchange request_token for access_token via Kite Connect API
func (c *Client) AutoRefresh(creds ZerodhaCredentials) error {
	if creds.UserID == "" || creds.Password == "" || creds.TOTPSecret == "" {
		return fmt.Errorf("zerodha credentials incomplete (user_id/password/totp_secret all required)")
	}

	jar := &cookieJar{cookies: map[string][]*http.Cookie{}}
	client := &http.Client{
		Timeout:   20 * time.Second,
		Jar:       jar,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse // we handle redirects manually
		},
	}

	// ── Step 1: load login page to seed session cookies ──────────────────
	loginPageURL := fmt.Sprintf("https://kite.zerodha.com/connect/login?v=3&api_key=%s", c.apiKey)
	req1, _ := http.NewRequest("GET", loginPageURL, nil)
	req1.Header.Set("User-Agent", browserUA)
	if _, err := client.Do(req1); err != nil {
		return fmt.Errorf("step1 load login page: %w", err)
	}
	time.Sleep(500 * time.Millisecond)

	// ── Step 2: POST user credentials ────────────────────────────────────
	form2 := url.Values{"user_id": {creds.UserID}, "password": {creds.Password}}
	req2, _ := http.NewRequest("POST", "https://kite.zerodha.com/api/login",
		strings.NewReader(form2.Encode()))
	req2.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req2.Header.Set("User-Agent", browserUA)
	req2.Header.Set("Referer", loginPageURL)
	req2.Header.Set("X-Kite-Version", "3")

	resp2, err := client.Do(req2)
	if err != nil {
		return fmt.Errorf("step2 login POST: %w", err)
	}
	defer resp2.Body.Close()
	body2, _ := io.ReadAll(resp2.Body)

	var loginResp struct {
		Status string `json:"status"`
		Data   struct {
			RequestID string `json:"request_id"`
			UserID    string `json:"user_id"`
		} `json:"data"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body2, &loginResp); err != nil {
		return fmt.Errorf("step2 decode: %w (body: %s)", err, string(body2))
	}
	if loginResp.Status != "success" || loginResp.Data.RequestID == "" {
		return fmt.Errorf("step2 login failed: %s", loginResp.Message)
	}

	// ── Step 3: generate TOTP and complete 2FA ────────────────────────────
	totpCode, err := totp.GenerateCode(creds.TOTPSecret, time.Now().UTC())
	if err != nil {
		return fmt.Errorf("step3 TOTP generation: %w", err)
	}

	form3 := url.Values{
		"request_id":   {loginResp.Data.RequestID},
		"twofa_value":  {totpCode},
		"twofa_type":   {"totp"},
		"skip_session": {"true"},
	}
	req3, _ := http.NewRequest("POST", "https://kite.zerodha.com/api/twofa",
		strings.NewReader(form3.Encode()))
	req3.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req3.Header.Set("User-Agent", browserUA)
	req3.Header.Set("Referer", loginPageURL)
	req3.Header.Set("X-Kite-Version", "3")

	resp3, err := client.Do(req3)
	if err != nil {
		return fmt.Errorf("step3 2FA POST: %w", err)
	}
	defer resp3.Body.Close()
	body3, _ := io.ReadAll(resp3.Body)

	// The 2FA response either:
	//   a) Returns JSON with a redirect URL containing request_token
	//   b) Redirects directly to our callback URL
	var twoFAResp struct {
		Status string `json:"status"`
		Data   struct {
			Profile interface{} `json:"profile"`
		} `json:"data"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(body3, &twoFAResp)

	// Extract request_token from the Location redirect header
	reqToken := ""
	if loc := resp3.Header.Get("Location"); loc != "" {
		reqToken = extractRequestToken(loc)
	}
	// Also check body for the redirect URL pattern
	if reqToken == "" {
		reqToken = extractRequestToken(string(body3))
	}

	if reqToken == "" {
		// Try following the redirect to our callback
		if twoFAResp.Status == "success" {
			// The 2FA completed but token is in subsequent redirect
			// Follow to the connect/finish endpoint
			req4, _ := http.NewRequest("GET",
				fmt.Sprintf("https://kite.zerodha.com/connect/finish?api_key=%s", c.apiKey), nil)
			req4.Header.Set("User-Agent", browserUA)
			resp4, err := client.Do(req4)
			if err == nil {
				loc := resp4.Header.Get("Location")
				resp4.Body.Close()
				if loc != "" {
					reqToken = extractRequestToken(loc)
				}
			}
		}
	}

	if reqToken == "" {
		return fmt.Errorf("step3 could not extract request_token from 2FA response (status=%s msg=%s)",
			twoFAResp.Status, twoFAResp.Message)
	}

	// ── Step 4: exchange request_token for access_token ───────────────────
	return c.GenerateSession(reqToken)
}

// extractRequestToken parses a request_token= query parameter from a URL string.
func extractRequestToken(s string) string {
	// Try parsing as URL first
	if u, err := url.Parse(s); err == nil {
		if t := u.Query().Get("request_token"); t != "" {
			return t
		}
	}
	// Fall back to string search
	const marker = "request_token="
	idx := strings.Index(s, marker)
	if idx < 0 {
		return ""
	}
	rest := s[idx+len(marker):]
	end := strings.IndexAny(rest, "&\" \t\n'")
	if end < 0 {
		return rest
	}
	return rest[:end]
}

const browserUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// ─── Minimal cookie jar ──────────────────────────────────────────────────────

type cookieJar struct {
	cookies map[string][]*http.Cookie
}

func (j *cookieJar) SetCookies(u *url.URL, cookies []*http.Cookie) {
	j.cookies[u.Host] = append(j.cookies[u.Host], cookies...)
}
func (j *cookieJar) Cookies(u *url.URL) []*http.Cookie {
	return j.cookies[u.Host]
}
