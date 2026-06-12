package storage

import (
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// PaperRepository handles all paper-trading persistence in PostgreSQL.
type PaperRepository struct {
	db *DB
}

func NewPaperRepository(db *DB) *PaperRepository {
	return &PaperRepository{db: db}
}

// ─── Account ──────────────────────────────────────────────────────────────────

// LoadAccount returns the paper-trading account settings.
// Returns defaults if no row exists yet.
func (r *PaperRepository) LoadAccount() (*PaperAccount, error) {
	var acc PaperAccount
	err := r.db.First(&acc, 1).Error
	if err == gorm.ErrRecordNotFound {
		acc = PaperAccount{
			ID: 1, Capital: 1_000_000, Lots: 2,
			RiskPct: 0.015, RR: 2.0, ConfThreshold: 55, AutoMode: false,
		}
		if err := r.db.Create(&acc).Error; err != nil {
			return nil, fmt.Errorf("creating default account: %w", err)
		}
	} else if err != nil {
		return nil, err
	}
	return &acc, nil
}

// SaveAccount upserts the account settings row (id = 1 always).
func (r *PaperRepository) SaveAccount(acc *PaperAccount) error {
	acc.ID = 1
	acc.UpdatedAt = time.Now()
	return r.db.Clauses(clause.OnConflict{UpdateAll: true}).Create(acc).Error
}

// ─── Positions ────────────────────────────────────────────────────────────────

// OpenPosition returns the single currently-open position, or nil if none.
func (r *PaperRepository) OpenPosition() (*PaperPosition, error) {
	var pos PaperPosition
	err := r.db.Preload("Legs").Where("status = ?", "OPEN").First(&pos).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &pos, nil
}

// CreatePosition inserts a new OPEN position with its legs atomically.
func (r *PaperRepository) CreatePosition(pos *PaperPosition) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(pos).Error; err != nil {
			return fmt.Errorf("insert position: %w", err)
		}
		return nil
	})
}

// ClosePosition marks a position CLOSED and saves final PnL, all in one transaction.
func (r *PaperRepository) ClosePosition(id string, exitTime time.Time, realizedPnL float64, exitReason string, legs []PaperLeg) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		updates := map[string]interface{}{
			"status":       "CLOSED",
			"exit_time":    exitTime,
			"realized_pnl": realizedPnL,
			"exit_reason":  exitReason,
			"updated_at":   time.Now(),
		}
		if err := tx.Model(&PaperPosition{}).Where("id = ?", id).Updates(updates).Error; err != nil {
			return fmt.Errorf("close position: %w", err)
		}
		// Save final exit premiums on legs
		for _, leg := range legs {
			if err := tx.Model(&PaperLeg{}).Where("id = ?", leg.ID).
				Update("exit_premium", leg.ExitPremium).Error; err != nil {
				return fmt.Errorf("update leg exit premium: %w", err)
			}
		}
		return nil
	})
}

// UpdateLegPremiums updates the current_premium of all legs for an open position.
// Called on every tick — does NOT flush to disk on every call for performance;
// a bulk UPDATE is done here but the caller controls how often this runs.
func (r *PaperRepository) UpdateLegPremiums(legs []PaperLeg) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		for _, leg := range legs {
			if err := tx.Model(&PaperLeg{}).Where("id = ?", leg.ID).
				Update("current_premium", leg.CurrentPremium).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// ─── History ─────────────────────────────────────────────────────────────────

// History returns closed positions, newest first, capped at limit.
func (r *PaperRepository) History(limit int) ([]PaperPosition, error) {
	var positions []PaperPosition
	err := r.db.Preload("Legs").
		Where("status = ?", "CLOSED").
		Order("exit_time DESC").
		Limit(limit).
		Find(&positions).Error
	return positions, err
}

// TodayStats returns today's realized PnL and trade count.
func (r *PaperRepository) TodayStats() (float64, int, error) {
	ist, _ := time.LoadLocation("Asia/Kolkata")
	now := time.Now().In(ist)
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, ist)
	todayEnd   := todayStart.AddDate(0, 0, 1)

	var result struct {
		TotalPnL float64
		Count    int64
	}
	err := r.db.Model(&PaperPosition{}).
		Select("COALESCE(SUM(realized_pnl), 0) AS total_pnl, COUNT(*) AS count").
		Where("status = ? AND exit_time >= ? AND exit_time < ?", "CLOSED", todayStart, todayEnd).
		Scan(&result).Error
	return result.TotalPnL, int(result.Count), err
}

// AllTimeStats returns total realized PnL, win count, loss count.
func (r *PaperRepository) AllTimeStats() (totalPnL float64, wins, losses int, err error) {
	var rows []struct {
		RealizedPnL float64
	}
	if err = r.db.Model(&PaperPosition{}).
		Select("realized_pnl").
		Where("status = ?", "CLOSED").
		Scan(&rows).Error; err != nil {
		return
	}
	for _, row := range rows {
		totalPnL += row.RealizedPnL
		if row.RealizedPnL >= 0 {
			wins++
		} else {
			losses++
		}
	}
	return
}
