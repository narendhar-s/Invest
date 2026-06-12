package news

import (
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// WatchList is the set of symbols and their display info monitored for news.
var WatchList = []WatchSymbol{
	{Symbol: "^NSEI", Name: "NIFTY 50", Sector: "Index", YFSymbol: "%5ENSEI"},
	{Symbol: "HDFCBANK.NS", Name: "HDFC Bank", Sector: "Banking", YFSymbol: "HDFCBANK.NS"},
	{Symbol: "SBIN.NS", Name: "State Bank of India", Sector: "Banking", YFSymbol: "SBIN.NS"},
	{Symbol: "INFY.NS", Name: "Infosys", Sector: "IT", YFSymbol: "INFY.NS"},
	{Symbol: "RELIANCE.NS", Name: "Reliance Industries", Sector: "Energy", YFSymbol: "RELIANCE.NS"},
	{Symbol: "TATAMOTORS.NS", Name: "Tata Motors", Sector: "Auto", YFSymbol: "TATAMOTORS.NS"},
	{Symbol: "ITC.NS", Name: "ITC", Sector: "FMCG", YFSymbol: "ITC.NS"},
	{Symbol: "SUNPHARMA.NS", Name: "Sun Pharma", Sector: "Pharma", YFSymbol: "SUNPHARMA.NS"},
	{Symbol: "TATASTEEL.NS", Name: "Tata Steel", Sector: "Metal", YFSymbol: "TATASTEEL.NS"},
	{Symbol: "NTPC.NS", Name: "NTPC", Sector: "Power", YFSymbol: "NTPC.NS"},
	{Symbol: "DLF.NS", Name: "DLF", Sector: "Realty", YFSymbol: "DLF.NS"},
	{Symbol: "MUTHOOTFIN.NS", Name: "Muthoot Finance", Sector: "Finance", YFSymbol: "MUTHOOTFIN.NS"},
}

// Sector RSS keywords for sector-level news queries
var sectorQueries = map[string]string{
	"Banking":  "India+banking+sector+RBI",
	"IT":       "India+IT+sector+technology",
	"Energy":   "India+energy+oil+Reliance",
	"Auto":     "India+automobile+sector+EV",
	"FMCG":     "India+FMCG+consumer+goods",
	"Pharma":   "India+pharma+healthcare+FDA",
	"Metal":    "India+metals+steel+commodity",
	"Power":    "India+power+energy+NTPC",
	"Realty":   "India+real+estate+DLF",
	"Finance":  "India+NBFC+finance+gold+loan",
}

var greenKeywords = []string{
	"profit", "growth", "record", "beat", "upgrade", "acquisition", "surge",
	"rally", "gain", "approve", "launch", "partnership", "bullish", "strong",
	"outperform", "raise", "dividend", "expansion", "order", "deal", "award",
	"positive", "recovery", "increase", "higher", "rise", "buy", "boost",
}

var redKeywords = []string{
	"loss", "decline", "fall", "crash", "miss", "downgrade", "probe", "penalty",
	"fraud", "cut", "layoff", "debt", "default", "risk", "warning", "lawsuit",
	"fine", "investigation", "weak", "bear", "sell", "plunge", "drop", "slump",
	"concern", "negative", "lower", "shrink", "exit", "resign", "delay", "halt",
}

// WatchSymbol describes a tracked instrument.
type WatchSymbol struct {
	Symbol   string
	Name     string
	Sector   string
	YFSymbol string // URL-safe symbol for Yahoo Finance RSS
}

// NewsFlag represents a single news item with sentiment classification.
type NewsFlag struct {
	Symbol    string    `json:"symbol"`
	Name      string    `json:"name"`
	Sector    string    `json:"sector"`
	Flag      string    `json:"flag"`       // GREEN | RED | NEUTRAL
	Headline  string    `json:"headline"`
	Summary   string    `json:"summary"`
	Source    string    `json:"source"`
	URL       string    `json:"url"`
	Impact    string    `json:"impact"`     // HIGH | MEDIUM | LOW
	Category  string    `json:"category"`   // Stock | Sector
	FetchedAt time.Time `json:"fetched_at"`
}

// NewsStore holds the latest classified news flags.
type NewsStore struct {
	GreenFlags []NewsFlag `json:"green_flags"`
	RedFlags   []NewsFlag `json:"red_flags"`
	LastUpdate time.Time  `json:"last_update"`
}

// Monitor runs a background goroutine that fetches news every hour.
type Monitor struct {
	mu    sync.RWMutex
	store NewsStore
}

// NewMonitor creates a Monitor and immediately kicks off a fetch, then repeats hourly.
func NewMonitor() *Monitor {
	m := &Monitor{}
	go m.run()
	return m
}

// GetStore returns a snapshot of the current news store (safe for concurrent reads).
func (m *Monitor) GetStore() NewsStore {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.store
}

func (m *Monitor) run() {
	m.fetch()
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		m.fetch()
	}
}

func (m *Monitor) fetch() {
	var green, red []NewsFlag

	seen := map[string]bool{} // deduplicate by headline

	for _, ws := range WatchList {
		items := fetchRSS(ws.Name)
		for _, item := range items {
			flag := classify(item.Title + " " + item.Description)
			if flag == "NEUTRAL" {
				continue
			}
			key := item.Title
			if seen[key] {
				continue
			}
			seen[key] = true

			nf := NewsFlag{
				Symbol:    ws.Symbol,
				Name:      ws.Name,
				Sector:    ws.Sector,
				Flag:      flag,
				Headline:  item.Title,
				Summary:   truncate(item.Description, 200),
				Source:    item.Source,
				URL:       item.Link,
				Impact:    impactLevel(item.Title + " " + item.Description),
				Category:  "Stock",
				FetchedAt: time.Now(),
			}
			if flag == "GREEN" {
				green = append(green, nf)
			} else {
				red = append(red, nf)
			}
		}

		// Also fetch sector-level news
		if q, ok := sectorQueries[ws.Sector]; ok {
			sectorItems := fetchRSSQuery(q)
			for _, item := range sectorItems {
				flag := classify(item.Title + " " + item.Description)
				if flag == "NEUTRAL" {
					continue
				}
				key := "sector:" + item.Title
				if seen[key] {
					continue
				}
				seen[key] = true

				nf := NewsFlag{
					Symbol:    ws.Symbol,
					Name:      ws.Name + " (Sector)",
					Sector:    ws.Sector,
					Flag:      flag,
					Headline:  item.Title,
					Summary:   truncate(item.Description, 200),
					Source:    item.Source,
					URL:       item.Link,
					Impact:    impactLevel(item.Title + " " + item.Description),
					Category:  "Sector",
					FetchedAt: time.Now(),
				}
				if flag == "GREEN" {
					green = append(green, nf)
				} else {
					red = append(red, nf)
				}
			}
			delete(sectorQueries, ws.Sector) // only fetch sector once per cycle
		}
	}

	// Restore sector queries map for next cycle
	sectorQueries = map[string]string{
		"Banking":  "India+banking+sector+RBI",
		"IT":       "India+IT+sector+technology",
		"Energy":   "India+energy+oil+Reliance",
		"Auto":     "India+automobile+sector+EV",
		"FMCG":     "India+FMCG+consumer+goods",
		"Pharma":   "India+pharma+healthcare+FDA",
		"Metal":    "India+metals+steel+commodity",
		"Power":    "India+power+energy+NTPC",
		"Realty":   "India+real+estate+DLF",
		"Finance":  "India+NBFC+finance+gold+loan",
	}

	m.mu.Lock()
	m.store = NewsStore{
		GreenFlags: green,
		RedFlags:   red,
		LastUpdate: time.Now(),
	}
	m.mu.Unlock()
}

// ─── RSS parsing ──────────────────────────────────────────────────────────────

type rssItem struct {
	Title       string `xml:"title"`
	Link        string `xml:"link"`
	Description string `xml:"description"`
	Source      string `xml:"source"`
	PubDate     string `xml:"pubDate"`
}

type rssFeed struct {
	Items []rssItem `xml:"channel>item"`
}

// fetchRSS fetches news for a stock symbol. Tries Google News first; falls back to Yahoo Finance.
func fetchRSS(companyName string) []rssItem {
	googleURL := fmt.Sprintf("https://news.google.com/rss/search?q=%s+stock+NSE&hl=en-IN&gl=IN&ceid=IN:en", strings.ReplaceAll(companyName, " ", "+"))
	if items := doFetchRSS(googleURL); len(items) > 0 {
		return items
	}
	// Yahoo Finance fallback
	yahooURL := fmt.Sprintf("https://feeds.finance.yahoo.com/rss/2.0/headline?s=%s&region=IN&lang=en-IN", companyName)
	return doFetchRSS(yahooURL)
}

// fetchRSSQuery fetches sector/query-based news. Tries Google News first; falls back to Yahoo.
func fetchRSSQuery(query string) []rssItem {
	googleURL := fmt.Sprintf("https://news.google.com/rss/search?q=%s&hl=en-IN&gl=IN&ceid=IN:en", query)
	if items := doFetchRSS(googleURL); len(items) > 0 {
		return items
	}
	yahooURL := fmt.Sprintf("https://feeds.finance.yahoo.com/rss/2.0/headline?s=%s&region=IN&lang=en-IN", query)
	return doFetchRSS(yahooURL)
}

func doFetchRSS(url string) []rssItem {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil
	}
	// Google News wraps items under <rss><channel><item> — same structure, but
	// the <link> element uses CDATA which xml.Unmarshal handles transparently.
	var feed rssFeed
	if err := xml.Unmarshal(body, &feed); err != nil {
		return nil
	}
	return feed.Items
}

// ─── Sentiment helpers ────────────────────────────────────────────────────────

func classify(text string) string {
	lower := strings.ToLower(text)
	greenScore, redScore := 0, 0
	for _, kw := range greenKeywords {
		if strings.Contains(lower, kw) {
			greenScore++
		}
	}
	for _, kw := range redKeywords {
		if strings.Contains(lower, kw) {
			redScore++
		}
	}
	if greenScore > redScore {
		return "GREEN"
	}
	if redScore > greenScore {
		return "RED"
	}
	return "NEUTRAL"
}

func impactLevel(text string) string {
	lower := strings.ToLower(text)
	highImpact := []string{"record", "crash", "fraud", "probe", "penalty", "acquisition", "merger", "ban", "approval", "q3", "q4", "results", "quarterly"}
	medImpact := []string{"upgrade", "downgrade", "order", "deal", "launch", "dividend", "expansion"}
	for _, kw := range highImpact {
		if strings.Contains(lower, kw) {
			return "HIGH"
		}
	}
	for _, kw := range medImpact {
		if strings.Contains(lower, kw) {
			return "MEDIUM"
		}
	}
	return "LOW"
}

func truncate(s string, n int) string {
	// strip HTML tags
	inTag := false
	var b strings.Builder
	for _, r := range s {
		if r == '<' {
			inTag = true
			continue
		}
		if r == '>' {
			inTag = false
			continue
		}
		if !inTag {
			b.WriteRune(r)
		}
	}
	clean := strings.TrimSpace(b.String())
	if len(clean) <= n {
		return clean
	}
	return clean[:n] + "…"
}
