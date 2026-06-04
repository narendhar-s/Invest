package api

import (
	"net/http"
	"strings"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"

	"stockwise/internal/data"
	"stockwise/internal/recommendation"
	"stockwise/internal/storage"
	"stockwise/internal/strategy"
	"stockwise/pkg/config"
)

// NewRouter creates and configures the Gin router.
func NewRouter(repo *storage.Repository, engine *strategy.Engine, fetcher *data.Fetcher, recEngine *recommendation.Engine, kite *data.KiteClient, kiteStream *data.KiteStream, liveEngine *strategy.LiveEngine, dataSource data.MarketDataSource, cfg *config.Config) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(requestLogger())

	// CORS: allow frontend dev server (localhost:5173) and any origin
	r.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"http://localhost:5173", "http://localhost:3000", "http://localhost:8080"},
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
		AllowCredentials: true,
	}))

	h := NewHandler(repo, engine, fetcher, recEngine, kite, kiteStream, liveEngine, dataSource, cfg)

	// ── API v1 ────────────────────────────────────────────────────────────
	v1 := r.Group("/api/v1")
	{
		v1.GET("/health", h.Health)

		// Dashboard
		v1.GET("/dashboard", h.Dashboard)

		// Stocks
		v1.GET("/stocks", h.ListStocks)
		v1.POST("/stocks/add", h.AddStock)
		v1.GET("/stocks/:symbol", h.StockDetail)
		v1.GET("/stocks/:symbol/price-history", h.PriceHistory)
		v1.GET("/stocks/:symbol/indicators", h.TechnicalIndicators)
		v1.GET("/stocks/:symbol/sr-levels", h.SupportResistance)
		v1.GET("/stocks/:symbol/backtest", h.RunBacktest)

		// Recommendations
		v1.GET("/recommendations", h.ListRecommendations)

		// Signals
		v1.GET("/signals/intraday", h.IntradaySignals)
		v1.GET("/signals/investment", h.InvestmentSignals)
		v1.GET("/signals/index", h.IndexSignals)
		v1.GET("/signals/scalping", h.ScalpingSignals)
		v1.GET("/signals/undervalued", h.UndervaluedStocks)
		v1.GET("/signals/btst", h.BTSTSignals)
		v1.GET("/signals/longterm-us", h.LongTermUSPicks)

		// Trades
		v1.GET("/trades", h.ListTrades)

		// Auth
		v1.POST("/auth/unlock", h.UnlockPortfolio)

		// Portfolio (password-protected)
		portfolio := v1.Group("/portfolio", h.PortfolioAuthMiddleware())
		{
			portfolio.GET("", h.GetPortfolio)
			portfolio.POST("/holding", h.UpsertPortfolioHolding)
			portfolio.DELETE("/holding/:symbol", h.DeletePortfolioHolding)
			portfolio.POST("/holding/:symbol/buy", h.BuyMore)
			portfolio.POST("/holding/:symbol/sell", h.SellPartial)
			portfolio.GET("/holding/:symbol", h.PortfolioStockDetail)
		}

		// Backtest results
		v1.GET("/backtest/results", h.StrategyResults)
		v1.GET("/backtest/scalping", h.ScalpingBacktest)

		// Zerodha / Live data
		v1.GET("/zerodha/status",    h.ZerodhaStatus)
		v1.GET("/zerodha/login-url", h.ZerodhaLoginURL)
		v1.GET("/zerodha/callback",  h.ZerodhaCallback)
		v1.POST("/zerodha/logout",   h.ZerodhaLogout)
		v1.GET("/zerodha/quotes",    h.ZerodhaQuotes)
		v1.GET("/zerodha/stream",    h.ZerodhaStream)

		// Live strategy trading
		v1.GET("/live/strategies", h.ListStrategies)
		v1.GET("/live/strategies/:key/config", h.GetStrategyConfig)
		v1.PUT("/live/strategies/:key/config", h.UpdateStrategyConfig)
		v1.GET("/live/status",     h.LiveStatus)
		v1.POST("/live/start",     h.LiveStart)
		v1.POST("/live/stop",      h.LiveStop)
		v1.GET("/live/calls",      h.LiveCallsStream)
		v1.GET("/live/calls/history", h.LiveCallsHistory)
		v1.GET("/live/patterns",   h.ListPatterns)
		v1.GET("/live/snapshot",   h.LiveSnapshot)
		v1.GET("/live/candles",    h.LiveCandlesStream)
		v1.GET("/live/candles/ws", h.LiveCandlesWS)
		v1.GET("/live/oi",         h.LiveOI)
		v1.GET("/live/history",    h.LiveHistory)
		v1.GET("/live/backtest",   h.LiveBacktest)
	}

	// ── Static frontend (for production) ─────────────────────────────────
	r.Static("/assets", "./frontend/dist/assets")
	r.StaticFile("/favicon.ico", "./frontend/dist/favicon.ico")
	r.NoRoute(func(c *gin.Context) {
		// Unmatched API paths must return JSON 404 — never the SPA shell.
		// Serving index.html for an /api miss lets browsers cache HTML against
		// an API URL, which then masks the real endpoint even after it exists.
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			c.Header("Cache-Control", "no-store")
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		// Serve the frontend SPA for client-side routes.
		if c.Request.Method == http.MethodGet {
			c.File("./frontend/dist/index.html")
			return
		}
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
	})

	return r
}

func requestLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
	}
}
