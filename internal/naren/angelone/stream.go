package angelone

// SmartStream v2 — WebSocket tick feed from Angel One
// Docs: https://smartapi.angelbroking.com/docs#streaming
//
// Flow:
//   Connect → Authenticate → Subscribe (NIFTY token 26000)
//   → Receive binary ticks → Parse LTP → Aggregate into 5-min candles

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

const (
	smartStreamURL = "wss://smartapisocket.angelone.in/smart-stream"

	// Subscription modes
	ModeLTP        = 1 // 51 bytes: just last trade price
	ModeQuote      = 2 // 123 bytes: bid/ask + OHLC
	ModeSnapQuote  = 3 // 459 bytes: full depth

	// Exchange type for NSE CM (cash market / index)
	ExchangeTypeNSECM = 1
)

// Tick is a single price update from SmartStream.
type Tick struct {
	Token    string
	Exchange int
	Time     time.Time
	LTP      float64 // last trade price
	Open     float64
	High     float64
	Low      float64
	Close    float64 // previous close
	Volume   int64
}

// TickHandler is called for every tick received.
type TickHandler func(Tick)

// StreamClient manages the SmartStream WebSocket connection.
type StreamClient struct {
	client   *Client
	handlers []TickHandler
	mu       sync.RWMutex
	conn     *websocket.Conn
	cancel   context.CancelFunc
	logger   *zap.Logger
	tokens   []string // token IDs to subscribe (e.g. ["26000"])
}

// NewStreamClient creates a new SmartStream client.
func NewStreamClient(client *Client, tokens []string, logger *zap.Logger) *StreamClient {
	return &StreamClient{
		client: client,
		tokens: tokens,
		logger: logger,
	}
}

// OnTick registers a tick handler. Safe to call before Start.
func (s *StreamClient) OnTick(h TickHandler) {
	s.mu.Lock()
	s.handlers = append(s.handlers, h)
	s.mu.Unlock()
}

// Start connects to SmartStream and starts receiving ticks.
// Reconnects automatically on disconnect. Call Stop to shut down.
func (s *StreamClient) Start(ctx context.Context) {
	ctx, s.cancel = context.WithCancel(ctx)
	go s.loop(ctx)
}

// Stop gracefully disconnects from SmartStream.
func (s *StreamClient) Stop() {
	if s.cancel != nil {
		s.cancel()
	}
	s.mu.Lock()
	if s.conn != nil {
		_ = s.conn.Close()
	}
	s.mu.Unlock()
}

func (s *StreamClient) loop(ctx context.Context) {
	backoff := time.Second
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		if err := s.client.EnsureAuth(); err != nil {
			s.logger.Warn("angelone stream: auth failed", zap.Error(err))
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
				backoff = min(backoff*2, 60*time.Second)
				continue
			}
		}

		if err := s.connect(ctx); err != nil {
			s.logger.Warn("angelone stream: disconnected", zap.Error(err))
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
			backoff = min(backoff*2, 30*time.Second)
		}
	}
}

func (s *StreamClient) connect(ctx context.Context) error {
	headers := map[string][]string{
		"Authorization": {s.client.JWTToken()},
		"x-api-key":     {s.client.APIKey()},
		"x-client-code": {s.client.cfg.ClientID},
		"x-feed-token":  {s.client.FeedToken()},
	}

	conn, _, err := websocket.DefaultDialer.DialContext(ctx, smartStreamURL, headers)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	s.mu.Lock()
	s.conn = conn
	s.mu.Unlock()

	s.logger.Info("angelone stream: connected to SmartStream")

	// Handle server pings
	conn.SetPingHandler(func(appData string) error {
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		return conn.WriteMessage(websocket.PongMessage, []byte(appData))
	})

	// Subscribe to tokens
	if err := s.subscribe(conn); err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}

	// Client-side heartbeat — Angel One requires a ping every 25s
	// Format: { "action": 0 } or just a WebSocket ping frame
	heartbeatTicker := time.NewTicker(25 * time.Second)
	defer heartbeatTicker.Stop()

	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-heartbeatTicker.C:
				_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
				// Angel One SmartStream heartbeat — send ping frame
				if err := conn.WriteMessage(websocket.PingMessage, []byte("ping")); err != nil {
					return
				}
			}
		}
	}()

	// Read loop — extend deadline on every message
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		msgType, data, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		// Reset deadline after every successful read
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		if msgType == websocket.BinaryMessage {
			if tick, err := parseBinary(data); err == nil {
				s.dispatch(tick)
			} else {
				s.logger.Debug("angelone: parse tick", zap.Error(err), zap.Int("len", len(data)))
			}
		} else if msgType == websocket.TextMessage {
			s.logger.Debug("angelone stream: text msg", zap.String("data", string(data)))
		}
	}
}

func (s *StreamClient) subscribe(conn *websocket.Conn) error {
	tokenList := make([]map[string]interface{}, 0, len(s.tokens))
	for _, tok := range s.tokens {
		tokenList = append(tokenList, map[string]interface{}{
			"exchangeType": ExchangeTypeNSECM,
			"tokens":       []string{tok},
		})
	}

	// Try LTP mode first (mode 1) — simplest, most reliable for indices
	msg, _ := json.Marshal(map[string]interface{}{
		"correlationID": "scalping_lab",
		"action":        1, // 1 = subscribe
		"params": map[string]interface{}{
			"mode":      ModeLTP, // mode 1: LTP only (51 bytes)
			"tokenList": tokenList,
		},
	})
	s.logger.Debug("angelone: subscribing", zap.String("msg", string(msg)))
	return conn.WriteMessage(websocket.TextMessage, msg)
}

func (s *StreamClient) dispatch(t Tick) {
	s.mu.RLock()
	hs := s.handlers
	s.mu.RUnlock()
	for _, h := range hs {
		h(t)
	}
}

// ─── Binary Protocol Parser ───────────────────────────────────────────────────
//
// SmartStream v2 binary frame layout (mode 2 = Quote, 123 bytes):
//   [0]      subscription mode (1 byte)
//   [1]      exchange type     (1 byte)
//   [2..26]  token             (25 bytes, null-padded ASCII)
//   [27..30] sequence number   (4 bytes, big-endian)
//   [31..38] exchange time     (8 bytes, big-endian, epoch ms)
//   [39..46] LTP               (8 bytes, big-endian, value × 100)
//   [47..54] last traded qty   (8 bytes, big-endian)
//   [55..62] avg traded price  (8 bytes, big-endian, × 100)
//   [63..70] volume            (8 bytes, big-endian)
//   [71..78] total buy qty     (8 bytes, big-endian)
//   [79..86] total sell qty    (8 bytes, big-endian)
//   [87..94] open              (8 bytes, big-endian, × 100)
//   [95..102] high             (8 bytes, big-endian, × 100)
//   [103..110] low             (8 bytes, big-endian, × 100)
//   [111..118] close           (8 bytes, big-endian, × 100)
//   [119..122] change pct      (4 bytes, big-endian)

func parseBinary(data []byte) (Tick, error) {
	if len(data) < 51 {
		return Tick{}, fmt.Errorf("frame too short: %d bytes", len(data))
	}

	mode := int(data[0])
	exchangeType := int(data[1])

	// Token: bytes 2..26, null-terminated
	tokenBytes := data[2:27]
	tokenEnd := 25
	for i, b := range tokenBytes {
		if b == 0 {
			tokenEnd = i
			break
		}
	}
	token := string(tokenBytes[:tokenEnd])

	// Exchange timestamp
	var tsMs int64
	if len(data) >= 39 {
		tsMs = int64(binary.BigEndian.Uint64(data[31:39]))
	}
	ts := time.UnixMilli(tsMs)

	// LTP (always at offset 39, both mode 1 and 2)
	ltp := float64(binary.BigEndian.Uint64(data[39:47])) / 100.0

	tick := Tick{
		Token:    token,
		Exchange: exchangeType,
		Time:     ts,
		LTP:      ltp,
	}

	// Mode 2 (Quote) has OHLC at offsets 87..118
	if mode == ModeQuote && len(data) >= 119 {
		tick.Open  = float64(binary.BigEndian.Uint64(data[87:95]))  / 100.0
		tick.High  = float64(binary.BigEndian.Uint64(data[95:103])) / 100.0
		tick.Low   = float64(binary.BigEndian.Uint64(data[103:111]))/ 100.0
		tick.Close = float64(binary.BigEndian.Uint64(data[111:119]))/ 100.0
		tick.Volume = int64(binary.BigEndian.Uint64(data[63:71]))
	}

	// Sanity check: price must be positive and reasonable
	if tick.LTP <= 0 || math.IsNaN(tick.LTP) || math.IsInf(tick.LTP, 0) {
		return Tick{}, fmt.Errorf("invalid LTP: %f", tick.LTP)
	}

	return tick, nil
}

func min(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
