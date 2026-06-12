package api

// Angel One SmartAPI handlers
// Routes:
//   GET  /api/v1/ao/status        — connection status + auth state
//   GET  /api/v1/ao/candles       — historical 5-min NIFTY candles
//   GET  /api/v1/ao/quote         — live LTP for NIFTY/BANKNIFTY
//   GET  /api/v1/ao/optionchain   — live option chain
//   GET  /api/v1/ao/ws            — WebSocket: streams live candle updates

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"time"

	"stockwise/internal/naren/angelone"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

var wsUpgrader = websocket.Upgrader{
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
}

// ─── Service (singleton, started once) ──────────────────────────────────────

type AngelOneService struct {
	mu     sync.Mutex
	client *angelone.Client
	stream *angelone.StreamClient
	agg    *angelone.CandleAggregator
	subs   map[*wsConn]struct{}
	subMu  sync.RWMutex
	logger *zap.Logger
	started bool
}

type wsConn struct {
	conn *websocket.Conn
	send chan []byte
	done chan struct{}
}

var aoService *AngelOneService

// InitAngelOne must be called once from router setup if Angel One is configured.
func InitAngelOne(cfg angelone.Config, logger *zap.Logger) {
	if !cfg.Enabled || cfg.APIKey == "" {
		logger.Info("angel one: disabled (no credentials in config)")
		return
	}
	client := angelone.NewClient(cfg)
	agg := angelone.NewCandleAggregator(5*time.Minute, 600) // keep 600 bars (~50 hours)

	stream := angelone.NewStreamClient(client, []string{
		angelone.TokenNIFTY,
		angelone.TokenBANKNIFTY,
	}, logger)

	svc := &AngelOneService{
		client: client,
		stream: stream,
		agg:    agg,
		subs:   make(map[*wsConn]struct{}),
		logger: logger,
	}

	// Wire tick → aggregator
	stream.OnTick(func(t angelone.Tick) {
		agg.AddTick(t)
	})

	// Wire aggregator → WebSocket subscribers
	agg.Subscribe(func(u angelone.CandleUpdate) {
		msg, _ := json.Marshal(map[string]interface{}{
			"type":  "candle",
			"token": u.Token,
			"final": u.Final,
			"bar": map[string]interface{}{
				"time":   u.Candle.Time.UnixMilli(),
				"open":   u.Candle.Open,
				"high":   u.Candle.High,
				"low":    u.Candle.Low,
				"close":  u.Candle.Close,
				"volume": u.Candle.Volume,
				"ticks":  u.Candle.Ticks,
			},
		})
		svc.broadcast(msg)
	})

	aoService = svc

	// Start SmartStream in background
	stream.Start(context.Background())
	logger.Info("angel one: SmartStream started", zap.Strings("tokens", []string{angelone.TokenNIFTY, angelone.TokenBANKNIFTY}))

	// Quote poller — polls REST quote API every 2s as reliable real-time feed.
	// Feeds the aggregator with LTP ticks, same as SmartStream would.
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			q, err := svc.client.FetchQuote(angelone.ExchangeNSE, angelone.TokenNIFTY)
			if err != nil || q.LTP <= 0 {
				continue
			}
			t := angelone.Tick{
				Token:  angelone.TokenNIFTY,
				Time:   time.Now(),
				LTP:    q.LTP,
				Open:   q.Open,
				High:   q.High,
				Low:    q.Low,
				Close:  q.Close,
				Volume: q.Volume,
			}
			svc.agg.AddTick(t)

			// Also push raw quote to WS subscribers
			msg, _ := json.Marshal(map[string]interface{}{
				"type":   "quote",
				"token":  angelone.TokenNIFTY,
				"symbol": "NIFTY",
				"ltp":    q.LTP,
				"open":   q.Open,
				"high":   q.High,
				"low":    q.Low,
				"close":  q.Close,
			})
			svc.broadcast(msg)
		}
	}()
}

func (s *AngelOneService) broadcast(msg []byte) {
	s.subMu.RLock()
	defer s.subMu.RUnlock()
	for c := range s.subs {
		select {
		case c.send <- msg:
		default:
			// drop if slow consumer
		}
	}
}

func (s *AngelOneService) addSub(c *wsConn) {
	s.subMu.Lock()
	s.subs[c] = struct{}{}
	s.subMu.Unlock()
}

func (s *AngelOneService) removeSub(c *wsConn) {
	s.subMu.Lock()
	delete(s.subs, c)
	s.subMu.Unlock()
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

// AOStatus returns Angel One connection status.
func AOStatus(c *gin.Context) {
	if aoService == nil {
		c.JSON(200, gin.H{
			"enabled": false,
			"message": "Angel One not configured. Add credentials to config.yaml → angel_one section.",
			"setup_url": "https://smartapi.angelbroking.com",
		})
		return
	}
	c.JSON(200, gin.H{
		"enabled":    true,
		"connected":  true,
		"feed_token": aoService.client.FeedToken() != "",
		"message":    "Angel One SmartStream active — real-time data flowing",
	})
}

// AOCandles returns NIFTY candles from Angel One Futures (primary data source).
// Query params:
//   - timeframe: "5m" | "15m" | "1h" | "1d"  (default "5m")
//   - days:      how many calendar days back    (default 30, max 365)
func AOCandles(c *gin.Context) {
	if aoService == nil {
		c.JSON(503, gin.H{"error": "Angel One not configured"})
		return
	}

	tf := c.DefaultQuery("timeframe", "5m")
	if tf != "5m" && tf != "15m" && tf != "1h" && tf != "1d" {
		tf = "5m"
	}
	days, _ := strconv.Atoi(c.DefaultQuery("days", "30"))
	if days < 1 || days > 365 {
		days = 30
	}

	candles, err := aoService.client.FetchNIFTY(tf, days)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Convert to same format as existing /nifty/chart-data for drop-in compatibility
	type Bar struct {
		Date     string  `json:"date"`
		UnixTime int64   `json:"unix_time"`
		Open     float64 `json:"open"`
		High     float64 `json:"high"`
		Low      float64 `json:"low"`
		Close    float64 `json:"close"`
		Volume   int64   `json:"volume"`
	}
	bars := make([]Bar, 0, len(candles))
	ist := time.FixedZone("IST", 5*3600+30*60)
	for _, can := range candles {
		t := can.Time.In(ist)
		bars = append(bars, Bar{
			Date:     t.Format("2006-01-02 15:04"),
			UnixTime: can.Time.Unix(),
			Open:     can.Open,
			High:     can.High,
			Low:      can.Low,
			Close:    can.Close,
			Volume:   can.Volume,
		})
	}

	// Also include current live bar if we have one
	if live := aoService.agg.Current(angelone.TokenNIFTY); live != nil && live.Ticks > 0 {
		t := live.Time.In(ist)
		bars = append(bars, Bar{
			Date:     t.Format("2006-01-02 15:04") + " *",
			UnixTime: live.Time.Unix(),
			Open:     live.Open,
			High:     live.High,
			Low:      live.Low,
			Close:    live.Close,
			Volume:   live.Volume,
		})
	}

	c.JSON(200, gin.H{
		"source": "angel_one",
		"bars":   bars,
		"count":  len(bars),
	})
}

// AOQuote returns the live LTP for NIFTY or BANKNIFTY.
func AOQuote(c *gin.Context) {
	if aoService == nil {
		c.JSON(503, gin.H{"error": "Angel One not configured"})
		return
	}

	symbol := c.DefaultQuery("symbol", "NIFTY")
	token := angelone.TokenNIFTY
	if symbol == "BANKNIFTY" {
		token = angelone.TokenBANKNIFTY
	}

	quote, err := aoService.client.FetchQuote(angelone.ExchangeNSE, token)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{
		"source": "angel_one",
		"symbol": symbol,
		"token":  token,
		"quote":  quote,
	})
}

// AOOptionChain returns the live option chain for NIFTY.
func AOOptionChain(c *gin.Context) {
	if aoService == nil {
		c.JSON(503, gin.H{"error": "Angel One not configured"})
		return
	}

	expiry := c.DefaultQuery("expiry", nearestExpiry())
	strikes, _ := strconv.Atoi(c.DefaultQuery("strikes", "10"))
	if strikes < 5 || strikes > 20 {
		strikes = 10
	}

	chain, err := aoService.client.FetchOptionChain(expiry, strikes)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"source": "angel_one", "chain": chain})
}

// AOWebSocket upgrades to a WebSocket and streams live candle updates.
// Messages are JSON: { type:"candle", token:"26000", final:bool, bar:{...} }
func AOWebSocket(c *gin.Context) {
	if aoService == nil {
		c.JSON(503, gin.H{"error": "Angel One not configured"})
		return
	}

	conn, err := wsUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		aoService.logger.Warn("ao ws upgrade failed", zap.Error(err))
		return
	}

	wsc := &wsConn{
		conn: conn,
		send: make(chan []byte, 64),
		done: make(chan struct{}),
	}
	aoService.addSub(wsc)
	defer func() {
		aoService.removeSub(wsc)
		conn.Close()
		close(wsc.done)
	}()

	// Send current history on connect
	hist := aoService.agg.History(angelone.TokenNIFTY)
	if len(hist) > 0 {
		init, _ := json.Marshal(map[string]interface{}{
			"type":   "history",
			"token":  angelone.TokenNIFTY,
			"candles": hist,
		})
		_ = conn.WriteMessage(websocket.TextMessage, init)
	}

	// Write pump
	go func() {
		for {
			select {
			case msg, ok := <-wsc.send:
				if !ok {
					return
				}
				_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
				if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
					return
				}
			case <-wsc.done:
				return
			}
		}
	}()

	// Read pump (just handle pings/disconnects)
	conn.SetReadLimit(512)
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

// nearestExpiry returns the current week's NIFTY expiry in "DDMMMYYYY" format (Angel One format).
// NIFTY weekly expiry moved to Tuesday from June 2026.
func nearestExpiry() string {
	ist := time.FixedZone("IST", 5*3600+30*60)
	now := time.Now().In(ist)
	days := (int(time.Tuesday) - int(now.Weekday()) + 7) % 7
	if days == 0 && now.Hour() >= 15 {
		days = 7
	}
	expiry := now.AddDate(0, 0, days)
	return expiry.Format("02Jan2006")
}
