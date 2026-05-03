package storage

import (
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Repository provides data-access methods for all models.
type Repository struct {
	db *DB
}

func NewRepository(db *DB) *Repository {
	return &Repository{db: db}
}

// ─── Stock ──────────────────────────────────────────────────────────────────

func (r *Repository) UpsertStock(s *Stock) error {
	return r.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "symbol"}},
		DoUpdates: clause.AssignmentColumns([]string{"name", "market", "sector", "exchange", "currency", "is_index", "updated_at"}),
	}).Create(s).Error
}

func (r *Repository) GetAllStocks() ([]Stock, error) {
	var stocks []Stock
	err := r.db.Where("market != ?", "INDEX").Find(&stocks).Error
	return stocks, err
}

func (r *Repository) GetIndexStocks() ([]Stock, error) {
	var stocks []Stock
	err := r.db.Where("market = ?", "INDEX").Find(&stocks).Error
	return stocks, err
}

func (r *Repository) GetStocksByMarket(market string) ([]Stock, error) {
	var stocks []Stock
	err := r.db.Where("market = ?", market).Find(&stocks).Error
	return stocks, err
}

func (r *Repository) GetStockBySymbol(symbol string) (*Stock, error) {
	var stock Stock
	err := r.db.Where("symbol = ?", symbol).First(&stock).Error
	if err != nil {
		return nil, err
	}
	return &stock, nil
}

// ─── PriceBar ────────────────────────────────────────────────────────────────

func (r *Repository) UpsertPriceBars(bars []PriceBar) error {
	if len(bars) == 0 {
		return nil
	}
	// Deduplicate by (stock_id, date) — keep last occurrence
	seen := make(map[string]int) // key → index in deduped
	deduped := make([]PriceBar, 0, len(bars))
	for _, b := range bars {
		key := fmt.Sprintf("%d_%s", b.StockID, b.Date.Format("2006-01-02"))
		if idx, ok := seen[key]; ok {
			deduped[idx] = b // overwrite with latest
		} else {
			seen[key] = len(deduped)
			deduped = append(deduped, b)
		}
	}
	// Insert in small batches to avoid the ON CONFLICT duplicate row issue
	batchSize := 200
	for i := 0; i < len(deduped); i += batchSize {
		end := i + batchSize
		if end > len(deduped) {
			end = len(deduped)
		}
		err := r.db.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "stock_id"}, {Name: "date"}},
			DoUpdates: clause.AssignmentColumns([]string{"open", "high", "low", "close", "adj_close", "volume"}),
		}).Create(deduped[i:end]).Error
		if err != nil {
			return err
		}
	}
	return nil
}

func (r *Repository) GetPriceBars(stockID uint, from, to time.Time) ([]PriceBar, error) {
	var bars []PriceBar
	err := r.db.
		Where("stock_id = ? AND date BETWEEN ? AND ?", stockID, from, to).
		Order("date ASC").
		Find(&bars).Error
	return bars, err
}

func (r *Repository) GetLatestPriceBars(stockID uint, limit int) ([]PriceBar, error) {
	var bars []PriceBar
	err := r.db.
		Where("stock_id = ?", stockID).
		Order("date DESC").
		Limit(limit).
		Find(&bars).Error
	// Reverse to ascending order
	for i, j := 0, len(bars)-1; i < j; i, j = i+1, j-1 {
		bars[i], bars[j] = bars[j], bars[i]
	}
	return bars, err
}

func (r *Repository) GetLastPriceDate(stockID uint) (time.Time, error) {
	var bar PriceBar
	err := r.db.Where("stock_id = ?", stockID).Order("date DESC").First(&bar).Error
	if err != nil {
		return time.Time{}, err
	}
	return bar.Date, nil
}

// ─── TechnicalIndicator ──────────────────────────────────────────────────────

func (r *Repository) UpsertTechnicalIndicators(indicators []TechnicalIndicator) error {
	if len(indicators) == 0 {
		return nil
	}
	return r.db.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "stock_id"}, {Name: "date"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"sma20", "sma50", "sma200", "ema20", "ema50",
			"rsi", "macd_line", "signal_line", "macd_hist",
			"bb_upper", "bb_middle", "bb_lower", "bb_width",
			"vwap", "relative_volume", "volume_spike",
			"trend_direction", "trend_strength", "technical_score",
		}),
	}).CreateInBatches(indicators, 500).Error
}

func (r *Repository) GetLatestTechnicalIndicator(stockID uint) (*TechnicalIndicator, error) {
	var ind TechnicalIndicator
	err := r.db.Where("stock_id = ?", stockID).Order("date DESC").First(&ind).Error
	if err != nil {
		return nil, err
	}
	return &ind, nil
}

func (r *Repository) GetTechnicalIndicators(stockID uint, from, to time.Time) ([]TechnicalIndicator, error) {
	var inds []TechnicalIndicator
	err := r.db.
		Where("stock_id = ? AND date BETWEEN ? AND ?", stockID, from, to).
		Order("date ASC").
		Find(&inds).Error
	return inds, err
}

// ─── Fundamental ─────────────────────────────────────────────────────────────

func (r *Repository) UpsertFundamental(f *Fundamental) error {
	return r.db.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "stock_id"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"pe_ratio", "forward_pe", "eps", "eps_growth", "revenue_growth",
			"debt_equity", "roe", "roa", "market_cap", "dividend_yield",
			"price_to_book", "profit_margin", "fundamental_score", "sector_rank", "updated_at",
		}),
	}).Create(f).Error
}

func (r *Repository) GetFundamental(stockID uint) (*Fundamental, error) {
	var f Fundamental
	err := r.db.Where("stock_id = ?", stockID).First(&f).Error
	if err != nil {
		return nil, err
	}
	return &f, nil
}

// ─── SupportResistanceLevel ──────────────────────────────────────────────────

func (r *Repository) ReplaceSRLevels(stockID uint, levels []SupportResistanceLevel) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("stock_id = ?", stockID).Delete(&SupportResistanceLevel{}).Error; err != nil {
			return err
		}
		if len(levels) == 0 {
			return nil
		}
		return tx.CreateInBatches(levels, 100).Error
	})
}

func (r *Repository) GetSRLevels(stockID uint) ([]SupportResistanceLevel, error) {
	var levels []SupportResistanceLevel
	err := r.db.Where("stock_id = ? AND is_active = true", stockID).
		Order("price ASC").
		Find(&levels).Error
	return levels, err
}

// ─── Recommendation ──────────────────────────────────────────────────────────

// UpsertRecommendation inserts or replaces the recommendation for (stock_id, date, horizon).
// This ensures exactly one recommendation per stock per horizon per day.
func (r *Repository) UpsertRecommendation(rec *Recommendation) error {
	return r.db.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "stock_id"}, {Name: "date"}, {Name: "horizon"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"rec_type", "confidence", "risk_level",
			"entry_price", "target_price", "stop_loss", "risk_reward",
			"technical_factors", "fundamental_factors", "summary",
			"technical_score", "fundamental_score",
		}),
	}).Create(rec).Error
}

// GetLatestRecommendations returns the most-recent recommendation per (stock, horizon).
// Filters by market and optionally by horizon ("intraday", "swing", "longterm").
func (r *Repository) GetLatestRecommendations(market, horizon string, limit int) ([]Recommendation, error) {
	var recs []Recommendation

	// Subquery selects the latest rec for each (stock_id, horizon) pair.
	query := r.db.Preload("Stock").
		Joins("JOIN stocks ON stocks.id = recommendations.stock_id").
		Where(`recommendations.id = (
			SELECT r2.id FROM recommendations r2
			WHERE r2.stock_id = recommendations.stock_id
			  AND r2.horizon  = recommendations.horizon
			ORDER BY r2.date DESC, r2.id DESC
			LIMIT 1
		)`).
		Order("recommendations.confidence DESC").
		Limit(limit)

	if market != "" {
		query = query.Where("stocks.market = ?", market)
	}
	if horizon != "" {
		query = query.Where("recommendations.horizon = ?", horizon)
	}

	err := query.Find(&recs).Error
	return recs, err
}

func (r *Repository) GetStockRecommendations(stockID uint, limit int) ([]Recommendation, error) {
	var recs []Recommendation
	err := r.db.Preload("Stock").
		Where("stock_id = ?", stockID).
		Order("date DESC").
		Limit(limit).
		Find(&recs).Error
	return recs, err
}

func (r *Repository) GetLatestRecommendationForStock(stockID uint) (*Recommendation, error) {
	var rec Recommendation
	err := r.db.Preload("Stock").
		Where("stock_id = ?", stockID).
		Order("date DESC").
		First(&rec).Error
	if err != nil {
		return nil, err
	}
	return &rec, nil
}

// ─── Trade ───────────────────────────────────────────────────────────────────

func (r *Repository) CreateTrade(t *Trade) error {
	return r.db.Create(t).Error
}

func (r *Repository) GetActiveTrades(market string) ([]Trade, error) {
	var trades []Trade
	query := r.db.Preload("Stock").Where("trades.status = 'active'")
	if market != "" {
		query = query.Joins("JOIN stocks ON stocks.id = trades.stock_id").
			Where("stocks.market = ?", market)
	}
	err := query.Order("trades.created_at DESC").Find(&trades).Error
	return trades, err
}

func (r *Repository) UpdateTrade(t *Trade) error {
	return r.db.Save(t).Error
}

// ─── StrategyResult ──────────────────────────────────────────────────────────

func (r *Repository) SaveStrategyResult(sr *StrategyResult) error {
	return r.db.Create(sr).Error
}

func (r *Repository) GetStrategyResults(strategyName, symbol string) ([]StrategyResult, error) {
	var results []StrategyResult
	q := r.db.Order("created_at DESC")
	if strategyName != "" {
		q = q.Where("strategy_name = ?", strategyName)
	}
	if symbol != "" {
		q = q.Where("symbol = ?", symbol)
	}
	return results, q.Find(&results).Error
}

// ─── Portfolio ───────────────────────────────────────────────────────────────

func (r *Repository) GetAllPortfolioHoldings() ([]PortfolioHolding, error) {
	var holdings []PortfolioHolding
	err := r.db.Order("market, sector, symbol").Find(&holdings).Error
	return holdings, err
}

func (r *Repository) UpsertPortfolioHolding(h *PortfolioHolding) error {
	return r.db.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "symbol"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"yf_symbol", "display_name", "market", "sector", "currency",
			"quantity", "avg_buy_price", "notes", "updated_at",
		}),
	}).Create(h).Error
}

func (r *Repository) DeletePortfolioHolding(symbol string) error {
	return r.db.Where("symbol = ?", symbol).Delete(&PortfolioHolding{}).Error
}

func (r *Repository) GetPortfolioHoldingBySymbol(symbol string) (*PortfolioHolding, error) {
	var h PortfolioHolding
	err := r.db.Where("symbol = ?", symbol).First(&h).Error
	return &h, err
}

// ─── Analytics ───────────────────────────────────────────────────────────────

func (r *Repository) GetDashboardSummary() (map[string]interface{}, error) {
	type summary struct {
		Market string
		Count  int
	}
	var summaries []summary
	err := r.db.Raw(`
		SELECT s.market, COUNT(*) as count
		FROM recommendations r
		JOIN stocks s ON s.id = r.stock_id
		WHERE r.date = (SELECT MAX(date) FROM recommendations)
		GROUP BY s.market
	`).Scan(&summaries).Error
	if err != nil {
		return nil, err
	}

	result := make(map[string]interface{})
	for _, s := range summaries {
		result[s.Market] = s.Count
	}
	return result, nil
}
