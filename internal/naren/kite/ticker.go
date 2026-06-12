package kite

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ─── Tick ─────────────────────────────────────────────────────────────────────

// Tick is a real-time price update from the Kite WebSocket.
type Tick struct {
	InstrumentToken uint32
	LastPrice       float64
	High            float64
	Low             float64
	Open            float64
	Close           float64
	Volume          uint32
	OI              uint32
	Timestamp       time.Time
}

// TickHandler is called on every incoming tick.
type TickHandler func(ticks []Tick)

// ─── Ticker ───────────────────────────────────────────────────────────────────

// Ticker maintains a persistent Kite WebSocket connection with auto-reconnect.
// It streams real-time LTP + OHLC for subscribed instrument tokens.
type Ticker struct {
	mu      sync.RWMutex
	client  *Client
	conn    *websocket.Conn
	tokens  []uint32
	handler TickHandler
	latestP map[uint32]float64 // instrument_token → latest price cache

	running bool
	stopCh  chan struct{}
}

// NewTicker creates a Ticker. Call Subscribe + Start to begin streaming.
func NewTicker(c *Client) *Ticker {
	return &Ticker{client: c, latestP: map[uint32]float64{}}
}

// Subscribe replaces the token subscription list.
// Can be called at any time; the change is sent to the server immediately.
func (t *Ticker) Subscribe(tokens ...uint32) {
	t.mu.Lock()
	t.tokens = tokens
	conn := t.conn
	t.mu.Unlock()
	if conn != nil {
		_ = t.sendSubscribe(conn, tokens)
	}
}

// Price returns the latest cached LTP for a token (0 if not yet received).
func (t *Ticker) Price(token uint32) float64 {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.latestP[token]
}

// OnTick sets the callback invoked on every tick batch.
func (t *Ticker) OnTick(fn TickHandler) { t.mu.Lock(); t.handler = fn; t.mu.Unlock() }

// Start begins the WebSocket connection loop with auto-reconnect.
func (t *Ticker) Start() {
	t.mu.Lock()
	if t.running { t.mu.Unlock(); return }
	t.running = true
	t.stopCh = make(chan struct{})
	stop := t.stopCh
	t.mu.Unlock()
	go t.loop(stop)
}

// Stop disconnects and terminates the loop.
func (t *Ticker) Stop() {
	t.mu.Lock(); defer t.mu.Unlock()
	if !t.running { return }
	t.running = false; close(t.stopCh)
	if t.conn != nil { _ = t.conn.Close() }
}

// ─── Internal loop ────────────────────────────────────────────────────────────

func (t *Ticker) loop(stop chan struct{}) {
	backoff := 2 * time.Second
	for {
		select {
		case <-stop:
			return
		default:
		}
		if !t.client.IsConnected() {
			time.Sleep(5 * time.Second)
			continue
		}
		if err := t.connect(); err != nil {
			time.Sleep(backoff)
			if backoff < 60*time.Second { backoff *= 2 }
			continue
		}
		backoff = 2 * time.Second
		t.readLoop(stop)
		select {
		case <-stop:
			return
		default:
			time.Sleep(backoff)
		}
	}
}

func (t *Ticker) connect() error {
	wsURL := url.URL{
		Scheme:   "wss",
		Host:     "ws.kite.trade",
		RawQuery: fmt.Sprintf("api_key=%s&access_token=%s", t.client.apiKey, t.client.AccessToken()),
	}
	conn, _, err := websocket.DefaultDialer.Dial(wsURL.String(), nil)
	if err != nil {
		return fmt.Errorf("kite ws dial: %w", err)
	}
	t.mu.Lock()
	t.conn = conn
	tokens := t.tokens
	t.mu.Unlock()

	if len(tokens) > 0 {
		_ = t.sendSubscribe(conn, tokens)
	}
	return nil
}

func (t *Ticker) sendSubscribe(conn *websocket.Conn, tokens []uint32) error {
	// Step 1: subscribe
	sub := map[string]interface{}{"a": "subscribe", "v": tokens}
	b, _ := json.Marshal(sub)
	if err := conn.WriteMessage(websocket.TextMessage, b); err != nil {
		return err
	}
	// Step 2: set mode to "full" (includes OHLC and OI)
	mode := map[string]interface{}{"a": "mode", "v": []interface{}{"full", tokens}}
	b2, _ := json.Marshal(mode)
	return conn.WriteMessage(websocket.TextMessage, b2)
}

func (t *Ticker) readLoop(stop chan struct{}) {
	t.mu.RLock()
	conn := t.conn
	t.mu.RUnlock()
	if conn == nil { return }

	for {
		select {
		case <-stop:
			return
		default:
		}
		_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if len(msg) < 2 { continue }

		ticks := parseBinaryPackets(msg)
		if len(ticks) == 0 { continue }

		t.mu.Lock()
		for _, tick := range ticks {
			t.latestP[tick.InstrumentToken] = tick.LastPrice
		}
		handler := t.handler
		t.mu.Unlock()

		if handler != nil {
			handler(ticks)
		}
	}
}

// ─── Binary packet parser ─────────────────────────────────────────────────────
// Kite WebSocket binary format:
//   bytes 0-1: number of packets (big-endian uint16)
//   for each packet:
//     bytes 0-1: packet length (big-endian uint16)
//     bytes 2+:  packet data

func parseBinaryPackets(data []byte) []Tick {
	if len(data) < 2 { return nil }
	numPackets := binary.BigEndian.Uint16(data[:2])
	pos := 2
	ticks := make([]Tick, 0, numPackets)

	for i := 0; i < int(numPackets) && pos+2 <= len(data); i++ {
		pktLen := int(binary.BigEndian.Uint16(data[pos : pos+2]))
		pos += 2
		if pos+pktLen > len(data) { break }
		pkt := data[pos : pos+pktLen]
		pos += pktLen

		tick := parsePacket(pkt)
		if tick != nil {
			ticks = append(ticks, *tick)
		}
	}
	return ticks
}

func parsePacket(pkt []byte) *Tick {
	if len(pkt) < 8 { return nil }
	token := binary.BigEndian.Uint32(pkt[:4])
	tick := &Tick{
		InstrumentToken: token,
		LastPrice:       fixedToFloat(binary.BigEndian.Uint32(pkt[4:8])),
		Timestamp:       time.Now(),
	}
	// Quote / Full mode — additional fields
	if len(pkt) >= 28 {
		tick.High   = fixedToFloat(binary.BigEndian.Uint32(pkt[8:12]))
		tick.Low    = fixedToFloat(binary.BigEndian.Uint32(pkt[12:16]))
		tick.Open   = fixedToFloat(binary.BigEndian.Uint32(pkt[16:20]))
		tick.Close  = fixedToFloat(binary.BigEndian.Uint32(pkt[20:24]))
		tick.Volume = binary.BigEndian.Uint32(pkt[24:28])
	}
	if len(pkt) >= 32 {
		tick.OI = binary.BigEndian.Uint32(pkt[28:32])
	}
	return tick
}

// Kite sends prices as integers × 100 (fixed-point).
func fixedToFloat(v uint32) float64 {
	return math.Round(float64(v)/100.0*100) / 100
}
