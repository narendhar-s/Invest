package api

import (
	"net/http"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"

	"stockwise/internal/storage"
	"stockwise/internal/strategy"
	"stockwise/pkg/config"
)

// NewRouter creates and configures the Gin router.
func NewRouter(repo *storage.Repository, engine *strategy.Engine, cfg *config.Config) *gin.Engine {
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

	h := NewHandler(repo, engine, cfg)

	// ── API v1 ────────────────────────────────────────────────────────────
	v1 := r.Group("/api/v1")
	{
		v1.GET("/health", h.Health)

		// Dashboard
		v1.GET("/dashboard", h.Dashboard)

		// Stocks
		v1.GET("/stocks", h.ListStocks)
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

		// Portfolio
		v1.GET("/portfolio", h.GetPortfolio)
		v1.POST("/portfolio/holding", h.UpsertPortfolioHolding)
		v1.DELETE("/portfolio/holding/:symbol", h.DeletePortfolioHolding)
		v1.POST("/portfolio/holding/:symbol/buy", h.BuyMore)
		v1.POST("/portfolio/holding/:symbol/sell", h.SellPartial)
		v1.GET("/portfolio/holding/:symbol", h.PortfolioStockDetail)

		// Backtest results
		v1.GET("/backtest/results", h.StrategyResults)
		v1.GET("/backtest/scalping", h.ScalpingBacktest)
	}

	// ── Static frontend (for production) ─────────────────────────────────
	r.Static("/assets", "./frontend/dist/assets")
	r.StaticFile("/favicon.ico", "./frontend/dist/favicon.ico")
	r.NoRoute(func(c *gin.Context) {
		// Try to serve the frontend SPA
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
