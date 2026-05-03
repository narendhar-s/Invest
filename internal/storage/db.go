package storage

import (
	"fmt"

	"go.uber.org/zap"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"

	"stockwise/pkg/logger"
)

// DB wraps the GORM database connection.
type DB struct {
	*gorm.DB
}

// Connect opens a connection to PostgreSQL and runs auto-migration.
func Connect(dsn string) (*DB, error) {
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: gormlogger.Default.LogMode(gormlogger.Warn),
	})
	if err != nil {
		return nil, fmt.Errorf("connecting to postgres: %w", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(20)
	sqlDB.SetMaxIdleConns(5)

	if err := migrate(db); err != nil {
		return nil, fmt.Errorf("running migrations: %w", err)
	}

	logger.Info("database connected and migrated")
	return &DB{db}, nil
}

func migrate(db *gorm.DB) error {
	return db.AutoMigrate(
		&Stock{},
		&PriceBar{},
		&TechnicalIndicator{},
		&Fundamental{},
		&SupportResistanceLevel{},
		&Recommendation{},
		&Trade{},
		&StrategyResult{},
		&PortfolioHolding{},
	)
}

// Ping checks the database connection.
func (d *DB) Ping() error {
	sqlDB, err := d.DB.DB()
	if err != nil {
		return err
	}
	if err := sqlDB.Ping(); err != nil {
		return err
	}
	logger.Info("database ping successful")
	return nil
}

// Close closes the underlying SQL connection.
func (d *DB) Close() {
	sqlDB, err := d.DB.DB()
	if err != nil {
		logger.Error("getting sql.DB", zap.Error(err))
		return
	}
	_ = sqlDB.Close()
}
