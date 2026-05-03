package config

import (
	"fmt"
	"strings"

	"github.com/spf13/viper"
)

type Config struct {
	Server         ServerConfig         `mapstructure:"server"`
	Database       DatabaseConfig       `mapstructure:"database"`
	Data           DataConfig           `mapstructure:"data"`
	Markets        MarketsConfig        `mapstructure:"markets"`
	Indicators     IndicatorsConfig     `mapstructure:"indicators"`
	Recommendation RecommendationConfig `mapstructure:"recommendation"`
	Backtest       BacktestConfig       `mapstructure:"backtest"`
}

type ServerConfig struct {
	Port        int  `mapstructure:"port"`
	OpenBrowser bool `mapstructure:"open_browser"`
}

type DatabaseConfig struct {
	Host     string `mapstructure:"host"`
	Port     int    `mapstructure:"port"`
	User     string `mapstructure:"user"`
	Password string `mapstructure:"password"`
	Name     string `mapstructure:"name"`
	SSLMode  string `mapstructure:"sslmode"`
	Timezone string `mapstructure:"timezone"`
}

func (d DatabaseConfig) DSN() string {
	return fmt.Sprintf(
		"host=%s port=%d user=%s password=%s dbname=%s sslmode=%s TimeZone=%s",
		d.Host, d.Port, d.User, d.Password, d.Name, d.SSLMode, d.Timezone,
	)
}

type DataConfig struct {
	RefreshIntervalHours int    `mapstructure:"refresh_interval_hours"`
	HistoryDays          int    `mapstructure:"history_days"`
	IntradayInterval     string `mapstructure:"intraday_interval"`
	IntradayRange        string `mapstructure:"intraday_range"`
}

type MarketsConfig struct {
	NSE MarketConfig `mapstructure:"nse"`
	US  MarketConfig `mapstructure:"us"`
}

type MarketConfig struct {
	Enabled bool     `mapstructure:"enabled"`
	Symbols []string `mapstructure:"symbols"`
	Indices []string `mapstructure:"indices"`
}

type IndicatorsConfig struct {
	MAPeriods  []int    `mapstructure:"ma_periods"`
	RSIPeriod  int      `mapstructure:"rsi_period"`
	MACDFast   int      `mapstructure:"macd_fast"`
	MACDSlow   int      `mapstructure:"macd_slow"`
	MACDSignal int      `mapstructure:"macd_signal"`
	BBPeriod   int      `mapstructure:"bb_period"`
	BBStdDev   float64  `mapstructure:"bb_std_dev"`
	VWAPPeriod int      `mapstructure:"vwap_period"`
}

type RecommendationConfig struct {
	StrongBuyThreshold int `mapstructure:"strong_buy_threshold"`
	BuyThreshold       int `mapstructure:"buy_threshold"`
	HoldThreshold      int `mapstructure:"hold_threshold"`
	MinConfidence      int `mapstructure:"min_confidence"`
}

type BacktestConfig struct {
	DefaultCapital float64 `mapstructure:"default_capital"`
	CommissionPct  float64 `mapstructure:"commission_pct"`
	SlippagePct    float64 `mapstructure:"slippage_pct"`
}

func Load(cfgFile string) (*Config, error) {
	v := viper.New()

	if cfgFile != "" {
		v.SetConfigFile(cfgFile)
	} else {
		v.SetConfigName("config")
		v.SetConfigType("yaml")
		v.AddConfigPath(".")
		v.AddConfigPath("$HOME/.stockwise")
	}

	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	// Allow env overrides for database
	v.BindEnv("database.host", "DATABASE_HOST")
	v.BindEnv("database.port", "DATABASE_PORT")
	v.BindEnv("database.user", "DATABASE_USER")
	v.BindEnv("database.password", "DATABASE_PASSWORD")
	v.BindEnv("database.name", "DATABASE_NAME")

	if err := v.ReadInConfig(); err != nil {
		return nil, fmt.Errorf("reading config: %w", err)
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("unmarshaling config: %w", err)
	}

	return &cfg, nil
}

// AllSymbols returns all configured stock symbols across all markets.
func (c *Config) AllSymbols() []string {
	var all []string
	all = append(all, c.Markets.NSE.Symbols...)
	all = append(all, c.Markets.NSE.Indices...)
	all = append(all, c.Markets.US.Symbols...)
	all = append(all, c.Markets.US.Indices...)
	return all
}

// MarketOfSymbol returns the market ("NSE", "US", "INDEX") for a symbol.
func (c *Config) MarketOfSymbol(symbol string) string {
	for _, s := range c.Markets.NSE.Symbols {
		if s == symbol {
			return "NSE"
		}
	}
	for _, s := range c.Markets.NSE.Indices {
		if s == symbol {
			return "INDEX"
		}
	}
	for _, s := range c.Markets.US.Symbols {
		if s == symbol {
			return "US"
		}
	}
	for _, s := range c.Markets.US.Indices {
		if s == symbol {
			return "INDEX"
		}
	}
	return "UNKNOWN"
}
