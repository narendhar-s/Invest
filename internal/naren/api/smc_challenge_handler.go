package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"stockwise/internal/naren/paper"
	"stockwise/internal/naren/storage"
)

// smcChallengeSvc is the parallel 90-day SMC challenge service (SMC + FVG + VWAP
// multi-timeframe, 5-min entries on 15-min HTF context, ATM weekly CE/PE). It is
// initialised in InitChallenge.
var smcChallengeSvc *paper.ChallengeService

func smcReady(c *gin.Context) bool {
	if smcChallengeSvc == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "smc challenge service not initialised"})
		return false
	}
	return true
}

// GET /api/naren/v1/smc-challenge/status
func (h *Handler) SMCChallengeStatus(c *gin.Context) {
	if !smcReady(c) {
		return
	}
	c.JSON(http.StatusOK, smcChallengeSvc.Status())
}

// POST /api/naren/v1/smc-challenge/start
func (h *Handler) SMCChallengeStart(c *gin.Context) {
	if !smcReady(c) {
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
		body.TargetPerTrade = body.RiskPerTrade * 3.0 // ~3:1 R:R per the 1.8×ATR / 0.6×ATR rules
	}

	cfg, err := smcChallengeSvc.StartChallenge(body.Lots, body.RiskPerTrade, body.TargetPerTrade, body.Notes)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, cfg)
}

// POST /api/naren/v1/smc-challenge/live-config — enable/disable real Zerodha
// orders for the SMC challenge + set the live guards (profit square-off, trailing
// stop, daily target profit, max lots, etc.).
func (h *Handler) SMCChallengeLiveConfig(c *gin.Context) {
	if !smcReady(c) {
		return
	}
	var body struct {
		Enabled           bool    `json:"enabled"`
		ProfitTarget      float64 `json:"profit_target"`
		MaxLots           int     `json:"max_lots"`
		MinProfit         float64 `json:"min_profit"`
		WindowStart       string  `json:"window_start"`
		WindowEnd         string  `json:"window_end"`
		HoldConfidence    int     `json:"hold_confidence"`
		RR                float64 `json:"rr"`
		MaxDailyLoss      float64 `json:"max_daily_loss"`
		MaxConsecLosses   int     `json:"max_consec_losses"`
		DailyTargetProfit float64 `json:"daily_target_profit"`
		TrailSL           float64 `json:"trail_sl"`
		MaxEntriesPerDay  int     `json:"max_entries_per_day"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	if err := smcChallengeSvc.SetLiveConfig(paper.LiveSettings{
		Enabled:           body.Enabled,
		ProfitTarget:      body.ProfitTarget,
		MaxLots:           body.MaxLots,
		MinProfit:         body.MinProfit,
		WindowStart:       body.WindowStart,
		WindowEnd:         body.WindowEnd,
		HoldConfidence:    body.HoldConfidence,
		RR:                body.RR,
		MaxDailyLoss:      body.MaxDailyLoss,
		MaxConsecLosses:   body.MaxConsecLosses,
		DailyTargetProfit: body.DailyTargetProfit,
		TrailSL:           body.TrailSL,
		MaxEntriesPerDay:  body.MaxEntriesPerDay,
	}); err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /api/naren/v1/smc-challenge/pause
func (h *Handler) SMCChallengePause(c *gin.Context) {
	if !smcReady(c) {
		return
	}
	if err := smcChallengeSvc.PauseChallenge(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "paused"})
}

// POST /api/naren/v1/smc-challenge/resume
func (h *Handler) SMCChallengeResume(c *gin.Context) {
	if !smcReady(c) {
		return
	}
	if err := smcChallengeSvc.ResumeChallenge(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, smcChallengeSvc.Status())
}

// POST /api/naren/v1/smc-challenge/enter
func (h *Handler) SMCChallengeEnter(c *gin.Context) {
	if !smcReady(c) {
		return
	}
	t, err := smcChallengeSvc.ManualEntry()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, t)
}

// POST /api/naren/v1/smc-challenge/exit
func (h *Handler) SMCChallengeExit(c *gin.Context) {
	if !smcReady(c) {
		return
	}
	if err := smcChallengeSvc.ManualExit(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, smcChallengeSvc.Status())
}

// POST /api/naren/v1/smc-challenge/snapshot
func (h *Handler) SMCChallengeSnapshot(c *gin.Context) {
	if !smcReady(c) {
		return
	}
	smcChallengeSvc.ForceSnapshot()
	c.JSON(http.StatusOK, gin.H{"status": "snapshot written"})
}

// GET /api/naren/v1/smc-challenge/trades?limit=100
func (h *Handler) SMCChallengeTrades(c *gin.Context) {
	if !smcReady(c) {
		return
	}
	limit := 200
	if l := c.Query("limit"); l != "" {
		var n int
		if _, err := cFmtSscanf(l, "%d", &n); err == nil && n > 0 {
			limit = n
		}
	}
	trades := smcChallengeSvc.Trades(limit)
	if trades == nil {
		trades = []storage.ChallengeTrade{}
	}
	c.JSON(http.StatusOK, trades)
}

// GET /api/naren/v1/smc-challenge/daily
func (h *Handler) SMCChallengeDaily(c *gin.Context) {
	if !smcReady(c) {
		return
	}
	days := smcChallengeSvc.DailyHistory()
	if days == nil {
		days = []storage.ChallengeDay{}
	}
	c.JSON(http.StatusOK, days)
}

// GET /api/naren/v1/smc-challenge/expiry-breakdown
func (h *Handler) SMCChallengeExpiryBreakdown(c *gin.Context) {
	if !smcReady(c) {
		return
	}
	c.JSON(http.StatusOK, smcChallengeSvc.ExpiryBreakdown())
}

// GET /api/naren/v1/smc-challenge/all
func (h *Handler) SMCChallengeAll(c *gin.Context) {
	if !smcReady(c) {
		return
	}
	c.JSON(http.StatusOK, smcChallengeSvc.AllChallenges())
}
