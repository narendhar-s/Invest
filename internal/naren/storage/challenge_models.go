package storage

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"time"
)

// ─── ChallengeConfig ──────────────────────────────────────────────────────────

// ChallengeConfig is the master record for a 90-day paper-trading challenge.
// Only one challenge can be ACTIVE at a time.
type ChallengeConfig struct {
	ID             uint      `gorm:"primaryKey;autoIncrement"             json:"id"`
	StartDate      time.Time `gorm:"not null;index"                       json:"start_date"`
	EndDate        time.Time `gorm:"not null"                             json:"end_date"`
	InitialCapital float64   `gorm:"not null;default:1000000"             json:"initial_capital"`
	TargetCapital  float64   `gorm:"default:0"                            json:"target_capital"` // optional goal
	Lots           int       `gorm:"not null;default:2"                   json:"lots"`
	RiskPerTrade   float64   `gorm:"not null;default:5000"                json:"risk_per_trade"`
	TargetPerTrade float64   `gorm:"not null;default:10000"               json:"target_per_trade"`
	Status         string    `gorm:"not null;type:varchar(20);default:'ACTIVE';index" json:"status"` // ACTIVE | COMPLETED | PAUSED
	ChallengeType  string    `gorm:"type:varchar(20);default:'OPTIONS';index" json:"challenge_type"` // OPTIONS | SCALP
	Notes          string    `gorm:"type:text"                            json:"notes"`
	CreatedAt      time.Time `gorm:"autoCreateTime"                       json:"created_at"`
	UpdatedAt      time.Time `gorm:"autoUpdateTime"                       json:"updated_at"`
}

func (ChallengeConfig) TableName() string { return "challenge_configs" }

// DayNumber returns how many trading days into the challenge we are.
func (c *ChallengeConfig) DayNumber(now time.Time) int {
	ist, _ := time.LoadLocation("Asia/Kolkata")
	start := c.StartDate.In(ist)
	cur   := now.In(ist)
	days  := 0
	d     := start
	for !d.After(cur) {
		if d.Weekday() != time.Saturday && d.Weekday() != time.Sunday {
			days++
		}
		d = d.AddDate(0, 0, 1)
	}
	return days
}

// DaysRemaining returns trading days left in the challenge.
func (c *ChallengeConfig) DaysRemaining(now time.Time) int {
	return 90 - c.DayNumber(now)
}

// ─── ChallengeTrade ───────────────────────────────────────────────────────────

// OptionSnapshot captures the option chain context at the moment of a trade.
type OptionSnapshot struct {
	PCR        float64 `json:"pcr"`          // Put-Call Ratio (OI-based)
	CallOI     float64 `json:"call_oi"`
	PutOI      float64 `json:"put_oi"`
	IV         float64 `json:"iv"`           // implied vol % (annualised)
	ATMCallLTP float64 `json:"atm_call_ltp"`
	ATMPutLTP  float64 `json:"atm_put_ltp"`
	VIXIndex   float64 `json:"vix_index"`    // India VIX if available
}

func (s OptionSnapshot) Value() (driver.Value, error) {
	b, err := json.Marshal(s)
	return string(b), err
}
func (s *OptionSnapshot) Scan(val interface{}) error {
	switch v := val.(type) {
	case string: return json.Unmarshal([]byte(v), s)
	case []byte: return json.Unmarshal(v, s)
	case nil:    return nil
	}
	return fmt.Errorf("OptionSnapshot.Scan: unsupported type %T", val)
}

// ChallengeTrade is one complete paper trade within a 90-day challenge.
// Contains far richer context than the basic PaperPosition.
type ChallengeTrade struct {
	ID          string `gorm:"primaryKey;type:varchar(60)"    json:"id"`
	ChallengeID uint   `gorm:"not null;index"                 json:"challenge_id"`
	DayNumber   int    `gorm:"not null"                       json:"day_number"` // day 1-90

	// Strategy context
	Strategy  string      `gorm:"not null;type:varchar(50)"  json:"strategy"`
	Direction string      `gorm:"not null;type:varchar(10)"  json:"direction"`
	Regime    string      `gorm:"type:varchar(30)"           json:"regime"`
	SignalBasis StringSlice `gorm:"type:text"                 json:"signal_basis"`
	Mode      string      `gorm:"not null;type:varchar(10)"  json:"mode"` // AUTO | MANUAL

	// Option contract details
	TradingSymbol string  `gorm:"type:varchar(50);index"     json:"trading_symbol"` // e.g. NIFTY2660923400CE
	Expiry        string  `gorm:"type:varchar(20);index"     json:"expiry"`          // yyyy-mm-dd
	Strike        float64 `gorm:"not null"                   json:"strike"`
	OptionType    string  `gorm:"not null;type:varchar(10)"  json:"option_type"`     // CE | PE
	Lots          int     `gorm:"not null"                   json:"lots"`
	Qty           int     `gorm:"not null"                   json:"qty"`
	DTE           int     `gorm:"not null"                   json:"dte"`             // days to expiry at entry

	// Entry — filled at NEXT bar open to avoid look-ahead
	EntryTime    time.Time      `gorm:"not null;index"            json:"entry_time"`
	EntrySpot    float64        `gorm:"not null"                  json:"entry_spot"`
	EntryPremium float64        `gorm:"not null"                  json:"entry_premium"`  // REAL Kite LTP
	EntryIV      float64        `gorm:"not null"                  json:"entry_iv"`        // annualised %
	EntryPCR     float64        `gorm:"not null"                  json:"entry_pcr"`       // option chain PCR
	EntryOI      float64        `gorm:"not null"                  json:"entry_oi"`        // open interest of this option
	EntrySnapshot OptionSnapshot `gorm:"type:text;serializer:json" json:"entry_snapshot"` // full chain context

	// Exit
	ExitTime    *time.Time `gorm:"index"                    json:"exit_time,omitempty"`
	ExitSpot    float64    `gorm:"default:0"                json:"exit_spot"`
	ExitPremium float64    `gorm:"default:0"                json:"exit_premium"` // REAL Kite LTP
	ExitReason  string     `gorm:"type:text"                json:"exit_reason"`

	// Results — explicit column names to avoid GORM's PnL → pn_l snake_case conversion
	RR          float64 `gorm:"column:rr;default:0"        json:"rr"`
	PnL         float64 `gorm:"column:pnl;default:0;index" json:"pnl"`
	PnLPct      float64 `gorm:"column:pnl_pct;default:0"   json:"pnl_pct"` // % of risk

	// Status
	Status    string    `gorm:"not null;type:varchar(10);default:'OPEN';index" json:"status"` // OPEN | CLOSED
	CreatedAt time.Time `gorm:"autoCreateTime"             json:"created_at"`
	UpdatedAt time.Time `gorm:"autoUpdateTime"             json:"updated_at"`

	// Live trading — true when a REAL Zerodha order backed this paper trade.
	Live          bool   `gorm:"default:false"             json:"live"`
	LiveOrderID   string `gorm:"type:varchar(40)"          json:"live_order_id"`
	LiveExitOrderID string `gorm:"type:varchar(40)"        json:"live_exit_order_id"`
}

func (ChallengeTrade) TableName() string { return "challenge_trades" }

// ─── ChallengeDay ─────────────────────────────────────────────────────────────

// ChallengeDay is a daily P&L snapshot, written at EOD or on-demand.
type ChallengeDay struct {
	ID             uint      `gorm:"primaryKey;autoIncrement"                    json:"id"`
	ChallengeID    uint      `gorm:"not null;index"                              json:"challenge_id"`
	Date           time.Time `gorm:"not null;uniqueIndex:uidx_challenge_day_date" json:"date"`
	DayNumber      int       `gorm:"not null"                                    json:"day_number"`
	OpeningBalance float64   `gorm:"not null"                                    json:"opening_balance"`
	ClosingBalance float64   `gorm:"not null"                                    json:"closing_balance"`
	DailyPnL       float64   `gorm:"not null"                                    json:"daily_pnl"`
	TradeCount     int       `gorm:"not null;default:0"                          json:"trade_count"`
	Wins           int       `gorm:"not null;default:0"                          json:"wins"`
	Losses         int       `gorm:"not null;default:0"                          json:"losses"`
	NiftyOpen      float64   `gorm:"default:0"                                   json:"nifty_open"`
	NiftyClose     float64   `gorm:"default:0"                                   json:"nifty_close"`
	BestTrade      float64   `gorm:"default:0"                                   json:"best_trade"`
	WorstTrade     float64   `gorm:"default:0"                                   json:"worst_trade"`
	CreatedAt      time.Time `gorm:"autoCreateTime"                              json:"created_at"`
}

func (ChallengeDay) TableName() string { return "challenge_days" }
