package angelone

// ScripMaster — downloads and caches the Angel One instrument list.
// Used to find the current NIFTY/BANKNIFTY futures token for historical data.
// Cache TTL: 12 hours (tokens rarely change intraday).

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

const scripMasterURL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"

// ScripEntry is one row from the Angel One instrument master.
type ScripEntry struct {
	Token          string `json:"token"`
	Symbol         string `json:"symbol"`
	Name           string `json:"name"`
	Expiry         string `json:"expiry"`
	Strike         string `json:"strike"`
	LotSize        string `json:"lotsize"`
	InstrumentType string `json:"instrumenttype"`
	ExchSeg        string `json:"exch_seg"`
}

// FuturesInfo holds the resolved token for a futures contract.
type FuturesInfo struct {
	Token    string
	Exchange string // "NFO"
	Symbol   string
	Expiry   time.Time
	LotSize  int
}

var (
	smCache     []ScripEntry
	smCacheTime time.Time
	smMu        sync.RWMutex
)

// NearestNIFTYFutures returns the token for the nearest-expiry NIFTY futures.
// Falls back to hardcoded June 2026 token if scripmaster fetch fails.
func NearestNIFTYFutures() FuturesInfo {
	entries, err := loadScripMaster()
	if err != nil || len(entries) == 0 {
		// Hardcoded fallback — June 2026 expiry
		return FuturesInfo{Token: "62329", Exchange: "NFO", Symbol: "NIFTY30JUN26FUT", LotSize: 65}
	}

	now := time.Now()
	var candidates []FuturesInfo

	for _, e := range entries {
		if e.ExchSeg != "NFO" || e.InstrumentType != "FUTIDX" {
			continue
		}
		// Pure NIFTY (not BANKNIFTY, NIFTYNXT50, MIDCPNIFTY etc.)
		if e.Name != "Nifty 50" && !isNifty50(e.Symbol) {
			continue
		}
		exp := parseExpiryDate(e.Expiry)
		if exp.IsZero() || exp.Before(now.AddDate(0, 0, -1)) {
			continue // already expired
		}
		candidates = append(candidates, FuturesInfo{
			Token: e.Token, Exchange: "NFO", Symbol: e.Symbol, Expiry: exp,
		})
	}

	if len(candidates) == 0 {
		return FuturesInfo{Token: "62329", Exchange: "NFO", Symbol: "NIFTY30JUN26FUT", LotSize: 65}
	}

	// Sort by expiry — pick nearest
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].Expiry.Before(candidates[j].Expiry)
	})
	return candidates[0]
}

// isNifty50 returns true if the symbol is a pure NIFTY 50 futures contract.
func isNifty50(sym string) bool {
	if !strings.HasPrefix(sym, "NIFTY") {
		return false
	}
	// Exclude BANKNIFTY, NIFTYNXT50, NIFTYMIDCAP, FINNIFTY, etc.
	excludes := []string{"BANK", "NXT", "MID", "FIN", "IT", "AUTO", "PHARMA", "INFRA", "MEDIA", "REALTY", "CPSE", "DIV", "100", "200", "500"}
	upper := strings.ToUpper(sym)
	for _, ex := range excludes {
		if strings.Contains(upper, ex) {
			return false
		}
	}
	return true
}

// parseExpiryDate parses Angel One expiry strings like "30JUN2026" or "2026-06-30".
func parseExpiryDate(s string) time.Time {
	formats := []string{"02Jan2006", "02JAN2006", "2006-01-02", "02-Jan-2006"}
	for _, f := range formats {
		if t, err := time.Parse(f, s); err == nil {
			return t
		}
	}
	// Try uppercase month: "30JUN2026"
	if len(s) == 9 {
		s2 := s[:2] + strings.Title(strings.ToLower(s[2:5])) + s[5:]
		if t, err := time.Parse("02Jan2006", s2); err == nil {
			return t
		}
	}
	return time.Time{}
}

func loadScripMaster() ([]ScripEntry, error) {
	smMu.RLock()
	if time.Since(smCacheTime) < 12*time.Hour && len(smCache) > 0 {
		out := smCache
		smMu.RUnlock()
		return out, nil
	}
	smMu.RUnlock()

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(scripMasterURL)
	if err != nil {
		return nil, fmt.Errorf("scripmaster fetch: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var entries []ScripEntry
	if err := json.Unmarshal(body, &entries); err != nil {
		return nil, fmt.Errorf("scripmaster parse: %w", err)
	}

	smMu.Lock()
	smCache = entries
	smCacheTime = time.Now()
	smMu.Unlock()

	return entries, nil
}
