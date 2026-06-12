package main

import (
	"encoding/json"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	investconfig "stockwise/pkg/config"
	investstorage "stockwise/internal/storage"
	"stockwise/pkg/logger"

	narenapi "stockwise/internal/naren/api"
	narenconfig "stockwise/internal/naren/config"
	narennews "stockwise/internal/naren/news"
	narenstorage "stockwise/internal/naren/storage"
	narenstrategy "stockwise/internal/naren/strategy"
)

// mountNaren wires the full NarenInvestment feature set into the already-built
// Invest Gin engine. Everything Naren exposes lives under /api/naren/v1 (API) and
// /naren (SPA), so Invest's own routes and behaviour are completely untouched.
//
// The whole thing is best-effort: if the Naren config or its database can't be
// loaded (e.g. Mongo/Angel One unavailable), we log and return so the Invest app
// still boots normally.
func mountNaren(r *gin.Engine, investRepo *investstorage.Repository, investCfg *investconfig.Config) {
	defer func() {
		if rec := recover(); rec != nil {
			logger.Error("naren: mount panicked — Naren features disabled, Invest unaffected",
				zap.Any("panic", rec))
		}
	}()

	// ── Share the Zerodha Kite token ──────────────────────────────────────
	// Invest and Naren use the same Kite app key, so the access token Invest
	// obtained today is valid for Naren too. Bridge it into kite_token.json,
	// which Naren's InitKite reads on startup.
	bridgeKiteToken(investRepo)

	// ── Load Naren config (Angel One + Kite + Mongo + markets) ────────────
	nCfg, err := narenconfig.Load("config.naren.yaml")
	if err != nil {
		logger.Warn("naren: could not load config.naren.yaml — Naren features disabled",
			zap.Error(err))
		return
	}

	// ── Naren database repo (same Postgres; migrates Naren's extra tables) ─
	nDB, err := narenstorage.Connect(nCfg.Database.DSN())
	if err != nil {
		logger.Warn("naren: could not connect database — Naren features disabled",
			zap.Error(err))
		return
	}

	nRepo := narenstorage.NewRepository(nDB)
	nEngine := narenstrategy.NewEngine(nCfg, nRepo)
	nNews := narennews.NewMonitor()

	// ── Mount all Naren routes under /api/naren/v1 ────────────────────────
	narenapi.Mount(r, nRepo, nEngine, nCfg, nNews, logger.L())

	// ── Serve the Naren SPA's static assets under /naren ──────────────────
	// (The SPA fallback for /naren/* HTML routes is handled in the router's
	//  NoRoute so it doesn't conflict with this static asset registration.)
	r.Static("/naren/assets", "./frontend-naren/dist/assets")
	r.StaticFile("/naren/vite.svg", "./frontend-naren/dist/vite.svg")

	// ── Keep the shared Zerodha token in sync, continuously ───────────────
	// Invest and Naren use the SAME Kite app key, so Invest's access token is
	// valid for Naren. Invest is usually connected AFTER startup (user clicks
	// "Connect Zerodha"), so a one-time boot bridge isn't enough — we poll the
	// Invest token and push it into Naren's live client whenever it changes.
	go syncKiteTokenLoop(investRepo)

	logger.Info("naren: mounted /api/naren/v1 + /naren (NarenInvestment feature set)")
}

// bridgeKiteToken copies Invest's saved Zerodha access token (if it was issued
// today) into kite_token.json so the shared-credentials Naren side picks it up
// at boot, before its Kite client initialises.
func bridgeKiteToken(investRepo *investstorage.Repository) {
	token, err := investRepo.GetSetting("zerodha_access_token")
	if err != nil || token == "" {
		return
	}
	tokenDate, _ := investRepo.GetSetting("zerodha_token_date")
	today := time.Now().Format("2006-01-02")
	if tokenDate != today {
		return
	}
	payload, _ := json.Marshal(map[string]string{
		"access_token": token,
		"date":         today,
	})
	if err := os.WriteFile("kite_token.json", payload, 0o600); err != nil {
		logger.Warn("naren: could not write shared kite_token.json", zap.Error(err))
		return
	}
	logger.Info("naren: bridged Invest Zerodha token into kite_token.json (shared credentials)")
}

// syncKiteTokenLoop continuously mirrors Invest's live Zerodha access token into
// Naren's Kite client. It applies the current token immediately, then re-checks
// every 20s so that connecting Zerodha on the Invest side (at any time, or after
// the daily 8:30 AM refresh) lights up all the Naren Kite features — challenge,
// paper trading, live terminal — without a restart.
func syncKiteTokenLoop(investRepo *investstorage.Repository) {
	apply := func() {
		token, err := investRepo.GetSetting("zerodha_access_token")
		if err != nil || token == "" {
			return
		}
		date, _ := investRepo.GetSetting("zerodha_token_date")
		if date != time.Now().Format("2006-01-02") {
			return // stale token from a previous day — ignore
		}
		if narenapi.SyncAccessToken(token) {
			logger.Info("naren: shared Zerodha token applied to Naren Kite client")
		}
	}

	apply() // immediately, in case Invest is already connected at mount time
	t := time.NewTicker(20 * time.Second)
	defer t.Stop()
	for range t.C {
		apply()
	}
}
