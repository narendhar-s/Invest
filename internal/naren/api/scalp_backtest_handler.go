package api

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"stockwise/internal/naren/analysis/options"
	"stockwise/internal/naren/kite"
)

// KiteScalpBacktest backtests the EMA50/200 + Stochastic 1-minute scalp on NIFTY
// (ATM CE/PE), surfaced in the Kite Terminal → Backtest tab.
//
// POST /api/naren/v1/kite/scalp-backtest
// Body: { "days": 10, "lots": 2, "rr": 1.5 }
func (h *Handler) KiteScalpBacktest(c *gin.Context) {
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
		body.Days = 10
	}
	if body.Days > 30 {
		body.Days = 30 // Kite minute-data window guard
	}
	if body.Lots <= 0 {
		body.Lots = 2
	}
	if body.RR <= 0 {
		body.RR = 1.5
	}

	now := time.Now()
	from := now.AddDate(0, 0, -body.Days).Format("2006-01-02 15:04:05")
	to := now.Format("2006-01-02 15:04:05")

	candles, err := kiteSvc.client.HistoricalData(kite.NiftyIndexToken, "minute", from, to)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	res := options.ScalpBacktest(candles, body.Lots, body.RR)
	res.Days = body.Days
	c.JSON(http.StatusOK, res)
}
