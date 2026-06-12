package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"stockwise/internal/naren/nifty"
)

// ─── Nifty Scalping Handlers ─────────────────────────────────────────────────

// NiftyDashboard returns the complete Nifty scalping dashboard:
// option chain, strategy cards, live signals, strike suggestions.
func (h *Handler) NiftyDashboard(c *gin.Context) {
	expiry := c.Query("expiry")
	years := 3
	if y, err := strconv.Atoi(c.Query("years")); err == nil && y > 0 && y <= 5 {
		years = y
	}

	nseClient := nifty.NewNSEClient()

	// Fetch option chain and VIX concurrently
	chainCh := make(chan *nifty.OptionChainData, 1)
	vixCh := make(chan float64, 1)

	go func() {
		chain, _ := nseClient.FetchOptionChain(expiry)
		chainCh <- chain
	}()
	go func() {
		vixCh <- nseClient.FetchVIX()
	}()

	chain := <-chainCh
	vix := <-vixCh

	// Run strategy backtests
	cards, err := h.strategyEngine.RunNiftyStrategyBacktest(years)
	if err != nil {
		cards = []nifty.NiftyStrategyCard{}
	}

	// Get live signals
	liveSignals, _ := h.strategyEngine.GetNiftyLiveSignals()
	if liveSignals == nil {
		liveSignals = []nifty.NiftyScalpSignal{}
	}

	// Determine overall signal direction from live signals
	direction := "NEUTRAL"
	bullCount, bearCount := 0, 0
	for _, s := range liveSignals {
		if s.Direction == "BUY" {
			bullCount++
		} else if s.Direction == "SELL" {
			bearCount++
		}
	}
	if bullCount > bearCount+1 {
		direction = "BULLISH"
	} else if bearCount > bullCount+1 {
		direction = "BEARISH"
	}

	// Generate strike suggestions
	var strikeSuggestions *nifty.StrikeSuggestionReport
	if chain != nil {
		strikeSuggestions = nifty.SuggestStrikes(chain, direction)
	}

	// Attach current signal to each strategy card
	signalMap := map[string]nifty.NiftyScalpSignal{}
	for _, s := range liveSignals {
		signalMap[s.Strategy] = s
	}
	for i := range cards {
		if sig, ok := signalMap[cards[i].StrategyName]; ok {
			cards[i].CurrentSignal = &sig
		}
	}

	spot := 0.0
	change := 0.0
	changePct := 0.0
	pcr := 0.0
	maxPain := 0.0
	atm := 0.0
	sentiment := "NEUTRAL"
	trendDir := "SIDEWAYS"

	if chain != nil {
		spot = chain.SpotPrice
		pcr = chain.PCR
		maxPain = chain.MaxPainStrike
		atm = chain.ATMStrike
		sentiment = chain.MarketSentiment
	}

	// Derive change from recent price bars
	if stock, err := h.repo.GetStockBySymbol("^NSEI"); err == nil {
		to := time.Now()
		from := to.AddDate(0, 0, -5)
		if bars, err := h.repo.GetPriceBars(stock.ID, from, to); err == nil && len(bars) >= 2 {
			prev := bars[len(bars)-2].Close
			cur := bars[len(bars)-1].Close
			if spot == 0 {
				spot = cur
			}
			change = cur - prev
			if prev > 0 {
				changePct = (cur - prev) / prev * 100
			}
			if cur > bars[len(bars)-2].Close {
				trendDir = "UP"
			} else {
				trendDir = "DOWN"
			}
		}
	}

	dashboard := nifty.NiftyDashboard{
		SpotPrice:         spot,
		Change:            change,
		ChangePct:         changePct,
		VIX:               vix,
		PCR:               pcr,
		MaxPainStrike:     maxPain,
		ATMStrike:         atm,
		MarketSentiment:   sentiment,
		TrendDirection:    trendDir,
		Strategies:        cards,
		LiveSignals:       liveSignals,
		StrikeSuggestions: strikeSuggestions,
		OptionChain:       chain,
		GeneratedAt:       time.Now().Format(time.RFC3339),
	}

	c.JSON(http.StatusOK, dashboard)
}

// NiftyOptionChain returns just the option chain data.
func (h *Handler) NiftyOptionChain(c *gin.Context) {
	expiry := c.Query("expiry")
	client := nifty.NewNSEClient()
	chain, err := client.FetchOptionChain(expiry)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "NSE data unavailable", "detail": err.Error()})
		return
	}
	c.JSON(http.StatusOK, chain)
}

// NiftyStrikeSuggestions returns strike price suggestions for a given direction.
func (h *Handler) NiftyStrikeSuggestions(c *gin.Context) {
	direction := c.Query("direction")
	if direction == "" {
		direction = "BULLISH"
	}
	expiry := c.Query("expiry")
	client := nifty.NewNSEClient()
	chain, _ := client.FetchOptionChain(expiry)
	if chain == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "option chain unavailable"})
		return
	}
	report := nifty.SuggestStrikes(chain, direction)
	c.JSON(http.StatusOK, report)
}

// NiftyLiveSignals returns live scalping signals for the requested timeframe.
// Query param: timeframe = "5m" | "15m" | "daily" (default "daily").
// Intraday timeframes fetch fresh data from Yahoo Finance on every call.
func (h *Handler) NiftyLiveSignals(c *gin.Context) {
	tf := c.Query("timeframe")
	if tf != "5m" && tf != "15m" {
		tf = "daily"
	}

	signals, err := h.strategyEngine.GetNiftyLiveSignalsByTimeframe(tf)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if signals == nil {
		signals = []nifty.NiftyScalpSignal{}
	}
	c.JSON(http.StatusOK, gin.H{
		"signals":      signals,
		"count":        len(signals),
		"timeframe":    tf,
		"generated_at": time.Now().Format(time.RFC3339),
	})
}

// NiftyChartData returns OHLCV + indicators + signals for the chart component.
// Query params:
//   - symbol:    Yahoo Finance symbol (default "^NSEI", e.g. "HDFCBANK.NS")
//   - timeframe: "5m" | "15m" | "daily" (default "daily")
//   - strategy:  strategy name (default "Triple Trend Momentum")
//   - days:      number of daily bars (1-1095, ignored for intraday)
func (h *Handler) NiftyChartData(c *gin.Context) {
	symbol := c.Query("symbol")
	if symbol == "" {
		symbol = "^NSEI"
	}

	strategy := c.Query("strategy")
	if strategy == "" {
		strategy = "Triple Trend Momentum"
	}

	timeframe := c.Query("timeframe")
	if timeframe == "5m" || timeframe == "15m" || timeframe == "1h" {
		// days param controls how many days of intraday data to return
		// 5m: max 30 days (stitched), 15m/1h: max 60 days
		days := 7
		if d, err := strconv.Atoi(c.Query("days")); err == nil && d > 0 && d <= 60 {
			days = d
		}
		data, err := h.strategyEngine.GetNiftyIntradayChartDataMultiDay(timeframe, strategy, symbol, days)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, data)
		return
	}

	days := 365
	if d, err := strconv.Atoi(c.Query("days")); err == nil && d > 0 && d <= 1095 {
		days = d
	}
	data, err := h.strategyEngine.GetNiftyChartData(days, strategy, symbol)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, data)
}

// NiftyBTST returns today's Buy-Today-Sell-Tomorrow assessment for Nifty 50.
// Fetches live daily bars from Yahoo Finance and scores 8 criteria.
func (h *Handler) NiftyBTST(c *gin.Context) {
	sig, err := h.strategyEngine.GetNiftyBTSTSignal()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, sig)
}

// BookScalpTerminal returns live signals for all 6 book-proven scalping strategies.
func (h *Handler) BookScalpTerminal(c *gin.Context) {
	account := 100000.0
	risk := 1.0
	if a, err := strconv.ParseFloat(c.Query("account"), 64); err == nil && a > 0 {
		account = a
	}
	if r, err := strconv.ParseFloat(c.Query("risk"), 64); err == nil && r > 0 {
		risk = r
	}
	dash, err := h.strategyEngine.GetBookScalpDashboard(account, risk)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, dash)
}

// MinerviniNiftyIndex applies Minervini's SEPA to the NIFTY 50 INDEX itself,
// generating a CE/PE signal for NIFTY index options.
func (h *Handler) MinerviniNiftyIndex(c *gin.Context) {
	account := 100000.0
	risk := 1.25
	if a, err := strconv.ParseFloat(c.Query("account"), 64); err == nil && a > 0 {
		account = a
	}
	if r, err := strconv.ParseFloat(c.Query("risk"), 64); err == nil && r > 0 {
		risk = r
	}
	sig, err := h.strategyEngine.GetMinerviniNiftyIndex(account, risk)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, sig)
}

// MinerviniPicks returns Nifty stocks scored on Minervini's SEPA criteria.
// Query params: ?account=100000&risk=1.25
func (h *Handler) MinerviniPicks(c *gin.Context) {
	account := 100000.0
	risk := 1.25
	if a, err := strconv.ParseFloat(c.Query("account"), 64); err == nil && a > 0 {
		account = a
	}
	if r, err := strconv.ParseFloat(c.Query("risk"), 64); err == nil && r > 0 {
		risk = r
	}
	rep, err := h.strategyEngine.GetMinerviniPicks(account, risk)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, rep)
}

// SMCJournal returns logged trades + stats + learning insights.
func (h *Handler) SMCJournal(c *gin.Context) {
	j, err := h.strategyEngine.GetSMCJournal()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, j)
}

// SMCCloseOpens forces a check of all OPEN trades against latest bars.
func (h *Handler) SMCCloseOpens(c *gin.Context) {
	n, err := h.strategyEngine.CloseOpenSMCTrades()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"closed": n})
}

// SMCEvents returns 5-min Nifty bars with sweep markers, FVG zones and active signal
// for chart rendering.
func (h *Handler) SMCEvents(c *gin.Context) {
	bars := 100
	if b, err := strconv.Atoi(c.Query("bars")); err == nil && b > 30 && b <= 500 {
		bars = b
	}
	tf := c.Query("timeframe")
	if tf != "5m" && tf != "15m" {
		tf = "5m"
	}
	evt, err := h.strategyEngine.NiftySMCEvents(bars, tf)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, evt)
}

// SMCSignal returns the live SMC sweep+FVG signal (87.5% backtested).
// Optional query params: ?account=100000&risk=1.0
func (h *Handler) SMCSignal(c *gin.Context) {
	account := 100000.0
	risk := 1.0
	if a, err := strconv.ParseFloat(c.Query("account"), 64); err == nil && a > 0 {
		account = a
	}
	if r, err := strconv.ParseFloat(c.Query("risk"), 64); err == nil && r > 0 {
		risk = r
	}
	sig, err := h.strategyEngine.NiftySMCSignalWithRisk(account, risk)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, sig)
}

// SMCBacktest runs the SMC backtest over N years.
func (h *Handler) SMCBacktest(c *gin.Context) {
	years := 1
	if y, err := strconv.Atoi(c.Query("years")); err == nil && y > 0 && y <= 5 {
		years = y
	}
	result, err := h.strategyEngine.NiftySMCBacktest(years)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"result":       result,
		"period_years": years,
		"generated_at": time.Now().Format(time.RFC3339),
	})
}

// OptionsSignal returns the live 5-factor Nifty options signal (CE/PE/WAIT).
func (h *Handler) OptionsSignal(c *gin.Context) {
	sig, err := h.strategyEngine.NiftyOptionsSignal()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, sig)
}

// OptionsBacktest runs the 5-factor backtest over 1–5 years of Nifty data.
func (h *Handler) OptionsBacktest(c *gin.Context) {
	years := 3
	if y, err := strconv.Atoi(c.Query("years")); err == nil && y > 0 && y <= 5 {
		years = y
	}
	result, err := h.strategyEngine.NiftyOptionsBacktest(years)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"result":       result,
		"period_years": years,
		"generated_at": time.Now().Format(time.RFC3339),
	})
}

// CPRSignal returns the live CPR signal for ^NSEI with all pivot levels and trade setup.
// Modes: NARROW_BREAKOUT (trending day), CPR_BOUNCE (support/resistance), WIDE_RANGE (range day).
func (h *Handler) CPRSignal(c *gin.Context) {
	sig, err := h.strategyEngine.GetCPRSignal()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, sig)
}

// CPRMultiTimeframe returns Daily, Weekly, and Monthly CPR levels + live signal + confluence bias.
func (h *Handler) CPRMultiTimeframe(c *gin.Context) {
	sig, err := h.strategyEngine.GetCPRMultiTimeframe()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, sig)
}

// CPRBacktest runs the CPR combined backtest over 1–5 years of Nifty data.
// Returns overall win rate + per-mode breakdown (narrow/bounce/wide).
// Query param: ?years=3 (default 3)
func (h *Handler) CPRBacktest(c *gin.Context) {
	years := 3
	if y, err := strconv.Atoi(c.Query("years")); err == nil && y > 0 && y <= 5 {
		years = y
	}
	result, err := h.strategyEngine.CPRBacktest(years)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"result":       result,
		"period_years": years,
		"generated_at": time.Now().Format(time.RFC3339),
	})
}

// ICTSMCEvents returns annotated intraday bars for the ICT+SMC chart.
// Query params: ?bars=120&timeframe=5m|15m
func (h *Handler) ICTSMCEvents(c *gin.Context) {
	bars := 120
	if b, err := strconv.Atoi(c.Query("bars")); err == nil && b > 30 && b <= 500 {
		bars = b
	}
	tf := c.Query("timeframe")
	if tf != "5m" && tf != "15m" {
		tf = "5m"
	}
	evt, err := h.strategyEngine.GetICTSMCEvents(bars, tf)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, evt)
}

// ICTSMCSignal returns the live combined ICT+SMC signal for Nifty.
func (h *Handler) ICTSMCSignal(c *gin.Context) {
	sig, err := h.strategyEngine.GetICTSMCSignal()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, sig)
}

// ICTSMCBacktest runs the ICT+SMC combined backtest over N years.
func (h *Handler) ICTSMCBacktest(c *gin.Context) {
	years := 3
	if y, err := strconv.Atoi(c.Query("years")); err == nil && y > 0 && y <= 5 {
		years = y
	}
	result, err := h.strategyEngine.ICTSMCBacktest(years)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"result":       result,
		"period_years": years,
		"generated_at": time.Now().Format(time.RFC3339),
	})
}

// ExpiryDaySignal returns live expiry day setups — Iron Fly, Straddle, ORB, Max Pain play.
func (h *Handler) ExpiryDaySignal(c *gin.Context) {
	sig, err := h.strategyEngine.ExpiryDaySignal()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, sig)
}

// SMCFVGVWAPBacktest runs the 3-layer SMC+FVG+VWAP multi-timeframe options backtest.
func (h *Handler) SMCFVGVWAPBacktest(c *gin.Context) {
	years := 3
	if y, err := strconv.Atoi(c.Query("years")); err == nil && y > 0 && y <= 5 {
		years = y
	}
	result, err := h.strategyEngine.RunSMCFVGVWAPBacktest(years)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, result)
}

// NiftyStrategyCards returns all 8 strategy cards with backtested data.
func (h *Handler) NiftyStrategyCards(c *gin.Context) {
	years := 3
	if y, err := strconv.Atoi(c.Query("years")); err == nil && y > 0 && y <= 5 {
		years = y
	}
	cards, err := h.strategyEngine.RunNiftyStrategyBacktest(years)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"strategies":   cards,
		"count":        len(cards),
		"period_years": years,
		"generated_at": time.Now().Format(time.RFC3339),
	})
}

// ─── Huddleston ICT Handlers ─────────────────────────────────────────────────

// HuddlestonSignal returns the live Michael Huddleston ICT signal for Nifty.
func (h *Handler) HuddlestonSignal(c *gin.Context) {
	sig, err := h.strategyEngine.GetHuddlestonSignal()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, sig)
}

// HuddlestonBacktest runs the full Huddleston backtest over configurable years.
func (h *Handler) HuddlestonBacktest(c *gin.Context) {
	years := 3
	if y, err := strconv.Atoi(c.Query("years")); err == nil && y > 0 && y <= 7 {
		years = y
	}
	res, err := h.strategyEngine.HuddlestonBacktest(years)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"result": res, "period_years": years, "generated_at": time.Now().Format(time.RFC3339)})
}

// MinerviniFullScan scans ~75 NSE stocks with Minervini SEPA + promoter integrity filter.
// This is a heavier endpoint (~30s); results include promoter holding, pledging, FII/DII trend.
func (h *Handler) MinerviniFullScan(c *gin.Context) {
	account := 100000.0
	if v, err := strconv.ParseFloat(c.Query("account"), 64); err == nil && v > 0 {
		account = v
	}
	risk := 1.25
	if v, err := strconv.ParseFloat(c.Query("risk"), 64); err == nil && v > 0 {
		risk = v
	}
	limit := 20
	if v, err := strconv.Atoi(c.Query("limit")); err == nil && v > 0 && v <= 50 {
		limit = v
	}

	report, err := h.strategyEngine.RunFullMinerviniScan(account, risk, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, report)
}
