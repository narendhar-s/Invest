package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/net/websocket"

	"stockwise/internal/data"
	"stockwise/internal/storage"
	"stockwise/internal/strategy"
)

// ListStrategies returns the strategies available for the dropdown.
func (h *Handler) ListStrategies(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"strategies": strategy.AvailableStrategies(),
		"modes": []gin.H{
			{"key": strategy.ModeSignal, "name": "Signals only"},
			{"key": strategy.ModePaper, "name": "Paper trading"},
			{"key": strategy.ModeLive, "name": "Live orders"},
		},
		"data_source": h.dataSourceName(),
	})
}

// GetStrategyConfig returns the editable config + defaults for a configurable
// strategy, so the frontend strategy editor can render a form.
func (h *Handler) GetStrategyConfig(c *gin.Context) {
	key := c.Param("key")
	s, ok := strategy.Get(key)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "unknown strategy"})
		return
	}
	cfg, ok := s.(strategy.Configurable)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "strategy is not configurable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"key":      key,
		"name":     s.Name(),
		"config":   cfg.Config(),
		"defaults": cfg.Defaults(),
	})
}

// UpdateStrategyConfig applies an edited config object to a configurable
// strategy. The body is the config JSON itself (partial updates merge).
func (h *Handler) UpdateStrategyConfig(c *gin.Context) {
	key := c.Param("key")
	s, ok := strategy.Get(key)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "unknown strategy"})
		return
	}
	cfg, ok := s.(strategy.Configurable)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "strategy is not configurable"})
		return
	}
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "could not read request body"})
		return
	}
	if err := cfg.SetConfig(raw); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"key": key, "config": cfg.Config()})
}

func (h *Handler) dataSourceName() string {
	if h.dataSource != nil {
		return h.dataSource.Name()
	}
	return "yfinance"
}

// LiveStatus returns the current live-engine state.
func (h *Handler) LiveStatus(c *gin.Context) {
	if h.liveEngine == nil {
		c.JSON(http.StatusOK, gin.H{"running": false, "available": false})
		return
	}
	c.JSON(http.StatusOK, h.liveEngine.Status())
}

// LiveCallsHistory returns the trade calls the engine emitted on a given day.
// Query param: date=YYYY-MM-DD (defaults to today, server-local time).
func (h *Handler) LiveCallsHistory(c *gin.Context) {
	if h.repo == nil {
		c.JSON(http.StatusOK, gin.H{"date": "", "calls": []any{}})
		return
	}
	dateStr := c.Query("date")
	day := time.Now()
	if dateStr != "" {
		parsed, err := time.ParseInLocation("2006-01-02", dateStr, time.Local)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid date, expected YYYY-MM-DD"})
			return
		}
		day = parsed
	}
	calls, err := h.repo.GetLiveCallsByDate(day)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if calls == nil {
		calls = []storage.LiveCallRecord{}
	}
	c.JSON(http.StatusOK, gin.H{"date": day.Format("2006-01-02"), "calls": calls})
}

// LiveStart begins live evaluation with the chosen strategy/mode/symbols.
func (h *Handler) LiveStart(c *gin.Context) {
	if h.liveEngine == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "live engine unavailable — configure Zerodha"})
		return
	}
	var req struct {
		Strategy   string   `json:"strategy"`   // single (back-compat)
		Strategies []string `json:"strategies"` // multi-select
		MinAgree   int      `json:"min_agree"`  // consensus threshold
		Mode       string   `json:"mode"`
		Symbols    []string `json:"symbols"`
		Timeframe  string   `json:"timeframe"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	// Accept either the multi-select list or the legacy single-strategy field.
	keys := req.Strategies
	if len(keys) == 0 && req.Strategy != "" {
		keys = []string{req.Strategy}
	}
	if len(keys) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "at least one strategy is required"})
		return
	}
	if req.MinAgree < 1 {
		req.MinAgree = 1
	}
	if len(req.Symbols) == 0 {
		req.Symbols = h.cfg.Markets.NSE.Symbols
	}
	if !h.kite.IsConnected() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Zerodha not connected — connect first to stream live candles"})
		return
	}
	if err := h.liveEngine.Start(keys, req.MinAgree, req.Mode, req.Symbols, req.Timeframe); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// Persist the session so the engine auto-resumes after a backend restart and
	// stays running until the user explicitly stops it (like the 90-day challenge).
	if h.repo != nil {
		cfg, _ := json.Marshal(map[string]any{
			"strategies": keys,
			"min_agree":  req.MinAgree,
			"mode":       req.Mode,
			"symbols":    req.Symbols,
			"timeframe":  req.Timeframe,
		})
		_ = h.repo.SetSetting("live_engine_config", string(cfg))
		_ = h.repo.SetSetting("live_engine_running", "true")
	}
	c.JSON(http.StatusOK, h.liveEngine.Status())
}

// LiveStop halts the live engine.
func (h *Handler) LiveStop(c *gin.Context) {
	if h.liveEngine != nil {
		h.liveEngine.Stop()
	}
	// Clear the persisted running flag so it does NOT auto-resume on restart.
	if h.repo != nil {
		_ = h.repo.SetSetting("live_engine_running", "false")
	}
	c.JSON(http.StatusOK, gin.H{"running": false})
}

// ListPatterns returns the catalog of detectable candlestick patterns for the
// frontend pattern picker.
func (h *Handler) ListPatterns(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"patterns": strategy.AvailablePatterns()})
}

// LiveSnapshot returns the candle history + detected patterns for one symbol so
// the chart can render before the live stream warms up.
func (h *Handler) LiveSnapshot(c *gin.Context) {
	if h.liveEngine == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "live engine unavailable"})
		return
	}
	symbol := c.Query("symbol")
	if symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol is required"})
		return
	}
	c.JSON(http.StatusOK, h.liveEngine.Snapshot(symbol))
}

// LiveCandlesStream is an SSE endpoint streaming closed and in-progress candles
// for one symbol, suitable for a live TradingView-style chart.
func (h *Handler) LiveCandlesStream(c *gin.Context) {
	if h.liveEngine == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "live engine unavailable"})
		return
	}
	symbol := c.Query("symbol")
	if symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol is required"})
		return
	}

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")

	// Replay history so a freshly-connected client sees the existing chart.
	snap := h.liveEngine.Snapshot(symbol)
	for _, candle := range snap.Candles {
		if b, err := json.Marshal(candle); err == nil {
			fmt.Fprintf(c.Writer, "data: %s\n\n", b)
		}
	}
	c.Writer.Flush()

	ch := h.liveEngine.SubscribeCandles()
	defer h.liveEngine.UnsubscribeCandles(ch)

	clientGone := c.Request.Context().Done()
	for {
		select {
		case <-clientGone:
			return
		case candle, ok := <-ch:
			if !ok {
				return
			}
			if candle.Symbol != symbol {
				continue
			}
			if b, err := json.Marshal(candle); err == nil {
				fmt.Fprintf(c.Writer, "data: %s\n\n", b)
				c.Writer.Flush()
			}
		}
	}
}

// LiveCandlesWS streams closed and in-progress candles for one symbol over a
// WebSocket. It mirrors LiveCandlesStream (SSE) but uses a persistent socket so
// chart updates push tick-by-tick with lower latency and no proxy buffering.
func (h *Handler) LiveCandlesWS(c *gin.Context) {
	if h.liveEngine == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "live engine unavailable"})
		return
	}
	symbol := c.Query("symbol")
	if symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol is required"})
		return
	}

	// websocket.Handler performs the HTTP upgrade and runs fn for the lifetime of
	// the connection. It does not enforce an Origin check, which is fine here —
	// the endpoint only emits public market data and triggers no side effects.
	websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()

		send := func(candle data.Candle) bool {
			b, err := json.Marshal(candle)
			if err != nil {
				return true // skip this candle, keep the socket open
			}
			return websocket.Message.Send(ws, string(b)) == nil
		}

		// Replay history so a freshly-connected client sees the existing chart.
		snap := h.liveEngine.Snapshot(symbol)
		for _, candle := range snap.Candles {
			if !send(candle) {
				return
			}
		}
		if snap.Current != nil {
			if !send(*snap.Current) {
				return
			}
		}

		ch := h.liveEngine.SubscribeCandles()
		defer h.liveEngine.UnsubscribeCandles(ch)

		// A reader goroutine detects client disconnects (and drains any pings).
		gone := make(chan struct{})
		go func() {
			var discard string
			for {
				if err := websocket.Message.Receive(ws, &discard); err != nil {
					close(gone)
					return
				}
			}
		}()

		clientGone := c.Request.Context().Done()
		for {
			select {
			case <-gone:
				return
			case <-clientGone:
				return
			case candle, ok := <-ch:
				if !ok {
					return
				}
				if candle.Symbol != symbol {
					continue
				}
				if !send(candle) {
					return
				}
			}
		}
	}).ServeHTTP(c.Writer, c.Request)
}

// LiveHistory returns last-session candles + detected patterns and replays a
// strategy over them. Works when the engine is stopped (e.g. after market close)
// so the chart can show read-only historical data with signal markers.
func (h *Handler) LiveHistory(c *gin.Context) {
	if h.liveEngine == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "live engine unavailable"})
		return
	}
	symbol := c.Query("symbol")
	if symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol is required"})
		return
	}
	timeframe := c.Query("timeframe")
	strategyKey := c.Query("strategy")
	from, to, err := parseBacktestRange(c.Query("from"), c.Query("to"), c.Query("days"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	snap, err := h.liveEngine.HistoryReplay(symbol, timeframe, strategyKey, from, to)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"available": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, snap)
}

// LiveBacktest replays a strategy over the most recent historical candles and
// returns trade-by-trade results plus summary stats. Query: symbol, timeframe,
// strategy. Works while the engine is stopped (uses the seed data source).
func (h *Handler) LiveBacktest(c *gin.Context) {
	if h.liveEngine == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "live engine unavailable"})
		return
	}
	symbol := c.Query("symbol")
	if symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol is required"})
		return
	}
	strategyKey := c.Query("strategy")
	if strategyKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "strategy is required"})
		return
	}

	// Optional date range. Accepts either explicit from/to (YYYY-MM-DD or
	// RFC3339) or a `days` lookback shortcut. When supplied (and Zerodha is
	// connected) candles are fetched from Kite over that exact window.
	from, to, err := parseBacktestRange(c.Query("from"), c.Query("to"), c.Query("days"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	res, err := h.liveEngine.BacktestStrategy(symbol, c.Query("timeframe"), strategyKey, from, to)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"available": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"available": true, "result": res})
}

// parseBacktestRange resolves the backtest window from query params. Priority:
//  1. explicit from & to (date "2006-01-02" or RFC3339)
//  2. days lookback (to = now, from = now-days)
//  3. neither set → zero times, signalling "use the seed source default window".
// Times are anchored to IST so a plain date covers the full Indian trading day.
func parseBacktestRange(fromStr, toStr, daysStr string) (time.Time, time.Time, error) {
	ist, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		ist = time.FixedZone("IST", 5*3600+30*60)
	}

	parse := func(s string, endOfDay bool) (time.Time, error) {
		if t, err := time.ParseInLocation("2006-01-02", s, ist); err == nil {
			if endOfDay {
				return t.Add(23*time.Hour + 59*time.Minute + 59*time.Second), nil
			}
			return t, nil
		}
		return time.Parse(time.RFC3339, s)
	}

	if fromStr != "" && toStr != "" {
		from, err := parse(fromStr, false)
		if err != nil {
			return time.Time{}, time.Time{}, fmt.Errorf("invalid 'from' date: %v", err)
		}
		to, err := parse(toStr, true)
		if err != nil {
			return time.Time{}, time.Time{}, fmt.Errorf("invalid 'to' date: %v", err)
		}
		if !to.After(from) {
			return time.Time{}, time.Time{}, fmt.Errorf("'to' must be after 'from'")
		}
		return from, to, nil
	}

	if daysStr != "" {
		days, err := strconv.Atoi(daysStr)
		if err != nil || days <= 0 {
			return time.Time{}, time.Time{}, fmt.Errorf("invalid 'days': must be a positive integer")
		}
		to := time.Now().In(ist)
		from := to.AddDate(0, 0, -days)
		return from, to, nil
	}

	return time.Time{}, time.Time{}, nil
}

// LiveOI returns the option-chain open-interest analysis (PCR, max-pain,
// support/resistance, bias) for a symbol — used by the chart's OI panel.
func (h *Handler) LiveOI(c *gin.Context) {
	if h.kite == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Zerodha unavailable"})
		return
	}
	if !h.kite.IsConnected() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Zerodha not connected"})
		return
	}
	symbol := c.Query("symbol")
	if symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol is required"})
		return
	}
	oi, err := h.kite.OptionChainOI(symbol)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"available": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"available": true, "oi": oi})
}

// LiveOIPulse returns the minute-by-minute OI Pulse for a symbol: the latest
// price-vs-OI regime, a composite bullish/bearish verdict with confidence, the
// rule hits behind it, and the recent per-minute history. Drives the OI Pulse page.
func (h *Handler) LiveOIPulse(c *gin.Context) {
	if h.kite == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Zerodha unavailable"})
		return
	}
	if !h.kite.IsConnected() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Zerodha not connected"})
		return
	}
	symbol := c.Query("symbol")
	if symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol is required"})
		return
	}
	// Optional comma-separated trade modes: option_buy,option_sell,futures_buy,futures_sell.
	// Empty → all modes.
	var modes []string
	if raw := c.Query("modes"); raw != "" {
		for _, m := range strings.Split(raw, ",") {
			if m = strings.TrimSpace(m); m != "" {
				modes = append(modes, m)
			}
		}
	}
	// Position-sizing cap and risk:reward, both configurable from the UI.
	maxLots := 2 // default cap
	if v, err := strconv.Atoi(c.Query("lots")); err == nil && v >= 1 {
		maxLots = v
	}
	rr := 2.0 // default 1:2
	if v, err := strconv.ParseFloat(c.Query("rr"), 64); err == nil && v > 0 {
		rr = v
	}
	pulse, err := h.kite.OIPulseFor(symbol, modes, maxLots, rr)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"available": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"available": true, "pulse": pulse})
}

// LiveCallsStream is an SSE endpoint pushing trade calls as they are generated.
func (h *Handler) LiveCallsStream(c *gin.Context) {
	if h.liveEngine == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "live engine unavailable"})
		return
	}

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")

	// Replay recent calls so a freshly-connected client sees history.
	for _, lc := range h.liveEngine.Status().RecentCall {
		if b, err := json.Marshal(lc); err == nil {
			fmt.Fprintf(c.Writer, "data: %s\n\n", b)
		}
	}
	c.Writer.Flush()

	ch := h.liveEngine.Subscribe()
	defer h.liveEngine.Unsubscribe(ch)

	clientGone := c.Request.Context().Done()
	for {
		select {
		case <-clientGone:
			return
		case lc, ok := <-ch:
			if !ok {
				return
			}
			if b, err := json.Marshal(lc); err == nil {
				fmt.Fprintf(c.Writer, "data: %s\n\n", b)
				c.Writer.Flush()
			}
		}
	}
}
