package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"stockwise/internal/naren/kite"
	"stockwise/internal/naren/paper"
	"stockwise/internal/naren/storage"
)

// ─── Service singleton ────────────────────────────────────────────────────────

var challengeSvc *paper.ChallengeService

// InitChallenge sets up the 90-day challenge services (options + scalp) with
// WebSocket tickers.
func InitChallenge(db *storage.DB, kc *kite.Client, ticker *kite.Ticker, logger *zap.Logger, liveAllowed bool) {
	// Backfill: classify any pre-existing challenge rows (created before the
	// scalp variant existed) as OPTIONS so the original challenge is unaffected.
	db.Exec("UPDATE challenge_configs SET challenge_type = 'OPTIONS' WHERE challenge_type IS NULL OR challenge_type = ''")

	challengeSvc = paper.NewChallengeService(db, kc, ticker, logger)
	challengeSvc.SetLiveAllowed(liveAllowed) // master kill-switch for real orders (options challenge only)
	challengeSvc.Start()

	// Parallel 90-day SCALP challenge (EMA50/200 + Stochastic, 1-min, ATM CE/PE).
	// It gets its OWN WebSocket ticker because kite.Ticker keeps a single tick
	// handler — sharing one ticker would let the two challenges overwrite each
	// other's callback.
	scalpTicker := kite.NewTicker(kc)
	scalpTicker.Subscribe(kite.NiftyIndexToken)
	scalpTicker.Start()
	scalpChallengeSvc = paper.NewScalpChallengeService(db, kc, scalpTicker, logger)
	scalpChallengeSvc.SetLiveAllowed(liveAllowed) // same master kill-switch as the options challenge
	scalpChallengeSvc.Start()

	logger.Info("challenge services initialised (options + scalp)")
}

func challengeReady(c *gin.Context) bool {
	if challengeSvc == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "challenge service not initialised"})
		return false
	}
	return true
}

// ─── Challenge management ─────────────────────────────────────────────────────

// GET /api/v1/challenge/status
func (h *Handler) ChallengeStatus(c *gin.Context) {
	if !challengeReady(c) { return }
	c.JSON(http.StatusOK, challengeSvc.Status())
}

// POST /api/v1/challenge/start
func (h *Handler) ChallengeStart(c *gin.Context) {
	if !challengeReady(c) { return }
	var body struct {
		Lots           int     `json:"lots"`
		RiskPerTrade   float64 `json:"risk_per_trade"`
		TargetPerTrade float64 `json:"target_per_trade"`
		Notes          string  `json:"notes"`
	}
	_ = c.ShouldBindJSON(&body)
	if body.Lots         <= 0  { body.Lots         = 2 }
	if body.RiskPerTrade  <= 0 { body.RiskPerTrade  = 5000 }
	if body.TargetPerTrade <= 0 { body.TargetPerTrade = 10000 }

	cfg, err := challengeSvc.StartChallenge(body.Lots, body.RiskPerTrade, body.TargetPerTrade, body.Notes)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, cfg)
}

// POST /api/naren/v1/challenge/live-config — enable/disable real Zerodha orders
// and set the per-position profit square-off (₹). Live always defaults OFF and
// resets to OFF on restart; enabling requires the server master switch.
func (h *Handler) ChallengeLiveConfig(c *gin.Context) {
	if !challengeReady(c) {
		return
	}
	var body struct {
		Enabled        bool    `json:"enabled"`
		ProfitTarget   float64 `json:"profit_target"`
		MaxLots        int     `json:"max_lots"`
		MinProfit      float64 `json:"min_profit"`
		WindowStart    string  `json:"window_start"`
		WindowEnd      string  `json:"window_end"`
		HoldConfidence int     `json:"hold_confidence"`
		RR             float64 `json:"rr"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	if err := challengeSvc.SetLiveConfig(paper.LiveSettings{
		Enabled:        body.Enabled,
		ProfitTarget:   body.ProfitTarget,
		MaxLots:        body.MaxLots,
		MinProfit:      body.MinProfit,
		WindowStart:    body.WindowStart,
		WindowEnd:      body.WindowEnd,
		HoldConfidence: body.HoldConfidence,
		RR:             body.RR,
	}); err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, challengeSvc.Status())
}

// POST /api/v1/challenge/pause
func (h *Handler) ChallengePause(c *gin.Context) {
	if !challengeReady(c) { return }
	if err := challengeSvc.PauseChallenge(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "paused"})
}

// POST /api/v1/challenge/resume
func (h *Handler) ChallengeResume(c *gin.Context) {
	if !challengeReady(c) { return }
	if err := challengeSvc.ResumeChallenge(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, challengeSvc.Status())
}

// ─── Trade actions ────────────────────────────────────────────────────────────

// POST /api/v1/challenge/enter  — force a manual entry from current signal
func (h *Handler) ChallengeEnter(c *gin.Context) {
	if !challengeReady(c) { return }
	t, err := challengeSvc.ManualEntry()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, t)
}

// POST /api/v1/challenge/exit  — manually close the open position
func (h *Handler) ChallengeExit(c *gin.Context) {
	if !challengeReady(c) { return }
	if err := challengeSvc.ManualExit(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, challengeSvc.Status())
}

// POST /api/v1/challenge/snapshot  — force a daily EOD snapshot write
func (h *Handler) ChallengeSnapshot(c *gin.Context) {
	if !challengeReady(c) { return }
	challengeSvc.ForceSnapshot()
	c.JSON(http.StatusOK, gin.H{"status": "snapshot written"})
}

// ─── Data endpoints ───────────────────────────────────────────────────────────

// GET /api/v1/challenge/trades?limit=100
func (h *Handler) ChallengeTrades(c *gin.Context) {
	if !challengeReady(c) { return }
	limit := 200
	if l := c.Query("limit"); l != "" {
		var n int
		if _, err := cFmtSscanf(l, "%d", &n); err == nil && n > 0 { limit = n }
	}
	trades := challengeSvc.Trades(limit)
	if trades == nil { trades = []storage.ChallengeTrade{} }
	c.JSON(http.StatusOK, trades)
}

// GET /api/v1/challenge/daily
func (h *Handler) ChallengeDaily(c *gin.Context) {
	if !challengeReady(c) { return }
	days := challengeSvc.DailyHistory()
	if days == nil { days = []storage.ChallengeDay{} }
	c.JSON(http.StatusOK, days)
}

// GET /api/v1/challenge/expiry-breakdown
func (h *Handler) ChallengeExpiryBreakdown(c *gin.Context) {
	if !challengeReady(c) { return }
	c.JSON(http.StatusOK, challengeSvc.ExpiryBreakdown())
}

// GET /api/v1/challenge/all  — list all historical challenges
func (h *Handler) ChallengeAll(c *gin.Context) {
	if !challengeReady(c) { return }
	c.JSON(http.StatusOK, challengeSvc.AllChallenges())
}

// ─── Helper ───────────────────────────────────────────────────────────────────

func cFmtSscanf(s, format string, a ...interface{}) (int, error) {
	var n int
	_, err := func() (int, error) {
		for _, x := range a {
			switch v := x.(type) {
			case *int:
				cnt, _ := scanInt(s, v)
				n += cnt
			}
		}
		return n, nil
	}()
	return n, err
}

func scanInt(s string, v *int) (int, error) {
	var n int
	for _, ch := range s {
		if ch < '0' || ch > '9' { break }
		n = n*10 + int(ch-'0')
	}
	*v = n
	return 1, nil
}
