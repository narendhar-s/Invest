package data

import (
	"fmt"
	"time"
)

// MarketDataSource is the common interface over historical/intraday OHLCV
// providers. Two concrete backends are supported: "yfinance" (Yahoo Finance)
// and "zerodha" (Kite Connect historical API).
type MarketDataSource interface {
	// Name returns the backend identifier ("yfinance" | "zerodha").
	Name() string
	// IntradayBars returns recent intraday candles for the given interval.
	// interval uses generic tokens: "1m","3m","5m","15m".
	IntradayBars(symbol, interval string) ([]ChartBar, error)
	// DailyBars returns daily candles spanning the given lookback window.
	DailyBars(symbol string, lookback time.Duration) ([]ChartBar, error)
}

// ─── yfinance backend ───────────────────────────────────────────────────────────

type yfinanceSource struct{ y *YahooClient }

// NewYFinanceSource wraps the Yahoo client as a MarketDataSource.
func NewYFinanceSource(y *YahooClient) MarketDataSource {
	if y == nil {
		y = NewYahooClient()
	}
	return &yfinanceSource{y: y}
}

func (s *yfinanceSource) Name() string { return "yfinance" }

func (s *yfinanceSource) IntradayBars(symbol, interval string) ([]ChartBar, error) {
	return s.y.FetchIntradayBars(symbol, toYahooInterval(interval))
}

func (s *yfinanceSource) DailyBars(symbol string, lookback time.Duration) ([]ChartBar, error) {
	rng := yahooRange(lookback)
	bars, _, _, err := s.y.FetchChart(symbol, "1d", rng)
	return bars, err
}

// ─── zerodha backend ─────────────────────────────────────────────────────────────

type zerodhaSource struct {
	k        *KiteClient
	fallback MarketDataSource // used when Kite is unauthenticated
}

// NewZerodhaSource wraps the Kite client as a MarketDataSource, falling back to
// yfinance whenever Zerodha is not connected.
func NewZerodhaSource(k *KiteClient, fallback MarketDataSource) MarketDataSource {
	return &zerodhaSource{k: k, fallback: fallback}
}

func (s *zerodhaSource) Name() string { return "zerodha" }

func (s *zerodhaSource) IntradayBars(symbol, interval string) ([]ChartBar, error) {
	if s.k == nil || !s.k.IsConnected() {
		if s.fallback != nil {
			return s.fallback.IntradayBars(symbol, interval)
		}
		return nil, fmt.Errorf("zerodha not connected")
	}
	to := time.Now()
	from := to.AddDate(0, 0, -5)
	bars, err := s.k.FetchHistorical(symbol, toKiteInterval(interval), from, to)
	if err != nil && s.fallback != nil {
		return s.fallback.IntradayBars(symbol, interval)
	}
	return bars, err
}

func (s *zerodhaSource) DailyBars(symbol string, lookback time.Duration) ([]ChartBar, error) {
	if s.k == nil || !s.k.IsConnected() {
		if s.fallback != nil {
			return s.fallback.DailyBars(symbol, lookback)
		}
		return nil, fmt.Errorf("zerodha not connected")
	}
	to := time.Now()
	from := to.Add(-lookback)
	bars, err := s.k.FetchHistorical(symbol, "day", from, to)
	if err != nil && s.fallback != nil {
		return s.fallback.DailyBars(symbol, lookback)
	}
	return bars, err
}

// ─── factory ──────────────────────────────────────────────────────────────────────

// NewDataSource selects a backend by name. Unknown names default to yfinance.
// The zerodha backend always falls back to yfinance when not connected.
func NewDataSource(name string, yahoo *YahooClient, kite *KiteClient) MarketDataSource {
	yf := NewYFinanceSource(yahoo)
	switch name {
	case "zerodha", "kite":
		if kite != nil {
			return NewZerodhaSource(kite, yf)
		}
		return yf
	default:
		return yf
	}
}

// ─── interval helpers ─────────────────────────────────────────────────────────────

func toYahooInterval(generic string) string {
	switch generic {
	case "1m":
		return "1m"
	case "3m", "5m":
		return "5m"
	case "15m":
		return "15m"
	default:
		return "5m"
	}
}

// ActualFetchedInterval returns the candle interval label that will actually
// be stored in seed candles for a given live timeframe. Yahoo Finance has no
// 3m bars, so "3m" seeds from 5m data and candles must be labelled "5m" so
// strategies (e.g. ORB) compute their range window correctly.
func ActualFetchedInterval(liveTimeframe string) string {
	switch liveTimeframe {
	case "3m":
		return "5m"
	default:
		return liveTimeframe
	}
}

// KiteInterval maps a generic timeframe ("5m") to a Kite historical-data
// interval ("5minute"). Exported for callers outside this package (backtests).
func KiteInterval(generic string) string { return toKiteInterval(generic) }

func toKiteInterval(generic string) string {
	switch generic {
	case "1m":
		return "minute"
	case "3m":
		return "3minute"
	case "5m":
		return "5minute"
	case "15m":
		return "15minute"
	default:
		return "5minute"
	}
}

func yahooRange(lookback time.Duration) string {
	days := lookback.Hours() / 24
	switch {
	case days <= 7:
		return "5d"
	case days <= 90:
		return "3mo"
	case days <= 370:
		return "1y"
	case days <= 740:
		return "2y"
	default:
		return "5y"
	}
}
