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

	// ── HTTP Server starts immediately ────────────────────────────────────
	router := api.NewRouter(repo, strategyEngine, cfg)
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
