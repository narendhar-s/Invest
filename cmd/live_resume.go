package main

import (
	"encoding/json"
	"time"

	"go.uber.org/zap"

	"stockwise/internal/data"
	"stockwise/internal/storage"
	"stockwise/internal/strategy"
	"stockwise/pkg/logger"
)

// resumeLiveEngine restarts a previously-running live session after a backend
// restart. The live engine keeps its running state only in memory, so without
// this it would silently switch off every time the server restarts. We persist
// the session in DB settings (live_engine_running / live_engine_config) on
// start/stop, and here we replay it once Zerodha is connected — so the engine
// stays running until the user explicitly stops it, just like the challenge.
func resumeLiveEngine(repo *storage.Repository, eng *strategy.LiveEngine, kc *data.KiteClient) {
	if repo == nil || eng == nil {
		return
	}
	if running, _ := repo.GetSetting("live_engine_running"); running != "true" {
		return
	}
	raw, _ := repo.GetSetting("live_engine_config")
	if raw == "" {
		return
	}
	var cfg struct {
		Strategies []string `json:"strategies"`
		MinAgree   int      `json:"min_agree"`
		Mode       string   `json:"mode"`
		Symbols    []string `json:"symbols"`
		Timeframe  string   `json:"timeframe"`
	}
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil || len(cfg.Strategies) == 0 {
		return
	}

	// Wait for Zerodha to connect (token restore / shared-token sync), up to ~2 min.
	for i := 0; i < 120; i++ {
		if kc != nil && kc.IsConnected() {
			break
		}
		time.Sleep(time.Second)
	}
	if kc == nil || !kc.IsConnected() {
		logger.Warn("live engine: could not auto-resume — Zerodha not connected")
		return
	}

	if cfg.MinAgree < 1 {
		cfg.MinAgree = 1
	}
	if err := eng.Start(cfg.Strategies, cfg.MinAgree, cfg.Mode, cfg.Symbols, cfg.Timeframe); err != nil {
		logger.Warn("live engine: auto-resume failed", zap.Error(err))
		return
	}
	logger.Info("live engine: auto-resumed previous session", zap.Strings("strategies", cfg.Strategies))
}
