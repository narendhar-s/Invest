package storage

import "time"

// CreateSMCTrade inserts a new trade log entry.
func (r *Repository) CreateSMCTrade(t *SMCTradeLog) error {
	return r.db.Create(t).Error
}

// UpdateSMCTrade saves changes to an existing trade.
func (r *Repository) UpdateSMCTrade(t *SMCTradeLog) error {
	return r.db.Save(t).Error
}

// GetOpenSMCTrades returns all trades still in OPEN status.
func (r *Repository) GetOpenSMCTrades() ([]SMCTradeLog, error) {
	var out []SMCTradeLog
	err := r.db.Where("status = ?", "OPEN").Order("generated_at desc").Find(&out).Error
	return out, err
}

// GetRecentSMCTrades returns the most recent N trades (any status).
func (r *Repository) GetRecentSMCTrades(limit int) ([]SMCTradeLog, error) {
	if limit <= 0 {
		limit = 100
	}
	var out []SMCTradeLog
	err := r.db.Order("generated_at desc").Limit(limit).Find(&out).Error
	return out, err
}

// GetSMCTradesByTimeframe filters trades by timeframe (e.g., "5m" or "15m").
func (r *Repository) GetSMCTradesByTimeframe(tf string) ([]SMCTradeLog, error) {
	var out []SMCTradeLog
	err := r.db.Where("timeframe = ?", tf).Order("generated_at desc").Find(&out).Error
	return out, err
}

// GetSMCTradeBySignature returns existing OPEN trade matching the same setup
// (used to prevent duplicate inserts when a setup persists across multiple polls).
func (r *Repository) GetSMCTradeBySignature(tf, dir string, sweepPrice, entry float64, since time.Time) (*SMCTradeLog, error) {
	var t SMCTradeLog
	err := r.db.Where(
		"timeframe = ? AND direction = ? AND status = 'OPEN' AND sweep_price = ? AND entry = ? AND generated_at >= ?",
		tf, dir, sweepPrice, entry, since,
	).First(&t).Error
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// CountSMCTradesAll returns total count.
func (r *Repository) CountSMCTradesAll() (int64, error) {
	var n int64
	err := r.db.Model(&SMCTradeLog{}).Count(&n).Error
	return n, err
}
