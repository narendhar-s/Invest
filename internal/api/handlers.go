package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"stockwise/internal/analysis/alpha"
	"stockwise/internal/data"
	"stockwise/internal/recommendation"
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
	fetcher        *data.Fetcher
	recEngine      *recommendation.Engine
	cfg            *config.Config
	kite           *data.KiteClient
	kiteStream     *data.KiteStream
	liveEngine     *strategy.LiveEngine
	dataSource     data.MarketDataSource
}

func NewHandler(repo *storage.Repository, engine *strategy.Engine, fetcher *data.Fetcher, recEngine *recommendation.Engine, kite *data.KiteClient, kiteStream *data.KiteStream, liveEngine *strategy.LiveEngine, dataSource data.MarketDataSource, cfg *config.Config) *Handler {
	return &Handler{repo: repo, strategyEngine: engine, fetcher: fetcher, recEngine: recEngine, kite: kite, kiteStream: kiteStream, liveEngine: liveEngine, dataSource: dataSource, cfg: cfg}
}

// inferMarket auto-detects the market from the symbol format.
func inferMarket(symbol string) string {
	if strings.HasPrefix(symbol, "^") {
		return "INDEX"
	}
	upper := strings.ToUpper(symbol)
	if strings.HasSuffix(upper, ".NS") || strings.HasSuffix(upper, ".BO") {
		return "NSE"
	}
	return "US"
}

// ─── Add Stock ────────────────────────────────────────────────────────────────

// AddStock fetches, analyses, and returns recommendations for any symbol on demand.
func (h *Handler) AddStock(c *gin.Context) {
	var req struct {
		Symbol string `json:"symbol" binding:"required"`
		Market string `json:"market"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol is required"})
		return
	}

	symbol := strings.ToUpper(strings.TrimSpace(req.Symbol))
	if symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol cannot be empty"})
		return
	}

	market := req.Market
	if market == "" {
		market = inferMarket(symbol)
	}

	// Step 1: Fetch price data + fundamentals from Yahoo Finance
	if err := h.fetcher.FetchOneSymbol(symbol); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   fmt.Sprintf("could not fetch data for %s", symbol),
			"details": err.Error(),
		})
		return
	}

	// Step 2: Retrieve the stock record (created/updated by fetch)
	stock, err := h.repo.GetStockBySymbol(symbol)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "stock not found after fetch"})
		return
	}

	// Patch market if still UNKNOWN (custom symbol not in config)
	if stock.Market == "UNKNOWN" || stock.Market == "" {
		stock.Market = market
		_ = h.repo.UpsertStock(stock)
	}

	// Step 3: Run technical analysis + S/R levels
	_ = h.strategyEngine.RunForStock(*stock)

	// Step 4: Generate recommendations for all horizons
	_ = h.recEngine.GenerateForStock(*stock)

	// Step 5: Return latest recommendation per horizon
	allRecs, _ := h.repo.GetStockRecommendations(stock.ID, 20)
	recsByHorizon := map[string]*storage.Recommendation{}
	for i := range allRecs {
		r := &allRecs[i]
		r.Stock = stock // attach stock info
		if _, exists := recsByHorizon[r.Horizon]; !exists {
			recsByHorizon[r.Horizon] = r
		}
	}

	// Latest indicator snapshot
	latestInd, _ := h.repo.GetLatestTechnicalIndicator(stock.ID)
	fund, _ := h.repo.GetFundamental(stock.ID)

	c.JSON(http.StatusOK, gin.H{
		"stock":           stock,
		"recommendations": recsByHorizon,
		"latest_indicator": latestInd,
		"fundamental":     fund,
		"message":         fmt.Sprintf("Stock %s fetched and analysed successfully", symbol),
	})
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

// ─── Zerodha / Kite Handlers ──────────────────────────────────────────────────

// ZerodhaLoginURL returns the Kite Connect OAuth URL.
// The originating host is encoded in the OAuth state parameter so that
// ZerodhaCallback can redirect back to the right frontend after auth —
// even when the Kite redirect URI is registered to a different host (e.g. OCI).
func (h *Handler) ZerodhaLoginURL(c *gin.Context) {
	if h.kite == nil || h.cfg.Zerodha.APIKey == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error":      "Zerodha not configured",
			"hint":       "Set ZERODHA_API_KEY and ZERODHA_API_SECRET in your .env file",
			"configured": false,
		})
		return
	}

	// Detect the frontend's origin from headers so we can carry it through
	// the Kite OAuth round-trip as a state parameter.
	stateBase := localhostOrigin(c)
	loginURL := h.kite.LoginURL(h.cfg.Zerodha.RedirectURL)
	if stateBase != "" {
		loginURL += "&state=" + url.QueryEscape(stateBase)
	}
	c.JSON(http.StatusOK, gin.H{
		"login_url":  loginURL,
		"configured": true,
	})
}

// ZerodhaCallback handles the OAuth redirect from Zerodha after user login.
func (h *Handler) ZerodhaCallback(c *gin.Context) {
	reqToken := c.Query("request_token")
	status   := c.Query("status")

	// Recover the originating frontend host from the OAuth state parameter.
	// Only localhost origins are trusted; production uses a relative URL.
	returnBase := ""
	if s, _ := url.QueryUnescape(c.Query("state")); isSafeLocalOrigin(s) {
		returnBase = s
	}
	narenRedirect := func(suffix string) string {
		if returnBase != "" {
			return returnBase + "/naren" + suffix
		}
		return "/naren" + suffix // relative — works on any production host
	}

	if status != "success" || reqToken == "" {
		c.Redirect(http.StatusFound, narenRedirect("?zerodha=error&msg=login_cancelled"))
		return
	}

	accessToken, err := h.kite.ExchangeToken(reqToken)
	if err != nil {
		c.Redirect(http.StatusFound,
			narenRedirect("?zerodha=error&msg="+url.QueryEscape(err.Error())))
		return
	}

	h.kite.SetAccessToken(accessToken)
	_ = h.repo.SetSetting("zerodha_access_token", accessToken)
	_ = h.repo.SetSetting("zerodha_token_date", time.Now().Format("2006-01-02"))

	// (Re)start the live stream
	if h.kiteStream != nil {
		h.kiteStream.Stop()
		h.kiteStream.Start()
	}

	c.Redirect(http.StatusFound, narenRedirect("?zerodha=connected"))
}

// localhostOrigin returns the scheme+host of the request if it originated from
// localhost (detected via Referer/Origin headers), or "" for production.
func localhostOrigin(c *gin.Context) string {
	for _, h := range []string{c.GetHeader("Origin"), c.GetHeader("Referer")} {
		if h == "" {
			continue
		}
		if strings.Contains(h, "localhost") || strings.Contains(h, "127.0.0.1") {
			if u, err := url.Parse(h); err == nil && u.Host != "" {
				return u.Scheme + "://" + u.Host
			}
		}
	}
	return ""
}

// isSafeLocalOrigin returns true when s is a localhost/loopback URL.
// Prevents open-redirect attacks by rejecting arbitrary state values.
func isSafeLocalOrigin(s string) bool {
	if s == "" {
		return false
	}
	return strings.HasPrefix(s, "http://localhost:") ||
		strings.HasPrefix(s, "http://127.0.0.1:")
}

// ZerodhaStatus returns Zerodha connection state.
func (h *Handler) ZerodhaStatus(c *gin.Context) {
	configured := h.kite != nil && h.cfg.Zerodha.APIKey != ""
	connected  := configured && h.kite.IsConnected()
	streaming  := h.kiteStream != nil && h.kiteStream.IsRunning()
	tokenDate, _ := h.repo.GetSetting("zerodha_token_date")

	c.JSON(http.StatusOK, gin.H{
		"configured":   configured,
		"connected":    connected,
		"streaming":    streaming,
		"token_date":   tokenDate,
		"live_trading": h.cfg.Zerodha.LiveTradingEnabled,
	})
}

// ZerodhaLogout clears the stored access token and stops the stream.
func (h *Handler) ZerodhaLogout(c *gin.Context) {
	if h.kite != nil {
		h.kite.SetAccessToken("")
	}
	if h.kiteStream != nil {
		h.kiteStream.Stop()
	}
	_ = h.repo.SetSetting("zerodha_access_token", "")
	c.JSON(http.StatusOK, gin.H{"message": "Disconnected from Zerodha"})
}

// ZerodhaQuotes returns a snapshot of all current live NSE quotes.
func (h *Handler) ZerodhaQuotes(c *gin.Context) {
	if h.kiteStream == nil || !h.kite.IsConnected() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Zerodha not connected"})
		return
	}
	quotes := h.kiteStream.GetAllQuotes()
	c.JSON(http.StatusOK, gin.H{"quotes": quotes, "count": len(quotes), "source": "zerodha_live"})
}

// placeOrderRequest is the JSON body accepted by ZerodhaPlaceOrder.
type placeOrderRequest struct {
	Symbol          string  `json:"symbol"`           // RELIANCE.NS (equity) or option tradingsymbol e.g. NIFTY25JUN24500CE
	Exchange        string  `json:"exchange"`         // NSE / BSE / NFO / BFO (default NSE)
	TransactionType string  `json:"transaction_type"` // BUY / SELL
	Quantity        int     `json:"quantity"`         // shares (equity) or lots × lot_size (options)
	Product         string  `json:"product"`          // MIS / CNC / NRML (default MIS)
	OrderType       string  `json:"order_type"`       // MARKET / LIMIT (default MARKET)
	Price           float64 `json:"price"`            // required for LIMIT
}

// ZerodhaPlaceOrder places a REAL order on the user's Zerodha account via Kite.
// Guarded by the server-side live_trading_enabled kill-switch AND an active
// Zerodha session. Supports equity (NSE/BSE) and options (NFO/BFO).
func (h *Handler) ZerodhaPlaceOrder(c *gin.Context) {
	// 1. Server-side master kill-switch.
	if !h.cfg.Zerodha.LiveTradingEnabled {
		c.JSON(http.StatusForbidden, gin.H{
			"error": "live trading is disabled on the server (set zerodha.live_trading_enabled: true in config.yaml)",
		})
		return
	}
	// 2. Must have an authenticated Kite session.
	if h.kite == nil || !h.kite.IsConnected() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Zerodha not connected — log in first"})
		return
	}

	var req placeOrderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body: " + err.Error()})
		return
	}

	// 3. Validate.
	req.Symbol = strings.TrimSpace(req.Symbol)
	req.TransactionType = strings.ToUpper(strings.TrimSpace(req.TransactionType))
	req.Exchange = strings.ToUpper(strings.TrimSpace(req.Exchange))
	req.Product = strings.ToUpper(strings.TrimSpace(req.Product))
	req.OrderType = strings.ToUpper(strings.TrimSpace(req.OrderType))

	if req.Symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol is required"})
		return
	}
	if req.TransactionType != "BUY" && req.TransactionType != "SELL" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "transaction_type must be BUY or SELL"})
		return
	}
	if req.Quantity <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "quantity must be greater than 0"})
		return
	}
	if req.Exchange == "" {
		req.Exchange = "NSE"
	}
	if req.Product == "" {
		req.Product = "MIS"
	}
	if req.OrderType == "" {
		req.OrderType = "MARKET"
	}
	if req.OrderType == "LIMIT" && req.Price <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "price is required for LIMIT orders"})
		return
	}

	orderID, err := h.kite.PlaceOrder(data.OrderRequest{
		Symbol:          req.Symbol,
		Exchange:        req.Exchange,
		TransactionType: req.TransactionType,
		Quantity:        req.Quantity,
		Product:         req.Product,
		OrderType:       req.OrderType,
		Price:           req.Price,
		Variety:         "regular",
	})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"order_id":         orderID,
		"status":           "placed",
		"symbol":           req.Symbol,
		"exchange":         req.Exchange,
		"transaction_type": req.TransactionType,
		"quantity":         req.Quantity,
		"product":          req.Product,
		"order_type":       req.OrderType,
	})
}

// ZerodhaLTP returns the last traded price for a single instrument so the trade
// ticket can preview the price before the user confirms. Query params:
//
//	?symbol=RELIANCE.NS&exchange=NSE         (equity)
//	?symbol=NIFTY25JUN24500CE&exchange=NFO   (option tradingsymbol)
func (h *Handler) ZerodhaLTP(c *gin.Context) {
	if h.kite == nil || !h.kite.IsConnected() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Zerodha not connected"})
		return
	}
	symbol := strings.TrimSpace(c.Query("symbol"))
	exchange := strings.ToUpper(strings.TrimSpace(c.Query("exchange")))
	if symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol is required"})
		return
	}
	if exchange == "" {
		exchange = "NSE"
	}
	// Build the Kite instrument key. Equity symbols carry Yahoo suffixes that
	// must be stripped; option tradingsymbols are used verbatim.
	trading := symbol
	if exchange == "NSE" || exchange == "BSE" {
		trading = strings.TrimSuffix(strings.TrimSuffix(symbol, ".NS"), ".BO")
	}
	inst := exchange + ":" + trading

	quotes, err := h.kite.FetchLiveQuotes([]string{inst})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	// FetchLiveQuotes re-keys results by a Yahoo-style symbol; with a single
	// instrument we can just take whatever it returned.
	for _, q := range quotes {
		c.JSON(http.StatusOK, gin.H{
			"symbol":     symbol,
			"exchange":   exchange,
			"last_price": q.LastPrice,
			"change":     q.Change,
			"change_pct": q.ChangePct,
		})
		return
	}
	c.JSON(http.StatusNotFound, gin.H{"error": "no quote for " + inst})
}

// ZerodhaStream is an SSE endpoint that pushes live quote updates every ~3 s.
func (h *Handler) ZerodhaStream(c *gin.Context) {
	if h.kiteStream == nil || !h.kite.IsConnected() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Zerodha not connected"})
		return
	}

	c.Header("Content-Type",      "text/event-stream")
	c.Header("Cache-Control",     "no-cache")
	c.Header("Connection",        "keep-alive")
	c.Header("X-Accel-Buffering", "no")

	// Send the current snapshot immediately so the client has data right away
	snap := h.kiteStream.GetAllQuotes()
	if snapJSON, err := json.Marshal(snap); err == nil {
		fmt.Fprintf(c.Writer, "data: %s\n\n", snapJSON)
		c.Writer.Flush()
	}

	ch := h.kiteStream.Subscribe()
	defer h.kiteStream.Unsubscribe(ch)

	clientGone := c.Request.Context().Done()
	for {
		select {
		case <-clientGone:
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(c.Writer, "data: %s\n\n", msg)
			c.Writer.Flush()
		}
	}
}
