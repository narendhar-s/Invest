package data

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"time"
)

const (
	yahooChartURL   = "https://query1.finance.yahoo.com/v8/finance/chart/%s"
	yahooQuoteURL   = "https://query1.finance.yahoo.com/v7/finance/quote"
	yahooSummaryURL = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/%s"
)

// YahooClient is an HTTP client for Yahoo Finance APIs.
type YahooClient struct {
	http   *http.Client
	crumb  string
	cookie string
}

func NewYahooClient() *YahooClient {
	jar, _ := cookiejar.New(nil)
	c := &YahooClient{
		http: &http.Client{
			Timeout: 30 * time.Second,
			Jar:     jar,
		},
	}
	c.initCrumb()
	return c
}

// initCrumb fetches a session cookie and crumb for authenticated Yahoo APIs (v10).
func (y *YahooClient) initCrumb() {
	// Step 1: establish cookie session
	req, _ := http.NewRequest("GET", "https://fc.yahoo.com", nil)
	y.setHeaders(req)
	resp, err := y.http.Do(req)
	if err != nil {
		return
	}
	resp.Body.Close()

	// Step 2: fetch crumb
	req, _ = http.NewRequest("GET", "https://query2.finance.yahoo.com/v1/test/getcrumb", nil)
	y.setHeaders(req)
	resp, err = y.http.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	crumb := strings.TrimSpace(string(body))
	if crumb != "" && !strings.Contains(crumb, "Too Many") && !strings.Contains(crumb, "<") {
		y.crumb = crumb
	}
}

// ─── Chart (OHLCV) ────────────────────────────────────────────────────────────

type ChartBar struct {
	Time     time.Time
	Open     float64
	High     float64
	Low      float64
	Close    float64
	AdjClose float64
	Volume   int64
}

type chartResponse struct {
	Chart struct {
		Result []struct {
			Meta struct {
				Symbol             string  `json:"symbol"`
				Currency           string  `json:"currency"`
				ExchangeName       string  `json:"exchangeName"`
				RegularMarketPrice float64 `json:"regularMarketPrice"`
			} `json:"meta"`
			Timestamp  []int64 `json:"timestamp"`
			Indicators struct {
				Quote []struct {
					Open   []float64 `json:"open"`
					High   []float64 `json:"high"`
					Low    []float64 `json:"low"`
					Close  []float64 `json:"close"`
					Volume []int64   `json:"volume"`
				} `json:"quote"`
				Adjclose []struct {
					Adjclose []float64 `json:"adjclose"`
				} `json:"adjclose"`
			} `json:"indicators"`
		} `json:"result"`
		Error *struct {
			Code        string `json:"code"`
			Description string `json:"description"`
		} `json:"error"`
	} `json:"chart"`
}

// FetchChart retrieves OHLCV data for a symbol.
// interval: "1d","1wk","1mo" | range: "1y","2y","5y","max" | "5d" for intraday
func (y *YahooClient) FetchChart(symbol, interval, rangeStr string) ([]ChartBar, string, string, error) {
	endpoint := fmt.Sprintf(yahooChartURL, url.PathEscape(symbol))
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, "", "", err
	}

	q := req.URL.Query()
	q.Set("interval", interval)
	q.Set("range", rangeStr)
	q.Set("includePrePost", "false")
	q.Set("events", "div,splits")
	req.URL.RawQuery = q.Encode()

	y.setHeaders(req)

	resp, err := y.http.Do(req)
	if err != nil {
		return nil, "", "", fmt.Errorf("fetching chart %s: %w", symbol, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", "", err
	}

	var cr chartResponse
	if err := json.Unmarshal(body, &cr); err != nil {
		return nil, "", "", fmt.Errorf("parsing chart %s: %w", symbol, err)
	}

	if cr.Chart.Error != nil {
		return nil, "", "", fmt.Errorf("yahoo error for %s: %s", symbol, cr.Chart.Error.Description)
	}

	if len(cr.Chart.Result) == 0 {
		return nil, "", "", fmt.Errorf("no chart data for %s", symbol)
	}

	result := cr.Chart.Result[0]
	if len(result.Timestamp) == 0 {
		return nil, "", "", fmt.Errorf("empty timestamp array for %s", symbol)
	}

	quote := result.Indicators.Quote[0]
	var adjclose []float64
	if len(result.Indicators.Adjclose) > 0 {
		adjclose = result.Indicators.Adjclose[0].Adjclose
	}

	bars := make([]ChartBar, 0, len(result.Timestamp))
	for i, ts := range result.Timestamp {
		if i >= len(quote.Close) || quote.Close[i] == 0 {
			continue
		}
		bar := ChartBar{
			Time:   time.Unix(ts, 0).UTC(),
			Open:   safeFloat(quote.Open, i),
			High:   safeFloat(quote.High, i),
			Low:    safeFloat(quote.Low, i),
			Close:  safeFloat(quote.Close, i),
			Volume: safeInt64(quote.Volume, i),
		}
		if len(adjclose) > i && adjclose[i] != 0 {
			bar.AdjClose = adjclose[i]
		} else {
			bar.AdjClose = bar.Close
		}
		bars = append(bars, bar)
	}

	currency := result.Meta.Currency
	exchange := result.Meta.ExchangeName
	return bars, currency, exchange, nil
}

// ─── Quote (current price snapshot) ─────────────────────────────────────────

type QuoteData struct {
	Symbol             string  `json:"symbol"`
	ShortName          string  `json:"shortName"`
	LongName           string  `json:"longName"`
	RegularMarketPrice float64 `json:"regularMarketPrice"`
	MarketCap          float64 `json:"marketCap"`
	Currency           string  `json:"currency"`
	Exchange           string  `json:"fullExchangeName"`
	Sector             string  `json:"sector"`
	Industry           string  `json:"industry"`
}

type quoteResponse struct {
	QuoteResponse struct {
		Result []QuoteData `json:"result"`
		Error  interface{} `json:"error"`
	} `json:"quoteResponse"`
}

func (y *YahooClient) FetchQuotes(symbols []string) ([]QuoteData, error) {
	req, err := http.NewRequest("GET", yahooQuoteURL, nil)
	if err != nil {
		return nil, err
	}
	q := req.URL.Query()
	q.Set("symbols", strings.Join(symbols, ","))
	q.Set("fields", "symbol,shortName,longName,regularMarketPrice,marketCap,currency,fullExchangeName,sector,industry")
	req.URL.RawQuery = q.Encode()
	y.setHeaders(req)

	resp, err := y.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetching quotes: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var qr quoteResponse
	if err := json.Unmarshal(body, &qr); err != nil {
		return nil, fmt.Errorf("parsing quotes: %w", err)
	}

	return qr.QuoteResponse.Result, nil
}

// ─── Summary (fundamentals) ───────────────────────────────────────────────────

type SummaryData struct {
	Symbol        string
	PERatio       *float64
	ForwardPE     *float64
	EPS           *float64
	EPSGrowth     *float64
	RevenueGrowth *float64
	DebtEquity    *float64
	ROE           *float64
	ROA           *float64
	MarketCap     *float64
	DividendYield *float64
	PriceToBook   *float64
	ProfitMargin  *float64
}

type summaryResponse struct {
	QuoteSummary struct {
		Result []struct {
			SummaryDetail struct {
				TrailingPE    valueWrapper `json:"trailingPE"`
				ForwardPE     valueWrapper `json:"forwardPE"`
				DividendYield valueWrapper `json:"dividendYield"`
				MarketCap     valueWrapper `json:"marketCap"`
				PriceToBook   valueWrapper `json:"priceToBook"`
			} `json:"summaryDetail"`
			FinancialData struct {
				RevenueGrowth valueWrapper `json:"revenueGrowth"`
				EarningsGrowth valueWrapper `json:"earningsGrowth"`
				DebtToEquity  valueWrapper `json:"debtToEquity"`
				ReturnOnEquity valueWrapper `json:"returnOnEquity"`
				ReturnOnAssets valueWrapper `json:"returnOnAssets"`
				ProfitMargins valueWrapper `json:"profitMargins"`
			} `json:"financialData"`
			DefaultKeyStatistics struct {
				TrailingEps   valueWrapper `json:"trailingEps"`
				ForwardEps    valueWrapper `json:"forwardEps"`
			} `json:"defaultKeyStatistics"`
		} `json:"result"`
		Error interface{} `json:"error"`
	} `json:"quoteSummary"`
}

type valueWrapper struct {
	Raw *float64 `json:"raw"`
}

func (y *YahooClient) FetchSummary(symbol string) (*SummaryData, error) {
	// Use query2 domain with crumb for authenticated access
	endpoint := fmt.Sprintf("https://query2.finance.yahoo.com/v10/finance/quoteSummary/%s", url.PathEscape(symbol))
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, err
	}

	q := req.URL.Query()
	q.Set("modules", "summaryDetail,financialData,defaultKeyStatistics")
	if y.crumb != "" {
		q.Set("crumb", y.crumb)
	}
	req.URL.RawQuery = q.Encode()
	y.setHeaders(req)

	resp, err := y.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetching summary %s: %w", symbol, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		// Crumb expired — refresh and retry once
		resp.Body.Close()
		y.initCrumb()
		if y.crumb != "" {
			q2 := req.URL.Query()
			q2.Set("crumb", y.crumb)
			req.URL.RawQuery = q2.Encode()
			resp, err = y.http.Do(req)
			if err != nil {
				return nil, fmt.Errorf("retry fetching summary %s: %w", symbol, err)
			}
			defer resp.Body.Close()
		}
	}
	if resp.StatusCode == 404 || resp.StatusCode == 429 {
		return nil, fmt.Errorf("yahoo returned %d for %s", resp.StatusCode, symbol)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var sr summaryResponse
	if err := json.Unmarshal(body, &sr); err != nil {
		return nil, fmt.Errorf("parsing summary %s: %w", symbol, err)
	}

	if len(sr.QuoteSummary.Result) == 0 {
		return nil, fmt.Errorf("no summary data for %s", symbol)
	}

	res := sr.QuoteSummary.Result[0]
	sd := res.SummaryDetail
	fd := res.FinancialData
	ks := res.DefaultKeyStatistics

	return &SummaryData{
		Symbol:        symbol,
		PERatio:       sd.TrailingPE.Raw,
		ForwardPE:     sd.ForwardPE.Raw,
		EPS:           ks.TrailingEps.Raw,
		EPSGrowth:     fd.EarningsGrowth.Raw,
		RevenueGrowth: fd.RevenueGrowth.Raw,
		DebtEquity:    fd.DebtToEquity.Raw,
		ROE:           fd.ReturnOnEquity.Raw,
		ROA:           fd.ReturnOnAssets.Raw,
		MarketCap:     sd.MarketCap.Raw,
		DividendYield: sd.DividendYield.Raw,
		PriceToBook:   sd.PriceToBook.Raw,
		ProfitMargin:  fd.ProfitMargins.Raw,
	}, nil
}

// FetchIntradayBars fetches intraday OHLCV bars for scalping signals.
// interval: "1m", "5m", "15m"  — Yahoo returns up to 7 days for 1m, 60 days for 5m/15m
func (y *YahooClient) FetchIntradayBars(symbol, interval string) ([]ChartBar, error) {
	rangeStr := "5d"
	if interval == "5m" || interval == "15m" {
		rangeStr = "10d"
	}
	bars, _, _, err := y.FetchChart(symbol, interval, rangeStr)
	return bars, err
}

func (y *YahooClient) setHeaders(req *http.Request) {
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
}

func safeFloat(arr []float64, i int) float64 {
	if i < len(arr) {
		return arr[i]
	}
	return 0
}

func safeInt64(arr []int64, i int) int64 {
	if i < len(arr) {
		return arr[i]
	}
	return 0
}
