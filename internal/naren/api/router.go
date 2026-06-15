package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"stockwise/internal/naren/config"
	"stockwise/internal/naren/news"
	"stockwise/internal/naren/storage"
	"stockwise/internal/naren/strategy"
)

// Mount registers all NarenInvestment routes onto an existing Gin engine under
// the /api/naren/v1 prefix. It does NOT create a new engine, configure CORS, or
// serve static files — the host (Invest) application owns those concerns. This
// lets the merged single binary expose Invest at /api/v1 and Naren at
// /api/naren/v1 side-by-side without any route collisions.
//
// PAPER-TRADE SAFETY: the original NarenInvestment app is paper-trading only and
// blocks any Kite order/GTT/basket endpoint. That guard is preserved here but
// scoped to the Naren group only, so it never affects Invest's own routes.
func Mount(
	r *gin.Engine,
	repo *storage.Repository,
	engine *strategy.Engine,
	cfg *config.Config,
	newsMonitor *news.Monitor,
	logger *zap.Logger,
) {
	// ── Angel One SmartAPI: DISABLED ──────────────────────────────────────
	// This merged app deliberately does NOT use Angel One streaming at all —
	// all real-time data comes from the Zerodha Kite websocket below. InitAngelOne
	// is intentionally not called, so aoService stays nil; the /ao/* endpoints
	// remain registered but report disabled, and the frontend falls back to the
	// Kite-backed feed automatically.

	// ── Zerodha Kite Connect (READ-ONLY · paper→PostgreSQL · NSE→MongoDB) ─
	InitKite(cfg.Kite, cfg.Mongo, repo.DB(), logger)

	// ── 90-Day Paper Trading Challenge (uses WebSocket ticker) ─────────────
	// cfg.Kite.LiveTradingEnabled is the master switch that allows the options
	// challenge's Live mode to place REAL Zerodha orders (default false).
	if kiteSvc != nil {
		InitChallenge(repo.DB(), kiteSvc.client, kiteSvc.ticker, logger, cfg.Kite.LiveTradingEnabled)
		// Telegram remote-control bot (allowlisted chats only). Safe to call when
		// disabled — it no-ops. Binds to the challenge services just initialised.
		StartTelegram(cfg.Telegram, logger)
	}

	h := NewHandler(repo, engine, cfg, newsMonitor)

	// ── API v1 (Naren namespace) ──────────────────────────────────────────
	v1 := r.Group("/api/naren/v1")

	// PAPER TRADE ONLY — hard block on any Kite order endpoints, scoped to the
	// Naren group so Invest routes are unaffected.
	v1.Use(func(c *gin.Context) {
		path := strings.ToLower(c.Request.URL.Path)
		for _, blocked := range []string{"/orders", "/gtt", "/basket"} {
			if strings.Contains(path, blocked) {
				c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
					"error":  "FORBIDDEN — this app is paper-trading only. Real orders cannot be placed.",
					"safety": "PAPER_TRADE_ONLY",
				})
				return
			}
		}
		c.Next()
	})

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

		// Nifty Scalping Terminal
		v1.GET("/nifty/dashboard", h.NiftyDashboard)
		v1.GET("/nifty/option-chain", h.NiftyOptionChain)
		v1.GET("/nifty/strike-suggestions", h.NiftyStrikeSuggestions)
		v1.GET("/nifty/live-signals", h.NiftyLiveSignals)
		v1.GET("/nifty/strategies", h.NiftyStrategyCards)
		v1.GET("/nifty/chart-data", h.NiftyChartData)
		v1.GET("/nifty/btst", h.NiftyBTST)

		// SIP Watchlist (live price + fundamentals + technicals)
		v1.GET("/watchlist", h.GetWatchlist)

		// News flags (hourly-refreshed sentiment)
		v1.GET("/news/flags", h.NewsFlags)

		// Fundamental / Screener / Warren Buffett Analysis
		v1.GET("/fundamental/search", h.FundamentalSearch)
		v1.GET("/fundamental/analyze/:symbol", h.FundamentalAnalyze)

		// Michael J. Huddleston ICT Strategy
		v1.GET("/nifty/huddleston-signal", h.HuddlestonSignal)
		v1.GET("/nifty/huddleston-backtest", h.HuddlestonBacktest)

		// On-demand picks with entry/exit levels
		v1.GET("/nifty/tomorrow-picks", h.TomorrowPicks)
		v1.GET("/nifty/today-picks", h.TodayPicks)

		// Options Power Setup
		v1.GET("/nifty/options-signal", h.OptionsSignal)
		v1.GET("/nifty/options-backtest", h.OptionsBacktest)

		// SMC Strategy (87.5% backtested WR)
		v1.GET("/nifty/smc-signal", h.SMCSignal)
		v1.GET("/nifty/smc-backtest", h.SMCBacktest)
		v1.GET("/nifty/smc-events", h.SMCEvents)
		// 6 Book-proven scalping strategies terminal
		v1.GET("/nifty/book-scalp", h.BookScalpTerminal)

		// CPR (Central Pivot Range) strategy
		v1.GET("/nifty/cpr-signal", h.CPRSignal)
		v1.GET("/nifty/cpr-backtest", h.CPRBacktest)
		v1.GET("/nifty/cpr-multi", h.CPRMultiTimeframe)

		// ICT + SMC Combined strategy
		v1.GET("/nifty/ict-smc-signal", h.ICTSMCSignal)
		v1.GET("/nifty/ict-smc-backtest", h.ICTSMCBacktest)
		v1.GET("/nifty/ict-smc-events", h.ICTSMCEvents)

		// SMC + FVG + VWAP multi-timeframe options scalping backtest
		v1.GET("/nifty/smc-fvg-vwap-backtest", h.SMCFVGVWAPBacktest)

		// Expiry Day live strategy (Iron Fly, Straddle, ORB, Max Pain)
		v1.GET("/nifty/expiry-day", h.ExpiryDaySignal)

		// P&L Analysis — upload Zerodha xlsx and get deep trade analytics
		v1.POST("/pnl/analyze", h.AnalyzePnL)

		// ── Kite Connect (READ-ONLY) + Paper Trading ──────────────────────
		v1.GET("/kite/status", h.KiteStatus)
		v1.GET("/kite/login", h.KiteLogin)
		v1.GET("/kite/callback", h.KiteCallback)
		v1.POST("/kite/auto-login", h.KiteAutoLogin) // new path
		v1.GET("/zerodha/callback", h.KiteCallback)  // matches Kite console setting
		v1.POST("/kite/token", h.KiteSetToken)
		v1.POST("/kite/disconnect", h.KiteDisconnect)
		v1.GET("/kite/nifty-quote", h.KiteNiftyQuote)
		v1.GET("/kite/analyze", h.KiteAnalyze)
		v1.GET("/kite/chart-data", h.KiteChartData)
		v1.POST("/kite/backtest", h.KiteBacktest)
		v1.POST("/kite/backtest-compare", h.KiteBacktestCompare)
		v1.POST("/kite/backtest-daily", h.KiteBacktestDaily)
		v1.GET("/kite/nse-status", h.KiteNseStatus)

		paper := v1.Group("/paper")
		{
			paper.GET("/state", h.PaperState)
			paper.POST("/auto", h.PaperAuto)
			paper.POST("/enter", h.PaperEnter)
			paper.POST("/close", h.PaperClose)
			paper.POST("/params", h.PaperParams)
		}

		// ── Live terminal (SSE stream + chart data) ────────────────────────
		v1.GET("/live/state", h.LiveState)
		v1.GET("/live/stream", h.LiveStream) // SSE
		v1.GET("/live/chart-data", h.LiveChartData)

		// ── 90-Day Challenge ───────────────────────────────────────────────
		ch := v1.Group("/challenge")
		{
			ch.GET("/status", h.ChallengeStatus)
			ch.POST("/start", h.ChallengeStart)
			ch.POST("/pause", h.ChallengePause)
			ch.POST("/resume", h.ChallengeResume)
			ch.POST("/enter", h.ChallengeEnter)
			ch.POST("/exit", h.ChallengeExit)
			ch.POST("/snapshot", h.ChallengeSnapshot)
			ch.POST("/backtest", h.ChallengeBacktest)
			ch.GET("/trades", h.ChallengeTrades)
			ch.GET("/daily", h.ChallengeDaily)
			ch.GET("/expiry-breakdown", h.ChallengeExpiryBreakdown)
			ch.GET("/all", h.ChallengeAll)
			ch.POST("/live-config", h.ChallengeLiveConfig) // enable real Zerodha orders + profit square-off
		}

		// ── 90-Day SCALP Challenge (EMA50/200 + Stochastic · 1-min · ATM CE/PE) ─
		sch := v1.Group("/scalp-challenge")
		{
			sch.GET("/status", h.ScalpChallengeStatus)
			sch.POST("/start", h.ScalpChallengeStart)
			sch.POST("/pause", h.ScalpChallengePause)
			sch.POST("/resume", h.ScalpChallengeResume)
			sch.POST("/enter", h.ScalpChallengeEnter)
			sch.POST("/exit", h.ScalpChallengeExit)
			sch.POST("/snapshot", h.ScalpChallengeSnapshot)
			sch.GET("/trades", h.ScalpChallengeTrades)
			sch.GET("/daily", h.ScalpChallengeDaily)
			sch.GET("/expiry-breakdown", h.ScalpChallengeExpiryBreakdown)
			sch.GET("/all", h.ScalpChallengeAll)
			sch.POST("/live-config", h.ScalpChallengeLiveConfig) // enable real Zerodha orders + profit square-off
		}

		// Scalp strategy backtest (surfaced in the Kite Terminal → Backtest tab)
		v1.POST("/kite/scalp-backtest", h.KiteScalpBacktest)

		v1.GET("/nifty/minervini", h.MinerviniPicks)
		v1.GET("/nifty/minervini-index", h.MinerviniNiftyIndex)
		v1.GET("/nifty/minervini-full", h.MinerviniFullScan)
		v1.GET("/nifty/smc-journal", h.SMCJournal)
		v1.POST("/nifty/smc-close-opens", h.SMCCloseOpens)

		// ── Angel One SmartAPI (real-time) ────────────────────────────────
		ao := v1.Group("/ao")
		{
			ao.GET("/status", AOStatus)
			ao.GET("/candles", AOCandles)
			ao.GET("/quote", AOQuote)
			ao.GET("/optionchain", AOOptionChain)
			ao.GET("/ws", AOWebSocket)
		}
	}
}
