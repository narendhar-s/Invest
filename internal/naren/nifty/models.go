package nifty

import "time"

// OptionData holds data for a single option contract (CE or PE).
type OptionData struct {
	StrikePrice          float64 `json:"strikePrice"`
	ExpiryDate           string  `json:"expiryDate"`
	Identifier           string  `json:"identifier"`
	OpenInterest         float64 `json:"openInterest"`
	ChangeInOI           float64 `json:"changeinOpenInterest"`
	PctChangeInOI        float64 `json:"pchangeinOpenInterest"`
	TotalTradedVolume    float64 `json:"totalTradedVolume"`
	ImpliedVolatility    float64 `json:"impliedVolatility"`
	LastPrice            float64 `json:"lastPrice"`
	Change               float64 `json:"change"`
	PctChange            float64 `json:"pChange"`
	TotalBuyQty          float64 `json:"totalBuyQuantity"`
	TotalSellQty         float64 `json:"totalSellQuantity"`
	BidPrice             float64 `json:"bidprice"`
	AskPrice             float64 `json:"askPrice"`
	UnderlyingValue      float64 `json:"underlyingValue"`
}

// OptionChainRow is one row in the option chain table (one strike, both CE and PE).
type OptionChainRow struct {
	StrikePrice float64    `json:"strike_price"`
	CE          OptionData `json:"ce"`
	PE          OptionData `json:"pe"`
	IsATM       bool       `json:"is_atm"`
	MaxPainScore float64   `json:"max_pain_score"` // total pain at this strike
}

// OptionChainData is the full parsed option chain for NIFTY.
type OptionChainData struct {
	Symbol          string           `json:"symbol"`
	SpotPrice       float64          `json:"spot_price"`
	ExpiryDates     []string         `json:"expiry_dates"`
	SelectedExpiry  string           `json:"selected_expiry"`
	Rows            []OptionChainRow `json:"rows"`
	TotalCEOI       float64          `json:"total_ce_oi"`
	TotalPEOI       float64          `json:"total_pe_oi"`
	PCR             float64          `json:"pcr"`              // Put-Call Ratio (OI based)
	MaxPainStrike   float64          `json:"max_pain_strike"`
	ATMStrike       float64          `json:"atm_strike"`
	IVSkew          float64          `json:"iv_skew"`          // PE IV - CE IV at ATM
	MarketSentiment string           `json:"market_sentiment"` // BULLISH, BEARISH, NEUTRAL
	SupportLevels   []float64        `json:"support_levels"`   // from high PE OI
	ResistanceLevels []float64       `json:"resistance_levels"` // from high CE OI
	Timestamp       string           `json:"timestamp"`
	FetchedAt       time.Time        `json:"fetched_at"`
}

// StrikeSuggestion is one suggested option to trade.
type StrikeSuggestion struct {
	Strike       float64 `json:"strike"`
	OptionType   string  `json:"option_type"`   // CE or PE
	ExpiryDate   string  `json:"expiry_date"`
	ExpiryType   string  `json:"expiry_type"`   // WEEKLY or MONTHLY
	LTP          float64 `json:"ltp"`
	Delta        float64 `json:"delta"`
	IV           float64 `json:"iv"`
	Theta        float64 `json:"theta"`
	SuggestedEntry  float64 `json:"suggested_entry"`
	Target       float64 `json:"target"`
	StopLoss     float64 `json:"stop_loss"`
	MaxLoss      float64 `json:"max_loss"`      // per lot
	MaxProfit    float64 `json:"max_profit"`    // per lot
	RiskReward   float64 `json:"risk_reward"`
	LotSize      int     `json:"lot_size"`
	RiskLevel    string  `json:"risk_level"`    // CONSERVATIVE, MODERATE, AGGRESSIVE
	Label        string  `json:"label"`         // ATM, OTM, ITM
	Rationale    string  `json:"rationale"`
	Confidence   float64 `json:"confidence"`
}

// StrikeSuggestionReport groups suggestions by signal direction.
type StrikeSuggestionReport struct {
	SpotPrice       float64            `json:"spot_price"`
	Direction       string             `json:"direction"`       // BULLISH, BEARISH, NEUTRAL
	Expiry          string             `json:"expiry"`
	ATMStrike       float64            `json:"atm_strike"`
	Suggestions     []StrikeSuggestion `json:"suggestions"`
	MaxPainStrike   float64            `json:"max_pain_strike"`
	PCR             float64            `json:"pcr"`
	MarketSentiment string             `json:"market_sentiment"`
	GeneratedAt     string             `json:"generated_at"`
}

// NiftyScalpSignal is an enhanced scalping signal with option context.
type NiftyScalpSignal struct {
	Strategy        string  `json:"strategy"`
	Direction       string  `json:"direction"`       // BUY, SELL, NEUTRAL
	Signal          string  `json:"signal"`          // STRONG_BUY, BUY, NEUTRAL, SELL, STRONG_SELL
	SpotEntry       float64 `json:"spot_entry"`
	SpotTarget      float64 `json:"spot_target"`
	SpotStop        float64 `json:"spot_stop"`
	PointsTarget    float64 `json:"points_target"`
	PointsStop      float64 `json:"points_stop"`
	RiskReward      float64 `json:"risk_reward"`
	Confidence      float64 `json:"confidence"`
	WinRate         float64 `json:"win_rate"`         // from 3yr backtest
	ProfitFactor    float64 `json:"profit_factor"`
	Timeframe       string  `json:"timeframe"`
	Reasons         []string `json:"reasons"`
	SuggestedOption string  `json:"suggested_option"` // e.g. "24850 CE"
	GeneratedAt     string  `json:"generated_at"`
}

// NiftyStrategyCard is the full card data for one strategy.
type NiftyStrategyCard struct {
	StrategyName    string             `json:"strategy_name"`
	Description     string             `json:"description"`
	Timeframe       string             `json:"timeframe"`
	WinRate         float64            `json:"win_rate"`
	ProfitFactor    float64            `json:"profit_factor"`
	MaxDrawdownPct  float64            `json:"max_drawdown_pct"`
	NetPnLPct       float64            `json:"net_pnl_pct"`
	SharpeRatio     float64            `json:"sharpe_ratio"`
	TotalTrades     int                `json:"total_trades"`
	AvgTradesPerMonth float64          `json:"avg_trades_per_month"`
	ExpectancyPct   float64            `json:"expectancy_pct"`
	YearlyBreakdown []YearlyStats      `json:"yearly_breakdown"`
	CurrentSignal   *NiftyScalpSignal  `json:"current_signal,omitempty"`
	Rules           []string           `json:"rules"`
	BestFor         string             `json:"best_for"`
	RiskLevel       string             `json:"risk_level"`
}

// YearlyStats for a strategy in one calendar year.
type YearlyStats struct {
	Year         int     `json:"year"`
	WinRate      float64 `json:"win_rate"`
	Trades       int     `json:"trades"`
	NetPnLPct    float64 `json:"net_pnl_pct"`
	ProfitFactor float64 `json:"profit_factor"`
}

// NiftyChartBar is one bar in the chart data series with computed indicators.
type NiftyChartBar struct {
	Date     string  `json:"date"`      // "2006-01-02" for daily
	UnixTime int64   `json:"unix_time"` // Unix seconds for intraday (0 for daily)
	Open     float64 `json:"open"`
	High     float64 `json:"high"`
	Low      float64 `json:"low"`
	Close    float64 `json:"close"`
	Volume   int64   `json:"volume"`
	EMA9     float64 `json:"ema9"`
	EMA21    float64 `json:"ema21"`
	SMA50    float64 `json:"sma50"`
	VWAP     float64 `json:"vwap"`     // session VWAP or 21-bar TPS proxy
	RSI      float64 `json:"rsi"`
	ATR      float64 `json:"atr"`
	Signal   string  `json:"signal"`   // "BUY", "SELL", or ""
	Strategy string  `json:"strategy"` // which strategy fired
	WinRate  float64 `json:"win_rate"` // strategy's historical win rate (for marker label)
}

// NiftyChartData is the full response for GET /nifty/chart-data.
type NiftyChartData struct {
	Symbol      string          `json:"symbol"`
	Timeframe   string          `json:"timeframe"`   // "daily", "5m", "15m"
	Bars        []NiftyChartBar `json:"bars"`
	TotalBars   int             `json:"total_bars"`
	GeneratedAt string          `json:"generated_at"`
}

// BTSTCriterion is one scored check in the BTST analysis.
type BTSTCriterion struct {
	Label  string `json:"label"`
	Value  string `json:"value"`
	Met    bool   `json:"met"`
	Weight int    `json:"weight"` // contribution to score (+ve or -ve)
}

// NiftyBTSTSignal is the full BTST assessment for today's Nifty 50.
type NiftyBTSTSignal struct {
	Date          string          `json:"date"`
	SpotPrice     float64         `json:"spot_price"`
	Open          float64         `json:"open"`
	High          float64         `json:"high"`
	Low           float64         `json:"low"`
	Change        float64         `json:"change"`
	ChangePct     float64         `json:"change_pct"`
	Signal        string          `json:"signal"`      // "BUY" | "AVOID" | "NEUTRAL"
	Confidence    float64         `json:"confidence"`
	Score         int             `json:"score"`
	EntryPrice    float64         `json:"entry_price"`
	TargetPrice   float64         `json:"target_price"`
	StopLoss      float64         `json:"stop_loss"`
	RiskReward    float64         `json:"risk_reward"`
	EMA9          float64         `json:"ema9"`
	EMA21         float64         `json:"ema21"`
	SMA50         float64         `json:"sma50"`
	RSI           float64         `json:"rsi"`
	ATR           float64         `json:"atr"`
	MACDHist      float64         `json:"macd_hist"`
	VolumeRatio   float64         `json:"volume_ratio"`
	ClosePosition float64         `json:"close_position"` // 0-100: % close is within day's range
	Criteria      []BTSTCriterion `json:"criteria"`
	Strategy      string          `json:"strategy"`
	MarketStatus  string          `json:"market_status"` // "OPEN" | "CLOSED"
	EntryWindow   string          `json:"entry_window"`
	ExitWindow    string          `json:"exit_window"`
	GeneratedAt   string          `json:"generated_at"`
	Note          string          `json:"note"`
}

// NiftyDashboard is the full payload returned by GET /nifty/dashboard.
type NiftyDashboard struct {
	SpotPrice       float64            `json:"spot_price"`
	Change          float64            `json:"change"`
	ChangePct       float64            `json:"change_pct"`
	VIX             float64            `json:"vix"`
	PCR             float64            `json:"pcr"`
	MaxPainStrike   float64            `json:"max_pain_strike"`
	ATMStrike       float64            `json:"atm_strike"`
	MarketSentiment string             `json:"market_sentiment"`
	TrendDirection  string             `json:"trend_direction"`
	Strategies      []NiftyStrategyCard `json:"strategies"`
	LiveSignals     []NiftyScalpSignal  `json:"live_signals"`
	StrikeSuggestions *StrikeSuggestionReport `json:"strike_suggestions"`
	OptionChain     *OptionChainData    `json:"option_chain"`
	GeneratedAt     string             `json:"generated_at"`
}
