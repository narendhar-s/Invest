package strategy

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"

	"stockwise/internal/data"
	"stockwise/internal/storage"
	"stockwise/pkg/logger"
)

// Execution modes for live calls.
const (
	ModeSignal = "signal" // emit signals only
	ModePaper  = "paper"  // simulate fills, track P&L
	ModeLive   = "live"   // place real orders via Kite
)

const (
	maxBuffer = 250 // rolling closed-candle window per symbol
	maxCalls  = 100 // recent calls retained for the UI
)

// LiveCall is a TradeCall plus execution metadata broadcast to subscribers.
type LiveCall struct {
	TradeCall
	Mode      string  `json:"mode"`
	Status    string  `json:"status"` // SIGNAL / PAPER_FILLED / ORDER_PLACED / ORDER_REJECTED
	OrderID   string  `json:"order_id,omitempty"`
	Quantity  int     `json:"quantity"`
	PaperPnL  float64 `json:"paper_pnl,omitempty"`
	Error     string  `json:"error,omitempty"`
	Timestamp string  `json:"timestamp"`
}

// LiveEngine connects the Kite ticker → candle aggregator → chosen strategy,
// emitting trade calls and executing them per the selected mode.
type LiveEngine struct {
	kite       *data.KiteClient
	ticker     *data.KiteTicker
	seedSource data.MarketDataSource
	defaultQty int
	repo       *storage.Repository // optional; persists emitted calls

	mu         sync.RWMutex
	running    bool
	strategies []LiveStrategy // one or more strategies evaluated per candle
	minAgree   int            // min strategies that must agree to emit a call
	mode       string
	symbols   []string
	timeframe string
	agg       *data.CandleAggregator
	buffers   map[string][]data.Candle
	calls     []LiveCall
	paper     *paperBook
	startedAt time.Time

	stopCh chan struct{}

	subMu sync.RWMutex
	subs  map[chan LiveCall]struct{}

	candleMu   sync.RWMutex
	candleSubs map[chan data.Candle]struct{}

	oiMu    sync.Mutex
	oiCache map[string]oiCacheEntry
}

// oiCacheEntry memoises an OI analysis per symbol to avoid hammering the Kite
// /quote endpoint on every closed candle.
type oiCacheEntry struct {
	analysis *data.OIAnalysis
	fetched  time.Time
}

// oiCacheTTL bounds how stale a cached OI analysis may be before refetch.
const oiCacheTTL = 60 * time.Second

// NewLiveEngine builds a live engine. seedSource is used to pre-fill candle
// buffers so strategies can fire without waiting for a full live window.
func NewLiveEngine(kite *data.KiteClient, ticker *data.KiteTicker, seed data.MarketDataSource, defaultQty int) *LiveEngine {
	if defaultQty <= 0 {
		defaultQty = 1
	}
	return &LiveEngine{
		kite:       kite,
		ticker:     ticker,
		seedSource: seed,
		defaultQty: defaultQty,
		subs:       make(map[chan LiveCall]struct{}),
		candleSubs: make(map[chan data.Candle]struct{}),
		oiCache:    make(map[string]oiCacheEntry),
	}
}

// SetRepository attaches a repository so emitted calls are persisted and can be
// listed by day. Safe to leave unset (persistence simply becomes a no-op).
func (e *LiveEngine) SetRepository(repo *storage.Repository) {
	e.mu.Lock()
	e.repo = repo
	e.mu.Unlock()
}

// LiveStatus is the snapshot returned to the UI.
type LiveStatus struct {
	Running    bool       `json:"running"`
	Strategy   string     `json:"strategy"`    // primary strategy (back-compat)
	Strategies []string   `json:"strategies"`  // all selected strategy keys
	MinAgree   int        `json:"min_agree"`   // consensus threshold
	Mode       string     `json:"mode"`
	Timeframe  string     `json:"timeframe"`
	Symbols    []string   `json:"symbols"`
	StartedAt  string     `json:"started_at,omitempty"`
	PaperPnL   float64    `json:"paper_pnl"`
	RecentCall []LiveCall `json:"recent_calls"`
}

// Status returns the current engine state.
func (e *LiveEngine) Status() LiveStatus {
	e.mu.RLock()
	defer e.mu.RUnlock()
	st := LiveStatus{
		Running:   e.running,
		Mode:      e.mode,
		Timeframe: e.timeframe,
		Symbols:   e.symbols,
		MinAgree:  e.minAgree,
	}
	for _, s := range e.strategies {
		st.Strategies = append(st.Strategies, s.Key())
	}
	if len(e.strategies) > 0 {
		st.Strategy = e.strategies[0].Key()
	}
	if !e.startedAt.IsZero() {
		st.StartedAt = e.startedAt.Format(time.RFC3339)
	}
	if e.paper != nil {
		st.PaperPnL = e.paper.realizedPnL()
	}
	st.RecentCall = append([]LiveCall(nil), e.calls...)
	return st
}

// Subscribe returns a channel receiving every new LiveCall.
func (e *LiveEngine) Subscribe() chan LiveCall {
	ch := make(chan LiveCall, 64)
	e.subMu.Lock()
	e.subs[ch] = struct{}{}
	e.subMu.Unlock()
	return ch
}

// Unsubscribe removes and closes a subscriber channel.
func (e *LiveEngine) Unsubscribe(ch chan LiveCall) {
	e.subMu.Lock()
	if _, ok := e.subs[ch]; ok {
		delete(e.subs, ch)
		close(ch)
	}
	e.subMu.Unlock()
}

// Start begins live evaluation with the chosen strategies, mode, symbols and
// timeframe. When more than one strategy is selected, a call is emitted only
// when at least minAgree of them agree on the same symbol + direction within a
// closed candle. It is idempotent: an already-running engine is stopped first.
func (e *LiveEngine) Start(strategyKeys []string, minAgree int, mode string, symbols []string, timeframe string) error {
	if len(strategyKeys) == 0 {
		return errUnknownStrategy("")
	}
	strats := make([]LiveStrategy, 0, len(strategyKeys))
	seen := make(map[string]struct{})
	for _, key := range strategyKeys {
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		s, ok := Registry()[key]
		if !ok {
			return errUnknownStrategy(key)
		}
		strats = append(strats, s)
	}
	// Clamp the consensus threshold to [1, len(strats)].
	if minAgree < 1 {
		minAgree = 1
	}
	if minAgree > len(strats) {
		minAgree = len(strats)
	}
	if mode != ModeSignal && mode != ModePaper && mode != ModeLive {
		mode = ModeSignal
	}
	if timeframe == "" {
		timeframe = "5m"
	}
	if e.IsRunning() {
		e.Stop()
	}

	logger.Info("live start: resolving symbols (loading instruments)",
		zap.Strings("symbols", symbols), zap.String("timeframe", timeframe))
	if err := e.ticker.SetSymbols(symbols); err != nil {
		logger.Warn("live start failed: SetSymbols/LoadInstruments error", zap.Error(err))
		return err
	}
	logger.Info("live start: symbols resolved, starting engine")

	agg := data.NewCandleAggregator(timeframe)
	e.ticker.OnTick(agg.AddTick)

	e.mu.Lock()
	e.running = true
	e.strategies = strats
	e.minAgree = minAgree
	e.mode = mode
	e.symbols = symbols
	e.timeframe = timeframe
	e.agg = agg
	e.buffers = make(map[string][]data.Candle)
	e.calls = e.loadTodaysCalls()
	e.paper = newPaperBook()
	e.startedAt = time.Now()
	e.stopCh = make(chan struct{})
	stopCh := e.stopCh
	e.mu.Unlock()

	// Seed historical bars in the background. Seeding hits Zerodha/Yahoo per
	// symbol (each up to ~45s on a slow upstream), so doing it inline blocked the
	// /live/start response past the UI's 30s timeout and surfaced as "failed to
	// start". The engine starts immediately and strategies warm up as the seed
	// fills in (and from live candles meanwhile).
	go e.seedBuffers(symbols, timeframe)

	candleCh := agg.Subscribe()
	e.ticker.Start()

	go e.consume(candleCh, stopCh)
	go e.sweepLoop(agg, stopCh)
	go e.liveCandleLoop(agg, stopCh)

	logger.Info("live engine started",
		zap.Strings("strategies", strategyKeys),
		zap.Int("min_agree", minAgree),
		zap.String("mode", mode),
		zap.String("timeframe", timeframe),
		zap.Int("symbols", len(symbols)))
	return nil
}

// Stop halts evaluation and the ticker.
func (e *LiveEngine) Stop() {
	e.mu.Lock()
	if !e.running {
		e.mu.Unlock()
		return
	}
	e.running = false
	if e.stopCh != nil {
		close(e.stopCh)
	}
	e.mu.Unlock()
	e.ticker.Stop()
	logger.Info("live engine stopped")
}

// IsRunning reports engine state.
func (e *LiveEngine) IsRunning() bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.running
}

// canonicalSymbol returns the buffer key the live tick path will stamp on
// candles for an app symbol. Equities arrive from the ticker as "<SYM>.NS"
// (SymbolForToken appends the suffix) while the symbols passed to Start() are
// the bare app form ("ITC", "^NSEI"). Seeding under the raw form would orphan
// the history — live candles would land under "ITC.NS" and the buffer would
// restart cold. Round-tripping through the Kite instrument map yields the exact
// key the aggregator uses; if Kite is unavailable (or the symbol is unknown) we
// fall back to the input unchanged.
func (e *LiveEngine) canonicalSymbol(sym string) string {
	if e.kite == nil {
		return sym
	}
	if tok := e.kite.TokenForSymbol(sym); tok != 0 {
		if canon := e.kite.SymbolForToken(tok); canon != "" {
			return canon
		}
	}
	return sym
}

// seedBuffers pre-fills the candle buffers from the configured data source so
// strategies have enough history to evaluate immediately.
func (e *LiveEngine) seedBuffers(symbols []string, timeframe string) {
	if e.seedSource == nil {
		return
	}
	for _, sym := range symbols {
		bars, err := e.seedSource.IntradayBars(sym, timeframe)
		if err != nil || len(bars) == 0 {
			logger.Warn("seed: no history for symbol (strategies start cold)",
				zap.String("symbol", sym),
				zap.String("timeframe", timeframe),
				zap.Int("bars", len(bars)),
				zap.Error(err))
			continue
		}
		// Key the buffer by the symbol the live tick path will emit, so seeded
		// history and live candles share one buffer (see canonicalSymbol).
		bufKey := e.canonicalSymbol(sym)
		logger.Info("seed: buffer filled",
			zap.String("symbol", sym),
			zap.String("buffer_key", bufKey),
			zap.String("timeframe", timeframe),
			zap.Int("bars", len(bars)))
		// Use the actual fetched interval label on seeded candles, not the live
		// timeframe label. Yahoo doesn't have 3m bars so a 3m session seeds from
		// 5m data; labelling them "3m" causes ORB to compute the wrong range window.
		seedInterval := data.ActualFetchedInterval(timeframe)
		candles := make([]data.Candle, 0, len(bars))
		for _, b := range bars {
			candles = append(candles, data.Candle{
				Symbol: bufKey, Interval: seedInterval, Start: b.Time,
				Open: b.Open, High: b.High, Low: b.Low, Close: b.Close,
				Volume: b.Volume, Closed: true,
			})
		}
		if len(candles) > maxBuffer {
			candles = candles[len(candles)-maxBuffer:]
		}
		// Seeding now runs in a goroutine, so a live candle may already have
		// landed in this buffer. Only seed when it's still empty, so we never
		// clobber live candles that arrived while history was being fetched.
		e.mu.Lock()
		if len(e.buffers[bufKey]) == 0 {
			e.buffers[bufKey] = candles
		}
		e.mu.Unlock()
	}
}

func (e *LiveEngine) sweepLoop(agg *data.CandleAggregator, stopCh chan struct{}) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-stopCh:
			return
		case now := <-t.C:
			agg.Sweep(now)
		}
	}
}

func (e *LiveEngine) consume(candleCh chan data.Candle, stopCh chan struct{}) {
	for {
		select {
		case <-stopCh:
			return
		case c, ok := <-candleCh:
			if !ok {
				return
			}
			e.onClosedCandle(c)
		}
	}
}

func (e *LiveEngine) onClosedCandle(c data.Candle) {
	e.mu.Lock()
	buf := append(e.buffers[c.Symbol], c)
	if len(buf) > maxBuffer {
		buf = buf[len(buf)-maxBuffer:]
	}
	e.buffers[c.Symbol] = buf
	strats := append([]LiveStrategy(nil), e.strategies...)
	minAgree := e.minAgree
	mode := e.mode
	bufCopy := append([]data.Candle(nil), buf...)
	e.mu.Unlock()

	// Forward the closed candle to chart subscribers.
	e.broadcastCandle(c)

	if len(strats) == 0 {
		return
	}

	// Evaluate every selected strategy and group the resulting calls by
	// direction. A consensus call is emitted only when at least minAgree
	// strategies independently agree on the same direction this candle.
	byDir := map[string][]*TradeCall{}
	for _, s := range strats {
		if tc := s.Evaluate(c.Symbol, bufCopy); tc != nil {
			byDir[tc.Direction] = append(byDir[tc.Direction], tc)
		}
	}

	// Per-candle diagnostic: count only directional (BUY/SELL) fires so the
	// "fired" field matches what the consensus engine actually considers.
	// NEUTRAL signals (delta_neutral) are logged separately.
	buyN := len(byDir["BUY"])
	sellN := len(byDir["SELL"])
	neutralN := len(byDir["NEUTRAL"])
	fired := buyN + sellN
	logger.Info("candle evaluated",
		zap.String("symbol", c.Symbol),
		zap.Int("bars", len(bufCopy)),
		zap.Int("strategies", len(strats)),
		zap.Int("fired", fired),
		zap.Int("buy", buyN),
		zap.Int("sell", sellN),
		zap.Int("neutral", neutralN),
		zap.Int("min_agree", minAgree))

	call := consensusCall(c.Symbol, byDir, minAgree, len(strats))
	if call == nil {
		if fired > 0 {
			logger.Info("no consensus call",
				zap.String("symbol", c.Symbol),
				zap.Int("fired", fired),
				zap.Int("min_agree", minAgree),
				zap.String("note", "threshold not met or conflicting directions"))
		}
		return
	}

	// OI confirmation filter: gate the call on the option-chain bias. A bearish
	// chain blocks BUYs; a bullish chain blocks SELLs. Missing data never blocks.
	if oi := e.oiFor(call.Symbol); oi != nil {
		if !oi.OIConfirms(call.Direction) {
			logger.Info("call suppressed by OI filter",
				zap.String("symbol", call.Symbol),
				zap.String("direction", call.Direction),
				zap.String("oi_bias", oi.Bias),
				zap.Float64("pcr", oi.PCR))
			return
		}
		call.Reason = appendOIReason(call.Reason, oi)
	}

	e.execute(*call, mode)
}

// oiFor returns a (possibly cached) OI analysis for a symbol, or nil when OI is
// unavailable (no Kite connection, non-F&O symbol, fetch error).
func (e *LiveEngine) oiFor(symbol string) *data.OIAnalysis {
	if e.kite == nil || !e.kite.IsConnected() {
		return nil
	}
	e.oiMu.Lock()
	if ent, ok := e.oiCache[symbol]; ok && time.Since(ent.fetched) < oiCacheTTL {
		e.oiMu.Unlock()
		return ent.analysis
	}
	e.oiMu.Unlock()

	analysis, err := e.kite.OptionChainOI(symbol)
	if err != nil {
		// Cache the miss briefly so we don't retry on every candle.
		e.oiMu.Lock()
		e.oiCache[symbol] = oiCacheEntry{analysis: nil, fetched: time.Now()}
		e.oiMu.Unlock()
		return nil
	}
	e.oiMu.Lock()
	e.oiCache[symbol] = oiCacheEntry{analysis: analysis, fetched: time.Now()}
	e.oiMu.Unlock()
	return analysis
}

// consensusCall merges the per-strategy calls for one candle into a single
// trade call when at least minAgree strategies agree on the same direction.
// It returns nil when no direction reaches the threshold, or when two opposing
// directions both reach it (conflicting signal → no call).
func consensusCall(symbol string, byDir map[string][]*TradeCall, minAgree, total int) *TradeCall {
	if minAgree < 1 {
		minAgree = 1
	}

	// Only BUY and SELL participate in consensus. NEUTRAL signals (e.g.
	// delta_neutral) are informational only — including them would suppress
	// genuine BUY/SELL calls whenever both directions pass the threshold.
	bestDir := ""
	bestN := 0
	qualifying := 0
	for dir, calls := range byDir {
		if dir != "BUY" && dir != "SELL" {
			continue
		}
		if len(calls) >= minAgree {
			qualifying++
		}
		if len(calls) > bestN {
			bestN, bestDir = len(calls), dir
		}
	}
	if bestN < minAgree || qualifying > 1 {
		return nil
	}

	agreeing := byDir[bestDir]
	// Average the price/target/stop/confidence across the agreeing strategies and
	// record which strategies contributed.
	var sumPrice, sumTarget, sumStop, sumConf float64
	names := make([]string, 0, len(agreeing))
	for _, c := range agreeing {
		sumPrice += c.Price
		sumTarget += c.Target
		sumStop += c.StopLoss
		sumConf += c.Confidence
		names = append(names, c.Strategy)
	}
	n := float64(len(agreeing))
	sort.Strings(names)

	reason := fmt.Sprintf("consensus %d/%d: %s", len(agreeing), total, strings.Join(names, "+"))
	call := &TradeCall{
		Symbol:     symbol,
		Direction:  bestDir,
		Strategy:   strings.Join(names, "+"),
		Price:      sumPrice / n,
		Target:     sumTarget / n,
		StopLoss:   sumStop / n,
		Confidence: sumConf / n,
		Reason:     reason,
	}

	// Preserve the options leg when every agreeing strategy proposes the same
	// option type + action (e.g. a lone Personal Strategy call). The averaged
	// strike keeps the leg meaningful when several options strategies agree.
	optType, optAction := agreeing[0].OptionType, agreeing[0].OptionAction
	sameLeg := optType != ""
	var sumStrike float64
	for _, c := range agreeing {
		if c.OptionType != optType || c.OptionAction != optAction {
			sameLeg = false
			break
		}
		sumStrike += c.Strike
	}
	if sameLeg {
		call.OptionType = optType
		call.OptionAction = optAction
		call.Strike = sumStrike / n
	}
	return call
}

// appendOIReason annotates a call's reason with the OI bias that confirmed it.
func appendOIReason(reason string, oi *data.OIAnalysis) string {
	note := "OI " + oi.Bias + " (PCR " + strconv.FormatFloat(oi.PCR, 'f', 2, 64) + ")"
	if reason == "" {
		return note
	}
	return reason + " · " + note
}

func (e *LiveEngine) execute(call TradeCall, mode string) {
	lc := LiveCall{
		TradeCall: call,
		Mode:      mode,
		Quantity:  e.defaultQty,
		Timestamp: time.Now().Format(time.RFC3339),
	}

	switch mode {
	case ModePaper:
		pnl := e.paper.fill(call.Symbol, call.Direction, call.Price, e.defaultQty)
		lc.Status = "PAPER_FILLED"
		lc.PaperPnL = pnl
		logger.Info("paper fill",
			zap.String("symbol", call.Symbol),
			zap.String("direction", call.Direction),
			zap.String("strategy", call.Strategy),
			zap.Float64("price", call.Price),
			zap.Float64("pnl", pnl),
			zap.String("reason", call.Reason))
	case ModeLive:
		if e.kite == nil || !e.kite.IsConnected() {
			lc.Status = "ORDER_REJECTED"
			lc.Error = "zerodha not connected"
			break
		}

		order := data.OrderRequest{
			Symbol:          call.Symbol,
			TransactionType: call.Direction,
			Quantity:        e.defaultQty,
			Product:         "MIS",
			OrderType:       "MARKET",
		}
		orderSym := call.Symbol

		// Options strategies carry an option leg: resolve it to a concrete
		// contract and trade that instrument with the option's buy/sell action.
		if call.OptionType != "" {
			leg, err := e.kite.ResolveOption(call.Symbol, call.OptionType, call.Strike)
			if err != nil {
				lc.Status = "ORDER_REJECTED"
				lc.Error = "option resolve: " + err.Error()
				logger.Warn("option resolve failed",
					zap.String("symbol", call.Symbol),
					zap.String("opt_type", call.OptionType),
					zap.Float64("strike", call.Strike),
					zap.Error(err))
				break
			}
			lots := e.defaultQty
			if lots < 1 {
				lots = 1
			}
			qty := lots
			if leg.LotSize > 0 {
				qty = lots * leg.LotSize
			}
			order.Symbol = leg.TradingSymbol
			order.Exchange = leg.Exchange
			order.TransactionType = call.OptionAction // BUY / SELL the premium
			order.Quantity = qty
			lc.Quantity = qty
			orderSym = leg.TradingSymbol
		}

		orderID, err := e.kite.PlaceOrder(order)
		if err != nil {
			lc.Status = "ORDER_REJECTED"
			lc.Error = err.Error()
			logger.Warn("live order rejected", zap.String("symbol", orderSym), zap.Error(err))
		} else {
			lc.Status = "ORDER_PLACED"
			lc.OrderID = orderID
		}
	default: // ModeSignal
		lc.Status = "SIGNAL"
		logger.Info("signal emitted",
			zap.String("symbol", call.Symbol),
			zap.String("direction", call.Direction),
			zap.String("strategy", call.Strategy),
			zap.Float64("price", call.Price),
			zap.String("reason", call.Reason))
	}

	e.mu.Lock()
	e.calls = append(e.calls, lc)
	if len(e.calls) > maxCalls {
		e.calls = e.calls[len(e.calls)-maxCalls:]
	}
	repo := e.repo
	e.mu.Unlock()

	e.persistCall(repo, lc)
	e.broadcast(lc)
}

// persistCall writes an emitted call to the DB. Failures are logged, never
// fatal — the in-memory list and broadcast still work without persistence.
func (e *LiveEngine) persistCall(repo *storage.Repository, lc LiveCall) {
	if repo == nil {
		return
	}
	calledAt, err := time.Parse(time.RFC3339, lc.Timestamp)
	if err != nil {
		calledAt = time.Now()
	}
	rec := &storage.LiveCallRecord{
		CalledAt:   calledAt,
		Symbol:     lc.Symbol,
		Direction:  lc.Direction,
		Strategy:   lc.Strategy,
		Price:      lc.Price,
		Target:     lc.Target,
		StopLoss:   lc.StopLoss,
		Confidence: lc.Confidence,
		Reason:     lc.Reason,
		Mode:       lc.Mode,
		Status:     lc.Status,
		OrderID:    lc.OrderID,
		Quantity:   lc.Quantity,
		PaperPnL:   lc.PaperPnL,
		Error:      lc.Error,
	}
	if err := repo.CreateLiveCall(rec); err != nil {
		logger.Warn("failed to persist live call", zap.String("symbol", lc.Symbol), zap.Error(err))
	}
}

// loadTodaysCalls rehydrates the in-memory call list from any calls already
// persisted for the current day, so a mid-session restart keeps the UI list.
// Caller must hold e.mu.
func (e *LiveEngine) loadTodaysCalls() []LiveCall {
	if e.repo == nil {
		return nil
	}
	recs, err := e.repo.GetLiveCallsByDate(time.Now())
	if err != nil {
		logger.Warn("failed to load today's live calls", zap.Error(err))
		return nil
	}
	calls := make([]LiveCall, 0, len(recs))
	for _, r := range recs {
		calls = append(calls, liveCallFromRecord(r))
	}
	if len(calls) > maxCalls {
		calls = calls[len(calls)-maxCalls:]
	}
	return calls
}

// liveCallFromRecord converts a persisted record back into a LiveCall.
func liveCallFromRecord(r storage.LiveCallRecord) LiveCall {
	return LiveCall{
		TradeCall: TradeCall{
			Symbol:     r.Symbol,
			Direction:  r.Direction,
			Strategy:   r.Strategy,
			Price:      r.Price,
			Target:     r.Target,
			StopLoss:   r.StopLoss,
			Confidence: r.Confidence,
			Reason:     r.Reason,
		},
		Mode:      r.Mode,
		Status:    r.Status,
		OrderID:   r.OrderID,
		Quantity:  r.Quantity,
		PaperPnL:  r.PaperPnL,
		Error:     r.Error,
		Timestamp: r.CalledAt.Format(time.RFC3339),
	}
}

func (e *LiveEngine) broadcast(lc LiveCall) {
	e.subMu.RLock()
	for ch := range e.subs {
		select {
		case ch <- lc:
		default:
		}
	}
	e.subMu.RUnlock()
}

// ─── paper book ──────────────────────────────────────────────────────────────────

type paperPos struct {
	qty int     // +long / -short
	avg float64 // average entry price
}

type paperBook struct {
	mu        sync.Mutex
	positions map[string]paperPos
	realized  float64
}

func newPaperBook() *paperBook {
	return &paperBook{positions: make(map[string]paperPos)}
}

func (b *paperBook) realizedPnL() float64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.realized
}

// fill applies a simulated market fill and returns the realized P&L from any
// position closed by this fill.
func (b *paperBook) fill(symbol, dir string, price float64, qty int) float64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	pos := b.positions[symbol]
	signed := qty
	if dir == "SELL" {
		signed = -qty
	}

	realized := 0.0
	if pos.qty != 0 && sign(pos.qty) != sign(signed) {
		closeQty := min(absInt(signed), absInt(pos.qty))
		if pos.qty > 0 {
			realized = float64(closeQty) * (price - pos.avg)
		} else {
			realized = float64(closeQty) * (pos.avg - price)
		}
		b.realized += realized
	}

	newQty := pos.qty + signed
	switch {
	case newQty == 0:
		pos = paperPos{}
	case pos.qty != 0 && sign(newQty) == sign(pos.qty):
		// adding to the same side → blend the average
		pos.avg = (pos.avg*float64(absInt(pos.qty)) + price*float64(absInt(signed))) / float64(absInt(newQty))
		pos.qty = newQty
	default:
		// opened fresh or flipped direction
		pos.avg = price
		pos.qty = newQty
	}
	b.positions[symbol] = pos
	return realized
}

func sign(n int) int {
	if n > 0 {
		return 1
	}
	if n < 0 {
		return -1
	}
	return 0
}

func absInt(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
