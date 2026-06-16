package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"stockwise/internal/naren/paper"
	"stockwise/internal/naren/storage"
)

// scalpChallengeSvc is the parallel 90-day SCALP challenge service (EMA50/200 +
// Stochastic, 1-minute, ATM CE/PE). It is initialised in InitChallenge.
var scalpChallengeSvc *paper.ChallengeService

func scalpReady(c *gin.Context) bool {
	if scalpChallengeSvc == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "scalp challenge service not initialised"})
		return false
	}
	return true
}

// GET /api/naren/v1/scalp-challenge/status
func (h *Handler) ScalpChallengeStatus(c *gin.Context) {
	if !scalpReady(c) {
		return
	}
	c.JSON(http.StatusOK, scalpChallengeSvc.Status())
}

// POST /api/naren/v1/scalp-challenge/start
func (h *Handler) ScalpChallengeStart(c *gin.Context) {
	if !scalpReady(c) {
		return
	}
	var body struct {
		Lots           int     `json:"lots"`
		RiskPerTrade   float64 `json:"risk_per_trade"`
		TargetPerTrade float64 `json:"target_per_trade"`
		Notes          string  `json:"notes"`
	}
	_ = c.ShouldBindJSON(&body)
	if body.Lots <= 0 {
		body.Lots = 2
	}
	if body.RiskPerTrade <= 0 {
		body.RiskPerTrade = 5000
	}
	if body.TargetPerTrade <= 0 {
		body.TargetPerTrade = body.RiskPerTrade * 1.5 // 1.5 R:R per the strategy
	}

	cfg, err := scalpChallengeSvc.StartChallenge(body.Lots, body.RiskPerTrade, body.TargetPerTrade, body.Notes)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, cfg)
}

// POST /api/naren/v1/scalp-challenge/live-config — enable/disable real Zerodha
// orders for the scalp challenge + set the per-position profit square-off (₹).
func (h *Handler) ScalpChallengeLiveConfig(c *gin.Context) {
	if !scalpReady(c) {
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
		MaxDailyLoss     float64 `json:"max_daily_loss"`
		MaxConsecLosses  int     `json:"max_consec_losses"`
		DailyRiskCapital float64 `json:"daily_risk_capital"`
		MaxEntriesPerDay int     `json:"max_entries_per_day"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	if err := scalpChallengeSvc.SetLiveConfig(paper.LiveSettings{
		Enabled:        body.Enabled,
		ProfitTarget:   body.ProfitTarget,
		MaxLots:        body.MaxLots,
		MinProfit:      body.MinProfit,
		WindowStart:    body.WindowStart,
		WindowEnd:      body.WindowEnd,
		HoldConfidence: body.HoldConfidence,
		RR:             body.RR,
		MaxDailyLoss:     body.MaxDailyLoss,
		MaxConsecLosses:  body.MaxConsecLosses,
		DailyRiskCapital: body.DailyRiskCapital,
		MaxEntriesPerDay: body.MaxEntriesPerDay,
	}); err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /api/naren/v1/scalp-challenge/pause
func (h *Handler) ScalpChallengePause(c *gin.Context) {
	if !scalpReady(c) {
		return
	}
	if err := scalpChallengeSvc.PauseChallenge(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "paused"})
}

// POST /api/naren/v1/scalp-challenge/resume
func (h *Handler) ScalpChallengeResume(c *gin.Context) {
	if !scalpReady(c) {
		return
	}
	if err := scalpChallengeSvc.ResumeChallenge(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, scalpChallengeSvc.Status())
}

// POST /api/naren/v1/scalp-challenge/enter
func (h *Handler) ScalpChallengeEnter(c *gin.Context) {
	if !scalpReady(c) {
		return
	}
	t, err := scalpChallengeSvc.ManualEntry()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, t)
}

// POST /api/naren/v1/scalp-challenge/exit
func (h *Handler) ScalpChallengeExit(c *gin.Context) {
	if !scalpReady(c) {
		return
	}
	if err := scalpChallengeSvc.ManualExit(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, scalpChallengeSvc.Status())
}

// POST /api/naren/v1/scalp-challenge/snapshot
func (h *Handler) ScalpChallengeSnapshot(c *gin.Context) {
	if !scalpReady(c) {
		return
	}
	scalpChallengeSvc.ForceSnapshot()
	c.JSON(http.StatusOK, gin.H{"status": "snapshot written"})
}

// GET /api/naren/v1/scalp-challenge/trades?limit=100
func (h *Handler) ScalpChallengeTrades(c *gin.Context) {
	if !scalpReady(c) {
		return
	}
	limit := 200
	if l := c.Query("limit"); l != "" {
		var n int
		if _, err := cFmtSscanf(l, "%d", &n); err == nil && n > 0 {
			limit = n
		}
	}
	trades := scalpChallengeSvc.Trades(limit)
	if trades == nil {
		trades = []storage.ChallengeTrade{}
	}
	c.JSON(http.StatusOK, trades)
}

// GET /api/naren/v1/scalp-challenge/daily
func (h *Handler) ScalpChallengeDaily(c *gin.Context) {
	if !scalpReady(c) {
		return
	}
	days := scalpChallengeSvc.DailyHistory()
	if days == nil {
		days = []storage.ChallengeDay{}
	}
	c.JSON(http.StatusOK, days)
}

// GET /api/naren/v1/scalp-challenge/expiry-breakdown
func (h *Handler) ScalpChallengeExpiryBreakdown(c *gin.Context) {
	if !scalpReady(c) {
		return
	}
	c.JSON(http.StatusOK, scalpChallengeSvc.ExpiryBreakdown())
}

// GET /api/naren/v1/scalp-challenge/all
func (h *Handler) ScalpChallengeAll(c *gin.Context) {
	if !scalpReady(c) {
		return
	}
	c.JSON(http.StatusOK, scalpChallengeSvc.AllChallenges())
}
