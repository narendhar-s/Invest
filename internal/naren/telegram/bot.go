// Package telegram is a minimal, dependency-free Telegram bot that remotely
// controls the 90-day challenge services. It talks to the Telegram Bot HTTP API
// directly (long-polling getUpdates + sendMessage) so no extra module is needed.
//
// Security model:
//   - Commands are honoured ONLY from chat IDs in the allowlist.
//   - Live (real-money) actions additionally require the kite.live_trading_enabled
//     master switch AND an in-chat /confirm step that expires after 60 seconds.
//
// This package never bypasses the challenge service's own safety gates; it just
// invokes the same methods the web UI does.
package telegram

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"

	"stockwise/internal/naren/paper"
)

const apiBase = "https://api.telegram.org/bot"

// Config mirrors config.naren.yaml → telegram.
type Config struct {
	Enabled        bool
	BotToken       string
	AllowedChatIDs []int64
}

type pending struct {
	desc string
	run  func() string
	exp  time.Time
}

// Bot polls Telegram and dispatches commands to the challenge services.
type Bot struct {
	token   string
	allowed map[int64]bool
	chats   []int64
	http    *http.Client
	log     *zap.Logger
	options *paper.ChallengeService
	scalp   *paper.ChallengeService
	offset  int64

	mu   sync.Mutex
	pend map[int64]pending
	stop chan struct{}
}

// New builds a Bot. optionsSvc is required; scalpSvc may be nil.
func New(cfg Config, optionsSvc, scalpSvc *paper.ChallengeService, log *zap.Logger) *Bot {
	allowed := make(map[int64]bool, len(cfg.AllowedChatIDs))
	for _, id := range cfg.AllowedChatIDs {
		allowed[id] = true
	}
	return &Bot{
		token:   cfg.BotToken,
		allowed: allowed,
		chats:   cfg.AllowedChatIDs,
		http:    &http.Client{Timeout: 70 * time.Second},
		log:     log,
		options: optionsSvc,
		scalp:   scalpSvc,
		pend:    map[int64]pending{},
		stop:    make(chan struct{}),
	}
}

// Start wires entry/exit alerts and begins long-polling in the background.
func (b *Bot) Start() {
	notify := func(msg string) { b.broadcast(msg) }
	if b.options != nil {
		b.options.SetNotifier(notify)
	}
	if b.scalp != nil {
		b.scalp.SetNotifier(notify)
	}
	go b.loop()
	b.log.Info("telegram bot started", zap.Int("allowed_chats", len(b.chats)))
	b.broadcast("🤖 Naren challenge bot online. Send /help for commands.")
}

// Stop ends the polling loop.
func (b *Bot) Stop() { close(b.stop) }

func (b *Bot) loop() {
	for {
		select {
		case <-b.stop:
			return
		default:
		}
		updates, err := b.getUpdates()
		if err != nil {
			b.log.Warn("telegram getUpdates failed", zap.Error(err))
			time.Sleep(3 * time.Second)
			continue
		}
		for _, u := range updates {
			b.offset = u.UpdateID + 1
			if u.Message == nil || u.Message.Text == "" {
				continue
			}
			b.handle(u.Message)
		}
	}
}

// ─── Telegram API types ───────────────────────────────────────────────────────

type tgUpdate struct {
	UpdateID int64      `json:"update_id"`
	Message  *tgMessage `json:"message"`
}

type tgMessage struct {
	Chat tgChat `json:"chat"`
	Text string `json:"text"`
}

type tgChat struct {
	ID int64 `json:"id"`
}

func (b *Bot) getUpdates() ([]tgUpdate, error) {
	u := fmt.Sprintf("%s%s/getUpdates?timeout=50&offset=%d", apiBase, b.token, b.offset)
	resp, err := b.http.Get(u)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var r struct {
		OK     bool       `json:"ok"`
		Result []tgUpdate `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, err
	}
	return r.Result, nil
}

func (b *Bot) send(chatID int64, text string) {
	form := url.Values{}
	form.Set("chat_id", strconv.FormatInt(chatID, 10))
	form.Set("text", text)
	if _, err := b.http.PostForm(apiBase+b.token+"/sendMessage", form); err != nil {
		b.log.Warn("telegram send failed", zap.Error(err))
	}
}

func (b *Bot) broadcast(text string) {
	for _, id := range b.chats {
		b.send(id, text)
	}
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

const helpText = `Naren challenge bot — commands:
/status [scalp] — challenge summary
/startchallenge [lots] [risk] [target] [scalp] — start a challenge
/pause [scalp] · /resume [scalp]
/live on|off [floor=2000] [rr=2] [maxlots=2] [target=2000] [conf=70] [window=09:30-15:00] [scalp]
/enter [scalp] — manual entry (real order if live is ON; needs /confirm)
/exit [scalp] — square off the open position (needs /confirm if live)
/confirm · /cancel — for live actions
Append "scalp" to target the scalp challenge (default is options).`

func (b *Bot) handle(m *tgMessage) {
	chatID := m.Chat.ID
	if !b.allowed[chatID] {
		b.log.Warn("telegram: command from unauthorized chat", zap.Int64("chat", chatID))
		b.send(chatID, "⛔ This chat is not authorized.")
		return
	}
	fields := strings.Fields(m.Text)
	if len(fields) == 0 {
		return
	}
	cmd := strings.ToLower(strings.TrimPrefix(fields[0], "/"))
	if i := strings.Index(cmd, "@"); i >= 0 {
		cmd = cmd[:i]
	}
	svc, name, args := b.pickTarget(fields[1:])

	switch cmd {
	case "start", "help":
		b.send(chatID, helpText)
	case "status":
		b.send(chatID, b.summary(svc, name))
	case "pause":
		if err := svc.PauseChallenge(); err != nil {
			b.send(chatID, "⚠ "+err.Error())
		} else {
			b.send(chatID, fmt.Sprintf("⏸ %s challenge paused.", name))
		}
	case "resume":
		if err := svc.ResumeChallenge(); err != nil {
			b.send(chatID, "⚠ "+err.Error())
		} else {
			b.send(chatID, fmt.Sprintf("▶️ %s challenge resumed.", name))
		}
	case "startchallenge", "begin":
		b.cmdStart(chatID, svc, name, args)
	case "live":
		b.cmdLive(chatID, svc, name, args)
	case "enter":
		b.cmdEnter(chatID, svc, name)
	case "exit", "squareoff":
		b.cmdExit(chatID, svc, name)
	case "confirm", "yes":
		b.cmdConfirm(chatID)
	case "cancel", "no":
		b.mu.Lock()
		delete(b.pend, chatID)
		b.mu.Unlock()
		b.send(chatID, "Cancelled.")
	default:
		b.send(chatID, "Unknown command. /help")
	}
}

// pickTarget selects the options or scalp service based on a "scalp"/"options"
// token anywhere in the args, returning the remaining args.
func (b *Bot) pickTarget(args []string) (*paper.ChallengeService, string, []string) {
	svc, name := b.options, "options"
	out := make([]string, 0, len(args))
	for _, a := range args {
		switch strings.ToLower(a) {
		case "scalp":
			if b.scalp != nil {
				svc, name = b.scalp, "scalp"
			}
		case "options":
			svc, name = b.options, "options"
		default:
			out = append(out, a)
		}
	}
	return svc, name, out
}

func (b *Bot) summary(svc *paper.ChallengeService, name string) string {
	if svc == nil {
		return "service unavailable"
	}
	s := svc.Status()
	if s.Active == nil {
		return fmt.Sprintf("📊 %s challenge: no active challenge.", name)
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "📊 %s — Day %d/90\n", name, s.DayNumber)
	fmt.Fprintf(&sb, "Capital ₹%.0f | Total P&L ₹%.0f | Today ₹%.0f\n", s.CurrentCapital, s.TotalPnL, s.TodayPnL)
	fmt.Fprintf(&sb, "Trades %d | W/L %d/%d (%.0f%%)\n", s.TotalTrades, s.WinCount, s.LossCount, s.WinRate)
	if s.OpenTrade != nil {
		fmt.Fprintf(&sb, "📈 OPEN %s @ ₹%.1f | live P&L ₹%.0f\n", s.OpenTrade.TradingSymbol, s.OpenTrade.EntryPremium, s.OpenPnL)
	} else {
		sb.WriteString("No open position.\n")
	}
	live := "OFF"
	if s.LiveEnabled {
		live = "ON 🔴"
	}
	fmt.Fprintf(&sb, "Live %s (allowed=%v) | floor ₹%.0f RR %.1f maxlots %d hold %d%% window %s-%s\n",
		live, s.LiveAllowed, s.LiveMinProfit, s.LiveRR, s.LiveMaxLots, s.LiveHoldConfidence, s.LiveWindowStart, s.LiveWindowEnd)
	if s.LastSignal != nil {
		fmt.Fprintf(&sb, "Signal %s %s conf %d%%\n", s.LastSignal.Strategy, s.LastSignal.Direction, s.LastSignal.Confidence)
	}
	if s.LastError != "" {
		fmt.Fprintf(&sb, "⚠ %s\n", s.LastError)
	}
	return sb.String()
}

func (b *Bot) cmdStart(chatID int64, svc *paper.ChallengeService, name string, args []string) {
	lots, risk, target := 2, 5000.0, 10000.0
	if len(args) >= 1 {
		if v, err := strconv.Atoi(args[0]); err == nil {
			lots = v
		}
	}
	if len(args) >= 2 {
		if v, err := strconv.ParseFloat(args[1], 64); err == nil {
			risk = v
		}
	}
	if len(args) >= 3 {
		if v, err := strconv.ParseFloat(args[2], 64); err == nil {
			target = v
		}
	}
	cfg, err := svc.StartChallenge(lots, risk, target, "started via Telegram")
	if err != nil {
		b.send(chatID, "⚠ "+err.Error())
		return
	}
	b.send(chatID, fmt.Sprintf("🚀 %s challenge started (id %d): %d lots, risk ₹%.0f, target ₹%.0f.",
		name, cfg.ID, lots, risk, target))
}

func (b *Bot) cmdLive(chatID int64, svc *paper.ChallengeService, name string, args []string) {
	if len(args) == 0 {
		b.send(chatID, "Usage: /live on|off [floor=2000] [rr=2] [maxlots=2] [target=2000] [conf=70] [window=09:30-15:00] [scalp]")
		return
	}
	cur := svc.Status()
	set := paper.LiveSettings{
		Enabled:        cur.LiveEnabled,
		ProfitTarget:   cur.LiveProfitTarget,
		MaxLots:        cur.LiveMaxLots,
		MinProfit:      cur.LiveMinProfit,
		WindowStart:    cur.LiveWindowStart,
		WindowEnd:      cur.LiveWindowEnd,
		HoldConfidence: cur.LiveHoldConfidence,
		RR:             cur.LiveRR,
	}
	enabling := false
	for _, a := range args {
		la := strings.ToLower(a)
		switch {
		case la == "on":
			enabling = !cur.LiveEnabled
			set.Enabled = true
		case la == "off":
			set.Enabled = false
		case strings.HasPrefix(la, "floor="):
			set.MinProfit = parseVal(la)
		case strings.HasPrefix(la, "rr="):
			set.RR = parseVal(la)
		case strings.HasPrefix(la, "target="):
			set.ProfitTarget = parseVal(la)
		case strings.HasPrefix(la, "maxlots="):
			set.MaxLots = int(parseVal(la))
		case strings.HasPrefix(la, "conf="):
			set.HoldConfidence = int(parseVal(la))
		case strings.HasPrefix(la, "window="):
			parts := strings.SplitN(strings.TrimPrefix(la, "window="), "-", 2)
			if len(parts) == 2 {
				set.WindowStart, set.WindowEnd = parts[0], parts[1]
			}
		}
	}
	apply := func() string {
		if err := svc.SetLiveConfig(set); err != nil {
			return "⚠ " + err.Error()
		}
		st := "OFF"
		if set.Enabled {
			st = "ON 🔴 REAL ORDERS"
		}
		return fmt.Sprintf("Live %s for %s: floor ₹%.0f, RR %.1f, maxlots %d, hold %d%%, window %s-%s.",
			st, name, set.MinProfit, set.RR, set.MaxLots, set.HoldConfidence, set.WindowStart, set.WindowEnd)
	}
	if enabling {
		b.requireConfirm(chatID, fmt.Sprintf("Enable LIVE real-money trading for %s?", name), apply)
		return
	}
	b.send(chatID, apply())
}

func (b *Bot) cmdEnter(chatID int64, svc *paper.ChallengeService, name string) {
	st := svc.Status()
	do := func() string {
		t, err := svc.ManualEntry()
		if err != nil {
			return "⚠ " + err.Error()
		}
		return fmt.Sprintf("📈 Manual entry: %s @ ₹%.1f", t.TradingSymbol, t.EntryPremium)
	}
	if st.LiveEnabled && st.LiveAllowed {
		b.requireConfirm(chatID, fmt.Sprintf("Place a REAL %s entry order now?", name), do)
		return
	}
	b.send(chatID, do())
}

func (b *Bot) cmdExit(chatID int64, svc *paper.ChallengeService, name string) {
	st := svc.Status()
	do := func() string {
		if err := svc.ManualExit(); err != nil {
			return "⚠ " + err.Error()
		}
		return "🔻 Square-off sent."
	}
	if st.LiveEnabled && st.LiveAllowed {
		b.requireConfirm(chatID, fmt.Sprintf("Square off the REAL %s position now?", name), do)
		return
	}
	b.send(chatID, do())
}

func (b *Bot) requireConfirm(chatID int64, desc string, run func() string) {
	b.mu.Lock()
	b.pend[chatID] = pending{desc: desc, run: run, exp: time.Now().Add(60 * time.Second)}
	b.mu.Unlock()
	b.send(chatID, "⚠ "+desc+"\nReply /confirm within 60s, or /cancel.")
}

func (b *Bot) cmdConfirm(chatID int64) {
	b.mu.Lock()
	p, ok := b.pend[chatID]
	delete(b.pend, chatID)
	b.mu.Unlock()
	if !ok || time.Now().After(p.exp) {
		b.send(chatID, "Nothing to confirm (or it expired).")
		return
	}
	b.send(chatID, p.run())
}

func parseVal(s string) float64 {
	i := strings.Index(s, "=")
	if i < 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(strings.TrimSpace(s[i+1:]), 64)
	return v
}
