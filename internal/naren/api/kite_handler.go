package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"stockwise/internal/naren/kite"
	"stockwise/internal/naren/mongostore"
	"stockwise/internal/naren/paper"
	"stockwise/internal/naren/storage"
	"stockwise/internal/naren/config"
)

// ─── Service singleton ────────────────────────────────────────────────────────

type KiteService struct {
	client        *kite.Client
	engine        *paper.Engine
	ticker        *kite.Ticker        // real-time WebSocket tick stream
	nseStore      *mongostore.NseStore
	snapStore     *mongostore.InstrumentSnapshotStore
	mongoClient   *mongostore.Client
	logger        *zap.Logger
	enabled       bool
	zeroCreds     kite.ZerodhaCredentials // for auto-refresh
}

var kiteSvc *KiteService

const kiteTokenFile = "kite_token.json"

type savedToken struct {
	AccessToken string `json:"access_token"`
	Date        string `json:"date"`
}

// InitKite wires up the Kite client, paper engine (PostgreSQL), and NSE store (MongoDB).
func InitKite(cfg config.KiteConfig, mongoCfg config.MongoConfig, db *storage.DB, logger *zap.Logger) {
	if !cfg.Enabled || cfg.APIKey == "" {
		logger.Info("Kite integration disabled")
		return
	}
	client := kite.New(cfg.APIKey, cfg.APISecret, cfg.RedirectURL)

	// Restore today's access token so a server restart doesn't require re-login.
	if b, err := os.ReadFile(kiteTokenFile); err == nil {
		var st savedToken
		if json.Unmarshal(b, &st) == nil &&
			st.Date == time.Now().Format("2006-01-02") &&
			st.AccessToken != "" {
			client.SetAccessToken(st.AccessToken)
			logger.Info("restored Kite access token for today")
		}
	}

	// Paper engine now backed by PostgreSQL (no more paper_state.json)
	paperRepo := storage.NewPaperRepository(db)
	engine := paper.NewEngine(client, paper.Config{
		Capital:       1_000_000,
		Lots:          2,
		RiskPct:       0.015,
		RR:            2.0,
		ConfThreshold: 55,
	}, paperRepo, logger)
	engine.Start()

	// MongoDB stores (optional — all backtesting still works without MongoDB)
	var (
		nseStore  *mongostore.NseStore
		snapStore *mongostore.InstrumentSnapshotStore
		mc        *mongostore.Client
	)
	if mongoCfg.URI != "" {
		var err error
		mc, err = mongostore.Connect(mongoCfg.URI, mongoCfg.Database, logger)
		if err != nil {
			logger.Warn("MongoDB unavailable — NSE Enhanced backtest and instrument snapshots disabled", zap.Error(err))
		} else {
			ctx5, cancel5 := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel5()

			// NSE bhavcopy store
			ns := mongostore.NewNseStore(mc)
			if err := ns.EnsureIndexes(ctx5); err != nil {
				logger.Warn("NSE store index creation failed", zap.Error(err))
			}
			nseStore = ns

			// Daily Kite instrument snapshot store
			ss := mongostore.NewInstrumentSnapshotStore(mc)
			if err := ss.EnsureIndexes(ctx5); err != nil {
				logger.Warn("Snapshot store index creation failed", zap.Error(err))
			}
			snapStore = ss
			logger.Info("MongoDB stores ready (nse_option_chain, kite_instruments)")

			// Take today's snapshot in the background (non-blocking)
			go snapshotInstrumentsIfStale(client, ss, logger)
		}
	}

	// Build the Zerodha credentials for auto-refresh
	zeroCreds := kite.ZerodhaCredentials{
		UserID:     cfg.ZerodhaUserID,
		Password:   cfg.ZerodhaPassword,
		TOTPSecret: cfg.ZerodhaTOTPSecret,
	}
	autoLoginConfigured := zeroCreds.UserID != "" && zeroCreds.Password != "" && zeroCreds.TOTPSecret != ""

	// Real-time WebSocket ticker (connects after token is ready)
	ticker := kite.NewTicker(client)
	// Subscribe to NIFTY index for real-time spot price
	ticker.Subscribe(kite.NiftyIndexToken)
	ticker.Start()

	kiteSvc = &KiteService{
		client: client, engine: engine, ticker: ticker,
		nseStore: nseStore, snapStore: snapStore, mongoClient: mc,
		logger: logger, enabled: true, zeroCreds: zeroCreds,
	}

	// Daily auto-refresh cron — runs in background, fires at 8:30 AM IST
	if autoLoginConfigured {
		go dailyAutoRefreshLoop(client, zeroCreds, logger)
		logger.Info("Kite auto-login configured — will refresh token daily at 08:30 IST")
	} else {
		logger.Info("Kite auto-login NOT configured — set zerodha_password + zerodha_totp_secret in config.yaml to enable")
	}

	logger.Info("Kite integration initialised (read-only · WebSocket ticker · paper→PostgreSQL · instruments→MongoDB)")
}

// dailyAutoRefreshLoop runs forever, refreshing the Kite token every morning
// at 08:30 IST before market open (9:15). Requires Zerodha credentials.
func dailyAutoRefreshLoop(client *kite.Client, creds kite.ZerodhaCredentials, logger *zap.Logger) {
	for {
		next := nextRefreshTime()
		logger.Info("kite auto-refresh scheduled", zap.Time("at", next))
		time.Sleep(time.Until(next))

		logger.Info("kite auto-refresh: starting daily login…")
		if err := client.AutoRefresh(creds); err != nil {
			logger.Error("kite auto-refresh failed — manual login may be needed", zap.Error(err))
			// Retry in 10 minutes
			time.Sleep(10 * time.Minute)
			continue
		}
		persistToken(client.AccessToken())
		logger.Info("kite auto-refresh: token renewed successfully")
	}
}

// nextRefreshTime returns the next 08:30 IST time (tomorrow if already past).
func nextRefreshTime() time.Time {
	ist, _ := time.LoadLocation("Asia/Kolkata")
	now := time.Now().In(ist)
	target := time.Date(now.Year(), now.Month(), now.Day(), 8, 30, 0, 0, ist)
	if now.After(target) {
		target = target.AddDate(0, 0, 1)
	}
	return target
}

func kiteReady(c *gin.Context) bool {
	if kiteSvc == nil || !kiteSvc.enabled {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Kite integration not enabled"})
		return false
	}
	return true
}

// snapshotInstrumentsIfStale takes a fresh NFO instrument master snapshot
// if one hasn't been taken today. Runs in a background goroutine at startup.
// This is the mechanism that builds the historical token DB over time —
// by capturing every option before it expires, the backtest can look up
// real Kite prices for recently-expired instruments.
func snapshotInstrumentsIfStale(kc *kite.Client, ss *mongostore.InstrumentSnapshotStore, log *zap.Logger) {
	if !kc.IsConnected() {
		log.Info("instrument snapshot skipped — Kite not connected yet")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	last, err := ss.LatestSnapshotDate(ctx)
	if err == nil && last.Format("2006-01-02") == time.Now().Format("2006-01-02") {
		log.Info("instrument snapshot already up-to-date for today")
		return
	}

	instruments, err := kc.Instruments("NFO")
	if err != nil {
		log.Warn("instrument snapshot: failed to fetch NFO master", zap.Error(err))
		return
	}
	saved, err := ss.SaveSnapshot(ctx, instruments)
	if err != nil {
		log.Warn("instrument snapshot: save failed", zap.Error(err))
		return
	}
	log.Info("instrument snapshot saved", zap.Int("instruments", saved))
}

// persistToken writes the access token to disk for today.
func persistToken(token string) {
	st := savedToken{AccessToken: token, Date: time.Now().Format("2006-01-02")}
	if b, err := json.Marshal(st); err == nil {
		_ = os.WriteFile(kiteTokenFile, b, 0o600)
	}
}

// SyncAccessToken applies an externally-obtained Kite access token (shared from
// the Invest side, which uses the SAME Kite app key) to the live Kite client.
// The WebSocket ticker reconnects on its own within a few seconds once the
// client is authenticated, and the challenge/paper services share this same
// client pointer, so they immediately see the connection too.
//
// It is safe to call repeatedly; it only acts when the token actually changes.
// Returns true if a new token was applied.
func SyncAccessToken(token string) bool {
	if kiteSvc == nil || !kiteSvc.enabled || token == "" {
		return false
	}
	if kiteSvc.client.AccessToken() == token {
		return false
	}
	kiteSvc.client.SetAccessToken(token)
	persistToken(token)
	kiteSvc.logger.Info("kite: applied shared Zerodha token from Invest (same app key) — ticker will reconnect")
	return true
}

// frontendURL builds a redirect URL that works whether the user is on the
// production server (:8080) or the Vite dev server (:5173).
// We detect the dev server by the Referer / Origin header; if absent we
// default to a relative path so the browser stays on whatever host it's on.
func frontendURL(c *gin.Context, path string) string {
	origin := c.GetHeader("Origin")
	referer := c.GetHeader("Referer")
	for _, h := range []string{origin, referer} {
		if strings.Contains(h, ":8081") || strings.Contains(h, ":5173") {
			return "http://localhost:8081" + path
		}
	}
	return path // relative → same host:port as the request
}

// ─── Auth endpoints ───────────────────────────────────────────────────────────

// KiteStatus reports connection state, the login URL, and auto-refresh status.
func (h *Handler) KiteStatus(c *gin.Context) {
	if !kiteReady(c) {
		return
	}
	connected, user, since := kiteSvc.client.Status()
	autoReady := kiteSvc.zeroCreds.UserID != "" &&
		kiteSvc.zeroCreds.Password != "" &&
		kiteSvc.zeroCreds.TOTPSecret != ""
	next := nextRefreshTime()
	c.JSON(http.StatusOK, gin.H{
		"connected":        connected,
		"user":             user,
		"login_time":       since,
		"login_url":        kiteSvc.client.LoginURL(),
		"auto_login":       autoReady,
		"next_refresh_at":  next,
		"ticker_running":   kiteSvc.ticker != nil,
	})
}

// KiteAutoLogin triggers an immediate auto-login using stored credentials.
func (h *Handler) KiteAutoLogin(c *gin.Context) {
	if !kiteReady(c) {
		return
	}
	creds := kiteSvc.zeroCreds
	if creds.UserID == "" || creds.Password == "" || creds.TOTPSecret == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Auto-login credentials not configured. Set zerodha_password and zerodha_totp_secret in config.yaml",
		})
		return
	}
	if err := kiteSvc.client.AutoRefresh(creds); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	persistToken(kiteSvc.client.AccessToken())
	connected, user, since := kiteSvc.client.Status()
	c.JSON(http.StatusOK, gin.H{
		"connected":  connected,
		"user":       user,
		"login_time": since,
		"message":    "Auto-login successful — token valid until ~07:30 IST tomorrow",
	})
}

// KiteLogin redirects the browser to Kite's OAuth login page.
func (h *Handler) KiteLogin(c *gin.Context) {
	if !kiteReady(c) {
		return
	}
	c.Redirect(http.StatusFound, kiteSvc.client.LoginURL())
}

// KiteCallback handles the OAuth redirect from Kite.
//
// Three error scenarios that previously caused the raw Kite JSON to appear:
//  1. request_token used twice (page refresh on callback URL) → Kite rejects it.
//     Fix: detect "already connected" and skip re-exchange.
//  2. Redirect goes to :8080 but user is on :5173 dev server → different host.
//     Fix: detect Referer and send back to the right port.
//  3. Error message swallowed → only ?error=session_failed was passed.
//     Fix: URL-encode the full error message so the frontend can show it.
func (h *Handler) KiteCallback(c *gin.Context) {
	if !kiteReady(c) {
		return
	}

	reqToken := c.Query("request_token")
	status   := c.Query("status")

	// Kite login was cancelled or failed on Zerodha's side.
	if status != "success" || reqToken == "" {
		reason := c.Query("message") // Kite sometimes includes a message param
		if reason == "" {
			reason = fmt.Sprintf("Kite returned status=%q", status)
		}
		dest := frontendURL(c, "/kite-terminal?error="+url.QueryEscape(reason))
		c.Redirect(http.StatusFound, dest)
		return
	}

	// If we already have a valid token today, skip the exchange (prevents the
	// "invalid session" error on browser back/refresh of the callback URL).
	if kiteSvc.client.IsConnected() {
		kiteSvc.logger.Info("KiteCallback: already connected, skipping re-exchange")
		c.Redirect(http.StatusFound, frontendURL(c, "/kite-terminal?connected=1&tab=signals"))
		return
	}

	if err := kiteSvc.client.GenerateSession(reqToken); err != nil {
		kiteSvc.logger.Error("kite session exchange failed", zap.Error(err))
		dest := frontendURL(c, "/kite-terminal?error="+url.QueryEscape(err.Error()))
		c.Redirect(http.StatusFound, dest)
		return
	}

	persistToken(kiteSvc.client.AccessToken())
	c.Redirect(http.StatusFound, frontendURL(c, "/kite-terminal?connected=1&tab=signals"))
}

// KiteSetToken accepts an access_token pasted directly by the user.
// This is the fallback flow when the OAuth redirect is inconvenient
// (e.g. running frontend on a different port than the backend).
func (h *Handler) KiteSetToken(c *gin.Context) {
	if !kiteReady(c) {
		return
	}
	var body struct {
		AccessToken string `json:"access_token"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.AccessToken) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "access_token is required"})
		return
	}
	kiteSvc.client.SetAccessToken(strings.TrimSpace(body.AccessToken))
	persistToken(kiteSvc.client.AccessToken())
	kiteSvc.logger.Info("Kite access token set manually")
	connected, user, since := kiteSvc.client.Status()
	c.JSON(http.StatusOK, gin.H{"connected": connected, "user": user, "login_time": since})
}

// KiteDisconnect clears the stored token (useful for re-login).
func (h *Handler) KiteDisconnect(c *gin.Context) {
	if !kiteReady(c) {
		return
	}
	kiteSvc.client.SetAccessToken("")
	_ = os.Remove(kiteTokenFile)
	c.JSON(http.StatusOK, gin.H{"connected": false})
}

// ─── Market data (read-only) ──────────────────────────────────────────────────

func (h *Handler) KiteNiftyQuote(c *gin.Context) {
	if !kiteReady(c) {
		return
	}
	ltp, err := kiteSvc.client.LTP(kite.NiftySymbol)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, ltp[kite.NiftySymbol])
}

func (h *Handler) KiteAnalyze(c *gin.Context) {
	if !kiteReady(c) {
		return
	}
	rec, err := kiteSvc.engine.LatestSignal()
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, rec)
}

// KiteChartData returns 15m NIFTY candles with EMA9, EMA21 and bar-level
// signal annotations for the chart components in the frontend.
// Query params: days=N (default 5, max 30 for live; use backtest for longer)
func (h *Handler) KiteChartData(c *gin.Context) {
	if !kiteReady(c) {
		return
	}
	days := 5
	if d := c.Query("days"); d != "" {
		fmt.Sscanf(d, "%d", &days)
	}
	if days < 1 { days = 1 }
	if days > 30 { days = 30 }

	now := time.Now()
	from := now.AddDate(0, 0, -days).Format("2006-01-02 15:04:05")
	to   := now.Format("2006-01-02 15:04:05")

	candles, err := kiteSvc.client.HistoricalData(kite.NiftyIndexToken, "15minute", from, to)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	// Compute EMAs
	closes := make([]float64, len(candles))
	for i, ca := range candles { closes[i] = ca.Close }

	k9  := 2.0 / float64(10)
	k21 := 2.0 / float64(22)
	ema9, ema21 := closes[0], closes[0]

	type bar struct {
		Time   time.Time `json:"time"`
		Open   float64   `json:"open"`
		High   float64   `json:"high"`
		Low    float64   `json:"low"`
		Close  float64   `json:"close"`
		Volume int64     `json:"volume"`
		EMA9   float64   `json:"ema9"`
		EMA21  float64   `json:"ema21"`
	}

	bars := make([]bar, 0, len(candles))
	for i, ca := range candles {
		if i > 0 {
			ema9  = ca.Close*k9  + ema9*(1-k9)
			ema21 = ca.Close*k21 + ema21*(1-k21)
		}
		bars = append(bars, bar{
			Time: ca.Time, Open: ca.Open, High: ca.High, Low: ca.Low,
			Close: ca.Close, Volume: ca.Volume,
			EMA9: math.Round(ema9*100)/100, EMA21: math.Round(ema21*100)/100,
		})
	}

	// Latest signal for annotation
	var signal interface{}
	if rec, err := kiteSvc.engine.LatestSignal(); err == nil {
		signal = rec
	}

	c.JSON(http.StatusOK, gin.H{"bars": bars, "signal": signal})
}

func (h *Handler) KiteBacktest(c *gin.Context) {
	if !kiteReady(c) {
		return
	}
	var body struct {
		Days    int     `json:"days"`
		RR      float64 `json:"rr"`
		RiskPct float64 `json:"risk_pct"`
		Lots    int     `json:"lots"`
		Conf    int     `json:"conf"`
	}
	_ = c.ShouldBindJSON(&body)
	res, err := kiteSvc.engine.Backtest(body.Days, body.RR, body.RiskPct, body.Lots, body.Conf)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, res)
}

// KiteBacktestDaily runs a 1-year backtest using daily NIFTY candles.
// KiteBacktestCompare runs all 7 book strategies on the same NIFTY 15m data.
// Body params:
//   days       - lookback period (default 60, max 120)
//   lots       - lots per trade (default 2; qty = lots × 75)
//   risk_rupees  - fixed ₹ stop-loss amount per trade (default 5000)
//   reward_rupees - fixed ₹ target amount per trade (default 10000)
func (h *Handler) KiteBacktestCompare(c *gin.Context) {
	if !kiteReady(c) {
		return
	}
	var body struct {
		Days          int     `json:"days"`
		Lots          int     `json:"lots"`
		RiskRupees    float64 `json:"risk_rupees"`
		RewardRupees  float64 `json:"reward_rupees"`
	}
	_ = c.ShouldBindJSON(&body)
	if body.Days         <= 0  { body.Days         = 60 }
	if body.Lots         <= 0  { body.Lots         = 2 }
	if body.RiskRupees   <= 0  { body.RiskRupees   = 5000 }
	if body.RewardRupees <= 0  { body.RewardRupees = body.RiskRupees * 2 }

	// Guard rails
	if body.Lots        > 20     { body.Lots        = 20 }
	if body.RiskRupees  > 100000 { body.RiskRupees  = 100000 }
	if body.RewardRupees < body.RiskRupees { body.RewardRupees = body.RiskRupees }

	res, err := kiteSvc.engine.BacktestCompare(body.Days, body.Lots, body.RiskRupees, body.RewardRupees)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *Handler) KiteBacktestDaily(c *gin.Context) {
	if !kiteReady(c) {
		return
	}
	var body struct {
		Days    int     `json:"days"`
		RR      float64 `json:"rr"`
		RiskPct float64 `json:"risk_pct"`
		Lots    int     `json:"lots"`
		Conf    int     `json:"conf"`
	}
	_ = c.ShouldBindJSON(&body)
	res, err := kiteSvc.engine.BacktestDaily(body.Days, body.RR, body.RiskPct, body.Lots, body.Conf)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, res)
}

// KiteNseStatus reports NSE MongoDB store statistics.
func (h *Handler) KiteNseStatus(c *gin.Context) {
	if kiteSvc == nil || kiteSvc.nseStore == nil {
		c.JSON(http.StatusOK, gin.H{"loaded": false, "reason": "MongoDB not connected"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	stats, err := kiteSvc.nseStore.Stats(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, stats)
}

// ─── Paper trading endpoints ──────────────────────────────────────────────────

func (h *Handler) PaperState(c *gin.Context) {
	if !kiteReady(c) {
		return
	}
	c.JSON(http.StatusOK, kiteSvc.engine.Snapshot())
}

func (h *Handler) PaperAuto(c *gin.Context) {
	if !kiteReady(c) {
		return
	}
	var body struct {
		On bool `json:"on"`
	}
	_ = c.ShouldBindJSON(&body)
	kiteSvc.engine.SetAutoMode(body.On)
	c.JSON(http.StatusOK, kiteSvc.engine.Snapshot())
}

func (h *Handler) PaperEnter(c *gin.Context) {
	if !kiteReady(c) {
		return
	}
	rec, err := kiteSvc.engine.LatestSignal()
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	pos, err := kiteSvc.engine.EnterFromRecommendation(rec, "MANUAL")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, pos)
}

func (h *Handler) PaperClose(c *gin.Context) {
	if !kiteReady(c) {
		return
	}
	if err := kiteSvc.engine.CloseOpen(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, kiteSvc.engine.Snapshot())
}

func (h *Handler) PaperParams(c *gin.Context) {
	if !kiteReady(c) {
		return
	}
	var body struct {
		RR      float64 `json:"rr"`
		RiskPct float64 `json:"risk_pct"`
		Lots    int     `json:"lots"`
		Conf    int     `json:"conf"`
	}
	_ = c.ShouldBindJSON(&body)
	kiteSvc.engine.SetParams(body.RR, body.RiskPct, body.Lots, body.Conf)
	c.JSON(http.StatusOK, kiteSvc.engine.Snapshot())
}
