package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"stockwise/internal/naren/analysis/options"
	"stockwise/internal/naren/kite"
)

// ─── Live terminal endpoints ──────────────────────────────────────────────────

// LiveState returns the current live state as a single JSON snapshot.
func (h *Handler) LiveState(c *gin.Context) {
	if challengeSvc == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "challenge service not running"})
		return
	}
	c.JSON(http.StatusOK, challengeSvc.LiveState())
}

// LiveStream streams real-time updates via Server-Sent Events (SSE).
//
// The browser opens ONE persistent connection; the server pushes a JSON
// snapshot every 2 seconds. No polling needed in the frontend.
//
// Each event:   data: <json>\n\n
func (h *Handler) LiveStream(c *gin.Context) {
	if challengeSvc == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "challenge service not running"})
		return
	}

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	c.Header("Access-Control-Allow-Origin", "*")

	ctx     := c.Request.Context()
	flusher := c.Writer

	send := func() bool {
		data, err := json.Marshal(challengeSvc.LiveState())
		if err != nil { return true }
		fmt.Fprintf(flusher, "data: %s\n\n", data)
		flusher.Flush()
		return false
	}
	if send() { return }

	tick := time.NewTicker(2 * time.Second)
	ping := time.NewTicker(25 * time.Second)
	defer tick.Stop(); defer ping.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if send() { return }
		case <-ping.C:
			fmt.Fprintf(flusher, ": ping\n\n")
			flusher.Flush()
		}
	}
}

// LiveChartData returns recent 15m NIFTY candles with:
//   - EMA9 and EMA21 values per bar
//   - Signal classification per bar (strategy, direction, confidence)
//   - Whether the bar's signal would pass the PCR filter
//   - Whether it's a tradeable signal (confidence >= 55, non-neutral)
func (h *Handler) LiveChartData(c *gin.Context) {
	if kiteSvc == nil || !kiteSvc.client.IsConnected() {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Kite not connected"})
		return
	}

	now  := time.Now()
	from := now.AddDate(0, 0, -4).Format("2006-01-02 15:04:05")
	to   := now.Format("2006-01-02 15:04:05")
	candles, err := kiteSvc.client.HistoricalData(kite.NiftyIndexToken, "15minute", from, to)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if len(candles) < 5 {
		c.JSON(http.StatusOK, gin.H{"bars": []interface{}{}})
		return
	}

	// Current PCR for filter annotation
	pcr := 0.0
	if challengeSvc != nil {
		snap := challengeSvc.LiveState()
		if snap.Chain != nil { pcr = snap.Chain.PCR }
	}

	type Bar struct {
		Time            string  `json:"time"`
		Open            float64 `json:"open"`
		High            float64 `json:"high"`
		Low             float64 `json:"low"`
		Close           float64 `json:"close"`
		Volume          int64   `json:"volume"`
		EMA9            float64 `json:"ema9"`
		EMA21           float64 `json:"ema21"`
		Strategy        string  `json:"strategy"`
		Direction       string  `json:"direction"`
		Regime          string  `json:"regime"`
		Confidence      int     `json:"confidence"`
		IsSignal        bool    `json:"is_signal"`         // passes tech filter (conf >= 55)
		PCRPass         bool    `json:"pcr_pass"`          // also passes PCR filter
		IsEntry         bool    `json:"is_entry"`          // all 3 gates pass (ideal entry)
		IsPositionEntry bool    `json:"is_position_entry"` // the ACTUAL open trade entry bar
		EntryPremium    float64 `json:"entry_premium"`     // option premium at that entry
	}

	// Get open position entry time to mark the exact entry bar on the chart
	var openEntryTime time.Time
	var openEntryPremium float64
	if challengeSvc != nil {
		snap := challengeSvc.LiveState()
		if snap.OpenTrade != nil {
			openEntryTime    = snap.OpenTrade.EntryTime
			openEntryPremium = snap.OpenTrade.EntryPremium
		}
	}

	bars := make([]Bar, 0, len(candles))
	k9   := 2.0 / float64(10)
	k21  := 2.0 / float64(22)
	e9, e21 := candles[0].Close, candles[0].Close

	const warmup = 20
	for i, ca := range candles {
		if i > 0 {
			e9  = ca.Close*k9  + e9*(1-k9)
			e21 = ca.Close*k21 + e21*(1-k21)
		}

		bar := Bar{
			Time:   ca.Time.Format("2006-01-02T15:04:05+05:30"),
			Open:   ca.Open, High: ca.High, Low: ca.Low,
			Close:  ca.Close, Volume: ca.Volume,
			EMA9:   round2dp(e9), EMA21: round2dp(e21),
			PCRPass: true, // default: pass (no PCR data or market closed)
		}

		// Run signal analysis using a sliding window
		if i >= warmup {
			start := i - 29; if start < 0 { start = 0 }
			expiry  := options.NiftyWeeklyExpiry(ca.Time)
			isExpDy := expiry.Format("2006-01-02") == ca.Time.Format("2006-01-02")
			if rec, err := options.Analyze(candles[start:i+1], isExpDy); err == nil {
				bar.Strategy   = string(rec.Strategy)
				bar.Direction  = rec.Direction
				bar.Regime     = string(rec.Regime)
				bar.Confidence = rec.Confidence
				bar.IsSignal   = rec.Confidence >= 55 && rec.Strategy != options.StratNone

				if bar.IsSignal && pcr > 0 {
					bar.PCRPass = pcrAlignsFn(rec.Direction, pcr)
				}
				bar.IsEntry = bar.IsSignal && bar.PCRPass
			}
		}
		// Mark the actual open position entry bar (within ±15 min of entry time)
		if !openEntryTime.IsZero() {
			diff := ca.Time.Sub(openEntryTime)
			if diff >= -15*time.Minute && diff <= 15*time.Minute {
				bar.IsPositionEntry = true
				bar.EntryPremium    = openEntryPremium
			}
		}
		bars = append(bars, bar)
	}

	c.JSON(http.StatusOK, gin.H{"bars": bars, "total": len(bars)})
}

// ─── helpers ──────────────────────────────────────────────────────────────────

func round2dp(v float64) float64 { return float64(int(v*100+0.5)) / 100 }

func pcrAlignsFn(direction string, pcr float64) bool {
	if pcr == 0 { return true }
	bias := kite.PCRBias(pcr)
	switch direction {
	case "BULLISH": return bias != "BEARISH"
	case "BEARISH": return bias != "BULLISH"
	}
	return true
}
