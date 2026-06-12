package storage

import (
	"time"

	"gorm.io/gorm"
)

// Stock represents a tracked security.
type Stock struct {
	ID        uint           `gorm:"primarykey" json:"id"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`

	Symbol   string `gorm:"uniqueIndex;not null" json:"symbol"`
	Name     string `json:"name"`
	Market   string `gorm:"index;not null" json:"market"` // NSE, US, INDEX
	Sector   string `json:"sector"`
	Exchange string `json:"exchange"`
	Currency string `json:"currency"`
	IsIndex  bool   `gorm:"default:false" json:"is_index"`
}

// PriceBar stores daily OHLCV data.
type PriceBar struct {
	ID      uint      `gorm:"primarykey" json:"id"`
	StockID uint      `gorm:"index:idx_stock_date,unique" json:"stock_id"`
	Date    time.Time `gorm:"index:idx_stock_date,unique" json:"date"`

	Open     float64 `json:"open"`
	High     float64 `json:"high"`
	Low      float64 `json:"low"`
	Close    float64 `json:"close"`
	AdjClose float64 `json:"adj_close"`
	Volume   int64   `json:"volume"`
}

// TechnicalIndicators holds computed TA values for a given date.
type TechnicalIndicator struct {
	ID      uint      `gorm:"primarykey" json:"id"`
	StockID uint      `gorm:"index:idx_tech_stock_date,unique" json:"stock_id"`
	Date    time.Time `gorm:"index:idx_tech_stock_date,unique" json:"date"`

	// Moving Averages
	SMA20  *float64 `json:"sma20"`
	SMA50  *float64 `json:"sma50"`
	SMA200 *float64 `json:"sma200"`
	EMA20  *float64 `json:"ema20"`
	EMA50  *float64 `json:"ema50"`

	// RSI
	RSI *float64 `json:"rsi"`

	// MACD
	MACDLine   *float64 `json:"macd_line"`
	SignalLine  *float64 `json:"signal_line"`
	MACDHist   *float64 `json:"macd_hist"`

	// Bollinger Bands
	BBUpper  *float64 `json:"bb_upper"`
	BBMiddle *float64 `json:"bb_middle"`
	BBLower  *float64 `json:"bb_lower"`
	BBWidth  *float64 `json:"bb_width"`

	// Volume
	VWAP           *float64 `json:"vwap"`
	RelativeVolume *float64 `json:"relative_volume"`
	VolumeSpike    bool     `json:"volume_spike"`

	// Trend
	TrendDirection string `json:"trend_direction"` // UP, DOWN, SIDEWAYS
	TrendStrength  *float64 `json:"trend_strength"` // 0-100

	// Scores
	TechnicalScore float64 `json:"technical_score"` // 0-100
}

// Fundamental holds fundamental data for a stock.
type Fundamental struct {
	ID        uint      `gorm:"primarykey" json:"id"`
	StockID   uint      `gorm:"uniqueIndex" json:"stock_id"`
	UpdatedAt time.Time `json:"updated_at"`

	PERatio       *float64 `json:"pe_ratio"`
	ForwardPE     *float64 `json:"forward_pe"`
	EPS           *float64 `json:"eps"`
	EPSGrowth     *float64 `json:"eps_growth"`     // YoY %
	RevenueGrowth *float64 `json:"revenue_growth"` // YoY %
	DebtEquity    *float64 `json:"debt_equity"`
	ROE           *float64 `json:"roe"`
	ROA           *float64 `json:"roa"`
	MarketCap     *float64 `json:"market_cap"`
	DividendYield *float64 `json:"dividend_yield"`
	PriceToBook   *float64 `json:"price_to_book"`
	ProfitMargin  *float64 `json:"profit_margin"`

	// Composite score
	FundamentalScore float64 `json:"fundamental_score"` // 0-100
	SectorRank       int     `json:"sector_rank"`
}

// SupportResistanceLevel stores identified S/R levels.
type SupportResistanceLevel struct {
	ID        uint      `gorm:"primarykey" json:"id"`
	StockID   uint      `gorm:"index" json:"stock_id"`
	CreatedAt time.Time `json:"created_at"`

	LevelType string  `json:"level_type"` // support, resistance, breakout, accumulation, supply
	Price     float64 `json:"price"`
	Strength  float64 `json:"strength"` // 0-100 (how many times tested)
	Timeframe string  `json:"timeframe"` // daily, weekly
	Touches   int     `json:"touches"`   // number of times price touched this level
	IsActive  bool    `gorm:"default:true" json:"is_active"`
}

// Recommendation is the engine's output for a stock.
type Recommendation struct {
	ID        uint      `gorm:"primarykey" json:"id"`
	StockID   uint      `gorm:"uniqueIndex:idx_rec_stock_date_horizon" json:"stock_id"`
	CreatedAt time.Time `json:"created_at"`
	Date      time.Time `gorm:"uniqueIndex:idx_rec_stock_date_horizon" json:"date"`

	RecType    string  `json:"rec_type"`    // strong_buy, buy, hold, sell, strong_sell
	Confidence float64 `json:"confidence"`  // 0-100
	RiskLevel  string  `json:"risk_level"`  // low, medium, high
	Horizon    string  `gorm:"uniqueIndex:idx_rec_stock_date_horizon" json:"horizon"` // intraday, swing, longterm

	// Prices
	EntryPrice  float64 `json:"entry_price"`
	TargetPrice float64 `json:"target_price"`
	StopLoss    float64 `json:"stop_loss"`
	RiskReward  float64 `json:"risk_reward"`

	// Reasoning
	TechnicalFactors   string `json:"technical_factors"`
	FundamentalFactors string `json:"fundamental_factors"`
	Summary            string `json:"summary"`

	// Scores
	TechnicalScore   float64 `json:"technical_score"`
	FundamentalScore float64 `json:"fundamental_score"`

	// Relation
	Stock *Stock `gorm:"foreignKey:StockID" json:"stock,omitempty"`
}

// Trade tracks active and closed trades.
type Trade struct {
	ID        uint      `gorm:"primarykey" json:"id"`
	StockID   uint      `gorm:"index" json:"stock_id"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	Strategy   string    `json:"strategy"` // ORB, VWAP, Momentum, LongTerm, etc.
	EntryPrice float64   `json:"entry_price"`
	EntryTime  time.Time `json:"entry_time"`
	ExitPrice  *float64  `json:"exit_price"`
	ExitTime   *time.Time `json:"exit_time"`
	Quantity   int        `json:"quantity"`
	PnL        *float64   `json:"pnl"`
	PnLPct     *float64   `json:"pnl_pct"`

	TargetPrice float64 `json:"target_price"`
	StopLoss    float64 `json:"stop_loss"`
	Status      string  `json:"status"` // active, closed, sl_hit, target_hit

	Stock *Stock `gorm:"foreignKey:StockID" json:"stock,omitempty"`
}

// PortfolioHolding stores a user's actual portfolio position.
type PortfolioHolding struct {
	ID          uint      `gorm:"primarykey" json:"id"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`

	Symbol      string  `gorm:"uniqueIndex;not null" json:"symbol"`      // user-facing symbol (CIPLA, QQQ)
	YFSymbol    string  `json:"yf_symbol"`                               // Yahoo Finance symbol (CIPLA.NS, QQQ)
	DisplayName string  `json:"display_name"`
	Market      string  `json:"market"`   // NSE, US
	Sector      string  `json:"sector"`
	Currency    string  `json:"currency"` // INR, USD
	Quantity    float64 `json:"quantity"`
	AvgBuyPrice float64 `json:"avg_buy_price"`
	Notes       string  `json:"notes"`
}

// StrategyResult stores backtesting output.
type StrategyResult struct {
	ID        uint      `gorm:"primarykey" json:"id"`
	CreatedAt time.Time `json:"created_at"`

	StrategyName string    `json:"strategy_name"`
	Symbol       string    `json:"symbol"`
	StartDate    time.Time `json:"start_date"`
	EndDate      time.Time `json:"end_date"`

	TotalTrades  int     `json:"total_trades"`
	WinningTrades int    `json:"winning_trades"`
	LosingTrades  int    `json:"losing_trades"`
	WinRate       float64 `json:"win_rate"`
	ProfitFactor  float64 `json:"profit_factor"`
	MaxDrawdown   float64 `json:"max_drawdown"`
	NetPnL        float64 `json:"net_pnl"`
	NetPnLPct     float64 `json:"net_pnl_pct"`
	SharpeRatio   float64 `json:"sharpe_ratio"`
	AvgWin        float64 `json:"avg_win"`
	AvgLoss       float64 `json:"avg_loss"`
}
