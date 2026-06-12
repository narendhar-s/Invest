package main

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"go.uber.org/zap"

	"stockwise/internal/api"
	"stockwise/internal/data"
	"stockwise/internal/portfolio"
	"stockwise/internal/recommendation"
	"stockwise/internal/storage"
	"stockwise/internal/strategy"
	"stockwise/pkg/config"
	"stockwise/pkg/logger"
)

func loadDotEnv() {
	f, err := os.Open(".env")
	if err != nil {
		return
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 {
			key := strings.TrimSpace(parts[0])
			val := strings.TrimSpace(parts[1])
			if os.Getenv(key) == "" {
				os.Setenv(key, val)
			}
		}
	}
}

func main() {
	// ── Load .env before anything else ────────────────────────────────────
	loadDotEnv()

	// ── Initialise logger ─────────────────────────────────────────────────
	logger.Init(true)
	defer logger.Sync()

	logger.Info("starting StockWise platform")

	// ── Load config ────────────────────────────────────────────────────────
	cfg, err := config.Load("")
	if err != nil {
		logger.Fatal("loading config", zap.Error(err))
	}

	// ── Connect database ───────────────────────────────────────────────────
	db, err := storage.Connect(cfg.Database.DSN())
	if err != nil {
		logger.Fatal("connecting to database", zap.Error(err))
	}
	defer db.Close()

	repo := storage.NewRepository(db)

	// Seed portfolio holdings (idempotent — only inserts new, updates existing)
	for _, h := range portfolio.DefaultHoldings {
		hCopy := h
		if err := repo.UpsertPortfolioHolding(&hCopy); err != nil {
			logger.Warn("seeding portfolio holding", zap.String("symbol", h.Symbol), zap.Error(err))
		}
	}
	logger.Info("portfolio seeded", zap.Int("holdings", len(portfolio.DefaultHoldings)))

	fetcher := data.NewFetcher(cfg, repo)
	strategyEngine := strategy.NewEngine(cfg, repo)
	recEngine := recommendation.NewEngine(cfg, repo)

	// ── Zerodha Kite Connect ──────────────────────────────────────────────────
	var kiteClient *data.KiteClient
	var kiteStream *data.KiteStream
	var kiteTicker *data.KiteTicker
	var liveEngine *strategy.LiveEngine

	if cfg.Zerodha.APIKey != "" {
		kiteClient = data.NewKiteClient(cfg.Zerodha.APIKey, cfg.Zerodha.APISecret)

		// Restore access token from DB (survives server restarts within same day)
		if storedToken, err := repo.GetSetting("zerodha_access_token"); err == nil && storedToken != "" {
			// Validate: token is fresh only if it was stored today
			tokenDate, _ := repo.GetSetting("zerodha_token_date")
			today := time.Now().Format("2006-01-02")
			if tokenDate == today {
				kiteClient.SetAccessToken(storedToken)
				logger.Info("zerodha: restored access token from db")
			} else {
				logger.Info("zerodha: stored token is stale, skipping", zap.String("token_date", tokenDate))
			}
		}

		// Build NSE symbol list for the stream
		nseSymbols := cfg.Markets.NSE.Symbols // Yahoo-format: RELIANCE.NS etc.
		kiteStream = data.NewKiteStream(kiteClient)
		kiteStream.SetSymbols(nseSymbols)

		// Live websocket ticker + strategy engine
		kiteTicker = data.NewKiteTicker(kiteClient, cfg.Zerodha.APIKey)

		if kiteClient.IsConnected() {
			kiteStream.Start()
			logger.Info("zerodha: live stream started with restored token")
		} else {
			logger.Info("zerodha: configured but not authenticated — visit /zerodha/login-url to connect")
		}
	} else {
		logger.Info("zerodha: not configured (ZERODHA_API_KEY not set)")
	}

	// ── Data source (yfinance | zerodha) + live strategy engine ──────────────
	dataSource := data.NewDataSource(cfg.Data.Source, data.NewYahooClient(), kiteClient)
	logger.Info("market data source selected", zap.String("source", dataSource.Name()))
	if kiteTicker != nil {
		// Live trading uses Zerodha exclusively: seed strategy buffers from
		// Kite historical only (no Yahoo fallback) so live candles and seed
		// data come from the same source. When Kite is disconnected the engine
		// simply skips seeding and builds buffers from live ticks.
		liveSeed := data.NewZerodhaSource(kiteClient, data.NewYFinanceSource(data.NewYahooClient()))
		liveEngine = strategy.NewLiveEngine(kiteClient, kiteTicker, liveSeed, cfg.Data.LiveDefaultQty)
		liveEngine.SetRepository(repo)

		// Auto-resume a previously-running live session across restarts so the
		// engine stays on until explicitly stopped (persisted in DB settings).
		go resumeLiveEngine(repo, liveEngine, kiteClient)
	}

	// ── HTTP Server starts immediately ────────────────────────────────────
	router := api.NewRouter(repo, strategyEngine, fetcher, recEngine, kiteClient, kiteStream, liveEngine, dataSource, cfg)

	// ── NarenInvestment feature set (mounted under /api/naren/v1 + /naren) ──
	// Additive only: never alters Invest's own routes or behaviour. If the Naren
	// side fails to initialise it is skipped and Invest still runs normally.
	mountNaren(router, repo, cfg)

	serverAddr := fmt.Sprintf(":%d", cfg.Server.Port)
	srv := &http.Server{
		Addr:         serverAddr,
		Handler:      router,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		logger.Info("server starting", zap.String("addr", serverAddr))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("server failed", zap.Error(err))
		}
	}()

	// ── Open browser after a short delay ──────────────────────────────────
	if cfg.Server.OpenBrowser {
		go func() {
			time.Sleep(1 * time.Second)
			url := fmt.Sprintf("http://localhost:5173") // dev server
			if err := openBrowser(url); err != nil {
				logger.Warn("could not open browser", zap.Error(err))
			}
		}()
	}

	// ── Initial data pipeline (runs in background) ────────────────────────
	go func() {
		runPipeline(fetcher, strategyEngine, recEngine)

		// Schedule periodic refresh
		interval := time.Duration(cfg.Data.RefreshIntervalHours) * time.Hour
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			logger.Info("running scheduled data refresh")
			runPipeline(fetcher, strategyEngine, recEngine)
		}
	}()

	// ── Graceful shutdown ──────────────────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("shutting down server...")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("server forced shutdown", zap.Error(err))
	}
	logger.Info("server stopped")
}

func runPipeline(fetcher *data.Fetcher, engine *strategy.Engine, recEngine *recommendation.Engine) {
	logger.Info("pipeline: fetching market data...")
	if err := fetcher.FetchAll(); err != nil {
		logger.Warn("pipeline: fetch errors", zap.Error(err))
	}

	logger.Info("pipeline: running analysis...")
	if err := engine.RunAll(); err != nil {
		logger.Warn("pipeline: analysis error", zap.Error(err))
	}

	logger.Info("pipeline: generating recommendations...")
	if err := recEngine.GenerateAll(); err != nil {
		logger.Warn("pipeline: recommendation error", zap.Error(err))
	}

	logger.Info("pipeline: complete")
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "linux":
		return exec.Command("xdg-open", url).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		return fmt.Errorf("unsupported platform")
	}
}
