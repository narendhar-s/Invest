package data

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
	"golang.org/x/net/websocket"

	"stockwise/pkg/logger"
)

const (
	kiteWSURL    = "wss://ws.kite.trade"
	kiteWSOrigin = "https://kite.zerodha.com"
	// NSE equity prices arrive as paise; divide by 100 to get rupees.
	nsePriceDivisor = 100.0
)

// Tick is a normalized last-traded snapshot emitted by the websocket.
type Tick struct {
	Token     uint32    `json:"token"`
	Symbol    string    `json:"symbol"` // Yahoo-format, e.g. RELIANCE.NS
	LastPrice float64   `json:"last_price"`
	Volume    int64     `json:"volume"`
	Timestamp time.Time `json:"timestamp"`
}

// KiteTicker is a live Kite Connect WebSocket client. It subscribes to a set of
// instrument tokens in "full" mode and emits normalized ticks to a callback.
type KiteTicker struct {
	kite    *KiteClient
	apiKey  string
	mu      sync.RWMutex
	tokens  []uint32
	conn    *websocket.Conn
	running bool
	stopCh  chan struct{}
	onTick  func(Tick)
}

// NewKiteTicker builds a ticker bound to a connected KiteClient.
func NewKiteTicker(kite *KiteClient, apiKey string) *KiteTicker {
	return &KiteTicker{
		kite:   kite,
		apiKey: apiKey,
		stopCh: make(chan struct{}),
	}
}

// OnTick registers the callback invoked for every parsed tick.
func (t *KiteTicker) OnTick(fn func(Tick)) { t.onTick = fn }

// SetSymbols resolves Yahoo-format symbols to instrument tokens and stores them.
func (t *KiteTicker) SetSymbols(yahooSymbols []string) error {
	if err := t.kite.LoadInstruments(); err != nil {
		return err
	}
	tokens := make([]uint32, 0, len(yahooSymbols))
	var unresolved []string
	for _, s := range yahooSymbols {
		if tk := t.kite.TokenForSymbol(s); tk != 0 {
			tokens = append(tokens, tk)
		} else {
			unresolved = append(unresolved, s)
		}
	}
	if len(unresolved) > 0 {
		logger.Warn("kite ticker: symbols not resolved to instrument tokens (will not stream)",
			zap.Strings("symbols", unresolved))
	}
	t.mu.Lock()
	t.tokens = tokens
	t.mu.Unlock()
	return nil
}

// IsRunning reports whether the websocket loop is active.
func (t *KiteTicker) IsRunning() bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.running
}

// Start launches the connect/read loop with automatic reconnection.
func (t *KiteTicker) Start() {
	t.mu.Lock()
	if t.running {
		t.mu.Unlock()
		return
	}
	t.running = true
	t.stopCh = make(chan struct{})
	t.mu.Unlock()
	go t.runLoop()
	logger.Info("kite ticker websocket started")
}

// Stop terminates the loop and closes the connection.
func (t *KiteTicker) Stop() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.running {
		return
	}
	t.running = false
	close(t.stopCh)
	if t.conn != nil {
		t.conn.Close()
	}
}

func (t *KiteTicker) runLoop() {
	backoff := time.Second
	for {
		select {
		case <-t.stopCh:
			return
		default:
		}

		if err := t.connectAndRead(); err != nil {
			logger.Warn("kite ticker disconnected", zap.Error(err))
		}

		// Reconnect with capped exponential backoff unless stopped.
		select {
		case <-t.stopCh:
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (t *KiteTicker) connectAndRead() error {
	token := t.kite.GetAccessToken()
	if token == "" {
		return fmt.Errorf("zerodha: not authenticated")
	}

	url := fmt.Sprintf("%s?api_key=%s&access_token=%s", kiteWSURL, t.apiKey, token)
	cfg, err := websocket.NewConfig(url, kiteWSOrigin)
	if err != nil {
		return fmt.Errorf("ws config: %w", err)
	}
	conn, err := websocket.DialConfig(cfg)
	if err != nil {
		return fmt.Errorf("ws dial: %w", err)
	}
	t.mu.Lock()
	t.conn = conn
	t.mu.Unlock()
	defer conn.Close()

	if err := t.subscribe(conn); err != nil {
		return fmt.Errorf("ws subscribe: %w", err)
	}
	logger.Info("kite ticker subscribed", zap.Int("instruments", len(t.tokens)))

	for {
		select {
		case <-t.stopCh:
			return nil
		default:
		}
		var payload []byte
		if err := websocket.Message.Receive(conn, &payload); err != nil {
			return fmt.Errorf("ws read: %w", err)
		}
		// Heartbeats are 1-byte frames; ignore anything too short to hold a packet.
		if len(payload) < 2 {
			continue
		}
		t.parseBinary(payload)
	}
}

// subscribe sends the subscribe + full-mode messages as text frames.
func (t *KiteTicker) subscribe(conn *websocket.Conn) error {
	t.mu.RLock()
	tokens := make([]uint32, len(t.tokens))
	copy(tokens, t.tokens)
	t.mu.RUnlock()
	if len(tokens) == 0 {
		return fmt.Errorf("no instrument tokens to subscribe")
	}

	sub := map[string]interface{}{"a": "subscribe", "v": tokens}
	if b, err := json.Marshal(sub); err == nil {
		if err := websocket.Message.Send(conn, string(b)); err != nil {
			return err
		}
	}
	mode := map[string]interface{}{"a": "mode", "v": []interface{}{"full", tokens}}
	b, err := json.Marshal(mode)
	if err != nil {
		return err
	}
	return websocket.Message.Send(conn, string(b))
}

// parseBinary decodes a Kite binary market-data frame into ticks.
//
// Frame: [int16 numPackets][ {int16 len}{len bytes} ... ]
// Packet (LTP=8B, quote=44B, full=184B); first fields are big-endian int32:
//   [0:4] instrument_token  [4:8] last_traded_price  [16:20] volume_traded
func (t *KiteTicker) parseBinary(b []byte) {
	if len(b) < 2 {
		return
	}
	numPackets := int(binary.BigEndian.Uint16(b[0:2]))
	offset := 2
	for i := 0; i < numPackets; i++ {
		if offset+2 > len(b) {
			return
		}
		plen := int(binary.BigEndian.Uint16(b[offset : offset+2]))
		offset += 2
		if offset+plen > len(b) || plen < 8 {
			return
		}
		pkt := b[offset : offset+plen]
		offset += plen

		token := binary.BigEndian.Uint32(pkt[0:4])
		ltp := float64(int32(binary.BigEndian.Uint32(pkt[4:8]))) / nsePriceDivisor
		var vol int64
		if plen >= 20 {
			vol = int64(int32(binary.BigEndian.Uint32(pkt[16:20])))
		}

		tick := Tick{
			Token:     token,
			Symbol:    t.kite.SymbolForToken(token),
			LastPrice: ltp,
			Volume:    vol,
			Timestamp: time.Now(),
		}
		if t.onTick != nil && tick.LastPrice > 0 {
			t.onTick(tick)
		}
	}
}
