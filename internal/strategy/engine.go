package strategy

import (
	"time"

	"go.uber.org/zap"
	"golang.org/x/sync/errgroup"

	"stockwise/internal/analysis/alpha"
	"stockwise/internal/analysis/fundamental"
	"stockwise/internal/analysis/technical"
	"stockwise/internal/storage"
	"stockwise/pkg/config"
	"stockwise/pkg/logger"
)

// Engine orchestrates the full analysis pipeline for all stocks.
type Engine struct {
	cfg        *config.Config
	repo       *storage.Repository
	taAnalyzer *technical.Analyzer
	srAnalyzer *technical.SRAnalyzer
	faAnalyzer *fundamental.Analyzer
	intraday   *alpha.IntradayAnalyzer
	investment *alpha.InvestmentAnalyzer
}

func NewEngine(cfg *config.Config, repo *storage.Repository) *Engine {
	return &Engine{
		cfg:        cfg,
		repo:       repo,
		taAnalyzer: technical.NewAnalyzer(&cfg.Indicators),
		srAnalyzer: technical.NewSRAnalyzer(),
		faAnalyzer: fundamental.NewAnalyzer(),
		intraday:   alpha.NewIntradayAnalyzer(),
		investment: alpha.NewInvestmentAnalyzer(),
	}
}

// RunAll runs the complete analysis pipeline for every stock.
func (e *Engine) RunAll() error {
	stocks, err := e.repo.GetAllStocks()
	if err != nil {
		return err
	}

	// Also include index stocks so ^NSEI / ^NSEBANK get technical indicators
	indexStocks, _ := e.repo.GetIndexStocks()
	stocks = append(stocks, indexStocks...)

	logger.Info("running analysis engine", zap.Int("stocks", len(stocks)))

	// Process stocks concurrently with worker pool
	jobs := make(chan storage.Stock, len(stocks))
	for _, s := range stocks {
		jobs <- s
	}
	close(jobs)

	g := new(errgroup.Group)
	for i := 0; i < 8; i++ { // 8 workers
		g.Go(func() error {
			for stock := range jobs {
				if err := e.analyzeStock(stock); err != nil {
					logger.Warn("analysis failed",
						zap.String("symbol", stock.Symbol),
						zap.Error(err))
				}
			}
			return nil
		})
	}

	_ = g.Wait()
	logger.Info("analysis engine complete")
	return nil
}

func (e *Engine) analyzeStock(stock storage.Stock) error {
	// Fetch price bars (last 250 trading days ≈ 1 year)
	to := time.Now()
	from := to.AddDate(-1, 0, 0)

	bars, err := e.repo.GetPriceBars(stock.ID, from, to)
	if err != nil || len(bars) < 20 {
		return nil // not enough data
	}

	// ── Technical Analysis ─────────────────────────────────────────────────
	indicatorSet := e.taAnalyzer.Compute(bars)
	indicatorModels := e.taAnalyzer.ToStorageModels(stock.ID, bars, indicatorSet)
	if err := e.repo.UpsertTechnicalIndicators(indicatorModels); err != nil {
		logger.Warn("storing technical indicators", zap.Error(err))
	}

	// ── Support & Resistance ──────────────────────────────────────────────
	srLevels := e.srAnalyzer.Identify(stock.ID, bars)
	if err := e.repo.ReplaceSRLevels(stock.ID, srLevels); err != nil {
		logger.Warn("storing SR levels", zap.Error(err))
	}

	// ── Fundamental Score ──────────────────────────────────────────────────
	fund, _ := e.repo.GetFundamental(stock.ID)
	if fund != nil {
		e.faAnalyzer.Score(fund)
		if err := e.repo.UpsertFundamental(fund); err != nil {
			logger.Warn("updating fundamental score", zap.Error(err))
		}
	}

	return nil
}

// GetIntradaySignals returns intraday signals for NSE stocks.
func (e *Engine) GetIntradaySignals() ([]alpha.IntradaySignal, error) {
	stocks, err := e.repo.GetStocksByMarket("NSE")
	if err != nil {
		return nil, err
	}

	var allSignals []alpha.IntradaySignal
	to := time.Now()
	from := to.AddDate(0, -2, 0)

	for _, stock := range stocks {
		bars, err := e.repo.GetPriceBars(stock.ID, from, to)
		if err != nil || len(bars) < 20 {
			continue
		}

		ind, err := e.repo.GetLatestTechnicalIndicator(stock.ID)
		if err != nil {
			continue
		}

		srLevels, _ := e.repo.GetSRLevels(stock.ID)
		stockCopy := stock
		signals := e.intraday.Analyze(&stockCopy, bars, ind, srLevels)
		allSignals = append(allSignals, signals...)
	}

	return allSignals, nil
}

// GetInvestmentSignals returns investment signals for all markets.
func (e *Engine) GetInvestmentSignals(market string) ([]alpha.InvestmentSignal, error) {
	var stocks []storage.Stock
	var err error

	if market == "" {
		stocks, err = e.repo.GetAllStocks()
	} else {
		stocks, err = e.repo.GetStocksByMarket(market)
	}
	if err != nil {
		return nil, err
	}

	var allSignals []alpha.InvestmentSignal
	to := time.Now()
	from := to.AddDate(-1, 0, 0)

	for _, stock := range stocks {
		bars, err := e.repo.GetPriceBars(stock.ID, from, to)
		if err != nil || len(bars) < 50 {
			continue
		}

		ind, err := e.repo.GetLatestTechnicalIndicator(stock.ID)
		if err != nil {
			continue
		}

		fund, _ := e.repo.GetFundamental(stock.ID)
		srLevels, _ := e.repo.GetSRLevels(stock.ID)

		stockCopy := stock
		signals := e.investment.Analyze(&stockCopy, bars, ind, fund, srLevels)
		allSignals = append(allSignals, signals...)
	}

	return allSignals, nil
}

// IndexSignal holds a scalping/swing signal for NIFTY / BANKNIFTY indices.
type IndexSignal struct {
	Symbol     string  `json:"symbol"`
	Name       string  `json:"name"`
	Direction  string  `json:"direction"`  // LONG / SHORT / NEUTRAL
	Strategy   string  `json:"strategy"`
	Signal     string  `json:"signal"`
	Close      float64 `json:"close"`
	RSI        float64 `json:"rsi"`
	MACDHist   float64 `json:"macd_hist"`
	Trend      string  `json:"trend"`
	SMA20      float64 `json:"sma20"`
	SMA50      float64 `json:"sma50"`
	VWAP       float64 `json:"vwap"`
	Confidence float64 `json:"confidence"`
}

// GetIndexSignals returns scalping + swing signals for all tracked indices.
// Pass market="" for all, "NSE" for India, "US" for US indices.
func (e *Engine) GetIndexSignals(market string) ([]IndexSignal, error) {
	allSymbols := map[string]string{
		"^NSEI":    "NIFTY 50",
		"^NSEBANK": "BANK NIFTY",
		"^GSPC":    "S&P 500",
		"^IXIC":    "NASDAQ Composite",
	}
	nseSymbols := map[string]bool{"^NSEI": true, "^NSEBANK": true}

	var indexSymbols []string
	indexNames := map[string]string{}
	for sym, name := range allSymbols {
		if market == "" || (market == "NSE" && nseSymbols[sym]) || (market == "US" && !nseSymbols[sym]) {
			indexSymbols = append(indexSymbols, sym)
			indexNames[sym] = name
		}
	}

	var signals []IndexSignal
	to   := time.Now()
	from := to.AddDate(-1, 0, 0)

	for _, sym := range indexSymbols {
		stock, err := e.repo.GetStockBySymbol(sym)
		if err != nil {
			continue
		}
		bars, err := e.repo.GetPriceBars(stock.ID, from, to)
		if err != nil || len(bars) < 20 {
			continue
		}
		ind, err := e.repo.GetLatestTechnicalIndicator(stock.ID)
		if err != nil || ind == nil {
			continue
		}

		latest := bars[len(bars)-1]
		sig := IndexSignal{
			Symbol: sym,
			Name:   indexNames[sym],
			Close:  latest.Close,
			Trend:  ind.TrendDirection,
		}
		if ind.RSI != nil      { sig.RSI = *ind.RSI }
		if ind.MACDHist != nil { sig.MACDHist = *ind.MACDHist }
		if ind.SMA20 != nil    { sig.SMA20 = *ind.SMA20 }
		if ind.SMA50 != nil    { sig.SMA50 = *ind.SMA50 }
		if ind.VWAP != nil     { sig.VWAP = *ind.VWAP }

		switch {
		case sig.RSI < 35 && sig.MACDHist > 0:
			sig.Direction  = "LONG"
			sig.Strategy   = "Scalp_Oversold"
			sig.Signal     = "RSI oversold bounce + MACD bullish — scalp long at VWAP support"
			sig.Confidence = 72
		case sig.RSI > 65 && sig.MACDHist < 0:
			sig.Direction  = "SHORT"
			sig.Strategy   = "Scalp_Overbought"
			sig.Signal     = "RSI overbought + MACD bearish — scalp short at VWAP resistance"
			sig.Confidence = 68
		case ind.TrendDirection == "UP" && sig.RSI > 45 && sig.RSI < 65 && sig.MACDHist > 0:
			sig.Direction  = "LONG"
			sig.Strategy   = "Swing_Trend"
			sig.Signal     = "Uptrend confirmed (SMA20>SMA50). RSI healthy. MACD positive — swing long"
			sig.Confidence = 75
		case ind.TrendDirection == "DOWN" && sig.RSI < 55 && sig.MACDHist < 0:
			sig.Direction  = "SHORT"
			sig.Strategy   = "Swing_Trend"
			sig.Signal     = "Downtrend confirmed. RSI weak. MACD negative — swing short / stay out"
			sig.Confidence = 70
		case ind.VolumeSpike && latest.Close > latest.Open && sig.MACDHist > 0:
			sig.Direction  = "LONG"
			sig.Strategy   = "Volume_Breakout"
			sig.Signal     = "Volume spike on up candle with bullish MACD — momentum breakout long"
			sig.Confidence = 65
		default:
			sig.Direction  = "NEUTRAL"
			sig.Strategy   = "Wait"
			sig.Signal     = "No high-probability setup. Wait for RSI/MACD confluence"
			sig.Confidence = 40
		}

		signals = append(signals, sig)
	}

	return signals, nil
}
