package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"stockwise/internal/analysis/alpha"
	"stockwise/internal/storage"
	"stockwise/internal/strategy"
	"stockwise/pkg/config"
)


// ─── BTST Signals ─────────────────────────────────────────────────────────────

// BTSTSignals generates Buy-Today-Sell-Tomorrow signals for NSE stocks.
func (h *Handler) BTSTSignals(c *gin.Context) {
	stocks, err := h.repo.GetStocksByMarket("NSE")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	to := time.Now()
	from := to.AddDate(-1, 0, 0)

	barsMap := map[uint][]storage.PriceBar{}
	indMap := map[uint]*storage.TechnicalIndicator{}
	srMap := map[uint][]storage.SupportResistanceLevel{}

	for _, stock := range stocks {
		if stock.IsIndex {
			continue
		}
		if bars, e := h.repo.GetPriceBars(stock.ID, from, to); e == nil {
			barsMap[stock.ID] = bars
		}
		if ind, e := h.repo.GetLatestTechnicalIndicator(stock.ID); e == nil && ind != nil {
			indMap[stock.ID] = ind
		}
		if sr, e := h.repo.GetSRLevels(stock.ID); e == nil {
			srMap[stock.ID] = sr
		}
	}

	result := alpha.GenerateBTSTSignals(stocks, barsMap, indMap, srMap)
	c.JSON(http.StatusOK, result)
}

// ─── Scalping Backtest ────────────────────────────────────────────────────────

// ScalpingBacktest runs historical backtest for all 7 scalping strategies.
// Defaults to NIFTY 50 (^NSEI); falls back to best available NSE stock with most history.
func (h *Handler) ScalpingBacktest(c *gin.Context) {
	sym := c.Query("symbol")
	if sym == "" {
		sym = "^NSEI"
	}
	years := 5
	if y := c.Query("years"); y != "" {
		if parsed, err := strconv.Atoi(y); err == nil && parsed > 0 && parsed <= 10 {
			years = parsed
		}
	}

	// Find the best symbol available — prefer requested, fallback to most data
	resolvedSym := h.resolveBestSymbol(sym, years)
	if resolvedSym == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error":   "insufficient data for backtest",
			"message": "Data pipeline still running. Wait ~10 minutes, then try again.",
		})
		return
	}

	report, err := h.strategyEngine.RunScalpingBacktest(resolvedSym, years)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if report == nil || report.DataPoints == 0 {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error":   "insufficient data for backtest",
			"message": "Data pipeline still running. Wait ~10 minutes, then try again.",
		})
		return
	}

	// Sanitize all float fields to prevent JSON marshaling failure on Inf/NaN
	strategy.SanitizeBacktestReport(report)
	c.JSON(http.StatusOK, report)
}

// resolveBestSymbol finds the best symbol to run a backtest on.
// Tries the requested symbol first; falls back to the NSE stock with most historical bars.
func (h *Handler) resolveBestSymbol(preferred string, years int) string {
	to := time.Now()
	from := to.AddDate(-years, 0, 0)

	// Check if preferred symbol has enough data
	if s, err := h.repo.GetStockBySymbol(preferred); err == nil {
		if bars, err := h.repo.GetPriceBars(s.ID, from, to); err == nil && len(bars) >= 50 {
			return preferred
		}
	}

	// Fallback: find NSE stock with most bars
	nseStocks, _ := h.repo.GetStocksByMarket("NSE")
	bestSym := ""
	maxBars := 0
	for _, s := range nseStocks {
		if s.IsIndex {
			continue
		}
		bars, e := h.repo.GetPriceBars(s.ID, from, to)
		if e == nil && len(bars) > maxBars {
			maxBars = len(bars)
			bestSym = s.Symbol
		}
	}
	if maxBars >= 50 {
		return bestSym
	}
	return ""
}

// Handler holds all API dependencies.
type Handler struct {
	repo           *storage.Repository
	strategyEngine *strategy.Engine
	cfg            *config.Config
}

func NewHandler(repo *storage.Repository, engine *strategy.Engine, cfg *config.Config) *Handler {
	return &Handler{repo: repo, strategyEngine: engine, cfg: cfg}
}

// ─── Health ──────────────────────────────────────────────────────────────────

func (h *Handler) Health(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status":    "ok",
		"timestamp": time.Now().Format(time.RFC3339),
	})
}

// ─── Dashboard ───────────────────────────────────────────────────────────────
// Returns recommendations split by market AND horizon for rich dashboard display.

func (h *Handler) Dashboard(c *gin.Context) {
	// NSE — by horizon
	nseIntraday, _ := h.repo.GetLatestRecommendations("NSE", "intraday", 10)
	nseSwing, _    := h.repo.GetLatestRecommendations("NSE", "swing", 10)
	nseLongterm, _ := h.repo.GetLatestRecommendations("NSE", "longterm", 10)

	// US — investment only
	usSwing, _    := h.repo.GetLatestRecommendations("US", "swing", 10)
	usLongterm, _ := h.repo.GetLatestRecommendations("US", "longterm", 10)

	// Top 10 highest-confidence across all markets (for summary card)
	topAll, _ := h.repo.GetLatestRecommendations("", "", 10)

	activeTrades, _ := h.repo.GetActiveTrades("")

	c.JSON(http.StatusOK, gin.H{
		"nse_intraday":  nseIntraday,
		"nse_swing":     nseSwing,
		"nse_longterm":  nseLongterm,
		"us_swing":      usSwing,
		"us_longterm":   usLongterm,
		"top_picks":     topAll,
		"active_trades": len(activeTrades),
		"generated_at":  time.Now().Format(time.RFC3339),
	})
}

// ─── Stocks ──────────────────────────────────────────────────────────────────

func (h *Handler) ListStocks(c *gin.Context) {
	market := c.Query("market")
	var stocks []storage.Stock
	var err error
	if market != "" {
		stocks, err = h.repo.GetStocksByMarket(market)
	} else {
		stocks, err = h.repo.GetAllStocks()
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"stocks": stocks, "total": len(stocks)})
}

// ─── Stock Detail ─────────────────────────────────────────────────────────────

func (h *Handler) StockDetail(c *gin.Context) {
	symbol := c.Param("symbol")
	if symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol required"})
		return
	}

	stock, err := h.repo.GetStockBySymbol(symbol)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "stock not found"})
		return
	}

	to := time.Now()
	from := to.AddDate(-1, 0, 0)
	bars, _ := h.repo.GetPriceBars(stock.ID, from, to)

	indFrom := to.AddDate(0, -2, 0)
	indicators, _ := h.repo.GetTechnicalIndicators(stock.ID, indFrom, to)
	latestInd, _   := h.repo.GetLatestTechnicalIndicator(stock.ID)
	fundamental, _ := h.repo.GetFundamental(stock.ID)
	srLevels, _    := h.repo.GetSRLevels(stock.ID)
	// Return all horizon recommendations for this stock
	allRecs, _ := h.repo.GetStockRecommendations(stock.ID, 30)

	// Latest rec per horizon
	recsByHorizon := map[string]*storage.Recommendation{}
	for i := range allRecs {
		r := &allRecs[i]
		if _, exists := recsByHorizon[r.Horizon]; !exists {
			recsByHorizon[r.Horizon] = r
		}
	}

	// For backwards-compat still return single "recommendation" (highest confidence)
	var bestRec *storage.Recommendation
	for _, r := range recsByHorizon {
		if bestRec == nil || r.Confidence > bestRec.Confidence {
			bestRec = r
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"stock":                  stock,
		"price_history":          bars,
		"indicators":             indicators,
		"latest_indicator":       latestInd,
		"fundamental":            fundamental,
		"sr_levels":              srLevels,
		"recommendation":         bestRec,
		"recommendations_by_horizon": recsByHorizon,
		"recommendation_history": allRecs,
	})
}

// ─── Price History ────────────────────────────────────────────────────────────

func (h *Handler) PriceHistory(c *gin.Context) {
	symbol := c.Param("symbol")
	days := 365
	if d := c.Query("days"); d != "" {
		if parsed, err := strconv.Atoi(d); err == nil && parsed > 0 {
			days = parsed
		}
	}
	stock, err := h.repo.GetStockBySymbol(symbol)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "stock not found"})
		return
	}
	to := time.Now()
	from := to.AddDate(0, 0, -days)
	bars, err := h.repo.GetPriceBars(stock.ID, from, to)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"symbol": symbol, "bars": bars, "count": len(bars)})
}

// ─── Technical Indicators ─────────────────────────────────────────────────────

func (h *Handler) TechnicalIndicators(c *gin.Context) {
	symbol := c.Param("symbol")
	stock, err := h.repo.GetStockBySymbol(symbol)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "stock not found"})
		return
	}
	to := time.Now()
	from := to.AddDate(0, -3, 0)
	indicators, _ := h.repo.GetTechnicalIndicators(stock.ID, from, to)
	latestInd, _  := h.repo.GetLatestTechnicalIndicator(stock.ID)
	c.JSON(http.StatusOK, gin.H{"symbol": symbol, "indicators": indicators, "latest": latestInd})
}

// ─── Recommendations ─────────────────────────────────────────────────────────

func (h *Handler) ListRecommendations(c *gin.Context) {
	market  := c.Query("market")
	horizon := c.Query("horizon") // intraday | swing | longterm | "" = all
	limit   := 30
	if l := c.Query("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	recs, err := h.repo.GetLatestRecommendations(market, horizon, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"recommendations": recs, "total": len(recs), "market": market, "horizon": horizon})
}

// ─── S/R Levels ──────────────────────────────────────────────────────────────

func (h *Handler) SupportResistance(c *gin.Context) {
	symbol := c.Param("symbol")
	stock, err := h.repo.GetStockBySymbol(symbol)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "stock not found"})
		return
	}
	levels, err := h.repo.GetSRLevels(stock.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"symbol": symbol, "levels": levels})
}

// ─── Intraday Signals ─────────────────────────────────────────────────────────

func (h *Handler) IntradaySignals(c *gin.Context) {
	signals, err := h.strategyEngine.GetIntradaySignals()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"signals": signals, "count": len(signals)})
}

// ─── Investment Signals ───────────────────────────────────────────────────────

func (h *Handler) InvestmentSignals(c *gin.Context) {
	market  := c.Query("market")
	horizon := c.Query("horizon") // swing | longterm | "" = all
	signals, err := h.strategyEngine.GetInvestmentSignals(market)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Filter by horizon if specified
	if horizon != "" {
		filtered := signals[:0]
		for _, s := range signals {
			if s.Horizon == horizon {
				filtered = append(filtered, s)
			}
		}
		signals = filtered
	}
	c.JSON(http.StatusOK, gin.H{"signals": signals, "count": len(signals), "market": market, "horizon": horizon})
}

// ─── NIFTY / Index Signals ────────────────────────────────────────────────────

func (h *Handler) IndexSignals(c *gin.Context) {
	market := c.Query("market") // optional: "NSE" or "US"
	signals, err := h.strategyEngine.GetIndexSignals(market)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"signals": signals, "count": len(signals)})
}

// ─── Scalping Signals ────────────────────────────────────────────────────────

func (h *Handler) ScalpingSignals(c *gin.Context) {
	timeframe := c.Query("timeframe") // 1m, 5m, 15m
	if timeframe == "" {
		timeframe = "5m"
	}

	scope := c.Query("scope") // "index" for NIFTY/BANKNIFTY only, "" for stocks
	var signals []strategy.ScalpSignal
	var err error

	if scope == "index" {
		signals, err = h.strategyEngine.GetIndexScalpingSignals(timeframe)
	} else {
		signals, err = h.strategyEngine.GetScalpingSignals(timeframe)
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"signals":   signals,
		"count":     len(signals),
		"timeframe": timeframe,
		"scope":     scope,
	})
}

// ─── Trades ──────────────────────────────────────────────────────────────────

func (h *Handler) ListTrades(c *gin.Context) {
	market := c.Query("market")
	trades, err := h.repo.GetActiveTrades(market)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"trades": trades, "count": len(trades)})
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

func (h *Handler) RunBacktest(c *gin.Context) {
	symbol       := c.Param("symbol")
	strategyName := c.Query("strategy")
	if strategyName == "" {
		strategyName = "RSI_MACD"
	}
	stock, err := h.repo.GetStockBySymbol(symbol)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "stock not found"})
		return
	}
	to := time.Now()
	from := to.AddDate(-2, 0, 0)
	bars, err := h.repo.GetPriceBars(stock.ID, from, to)
	if err != nil || len(bars) < 60 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "insufficient data for backtest"})
		return
	}
	runner := strategy.NewRunner(strategy.BacktestConfig{
		InitialCapital:  h.cfg.Backtest.DefaultCapital,
		CommissionPct:   h.cfg.Backtest.CommissionPct / 100,
		SlippagePct:     h.cfg.Backtest.SlippagePct / 100,
		PositionSizePct: 0.10,
	})
	var stratFn strategy.StrategyFunc
	switch strategyName {
	case "ORB":
		stratFn = strategy.ORBStrategy
	default:
		stratFn = strategy.RSIMACDStrategy
	}
	result := runner.Run(strategyName, symbol, bars, stratFn)
	model := runner.ToStorageModel(result)
	_ = h.repo.SaveStrategyResult(&model)
	c.JSON(http.StatusOK, gin.H{
		"strategy":      result.StrategyName,
		"symbol":        result.Symbol,
		"total_trades":  result.TotalTrades,
		"win_rate":      result.WinRate,
		"profit_factor": result.ProfitFactor,
		"max_drawdown":  result.MaxDrawdown,
		"net_pnl":       result.NetPnL,
		"net_pnl_pct":   result.NetPnLPct,
		"sharpe_ratio":  result.SharpeRatio,
		"avg_win":       result.AvgWin,
		"avg_loss":      result.AvgLoss,
		"trades":        result.Trades,
	})
}

// ─── Strategy Results ─────────────────────────────────────────────────────────

func (h *Handler) StrategyResults(c *gin.Context) {
	strategyName := c.Query("strategy")
	symbol       := c.Query("symbol")
	results, err := h.repo.GetStrategyResults(strategyName, symbol)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"results": results})
}

// ─── Long-Term US SIP Picks ───────────────────────────────────────────────────

// LongTermUSPicks generates 3-year SIP-optimised picks for US growth stocks.
// Scores each stock across 5 dimensions: growth sector, fundamentals,
// valuation, technicals, and SIP suitability.
func (h *Handler) LongTermUSPicks(c *gin.Context) {
	stocks, err := h.repo.GetStocksByMarket("US")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	indicators := map[uint]*storage.TechnicalIndicator{}
	fundamentals := map[uint]*storage.Fundamental{}
	latestPrices := map[uint]float64{}

	to := time.Now()
	from := to.AddDate(0, 0, -5)

	for _, stock := range stocks {
		if stock.IsIndex {
			continue
		}
		if ind, e := h.repo.GetLatestTechnicalIndicator(stock.ID); e == nil && ind != nil {
			indicators[stock.ID] = ind
		}
		if fund, e := h.repo.GetFundamental(stock.ID); e == nil && fund != nil {
			fundamentals[stock.ID] = fund
		}
		if bars, e := h.repo.GetPriceBars(stock.ID, from, to); e == nil && len(bars) > 0 {
			latestPrices[stock.ID] = bars[len(bars)-1].Close
		}
	}

	analyzer := alpha.NewLongTermUSAnalyzer()
	report := analyzer.GeneratePicks(stocks, indicators, fundamentals, latestPrices)
	c.JSON(http.StatusOK, report)
}

// ─── Undervalued Stocks ───────────────────────────────────────────────────────

// UndervaluedStocks scans all tracked stocks for undervalued opportunities
// using fundamental + technical analysis (P/E, P/B, EPS growth, ROE, RSI).
func (h *Handler) UndervaluedStocks(c *gin.Context) {
	market := c.Query("market") // optional: NSE | US | "" = all

	var stocks []storage.Stock
	var err error
	if market != "" {
		stocks, err = h.repo.GetStocksByMarket(market)
	} else {
		stocks, err = h.repo.GetAllStocks()
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Build indicator and fundamental maps
	indicators := map[uint]*storage.TechnicalIndicator{}
	fundamentals := map[uint]*storage.Fundamental{}
	latestPrices := map[uint]float64{}

	to := time.Now()
	from := to.AddDate(0, 0, -5)

	for _, stock := range stocks {
		if stock.IsIndex {
			continue
		}
		if ind, e := h.repo.GetLatestTechnicalIndicator(stock.ID); e == nil && ind != nil {
			indicators[stock.ID] = ind
		}
		if fund, e := h.repo.GetFundamental(stock.ID); e == nil && fund != nil {
			fundamentals[stock.ID] = fund
		}
		bars, _ := h.repo.GetPriceBars(stock.ID, from, to)
		if len(bars) > 0 {
			latestPrices[stock.ID] = bars[len(bars)-1].Close
		}
	}

	// Get portfolio symbols for cross-referencing
	portfolioSymbols := map[string]bool{}
	if holdings, e := h.repo.GetAllPortfolioHoldings(); e == nil {
		for _, hld := range holdings {
			portfolioSymbols[hld.Symbol] = true
			portfolioSymbols[hld.YFSymbol] = true
		}
	}

	analyzer := alpha.NewUndervaluedAnalyzer()
	undervalued := analyzer.FindUndervalued(stocks, indicators, fundamentals, latestPrices, portfolioSymbols)

	c.JSON(http.StatusOK, gin.H{
		"undervalued":  undervalued,
		"count":        len(undervalued),
		"market":       market,
		"generated_at": time.Now().Format(time.RFC3339),
	})
}
