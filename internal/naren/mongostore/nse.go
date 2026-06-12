package mongostore

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// NseOptionRecord is one row from the NSE F&O Bhavcopy.
// Stored in the nse_option_chain collection.
type NseOptionRecord struct {
	Symbol      string    `bson:"symbol"       json:"symbol"`
	TradeDate   time.Time `bson:"trade_date"   json:"trade_date"`
	ExpiryDate  time.Time `bson:"expiry_date"  json:"expiry_date"`
	Strike      float64   `bson:"strike"       json:"strike"`
	OptionType  string    `bson:"option_type"  json:"option_type"` // CE | PE
	SettlPrice  float64   `bson:"settl_price"  json:"settl_price"`
	OpenInt     float64   `bson:"open_interest"  json:"open_interest"`
	ChangeInOI  float64   `bson:"change_in_oi"   json:"change_in_oi"`
	Volume      float64   `bson:"volume"       json:"volume"`
	TradeValue  float64   `bson:"trade_value"  json:"trade_value"`
}

// NseStore wraps MongoDB operations for the NSE option chain collection.
type NseStore struct {
	coll *mongo.Collection
}

func NewNseStore(c *Client) *NseStore {
	return &NseStore{coll: c.Collection(CollNSEOptions)}
}

// EnsureIndexes creates the unique compound index and a date-range index.
// Safe to call on every startup (idempotent).
func (s *NseStore) EnsureIndexes(ctx context.Context) error {
	models := []mongo.IndexModel{
		{
			// Unique key — prevents duplicates on re-import
			Keys: bson.D{
				{Key: "trade_date",  Value: 1},
				{Key: "expiry_date", Value: 1},
				{Key: "strike",      Value: 1},
				{Key: "option_type", Value: 1},
			},
			Options: options.Index().SetUnique(true).SetName("trade_expiry_strike_type"),
		},
		{
			// Fast range query for the backtest: give me all records in date range
			Keys:    bson.D{{Key: "trade_date", Value: 1}},
			Options: options.Index().SetName("idx_trade_date"),
		},
	}
	_, err := s.coll.Indexes().CreateMany(ctx, models)
	return err
}

// BulkUpsert inserts or replaces option records.
// On duplicate (same trade_date + expiry + strike + type), the document is replaced.
func (s *NseStore) BulkUpsert(ctx context.Context, records []NseOptionRecord) (int, int, error) {
	if len(records) == 0 {
		return 0, 0, nil
	}
	models := make([]mongo.WriteModel, len(records))
	for i, r := range records {
		filter := bson.M{
			"trade_date":  r.TradeDate,
			"expiry_date": r.ExpiryDate,
			"strike":      r.Strike,
			"option_type": r.OptionType,
		}
		models[i] = mongo.NewReplaceOneModel().
			SetFilter(filter).
			SetReplacement(r).
			SetUpsert(true)
	}
	opts := options.BulkWrite().SetOrdered(false)
	res, err := s.coll.BulkWrite(ctx, models, opts)
	if err != nil {
		return 0, 0, err
	}
	return int(res.UpsertedCount), int(res.ModifiedCount), nil
}

// LookupSettlement returns the settlement price for a specific option on a given date.
func (s *NseStore) LookupSettlement(ctx context.Context, tradeDate, expiryDate time.Time, strike float64, optionType string) (float64, error) {
	filter := bson.M{
		"trade_date":  tradeDate,
		"expiry_date": expiryDate,
		"strike":      strike,
		"option_type": optionType,
	}
	var rec NseOptionRecord
	err := s.coll.FindOne(ctx, filter).Decode(&rec)
	if err == mongo.ErrNoDocuments {
		return 0, nil
	}
	return rec.SettlPrice, err
}

// Stats returns summary information about the stored dataset.
func (s *NseStore) Stats(ctx context.Context) (map[string]interface{}, error) {
	total, err := s.coll.CountDocuments(ctx, bson.M{})
	if err != nil {
		return nil, err
	}
	// Distinct trade dates
	tradeDates, err := s.coll.Distinct(ctx, "trade_date", bson.M{})
	if err != nil {
		return nil, err
	}
	// Distinct expiry dates
	expiryDates, err := s.coll.Distinct(ctx, "expiry_date", bson.M{})
	if err != nil {
		return nil, err
	}

	// Date range
	var earliest, latest NseOptionRecord
	_ = s.coll.FindOne(ctx, bson.M{}, options.FindOne().SetSort(bson.D{{Key: "trade_date", Value: 1}})).Decode(&earliest)
	_ = s.coll.FindOne(ctx, bson.M{}, options.FindOne().SetSort(bson.D{{Key: "trade_date", Value: -1}})).Decode(&latest)

	from, to := "", ""
	if !earliest.TradeDate.IsZero() { from = earliest.TradeDate.Format("2006-01-02") }
	if !latest.TradeDate.IsZero()   { to   = latest.TradeDate.Format("2006-01-02") }

	return map[string]interface{}{
		"loaded":        total > 0,
		"total_records": total,
		"trade_days":    len(tradeDates),
		"expiry_dates":  len(expiryDates),
		"date_from":     from,
		"date_to":       to,
	}, nil
}

// DateRange returns the available date range of loaded data.
func (s *NseStore) DateRange(ctx context.Context) (from, to time.Time, err error) {
	var earliest NseOptionRecord
	if e := s.coll.FindOne(ctx, bson.M{}, options.FindOne().SetSort(bson.D{{Key: "trade_date", Value: 1}})).Decode(&earliest); e == nil {
		from = earliest.TradeDate
	}
	var latest NseOptionRecord
	if e := s.coll.FindOne(ctx, bson.M{}, options.FindOne().SetSort(bson.D{{Key: "trade_date", Value: -1}})).Decode(&latest); e == nil {
		to = latest.TradeDate
	}
	return
}

// QueryByDateRange returns all records between two dates (inclusive).
func (s *NseStore) QueryByDateRange(ctx context.Context, from, to time.Time) ([]NseOptionRecord, error) {
	cursor, err := s.coll.Find(ctx, bson.M{
		"trade_date": bson.M{"$gte": from, "$lte": to},
	}, options.Find().SetSort(bson.D{{Key: "trade_date", Value: 1}, {Key: "strike", Value: 1}}))
	if err != nil {
		return nil, fmt.Errorf("query by date range: %w", err)
	}
	defer cursor.Close(ctx)
	var records []NseOptionRecord
	if err := cursor.All(ctx, &records); err != nil {
		return nil, err
	}
	return records, nil
}
