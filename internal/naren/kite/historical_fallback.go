package kite

// Yahoo Finance fallback for historical candles.
//
// Kite Connect's historical-candles endpoint requires (a) a valid daily access
// token and (b) the paid "Historical Data" subscription on the app's API key.
// When either is missing Kite returns HTTP 403. To keep charts, backtests and
// the 90-day challenge working regardless, HistoricalData() falls back to the
// public Yahoo Finance chart API for the instruments mapped below.
//
// This file is intentionally self-contained (stdlib only) so the kite package
// stays decoupled from internal/data.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// yahooSymbolForToken maps a Kite instrument token to its Yahoo Finance symbol.
// Only instruments listed here can be served from the fallback; others error.
var yahooSymbolForToken = map[int]string{
	NiftyIndexToken: "^NSEI", // NIFTY 50 index
}

type yahooChartResponse struct {
	Chart struct {
		Result []struct {
			Timestamp  []int64 `json:"timestamp"`
			Indicators struct {
				Quote []struct {
					Open   []float64 `json:"open"`
					High   []float64 `json:"high"`
					Low    []float64 `json:"low"`
					Close  []float64 `json:"close"`
					Volume []int64   `json:"volume"`
				} `json:"quote"`
			} `json:"indicators"`
		} `json:"result"`
		Error *struct {
			Code        string `json:"code"`
			Description string `json:"description"`
		} `json:"error"`
	} `json:"chart"`
}

// yahooHistorical fetches candles from Yahoo Finance for a Kite instrument token.
func yahooHistorical(httpc *http.Client, token int, interval, from, to string) ([]Candle, error) {
	sym, ok := yahooSymbolForToken[token]
	if !ok {
		return nil, fmt.Errorf("no yahoo fallback symbol for kite token %d", token)
	}
	span := spanDays(from, to)
	yInt, yRange, ok := yahooIntervalRange(interval, span)
	if !ok {
		return nil, fmt.Errorf("interval %q unsupported by yahoo fallback", interval)
	}

	endpoint := fmt.Sprintf("https://query1.finance.yahoo.com/v8/finance/chart/%s", url.PathEscape(sym))
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	q := req.URL.Query()
	q.Set("interval", yInt)
	q.Set("range", yRange)
	q.Set("includePrePost", "false")
	req.URL.RawQuery = q.Encode()
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")

	resp, err := httpc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("yahoo fallback request: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var cr yahooChartResponse
	if err := json.Unmarshal(body, &cr); err != nil {
		return nil, fmt.Errorf("yahoo fallback parse: %w", err)
	}
	if cr.Chart.Error != nil {
		return nil, fmt.Errorf("yahoo fallback error: %s", cr.Chart.Error.Description)
	}
	if len(cr.Chart.Result) == 0 || len(cr.Chart.Result[0].Timestamp) == 0 ||
		len(cr.Chart.Result[0].Indicators.Quote) == 0 {
		return nil, fmt.Errorf("yahoo fallback: no data for %s", sym)
	}

	res := cr.Chart.Result[0]
	quote := res.Indicators.Quote[0]
	fromT, toT := parseISTRange(from, to)

	candles := make([]Candle, 0, len(res.Timestamp))
	for i, ts := range res.Timestamp {
		if i >= len(quote.Close) || quote.Close[i] == 0 {
			continue
		}
		t := time.Unix(ts, 0).UTC()
		if !fromT.IsZero() && t.Before(fromT) {
			continue
		}
		if !toT.IsZero() && t.After(toT) {
			continue
		}
		candles = append(candles, Candle{
			Time:   t,
			Open:   yfFloat(quote.Open, i),
			High:   yfFloat(quote.High, i),
			Low:    yfFloat(quote.Low, i),
			Close:  yfFloat(quote.Close, i),
			Volume: yfInt64(quote.Volume, i),
		})
	}

	// If date filtering removed everything (e.g. requested window predates the
	// data Yahoo will return for this interval), return the unfiltered series
	// rather than nothing.
	if len(candles) == 0 {
		for i, ts := range res.Timestamp {
			if i >= len(quote.Close) || quote.Close[i] == 0 {
				continue
			}
			candles = append(candles, Candle{
				Time:   time.Unix(ts, 0).UTC(),
				Open:   yfFloat(quote.Open, i),
				High:   yfFloat(quote.High, i),
				Low:    yfFloat(quote.Low, i),
				Close:  yfFloat(quote.Close, i),
				Volume: yfInt64(quote.Volume, i),
			})
		}
	}
	return candles, nil
}

// yahooIntervalRange maps a Kite interval to a Yahoo (interval, range) pair,
// clamped to Yahoo's intraday history limits.
func yahooIntervalRange(interval string, span int) (string, string, bool) {
	clamp := func(d, max int) string {
		if d < 1 {
			d = 1
		}
		if d > max {
			d = max
		}
		return fmt.Sprintf("%dd", d)
	}
	switch interval {
	case "minute", "1minute":
		return "1m", clamp(span+1, 7), true // Yahoo: 1m up to 7 days
	case "3minute", "5minute":
		return "5m", clamp(span+1, 59), true // Yahoo: 5m up to 60 days
	case "10minute", "15minute":
		return "15m", clamp(span+1, 59), true // Yahoo: 15m up to 60 days
	case "30minute":
		return "30m", clamp(span+1, 59), true
	case "60minute", "hour":
		return "60m", clamp(span+1, 729), true
	case "day":
		return "1d", dayRange(span), true
	}
	return "", "", false
}

func dayRange(span int) string {
	switch {
	case span <= 5:
		return "5d"
	case span <= 30:
		return "1mo"
	case span <= 90:
		return "3mo"
	case span <= 180:
		return "6mo"
	case span <= 365:
		return "1y"
	case span <= 730:
		return "2y"
	case span <= 1825:
		return "5y"
	default:
		return "max"
	}
}

// spanDays returns the number of days between two "2006-01-02 15:04:05" strings.
func spanDays(from, to string) int {
	f, ferr := time.Parse("2006-01-02 15:04:05", from)
	t, terr := time.Parse("2006-01-02 15:04:05", to)
	if ferr != nil || terr != nil {
		return 60
	}
	d := int(t.Sub(f).Hours()/24) + 1
	if d < 1 {
		return 1
	}
	return d
}

// parseISTRange parses the from/to bounds as IST wall-clock times. Returns zero
// times when parsing fails, signalling "do not filter".
func parseISTRange(from, to string) (time.Time, time.Time) {
	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		loc = time.FixedZone("IST", 5*3600+30*60)
	}
	f, ferr := time.ParseInLocation("2006-01-02 15:04:05", from, loc)
	t, terr := time.ParseInLocation("2006-01-02 15:04:05", to, loc)
	if ferr != nil {
		f = time.Time{}
	}
	if terr != nil {
		t = time.Time{}
	}
	return f.UTC(), t.UTC()
}

func yfFloat(arr []float64, i int) float64 {
	if i < len(arr) {
		return arr[i]
	}
	return 0
}

func yfInt64(arr []int64, i int) int64 {
	if i < len(arr) {
		return arr[i]
	}
	return 0
}
