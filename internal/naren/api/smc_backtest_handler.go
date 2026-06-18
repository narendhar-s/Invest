package api

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"stockwise/internal/naren/analysis/options"
	"stockwise/internal/naren/kite"
)

// KiteSMCBacktest backtests the SMC + FVG + VWAP multi-timeframe options system on
// NIFTY (5-min entries, 15-min HTF context, ATM weekly CE/PE), surfaced in the
// SMC challenge → Backtest tab.
//
// POST /api/naren/v1/kite/smc-backtest
// Body: { "days": 15, "lots": 2, "rr": 3.0 }
func (h *Handler) KiteSMCBacktest(c *gin.Context) {
	if !kiteReady(c) {
		return
	}
	var body struct {
		Days int     `json:"days"`
		Lots int     `json:"lots"`
		RR   float64 `json:"rr"`
	}
	_ = c.ShouldBindJSON(&body)
	if body.Days <= 0 {
		body.Days = 15
	}
	if body.Days > 60 {
		body.Days = 60 // Kite 5-min data window guard
	}
	if body.Lots <= 0 {
		body.Lots = 2
	}
	if body.RR <= 0 {
		body.RR = 3.0
	}

	now := time.Now()
	from := now.AddDate(0, 0, -body.Days).Format("2006-01-02 15:04:05")
	to := now.Format("2006-01-02 15:04:05")

	candles, err := kiteSvc.client.HistoricalData(kite.NiftyIndexToken, "5minute", from, to)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	res := options.SMCBacktest(candles, body.Lots, body.RR)
	res.Days = body.Days
	c.JSON(http.StatusOK, res)
}
