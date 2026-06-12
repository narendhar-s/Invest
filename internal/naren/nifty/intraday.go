package nifty

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"time"
)

// IntradayBar is one OHLCV bar at sub-daily granularity.
type IntradayBar struct {
	Time   time.Time `json:"time"`
	Open   float64   `json:"open"`
	High   float64   `json:"high"`
	Low    float64   `json:"low"`
	Close  float64   `json:"close"`
	Volume int64     `json:"volume"`
}

type yahooChartResp struct {
	Chart struct {
		Result []struct {
			Meta struct {
				RegularMarketPrice float64 `json:"regularMarketPrice"`
			} `json:"meta"`
			Timestamp  []int64 `json:"timestamp"`
			Indicators struct {
				Quote []struct {
					Open   []*float64 `json:"open"`
					High   []*float64 `json:"high"`
					Low    []*float64 `json:"low"`
					Close  []*float64 `json:"close"`
					Volume []*float64 `json:"volume"`
				} `json:"quote"`
			} `json:"indicators"`
		} `json:"result"`
		Error *struct {
			Code        string `json:"code"`
			Description string `json:"description"`
		} `json:"error"`
	} `json:"chart"`
}

// fetchYahooChart is the core HTTP fetch for any Yahoo Finance symbol + interval + range.
func fetchYahooChart(symbol, interval, rangeStr string) ([]IntradayBar, bool /* isIntraday */, error) {
	encodedSymbol := url.PathEscape(symbol)
	endpoint := fmt.Sprintf(
		"https://query1.finance.yahoo.com/v8/finance/chart/%s?interval=%s&range=%s&includePrePost=false",
		encodedSymbol, interval, rangeStr,
	)

	client := &http.Client{Timeout: 20 * time.Second}
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("yahoo finance fetch: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, false, fmt.Errorf("yahoo finance returned %d for %s", resp.StatusCode, symbol)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, false, err
	}

	var yr yahooChartResp
	if err := json.Unmarshal(body, &yr); err != nil {
		return nil, false, fmt.Errorf("yahoo parse: %w", err)
	}
	if yr.Chart.Error != nil {
		return nil, false, fmt.Errorf("yahoo: %s – %s", yr.Chart.Error.Code, yr.Chart.Error.Description)
	}
	if len(yr.Chart.Result) == 0 || len(yr.Chart.Result[0].Indicators.Quote) == 0 {
		return nil, false, fmt.Errorf("no data returned by Yahoo Finance for %s", symbol)
	}

	r := yr.Chart.Result[0]
	q := r.Indicators.Quote[0]
	ist := time.FixedZone("IST", 5*3600+30*60)

	isIntraday := interval == "5m" || interval == "15m"

	var bars []IntradayBar
	for i, ts := range r.Timestamp {
		if i >= len(q.Close) || q.Close[i] == nil || q.Open[i] == nil {
			continue
		}
		o := safePtr(q.Open, i)
		h := safePtr(q.High, i)
		l := safePtr(q.Low, i)
		c := *q.Close[i]
		vol := int64(safePtr(q.Volume, i))
		if o == 0 || c == 0 {
			continue
		}

		t := time.Unix(ts, 0).In(ist)

		// Filter to NSE market hours for intraday bars (09:15 – 15:30 IST)
		if isIntraday {
			h24 := t.Hour()*60 + t.Minute()
			if h24 < 9*60+15 || h24 >= 15*60+30 {
				continue
			}
		}

		bars = append(bars, IntradayBar{
			Time:   t,
			Open:   math.Round(o*100) / 100,
			High:   math.Round(h*100) / 100,
			Low:    math.Round(l*100) / 100,
			Close:  math.Round(c*100) / 100,
			Volume: vol,
		})
	}

	if len(bars) == 0 {
		return nil, isIntraday, fmt.Errorf("no valid bars after filtering for %s", symbol)
	}
	return bars, isIntraday, nil
}

// FetchIntradayBars downloads intraday bars for ^NSEI at the given interval.
// interval: "5m" or "15m". Yahoo Finance limits: 5m → 7d, 15m → 60d.
func FetchIntradayBars(interval string) ([]IntradayBar, error) {
	return FetchIntradayBarsForSymbol("^NSEI", interval)
}

// FetchIntradayBarsForSymbol downloads intraday bars for any Yahoo Finance symbol.
func FetchIntradayBarsForSymbol(symbol, interval string) ([]IntradayBar, error) {
	rangeStr := "7d"
	if interval == "15m" {
		rangeStr = "60d"
	}
	bars, _, err := fetchYahooChart(symbol, interval, rangeStr)
	return bars, err
}

// fetchYahooChartPeriod fetches bars using explicit period1/period2 (Unix timestamps).
// This lets us fetch 5m data for specific 7-day windows beyond the last 7 days.
func fetchYahooChartPeriod(symbol, interval string, from, to time.Time) ([]IntradayBar, error) {
	encodedSymbol := url.PathEscape(symbol)
	endpoint := fmt.Sprintf(
		"https://query1.finance.yahoo.com/v8/finance/chart/%s?interval=%s&period1=%d&period2=%d&includePrePost=false",
		encodedSymbol, interval, from.Unix(), to.Unix(),
	)
	client := &http.Client{Timeout: 20 * time.Second}
	req, _ := http.NewRequest("GET", endpoint, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var yr yahooChartResp
	if err := json.Unmarshal(body, &yr); err != nil || len(yr.Chart.Result) == 0 {
		return nil, nil // silently skip bad windows
	}
	r := yr.Chart.Result[0]
	if len(r.Indicators.Quote) == 0 {
		return nil, nil
	}
	q := r.Indicators.Quote[0]
	ist := time.FixedZone("IST", 5*3600+30*60)

	var bars []IntradayBar
	for i, ts := range r.Timestamp {
		if i >= len(q.Close) || q.Close[i] == nil || q.Open[i] == nil {
			continue
		}
		o := safePtr(q.Open, i)
		c := *q.Close[i]
		if o == 0 || c == 0 {
			continue
		}
		t := time.Unix(ts, 0).In(ist)
		h24 := t.Hour()*60 + t.Minute()
		if h24 < 9*60+15 || h24 >= 15*60+30 {
			continue
		}
		bars = append(bars, IntradayBar{
			Time:   t,
			Open:   math.Round(o*100) / 100,
			High:   math.Round(safePtr(q.High, i)*100) / 100,
			Low:    math.Round(safePtr(q.Low, i)*100) / 100,
			Close:  math.Round(c*100) / 100,
			Volume: int64(safePtr(q.Volume, i)),
		})
	}
	return bars, nil
}

// FetchIntradayBarsMultiDay fetches up to 30 days of 5m bars by stitching
// multiple 7-day Yahoo Finance requests. For 15m uses single 60d request.
func FetchIntradayBarsMultiDay(symbol, interval string, days int) ([]IntradayBar, error) {
	if interval == "15m" || interval == "1h" {
		rangeStr := "60d"
		if days <= 7 {
			rangeStr = "7d"
		}
		bars, _, err := fetchYahooChart(symbol, interval, rangeStr)
		if err != nil {
			return nil, err
		}
		// Trim to requested days
		ist := time.FixedZone("IST", 5*3600+30*60)
		cutoff := time.Now().In(ist).AddDate(0, 0, -days)
		var out []IntradayBar
		for _, b := range bars {
			if !b.Time.Before(cutoff) {
				out = append(out, b)
			}
		}
		return out, nil
	}

	// 5m: stitch 7-day windows
	if days > 30 {
		days = 30
	}
	now := time.Now()
	seen := map[int64]bool{}
	var all []IntradayBar

	windowDays := 7
	for offset := 0; offset < days; offset += windowDays {
		end := now.AddDate(0, 0, -offset)
		start := end.AddDate(0, 0, -windowDays)
		window, err := fetchYahooChartPeriod(symbol, "5m", start, end)
		if err != nil || len(window) == 0 {
			continue
		}
		for _, b := range window {
			k := b.Time.Unix()
			if !seen[k] {
				seen[k] = true
				all = append(all, b)
			}
		}
		time.Sleep(200 * time.Millisecond) // polite rate limit
	}

	// Sort chronologically
	for i := 0; i < len(all)-1; i++ {
		for j := i + 1; j < len(all); j++ {
			if all[i].Time.After(all[j].Time) {
				all[i], all[j] = all[j], all[i]
			}
		}
	}
	if len(all) == 0 {
		return FetchIntradayBarsForSymbol(symbol, "5m") // fallback to single 7d
	}
	return all, nil
}

// FetchDailyBars downloads up to `days` daily OHLCV bars for ^NSEI from Yahoo Finance.
func FetchDailyBars(days int) ([]IntradayBar, error) {
	return FetchDailyBarsForSymbol("^NSEI", days)
}

// FetchDailyBarsForSymbol downloads daily bars for any Yahoo Finance symbol.
// Returns bars in chronological order including today's partial bar if market is open.
func FetchDailyBarsForSymbol(symbol string, days int) ([]IntradayBar, error) {
	rangeStr := "90d"
	switch {
	case days > 730:
		rangeStr = "5y"
	case days > 365:
		rangeStr = "2y"
	case days > 180:
		rangeStr = "1y"
	case days > 90:
		rangeStr = "180d"
	}

	allBars, _, err := fetchYahooChart(symbol, "1d", rangeStr)
	if err != nil {
		return nil, err
	}

	ist := time.FixedZone("IST", 5*3600+30*60)
	cutoff := time.Now().In(ist).AddDate(0, 0, -days)

	var bars []IntradayBar
	for _, b := range allBars {
		if !b.Time.Before(cutoff) {
			bars = append(bars, b)
		}
	}
	if len(bars) == 0 {
		return nil, fmt.Errorf("no valid daily bars returned for %s", symbol)
	}
	return bars, nil
}

func safePtr(arr []*float64, i int) float64 {
	if i >= len(arr) || arr[i] == nil {
		return 0
	}
	return *arr[i]
}
