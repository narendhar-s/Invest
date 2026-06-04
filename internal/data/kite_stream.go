package data

import (
	"encoding/json"
	"sync"
	"time"

	"go.uber.org/zap"
	"stockwise/pkg/logger"
)

// KiteStream polls Zerodha every few seconds for live NSE quotes
// and broadcasts them to SSE subscribers.
type KiteStream struct {
	kite       *KiteClient
	nseSymbols []string // Yahoo-format symbols tracked
	mu         sync.RWMutex
	quotes     map[string]KiteQuote
	subs       map[chan string]struct{}
	subMu      sync.RWMutex
	stopCh     chan struct{}
	running    bool
}

func NewKiteStream(kite *KiteClient) *KiteStream {
	return &KiteStream{
		kite:   kite,
		quotes: make(map[string]KiteQuote),
		subs:   make(map[chan string]struct{}),
		stopCh: make(chan struct{}),
	}
}

// SetSymbols configures which NSE symbols (Yahoo format) to track.
func (s *KiteStream) SetSymbols(syms []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nseSymbols = syms
}

// Start begins the background polling goroutine.
func (s *KiteStream) Start() {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	s.running = true
	s.stopCh = make(chan struct{})
	s.mu.Unlock()
	go s.loop()
	logger.Info("kite live stream started")
}

// Stop halts polling.
func (s *KiteStream) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		close(s.stopCh)
		s.running = false
	}
}

// IsRunning returns whether the stream is active.
func (s *KiteStream) IsRunning() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.running
}

// Subscribe returns a channel that receives JSON-encoded quote snapshots.
func (s *KiteStream) Subscribe() chan string {
	ch := make(chan string, 64)
	s.subMu.Lock()
	s.subs[ch] = struct{}{}
	s.subMu.Unlock()
	return ch
}

// Unsubscribe removes a subscriber and closes its channel.
func (s *KiteStream) Unsubscribe(ch chan string) {
	s.subMu.Lock()
	delete(s.subs, ch)
	s.subMu.Unlock()
	close(ch)
}

// GetAllQuotes returns a snapshot of all current quotes.
func (s *KiteStream) GetAllQuotes() map[string]KiteQuote {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cp := make(map[string]KiteQuote, len(s.quotes))
	for k, v := range s.quotes {
		cp[k] = v
	}
	return cp
}

// GetQuote returns the latest quote for one symbol.
func (s *KiteStream) GetQuote(yahooSymbol string) (KiteQuote, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	q, ok := s.quotes[yahooSymbol]
	return q, ok
}

func (s *KiteStream) loop() {
	tick := time.NewTicker(3 * time.Second)
	defer tick.Stop()
	s.poll() // immediate first fetch
	for {
		select {
		case <-s.stopCh:
			return
		case <-tick.C:
			if s.kite.IsConnected() {
				s.poll()
			}
		}
	}
}

func (s *KiteStream) poll() {
	s.mu.RLock()
	syms := make([]string, len(s.nseSymbols))
	copy(syms, s.nseSymbols)
	s.mu.RUnlock()

	if len(syms) == 0 || !s.kite.IsConnected() {
		return
	}

	// Build Kite instrument keys, skipping non-NSE symbols
	kiteKeys := make([]string, 0, len(syms))
	for _, y := range syms {
		if k := YahooToKite(y); k != "" {
			kiteKeys = append(kiteKeys, k)
		}
	}
	if len(kiteKeys) == 0 {
		return
	}

	quotes, err := s.kite.FetchLiveQuotes(kiteKeys)
	if err != nil {
		logger.Warn("kite live quote poll failed", zap.Error(err))
		return
	}

	s.mu.Lock()
	for sym, q := range quotes {
		s.quotes[sym] = q
	}
	s.mu.Unlock()

	// Broadcast snapshot to SSE subscribers
	snap := s.GetAllQuotes()
	data, err := json.Marshal(snap)
	if err != nil {
		return
	}
	msg := string(data)

	s.subMu.RLock()
	for ch := range s.subs {
		select {
		case ch <- msg:
		default: // drop if subscriber is too slow
		}
	}
	s.subMu.RUnlock()
}
