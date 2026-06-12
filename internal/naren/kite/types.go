package kite

import "time"

// ─── Constants ────────────────────────────────────────────────────────────────

const (
	// BaseURL is the Kite Connect REST endpoint.
	BaseURL = "https://api.kite.trade"
	// LoginBaseURL is the Kite OAuth login endpoint.
	LoginBaseURL = "https://kite.zerodha.com/connect/login"
	// NiftyIndexToken is the instrument_token for the NIFTY 50 index on NSE.
	NiftyIndexToken = 256265
	// NiftySymbol is the LTP/quote key for the NIFTY 50 index.
	NiftySymbol = "NSE:NIFTY 50"
	// NiftyLotSize is the current F&O lot size for NIFTY.
	NiftyLotSize = 75
)

// ─── Candle ───────────────────────────────────────────────────────────────────

// Candle is a single OHLCV bar returned by the historical data API.
type Candle struct {
	Time   time.Time `json:"time"`
	Open   float64   `json:"open"`
	High   float64   `json:"high"`
	Low    float64   `json:"low"`
	Close  float64   `json:"close"`
	Volume int64     `json:"volume"`
}

// ─── Quote / LTP ──────────────────────────────────────────────────────────────

// LTPData is the minimal last-price payload.
type LTPData struct {
	InstrumentToken int     `json:"instrument_token"`
	LastPrice       float64 `json:"last_price"`
}

// OHLC holds the day's open/high/low/close + previous close.
type OHLC struct {
	Open  float64 `json:"open"`
	High  float64 `json:"high"`
	Low   float64 `json:"low"`
	Close float64 `json:"close"`
}

// QuoteData is the full quote payload for an instrument.
type QuoteData struct {
	InstrumentToken int     `json:"instrument_token"`
	LastPrice       float64 `json:"last_price"`
	Volume          int64   `json:"volume"`
	OI              float64 `json:"oi"`
	OHLC            OHLC    `json:"ohlc"`
	NetChange       float64 `json:"net_change"`
}

// ─── Instruments ──────────────────────────────────────────────────────────────

// Instrument is one tradable contract from the instruments master.
type Instrument struct {
	InstrumentToken int     `json:"instrument_token"`
	TradingSymbol   string  `json:"tradingsymbol"`
	Name            string  `json:"name"`
	Expiry          string  `json:"expiry"`
	Strike          float64 `json:"strike"`
	LotSize         int     `json:"lot_size"`
	InstrumentType  string  `json:"instrument_type"` // CE | PE | FUT | EQ
	Segment         string  `json:"segment"`
	Exchange        string  `json:"exchange"`
}

// ─── API envelopes ────────────────────────────────────────────────────────────

type sessionResponse struct {
	Status string `json:"status"`
	Data   struct {
		AccessToken string `json:"access_token"`
		UserID      string `json:"user_id"`
		UserName    string `json:"user_name"`
		Email       string `json:"email"`
		LoginTime   string `json:"login_time"`
	} `json:"data"`
	Message   string `json:"message"`
	ErrorType string `json:"error_type"`
}

type ltpResponse struct {
	Status string             `json:"status"`
	Data   map[string]LTPData `json:"data"`
}

type quoteResponse struct {
	Status string               `json:"status"`
	Data   map[string]QuoteData `json:"data"`
}

type historicalResponse struct {
	Status string `json:"status"`
	Data   struct {
		Candles [][]interface{} `json:"candles"`
	} `json:"data"`
	Message   string `json:"message"`
	ErrorType string `json:"error_type"`
}
