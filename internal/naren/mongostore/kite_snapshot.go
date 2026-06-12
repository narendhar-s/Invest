package mongostore

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"

	"stockwise/internal/naren/kite"
)

const CollInstruments = "kite_instruments"

// InstrumentRecord is a snapshot of one Kite NFO instrument captured on a
// specific date. We store the full record so that tomorrow's backtest can look
// up yesterday's option token even after the option has expired and disappeared
// from the live instrument master.
type InstrumentRecord struct {
	SnapshotDate    time.Time `bson:"snapshot_date"      json:"snapshot_date"`
	InstrumentToken int       `bson:"instrument_token"   json:"instrument_token"`
	TradingSymbol   string    `bson:"trading_symbol"     json:"trading_symbol"`
	Name            string    `bson:"name"               json:"name"`
	Expiry          string    `bson:"expiry"             json:"expiry"`      // yyyy-mm-dd
	Strike          float64   `bson:"strike"             json:"strike"`
	LotSize         int       `bson:"lot_size"           json:"lot_size"`
	InstrumentType  string    `bson:"instrument_type"    json:"instrument_type"` // CE | PE | FUT
	Segment         string    `bson:"segment"            json:"segment"`
	Exchange        string    `bson:"exchange"           json:"exchange"`
}

// InstrumentSnapshotStore saves and queries daily Kite NFO instrument snapshots.
type InstrumentSnapshotStore struct {
	coll *mongo.Collection
}

func NewInstrumentSnapshotStore(c *Client) *InstrumentSnapshotStore {
	return &InstrumentSnapshotStore{coll: c.Collection(CollInstruments)}
}

// EnsureIndexes creates indexes for the instrument snapshot collection.
func (s *InstrumentSnapshotStore) EnsureIndexes(ctx context.Context) error {
	models := []mongo.IndexModel{
		{
			// Unique: one record per token per snapshot date
			Keys: bson.D{
				{Key: "snapshot_date",   Value: 1},
				{Key: "instrument_token", Value: 1},
			},
			Options: options.Index().SetUnique(true).SetName("snap_date_token"),
		},
		{
			// Fast lookup: find token for a given name/expiry/strike/type
			Keys: bson.D{
				{Key: "name",            Value: 1},
				{Key: "expiry",          Value: 1},
				{Key: "strike",          Value: 1},
				{Key: "instrument_type", Value: 1},
			},
			Options: options.Index().SetName("idx_nifty_lookup"),
		},
	}
	_, err := s.coll.Indexes().CreateMany(ctx, models)
	return err
}

// SaveSnapshot bulk-upserts a full NFO instrument master snapshot.
// Called once per day (on startup or via cron).
func (s *InstrumentSnapshotStore) SaveSnapshot(ctx context.Context, instruments []kite.Instrument) (int, error) {
	if len(instruments) == 0 {
		return 0, nil
	}
	today := time.Now().Truncate(24 * time.Hour)
	models := make([]mongo.WriteModel, 0, len(instruments))

	for _, ins := range instruments {
		rec := InstrumentRecord{
			SnapshotDate:    today,
			InstrumentToken: ins.InstrumentToken,
			TradingSymbol:   ins.TradingSymbol,
			Name:            ins.Name,
			Expiry:          ins.Expiry,
			Strike:          ins.Strike,
			LotSize:         ins.LotSize,
			InstrumentType:  ins.InstrumentType,
			Segment:         ins.Segment,
			Exchange:        ins.Exchange,
		}
		filter := bson.M{
			"snapshot_date":    today,
			"instrument_token": ins.InstrumentToken,
		}
		models = append(models, mongo.NewReplaceOneModel().
			SetFilter(filter).SetReplacement(rec).SetUpsert(true))
	}

	res, err := s.coll.BulkWrite(ctx, models, options.BulkWrite().SetOrdered(false))
	if err != nil {
		return 0, fmt.Errorf("saving instrument snapshot: %w", err)
	}
	return int(res.UpsertedCount + res.ModifiedCount), nil
}

// FindToken searches historical snapshots for an option's instrument token.
// Looks backwards from today until it finds a match, enabling lookups of
// recently expired options that are no longer in the live master.
func (s *InstrumentSnapshotStore) FindToken(ctx context.Context, name, expiry string, strike float64, optType string) (int, error) {
	filter := bson.M{
		"name":             name,
		"expiry":           expiry,
		"instrument_type":  optType,
		"strike":           strike,
	}
	// Most recent snapshot first
	opts := options.FindOne().SetSort(bson.D{{Key: "snapshot_date", Value: -1}})
	var rec InstrumentRecord
	err := s.coll.FindOne(ctx, filter, opts).Decode(&rec)
	if err == mongo.ErrNoDocuments {
		return 0, nil // not found — caller falls back to BS pricing
	}
	if err != nil {
		return 0, err
	}
	return rec.InstrumentToken, nil
}

// LatestSnapshotDate returns the date of the most recent snapshot.
func (s *InstrumentSnapshotStore) LatestSnapshotDate(ctx context.Context) (time.Time, error) {
	var rec InstrumentRecord
	err := s.coll.FindOne(ctx, bson.M{},
		options.FindOne().SetSort(bson.D{{Key: "snapshot_date", Value: -1}})).Decode(&rec)
	if err == mongo.ErrNoDocuments {
		return time.Time{}, nil
	}
	return rec.SnapshotDate, err
}
