package storage

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"time"
)

// ─── JSON helpers ─────────────────────────────────────────────────────────────

// StringSlice serialises a []string as a JSON array in PostgreSQL TEXT column.
type StringSlice []string

func (s StringSlice) Value() (driver.Value, error) {
	b, err := json.Marshal(s)
	return string(b), err
}

func (s *StringSlice) Scan(val interface{}) error {
	switch v := val.(type) {
	case string:
		return json.Unmarshal([]byte(v), s)
	case []byte:
		return json.Unmarshal(v, s)
	case nil:
		*s = nil
		return nil
	}
	return fmt.Errorf("StringSlice: unsupported type %T", val)
}

// ─── PaperAccount ─────────────────────────────────────────────────────────────

// PaperAccount stores the paper-trading engine configuration.
// There is exactly one row (id = 1), upserted on every settings change.
type PaperAccount struct {
	ID            uint      `gorm:"primaryKey;autoIncrement:false;default:1"`
	Capital       float64   `gorm:"not null;default:1000000"`
	Lots          int       `gorm:"not null;default:2"`
	RiskPct       float64   `gorm:"not null;default:0.015"`
	RR            float64   `gorm:"column:rr;not null;default:2.0"`
	ConfThreshold int       `gorm:"not null;default:55"`
	AutoMode      bool      `gorm:"not null;default:false"`
	UpdatedAt     time.Time `gorm:"autoUpdateTime"`
}

func (PaperAccount) TableName() string { return "paper_account" }

// ─── PaperPosition ────────────────────────────────────────────────────────────

// PaperPosition is one complete paper trade from entry to exit.
// Status is either "OPEN" or "CLOSED". Only one OPEN row may exist at a time.
type PaperPosition struct {
	ID          string       `gorm:"primaryKey;type:varchar(60)"`
	Strategy    string       `gorm:"not null;type:varchar(50)"`
	Direction   string       `gorm:"not null;type:varchar(10)"`
	Regime      string       `gorm:"type:varchar(30)"`
	Confidence  int
	Mode        string       `gorm:"not null;type:varchar(10);default:'AUTO'"`
	RR          float64      `gorm:"column:rr"`
	Lots        int          `gorm:"not null;default:2"`
	Spot        float64
	ATMStrike   float64
	TargetPnL   float64
	StopPnL     float64
	RealizedPnL float64      `gorm:"column:realized_pnl"` // pin name: GORM would otherwise map PnL → realized_pn_l, but the repo queries realized_pnl
	ExitReason  string
	Reasoning   StringSlice  `gorm:"type:text"`
	Status      string       `gorm:"not null;type:varchar(10);index;default:'OPEN'"`
	EntryTime   time.Time    `gorm:"not null;index"`
	ExitTime    *time.Time
	CreatedAt   time.Time    `gorm:"autoCreateTime"`
	UpdatedAt   time.Time    `gorm:"autoUpdateTime"`
	// Eager-loaded legs
	Legs        []PaperLeg   `gorm:"foreignKey:PositionID;constraint:OnDelete:CASCADE"`
}

func (PaperPosition) TableName() string { return "paper_positions" }

// ─── PaperLeg ─────────────────────────────────────────────────────────────────

// PaperLeg is one option contract leg within a PaperPosition.
type PaperLeg struct {
	ID              uint    `gorm:"primaryKey;autoIncrement"`
	PositionID      string  `gorm:"not null;type:varchar(60);index"`
	TradingSymbol   string  `gorm:"type:varchar(50)"`
	QuoteKey        string  `gorm:"type:varchar(60)"`
	InstrumentToken int
	OptionType      string  `gorm:"type:varchar(5)"`
	Strike          float64
	Side            string  `gorm:"type:varchar(10)"` // BUY | SELL
	Qty             int
	EntryPremium    float64
	CurrentPremium  float64
	ExitPremium     float64
	Label           string
	CreatedAt       time.Time `gorm:"autoCreateTime"`
}

func (PaperLeg) TableName() string { return "paper_legs" }
