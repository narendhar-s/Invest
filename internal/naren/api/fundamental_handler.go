package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"stockwise/internal/naren/analysis/fundamental"
	"stockwise/internal/naren/screener"
	"stockwise/internal/naren/storage"
)

var screenerClient = screener.NewClient()

// ─── Response Types ───────────────────────────────────────────────────────────

type FundamentalSearchResult struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	URL       string `json:"url"`
	MarketCap string `json:"market_cap"`
	Symbol    string `json:"symbol"`
}

type FundamentalAnalysis struct {
	Symbol      string `json:"symbol"`
	Name        string `json:"name"`
	Market      string `json:"market"`
	Sector      string `json:"sector"`
	GeneratedAt string `json:"generated_at"`

	// Price
	CurrentPrice  float64 `json:"current_price"`
	MarketCapCr   float64 `json:"market_cap_cr"`
	High52W       float64 `json:"high_52w"`
	Low52W        float64 `json:"low_52w"`
	PriceFromHigh float64 `json:"price_from_high_pct"`

	// Warren Buffett Scorecard
	BuffettScore fundamental.BuffettScore `json:"buffett_score"`

	// Screener.in data
	ScreenerData *screener.CompanyData `json:"screener_data,omitempty"`

	// DB fundamentals (Yahoo Finance)
	Fundamentals *storage.Fundamental `json:"fundamentals,omitempty"`

	// Technical signals from DB
	Technical *TechSummary `json:"technical,omitempty"`

	// Peer comparison (other stocks in same sector)
	Peers []PeerStock `json:"peers,omitempty"`
}

type TechSummary struct {
	RSI            float64 `json:"rsi"`
	MACD           float64 `json:"macd"`
	MACDSignal     string  `json:"macd_signal"` // BULLISH | BEARISH
	Trend          string  `json:"trend"`
	SMA20          float64 `json:"sma20"`
	SMA50          float64 `json:"sma50"`
	SMA200         float64 `json:"sma200"`
	AboveSMA200    bool    `json:"above_sma200"`
	TechnicalScore float64 `json:"technical_score"`
	Signal         string  `json:"signal"` // BUY | SELL | HOLD
}

type PeerStock struct {
	Symbol          string  `json:"symbol"`
	Name            string  `json:"name"`
	PERatio         float64 `json:"pe_ratio"`
	ROE             float64 `json:"roe"`
	MarketCapCr     float64 `json:"market_cap_cr"`
	FundamentalScore float64 `json:"fundamental_score"`
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

// FundamentalSearch handles GET /api/v1/fundamental/search?q={query}
func (h *Handler) FundamentalSearch(c *gin.Context) {
	query := strings.TrimSpace(c.Query("q"))
	if query == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "query parameter 'q' required"})
		return
	}

	results, err := screenerClient.Search(query)
	if err != nil {
		// Fall back to DB search
		dbResults := h.searchStocksFromDB(query)
		c.JSON(http.StatusOK, gin.H{"results": dbResults, "source": "db"})
		return
	}

	out := make([]FundamentalSearchResult, 0, len(results))
	for _, r := range results {
		sym := extractSymbolFromURL(r.URL)
		out = append(out, FundamentalSearchResult{
			ID:        r.ID,
			Name:      r.Name,
			URL:       r.URL,
			MarketCap: r.MarketCap,
			Symbol:    sym,
		})
	}
	c.JSON(http.StatusOK, gin.H{"results": out, "source": "screener"})
}

// FundamentalAnalyze handles GET /api/v1/fundamental/analyze/:symbol
func (h *Handler) FundamentalAnalyze(c *gin.Context) {
	rawSymbol := c.Param("symbol")
	if rawSymbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol required"})
		return
	}

	// Normalize symbol — strip leading slash if any
	sym := strings.TrimPrefix(rawSymbol, "/")

	analysis := FundamentalAnalysis{
		Symbol:      sym,
		GeneratedAt: time.Now().Format(time.RFC3339),
	}

	// ── 1. Load from DB ────────────────────────────────────────────────────
	// Try exact match, then with .NS suffix for NSE stocks
	stock, fundamentals, tech := h.loadFromDB(sym)
	if stock == nil {
		// Try with .NS suffix
		stock, fundamentals, tech = h.loadFromDB(sym + ".NS")
	}

	if stock != nil {
		analysis.Name = stock.Name
		analysis.Market = stock.Market
		analysis.Sector = stock.Sector
		if fundamentals != nil {
			analysis.Fundamentals = fundamentals
			if fundamentals.MarketCap != nil {
				analysis.MarketCapCr = *fundamentals.MarketCap / 1e7 // Convert to Crores (assuming stored in rupees)
			}
		}
		if tech != nil {
			analysis.Technical = buildTechSummary(tech, 0)
		}
	}

	// ── 2. Fetch from Screener.in (Indian stocks) ──────────────────────────
	isIndian := !strings.Contains(sym, ".") || strings.HasSuffix(sym, ".NS") || strings.HasSuffix(sym, ".BO")
	// Pure symbol without exchange suffix is treated as Indian
	if isIndian {
		cleanSym := strings.TrimSuffix(strings.TrimSuffix(sym, ".NS"), ".BO")

		// Use the screener_url query param if the frontend passes it directly (avoids an extra search round-trip)
		screenerURL := c.Query("screener_url")
		var results []screener.SearchResult
		if screenerURL != "" {
			results = []screener.SearchResult{{URL: screenerURL, Name: analysis.Name}}
		} else {
			if r, err2 := screenerClient.Search(cleanSym); err2 == nil {
				results = r
			}
		}

		if len(results) > 0 {
			// Use the top result
			cd, err := screenerClient.FetchCompany(results[0].URL)
			if err == nil && cd != nil {
				analysis.ScreenerData = cd
				if analysis.Name == "" {
					analysis.Name = cd.Name
				}
				if cd.CurrentPrice > 0 {
					analysis.CurrentPrice = cd.CurrentPrice
				}
				if cd.MarketCap > 0 {
					analysis.MarketCapCr = cd.MarketCap
				}
				analysis.High52W = cd.High52W
				analysis.Low52W = cd.Low52W
				if cd.High52W > 0 && cd.CurrentPrice > 0 {
					analysis.PriceFromHigh = (cd.High52W - cd.CurrentPrice) / cd.High52W * 100
				}
				if analysis.Market == "" {
					analysis.Market = "NSE"
				}
			}
		}
	}

	// ── 2b. Fill 52W range from DB price bars if screener didn't provide it ─
	if analysis.High52W == 0 && stock != nil {
		to := time.Now()
		from := to.AddDate(-1, 0, 0)
		if bars, err := h.repo.GetPriceBars(stock.ID, from, to); err == nil && len(bars) > 0 {
			hi, lo := bars[0].High, bars[0].Low
			for _, b := range bars {
				if b.High > hi { hi = b.High }
				if b.Low < lo  { lo = b.Low  }
			}
			analysis.High52W = hi
			analysis.Low52W = lo
			if hi > 0 && analysis.CurrentPrice > 0 {
				analysis.PriceFromHigh = (hi - analysis.CurrentPrice) / hi * 100
			}
		}
	}

	// ── 3. Apply Warren Buffett scoring ────────────────────────────────────
	analysis.BuffettScore = fundamental.ScoreBuffett(fundamentals, analysis.ScreenerData)

	// ── 4. Load peers from same sector ────────────────────────────────────
	if analysis.Sector != "" {
		analysis.Peers = h.loadPeers(analysis.Sector, sym)
	}

	c.JSON(http.StatusOK, analysis)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func (h *Handler) loadFromDB(sym string) (*storage.Stock, *storage.Fundamental, *storage.TechnicalIndicator) {
	stock, err := h.repo.GetStockBySymbol(sym)
	if err != nil || stock == nil {
		return nil, nil, nil
	}

	fundamentals, _ := h.repo.GetFundamental(stock.ID)
	tech, _ := h.repo.GetLatestTechnicalIndicator(stock.ID)
	return stock, fundamentals, tech
}

func buildTechSummary(t *storage.TechnicalIndicator, price float64) *TechSummary {
	if t == nil {
		return nil
	}
	ts := &TechSummary{TechnicalScore: t.TechnicalScore, Trend: t.TrendDirection}
	if t.RSI != nil {
		ts.RSI = *t.RSI
	}
	if t.MACDHist != nil {
		ts.MACD = *t.MACDHist
		if *t.MACDHist > 0 {
			ts.MACDSignal = "BULLISH"
		} else {
			ts.MACDSignal = "BEARISH"
		}
	}
	if t.SMA20 != nil {
		ts.SMA20 = *t.SMA20
	}
	if t.SMA50 != nil {
		ts.SMA50 = *t.SMA50
	}
	if t.SMA200 != nil {
		ts.SMA200 = *t.SMA200
		if price > 0 {
			ts.AboveSMA200 = price > *t.SMA200
		}
	}
	// Signal from score + trend
	switch {
	case t.TechnicalScore >= 65 && t.TrendDirection == "UP":
		ts.Signal = "BUY"
	case t.TechnicalScore <= 35 || t.TrendDirection == "DOWN":
		ts.Signal = "SELL"
	default:
		ts.Signal = "HOLD"
	}
	return ts
}

func (h *Handler) loadPeers(sector, excludeSym string) []PeerStock {
	stocks, err := h.repo.GetAllStocks()
	if err != nil {
		return nil
	}
	var peers []PeerStock
	for _, s := range stocks {
		if s.Sector != sector || s.Symbol == excludeSym || s.Symbol == excludeSym+".NS" {
			continue
		}
		f, _ := h.repo.GetFundamental(s.ID)
		peer := PeerStock{Symbol: s.Symbol, Name: s.Name}
		if peer.Name == "" {
			peer.Name = s.Symbol
		}
		if f != nil {
			if f.PERatio != nil {
				peer.PERatio = *f.PERatio
			}
			if f.ROE != nil {
				peer.ROE = *f.ROE * 100
			}
			if f.MarketCap != nil {
				peer.MarketCapCr = *f.MarketCap / 1e7
			}
			peer.FundamentalScore = f.FundamentalScore
		}
		peers = append(peers, peer)
		if len(peers) >= 5 {
			break
		}
	}
	return peers
}

func (h *Handler) searchStocksFromDB(query string) []FundamentalSearchResult {
	stocks, err := h.repo.GetAllStocks()
	if err != nil {
		return nil
	}
	query = strings.ToLower(query)
	var results []FundamentalSearchResult
	for _, s := range stocks {
		if strings.Contains(strings.ToLower(s.Symbol), query) ||
			strings.Contains(strings.ToLower(s.Name), query) {
			results = append(results, FundamentalSearchResult{
				Symbol: s.Symbol,
				Name:   s.Name,
			})
			if len(results) >= 10 {
				break
			}
		}
	}
	return results
}

func extractSymbolFromURL(urlPath string) string {
	parts := strings.Split(strings.Trim(urlPath, "/"), "/")
	for i, p := range parts {
		if strings.EqualFold(p, "company") && i+1 < len(parts) {
			return parts[i+1]
		}
	}
	return ""
}
