// Package mongostore manages the MongoDB connection and provides typed
// collection accessors. It is used for the NSE option-chain dataset which
// is large enough to benefit from MongoDB's document model and fast range
// queries on (trade_date, expiry_date, strike, option_type).
package mongostore

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"go.uber.org/zap"
)

const (
	CollNSEOptions = "nse_option_chain"
	ConnectTimeout = 10 * time.Second
)

// Client wraps the MongoDB connection.
type Client struct {
	client   *mongo.Client
	database string
	log      *zap.Logger
}

// Connect opens a MongoDB connection and verifies it with a ping.
func Connect(uri, database string, log *zap.Logger) (*Client, error) {
	ctx, cancel := context.WithTimeout(context.Background(), ConnectTimeout)
	defer cancel()

	opts := options.Client().ApplyURI(uri).
		SetConnectTimeout(ConnectTimeout).
		SetServerSelectionTimeout(ConnectTimeout)

	client, err := mongo.Connect(ctx, opts)
	if err != nil {
		return nil, fmt.Errorf("mongo connect: %w", err)
	}
	if err := client.Ping(ctx, nil); err != nil {
		return nil, fmt.Errorf("mongo ping: %w", err)
	}
	log.Info("mongodb connected", zap.String("uri", uri), zap.String("db", database))
	return &Client{client: client, database: database, log: log}, nil
}

// Collection returns a handle to the named collection.
func (c *Client) Collection(name string) *mongo.Collection {
	return c.client.Database(c.database).Collection(name)
}

// Disconnect cleanly closes the connection.
func (c *Client) Disconnect() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = c.client.Disconnect(ctx)
}
