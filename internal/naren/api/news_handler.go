package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
)

// NewsFlags returns the latest classified news flags (GREEN / RED) for all
// watched symbols and their sectors. The news monitor refreshes every hour.
func (h *Handler) NewsFlags(c *gin.Context) {
	store := h.newsMonitor.GetStore()
	c.JSON(http.StatusOK, gin.H{
		"green_flags": store.GreenFlags,
		"red_flags":   store.RedFlags,
		"green_count": len(store.GreenFlags),
		"red_count":   len(store.RedFlags),
		"last_update": store.LastUpdate,
	})
}

// TomorrowPicks runs all strategies on all 12 watched symbols and returns
// only active-signal picks (BUY/SELL) sorted by trade probability.
func (h *Handler) TomorrowPicks(c *gin.Context) {
	years := 3
	if y, err := strconv.Atoi(c.Query("years")); err == nil && y > 0 && y <= 5 {
		years = y
	}
	picks, err := h.strategyEngine.GetTomorrowPicks(years)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"picks":        picks,
		"count":        len(picks),
		"period_years": years,
		"generated_at": time.Now().Format(time.RFC3339),
	})
}

// TodayPicks returns all 12 symbols (including NEUTRAL) ranked by trade
// probability, each with computed entry / target / stop-loss prices.
func (h *Handler) TodayPicks(c *gin.Context) {
	years := 3
	if y, err := strconv.Atoi(c.Query("years")); err == nil && y > 0 && y <= 5 {
		years = y
	}
	picks, err := h.strategyEngine.GetTodayPicks(years)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"picks":        picks,
		"count":        len(picks),
		"period_years": years,
		"generated_at": time.Now().Format(time.RFC3339),
	})
}
