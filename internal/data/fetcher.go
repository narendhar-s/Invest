package data

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
	"golang.org/x/sync/errgroup"

	"stockwise/internal/storage"
	"stockwise/pkg/config"
	"stockwise/pkg/logger"
)

const (
	workerCount    = 3                      // concurrent Yahoo Finance requests (conservative to avoid rate limits)
	fetchRateLimit = 600 * time.Millisecond // polite delay between requests per worker
)

// sectorMap provides hardcoded sector mappings since Yahoo Finance's quote API
// no longer reliably returns sector data for NSE (.NS) or US stocks.
var sectorMap = map[string]string{
	// NSE — NIFTY 50 stocks
	"RELIANCE.NS":   "Energy",
	"TCS.NS":        "Technology",
	"HDFCBANK.NS":   "Financial Services",
	"INFY.NS":       "Technology",
	"ICICIBANK.NS":  "Financial Services",
	"HINDUNILVR.NS": "Consumer Staples",
	"SBIN.NS":       "Financial Services",
	"BHARTIARTL.NS": "Telecom",
	"ITC.NS":        "Consumer Staples",
	"KOTAKBANK.NS":  "Financial Services",
	"LT.NS":         "Infrastructure",
	"AXISBANK.NS":   "Financial Services",
	"ASIANPAINT.NS": "Materials",
	"MARUTI.NS":     "Automotive",
	"TITAN.NS":      "Consumer Discretionary",
	"BAJFINANCE.NS": "Financial Services",
	"WIPRO.NS":      "Technology",
	"HCLTECH.NS":    "Technology",
	"ULTRACEMCO.NS": "Materials",
	"NESTLEIND.NS":  "Consumer Staples",
	"SUNPHARMA.NS":  "Healthcare",
	"ONGC.NS":       "Energy",
	"NTPC.NS":       "Utilities",
	"POWERGRID.NS":  "Utilities",
	"ADANIENT.NS":   "Infrastructure",
	// NSE — Portfolio holdings
	"CIPLA.NS":      "Healthcare",
	"DRREDDY.NS":    "Healthcare",
	"EXIDEIND.NS":   "Industrials",
	"IDFCFIRSTB.NS": "Financial Services",
	"INDUSINDBK.NS": "Financial Services",
	"ITBEES.NS":     "ETF",
	"ITCHOTELS.NS":  "Consumer Discretionary",
	"JIOFIN.NS":     "Financial Services",
	"KTKBANK.NS":    "Financial Services",
	"MANAPPURAM.NS": "Financial Services",
	"NATCOPHARM.NS": "Healthcare",
	"SAIL.NS":       "Materials",
	"SOUTHBANK.NS":  "Financial Services",
	"TATACHEM.NS":   "Materials",
	"TATAPOWER.NS":  "Utilities",
	"TMCV.NS":       "Automotive",
	"TMPV.NS":       "Automotive",
	"ZYDUSLIFE.NS":  "Healthcare",
	"ICICINXT50.NS": "ETF",
	// US Stocks
	"AAPL":  "Technology",
	"MSFT":  "Technology",
	"GOOGL": "Communication Services",
	"AMZN":  "Consumer Discretionary",
	"NVDA":  "Technology",
	"META":  "Communication Services",
	"TSLA":  "Consumer Discretionary",
	"JPM":   "Financial Services",
	"JNJ":   "Healthcare",
	"V":     "Financial Services",
	"PG":    "Consumer Staples",
	"MA":    "Financial Services",
	"UNH":   "Healthcare",
	"HD":    "Consumer Discretionary",
	"BAC":   "Financial Services",
	"XOM":   "Energy",
	"CVX":   "Energy",
	"ABBV":  "Healthcare",
	"PFE":   "Healthcare",
	"COST":  "Consumer Staples",
	"NFLX":  "Communication Services",
	"ADBE":  "Technology",
	"CRM":   "Technology",
	"AMD":   "Technology",
	"INTC":  "Technology",
	"GLD":   "Commodities",
	// US Portfolio holdings
	"QQQ": "Tech ETF",
	"NVO": "Healthcare",
	"VOO": "Broad Market ETF",
}

// Fetcher orchestrates data ingestion for all configured markets.
type Fetcher struct {
	cfg    *config.Config
	repo   *storage.Repository
	yahoo  *YahooClient
}

func NewFetcher(cfg *config.Config, repo *storage.Repository) *Fetcher {
	return &Fetcher{
		cfg:   cfg,
		repo:  repo,
		yahoo: NewYahooClient(),
	}
}

// FetchAll ingests OHLCV + fundamentals for all configured symbols concurrently.
func (f *Fetcher) FetchAll() error {
	symbols := f.allSymbols()
	logger.Info("starting data fetch", zap.Int("total_symbols", len(symbols)))

	// Step 1: Upsert stock metadata from Yahoo quotes (batch 10 at a time)
	if err := f.upsertStockMetadata(symbols); err != nil {
		logger.Warn("partial metadata failure", zap.Error(err))
	}

	// Step 2: Fetch OHLCV + fundamentals concurrently with worker pool
	jobs := make(chan string, len(symbols))
	for _, s := range symbols {
		jobs <- s
	}
	close(jobs)

	var mu sync.Mutex
	errors := make([]string, 0)

	g := new(errgroup.Group)
	for i := 0; i < workerCount; i++ {
		g.Go(func() error {
			for symbol := range jobs {
				time.Sleep(fetchRateLimit)
				if err := f.fetchSymbol(symbol); err != nil {
					mu.Lock()
					errors = append(errors, fmt.Sprintf("%s: %v", symbol, err))
					mu.Unlock()
					logger.Warn("fetch failed for symbol", zap.String("symbol", symbol), zap.Error(err))
				} else {
					logger.Debug("fetched symbol", zap.String("symbol", symbol))
				}
			}
			return nil
		})
	}

	_ = g.Wait()

	if len(errors) > 0 {
		logger.Warn("some symbols failed to fetch",
			zap.Int("failed", len(errors)),
			zap.Int("total", len(symbols)))
	}

	logger.Info("data fetch complete",
		zap.Int("total", len(symbols)),
		zap.Int("failed", len(errors)))
	return nil
}

func (f *Fetcher) fetchSymbol(symbol string) error {
	// Get or create the stock record
	stock, err := f.repo.GetStockBySymbol(symbol)
	if err != nil {
		// Stock not found - create a minimal record
		stock = &storage.Stock{
			Symbol:  symbol,
			Market:  f.cfg.MarketOfSymbol(symbol),
			IsIndex: strings.HasPrefix(symbol, "^"),
		}
		if err := f.repo.UpsertStock(stock); err != nil {
			return fmt.Errorf("creating stock: %w", err)
		}
		stock, err = f.repo.GetStockBySymbol(symbol)
		if err != nil {
			return fmt.Errorf("re-fetching stock: %w", err)
		}
	}

	// Determine historical range to fetch
	rangeStr := f.historyRange(stock.ID)

	// Fetch OHLCV
	bars, currency, exchange, err := f.yahoo.FetchChart(symbol, "1d", rangeStr)
	if err != nil {
		return fmt.Errorf("chart fetch: %w", err)
	}

	// Update stock metadata
	updated := false
	if stock.Currency == "" || stock.Exchange == "" {
		stock.Currency = currency
		stock.Exchange = exchange
		updated = true
	}
	if stock.Sector == "" {
		if s, ok := sectorMap[symbol]; ok {
			stock.Sector = s
			updated = true
		}
	}
	if updated {
		if err := f.repo.UpsertStock(stock); err != nil {
			logger.Warn("updating stock metadata", zap.Error(err))
		}
	}

	// Convert to PriceBar models
	priceBars := make([]storage.PriceBar, 0, len(bars))
	for _, b := range bars {
		if b.Close == 0 {
			continue
		}
		priceBars = append(priceBars, storage.PriceBar{
			StockID:  stock.ID,
			Date:     b.Time.Truncate(24 * time.Hour),
			Open:     b.Open,
			High:     b.High,
			Low:      b.Low,
			Close:    b.Close,
			AdjClose: b.AdjClose,
			Volume:   b.Volume,
		})
	}

	if err := f.repo.UpsertPriceBars(priceBars); err != nil {
		return fmt.Errorf("storing price bars: %w", err)
	}

	// Fetch fundamentals (skip for indices)
	if !stock.IsIndex {
		f.fetchFundamentals(stock)
	}

	return nil
}

func (f *Fetcher) fetchFundamentals(stock *storage.Stock) {
	sum, err := f.yahoo.FetchSummary(stock.Symbol)
	if err != nil {
		logger.Debug("fundamentals unavailable", zap.String("symbol", stock.Symbol), zap.Error(err))
		return
	}

	fundamental := &storage.Fundamental{
		StockID:       stock.ID,
		PERatio:       sum.PERatio,
		ForwardPE:     sum.ForwardPE,
		EPS:           sum.EPS,
		EPSGrowth:     sum.EPSGrowth,
		RevenueGrowth: sum.RevenueGrowth,
		DebtEquity:    sum.DebtEquity,
		ROE:           sum.ROE,
		ROA:           sum.ROA,
		MarketCap:     sum.MarketCap,
		DividendYield: sum.DividendYield,
		PriceToBook:   sum.PriceToBook,
		ProfitMargin:  sum.ProfitMargin,
		UpdatedAt:     time.Now(),
	}

	if err := f.repo.UpsertFundamental(fundamental); err != nil {
		logger.Warn("storing fundamentals", zap.String("symbol", stock.Symbol), zap.Error(err))
	}
}

func (f *Fetcher) upsertStockMetadata(symbols []string) error {
	// Batch into groups of 10 for Yahoo quote API
	batchSize := 10
	for i := 0; i < len(symbols); i += batchSize {
		end := i + batchSize
		if end > len(symbols) {
			end = len(symbols)
		}
		batch := symbols[i:end]

		quotes, err := f.yahoo.FetchQuotes(batch)
		if err != nil {
			logger.Warn("batch quote fetch failed", zap.Error(err))
			continue
		}

		for _, q := range quotes {
			market := f.cfg.MarketOfSymbol(q.Symbol)
			name := q.LongName
			if name == "" {
				name = q.ShortName
			}
			sector := q.Sector
			if s, ok := sectorMap[q.Symbol]; ok {
				sector = s // prefer hardcoded mapping over Yahoo data
			}
			stock := &storage.Stock{
				Symbol:   q.Symbol,
				Name:     name,
				Market:   market,
				Sector:   sector,
				Exchange: q.Exchange,
				Currency: q.Currency,
				IsIndex:  strings.HasPrefix(q.Symbol, "^"),
			}
			if err := f.repo.UpsertStock(stock); err != nil {
				logger.Warn("upserting stock", zap.String("symbol", q.Symbol), zap.Error(err))
			}
		}

		time.Sleep(1 * time.Second)
	}
	return nil
}

// historyRange determines how far back to fetch data.
// Returns "max" for new stocks, else a shorter range.
func (f *Fetcher) historyRange(stockID uint) string {
	lastDate, err := f.repo.GetLastPriceDate(stockID)
	if err != nil || lastDate.IsZero() {
		return "2y" // fresh fetch
	}
	daysSince := time.Since(lastDate).Hours() / 24
	if daysSince > 30 {
		return "1y"
	}
	return "5d" // just refresh recent data
}

func (f *Fetcher) allSymbols() []string {
	seen := make(map[string]bool)
	var symbols []string

	add := func(s string) {
		if !seen[s] {
			seen[s] = true
			symbols = append(symbols, s)
		}
	}

	if f.cfg.Markets.NSE.Enabled {
		for _, s := range f.cfg.Markets.NSE.Symbols {
			add(s)
		}
		for _, s := range f.cfg.Markets.NSE.Indices {
			add(s)
		}
	}
	if f.cfg.Markets.US.Enabled {
		for _, s := range f.cfg.Markets.US.Symbols {
			add(s)
		}
		for _, s := range f.cfg.Markets.US.Indices {
			add(s)
		}
	}

	// Include portfolio holdings so their price data is kept up-to-date
	if holdings, err := f.repo.GetAllPortfolioHoldings(); err == nil {
		for _, h := range holdings {
			if h.YFSymbol != "" {
				add(h.YFSymbol)
			}
		}
	}

	return symbols
}
