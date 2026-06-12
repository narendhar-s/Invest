package screener

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"golang.org/x/net/html"
)

const (
	screenerSearchURL       = "https://www.screener.in/api/company/search/"
	screenerConsolidatedFmt = "https://www.screener.in/company/%s/consolidated/"
	screenerStandaloneFmt   = "https://www.screener.in/company/%s/"
	cacheTTL                = 30 * time.Minute
)

type cacheEntry struct {
	data      *CompanyData
	expiresAt time.Time
}

// Client scrapes Screener.in for Indian stock fundamentals.
type Client struct {
	http  *http.Client
	cache map[string]cacheEntry
}

func NewClient() *Client {
	return &Client{
		http:  &http.Client{Timeout: 20 * time.Second},
		cache: make(map[string]cacheEntry),
	}
}

// SearchResult is a single company hit from the screener.in search API.
type SearchResult struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	URL       string `json:"url"`
	MarketCap string `json:"market_cap"`
}

// ShareholdingData holds the latest and previous-quarter holding pattern.
type ShareholdingData struct {
	// Latest quarter holdings (%)
	PromoterPct  float64 `json:"promoter_pct"`
	FIIPct       float64 `json:"fii_pct"`
	DIIPct       float64 `json:"dii_pct"`
	PublicPct    float64 `json:"public_pct"`

	// Previous quarter holdings for trend detection
	PromoterPrev float64 `json:"promoter_prev"`
	FIIPrev      float64 `json:"fii_prev"`
	DIIPrev      float64 `json:"dii_prev"`

	// Pledging (extracted from ratios section when available)
	PledgingPct  float64 `json:"pledging_pct"`

	// Derived flags
	PromoterIncreasing bool `json:"promoter_increasing"`
	FIIIncreasing      bool `json:"fii_increasing"`
	DIIIncreasing      bool `json:"dii_increasing"`

	Quarters []string `json:"quarters"` // column labels from the table
}

// CompanyData holds scraped fundamental data from screener.in.
type CompanyData struct {
	Symbol        string
	Name          string
	CurrentPrice  float64
	MarketCap     float64 // in Crores
	PERatio       float64
	BookValue     float64
	PriceToBook   float64
	DividendYield float64
	ROCE          float64
	ROE           float64
	FaceValue     float64
	High52W       float64
	Low52W        float64
	FreeCashFlow  float64 // latest annual FCF in Crores
	ProfitMargin  float64 // computed from latest quarter (%)

	Shareholding    *ShareholdingData
	QuarterlyResults []QuarterResult
	AnnualResults    []AnnualResult
}

// QuarterResult holds a single quarter's financials (values in Crores).
type QuarterResult struct {
	Period    string
	Sales     float64
	Expenses  float64
	NetProfit float64
	EPS       float64
}

// AnnualResult holds a single year's financials (values in Crores).
type AnnualResult struct {
	Year      string
	Sales     float64
	NetProfit float64
	EPS       float64
}

// Search queries screener.in for companies matching the query string.
func (c *Client) Search(query string) ([]SearchResult, error) {
	req, err := http.NewRequest("GET", screenerSearchURL, nil)
	if err != nil {
		return nil, err
	}
	q := req.URL.Query()
	q.Set("q", query)
	q.Set("v", "3")
	req.URL.RawQuery = q.Encode()
	c.setHeaders(req)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("screener search: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var results []SearchResult
	if err := json.Unmarshal(body, &results); err != nil {
		return nil, fmt.Errorf("parsing screener results: %w", err)
	}
	return results, nil
}

// FetchCompany retrieves full fundamental data for a company identified by its
// screener.in URL path (e.g. "/company/RELIANCE/").
// Results are cached for 30 minutes to avoid rate-limiting.
func (c *Client) FetchCompany(urlPath string) (*CompanyData, error) {
	if entry, ok := c.cache[urlPath]; ok && time.Now().Before(entry.expiresAt) {
		return entry.data, nil
	}
	// Extract symbol from path segments like /company/RELIANCE/ or /company/RELIANCE/consolidated/
	parts := strings.Split(strings.Trim(urlPath, "/"), "/")
	symbol := ""
	for i, p := range parts {
		if strings.EqualFold(p, "company") && i+1 < len(parts) {
			symbol = parts[i+1]
			break
		}
	}
	if symbol == "" {
		return nil, fmt.Errorf("cannot extract symbol from url path: %s", urlPath)
	}

	// Try consolidated view first (preferred for large caps); fall back to standalone.
	for _, urlFmt := range []string{screenerConsolidatedFmt, screenerStandaloneFmt} {
		pageURL := fmt.Sprintf(urlFmt, symbol)
		req, err := http.NewRequest("GET", pageURL, nil)
		if err != nil {
			return nil, err
		}
		c.setHeaders(req)

		resp, err := c.http.Do(req)
		if err != nil {
			continue
		}
		defer resp.Body.Close()

		if resp.StatusCode == 404 {
			continue
		}

		data, err := c.parseCompanyPage(symbol, resp.Body)
		if err != nil {
			continue
		}
		c.cache[urlPath] = cacheEntry{data: data, expiresAt: time.Now().Add(cacheTTL)}
		return data, nil
	}
	return nil, fmt.Errorf("company %s not found on screener.in", symbol)
}

// ─── Page Parser ─────────────────────────────────────────────────────────────

func (c *Client) parseCompanyPage(symbol string, body io.Reader) (*CompanyData, error) {
	doc, err := html.Parse(body)
	if err != nil {
		return nil, fmt.Errorf("parsing HTML for %s: %w", symbol, err)
	}

	data := &CompanyData{Symbol: symbol}
	data.Name = extractFirstTagText(doc, "h1")

	if ratiosNode := findNodeByID(doc, "top-ratios"); ratiosNode != nil {
		parseTopRatios(ratiosNode, data)
	}

	if qSection := findNodeByID(doc, "quarters"); qSection != nil {
		data.QuarterlyResults = parseQuarterlyTable(qSection)
	}

	if plSection := findNodeByID(doc, "profit-loss"); plSection != nil {
		data.AnnualResults = parseAnnualTable(plSection)
	}

	if cfSection := findNodeByID(doc, "cash-flow"); cfSection != nil {
		data.FreeCashFlow = parseLatestFCF(cfSection)
	}

	if shSection := findNodeByID(doc, "shareholding"); shSection != nil {
		data.Shareholding = parseShareholding(shSection)
	}

	if data.CurrentPrice > 0 && data.BookValue > 0 {
		data.PriceToBook = data.CurrentPrice / data.BookValue
	}

	// Compute profit margin from most recent quarter
	if len(data.QuarterlyResults) > 0 {
		q := data.QuarterlyResults[len(data.QuarterlyResults)-1]
		if q.Sales > 0 && q.NetProfit > 0 {
			data.ProfitMargin = q.NetProfit / q.Sales * 100
		}
	}

	return data, nil
}

// ─── Top-Ratios ───────────────────────────────────────────────────────────────

func parseTopRatios(node *html.Node, data *CompanyData) {
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "li" {
			name, value := "", ""
			var extract func(*html.Node)
			extract = func(child *html.Node) {
				if child.Type == html.ElementNode {
					cls := getAttr(child, "class")
					if strings.Contains(cls, "name") {
						name = strings.TrimSpace(textContent(child))
					} else if strings.Contains(cls, "number") || strings.Contains(cls, "value") {
						value = strings.TrimSpace(textContent(child))
					}
				}
				for c := child.FirstChild; c != nil; c = c.NextSibling {
					extract(c)
				}
			}
			for child := n.FirstChild; child != nil; child = child.NextSibling {
				extract(child)
			}
			if name != "" && value != "" {
				applyRatio(data, name, value)
			}
		}
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(node)
}

func applyRatio(data *CompanyData, name, value string) {
	lo := strings.ToLower(strings.TrimSpace(name))

	// "High / Low" is screener.in's combined 52-week range field — split and parse both halves
	if lo == "high / low" || lo == "high/low" {
		parts := strings.SplitN(value, "/", 2)
		if len(parts) == 2 {
			data.High52W = parseIndianNumber(parts[0])
			data.Low52W = parseIndianNumber(parts[1])
		}
		return
	}

	v := parseIndianNumber(value)
	switch {
	case strings.Contains(lo, "market cap"):
		data.MarketCap = v
	case strings.Contains(lo, "current price"):
		data.CurrentPrice = v
	case lo == "p/e" || strings.HasPrefix(lo, "p/e ") || lo == "stock p/e":
		data.PERatio = v
	case strings.Contains(lo, "book value"):
		data.BookValue = v
	case strings.Contains(lo, "dividend yield"):
		data.DividendYield = v
	case strings.Contains(lo, "roce"):
		data.ROCE = v
	case lo == "roe" || strings.HasPrefix(lo, "roe ") || strings.HasSuffix(lo, " roe"):
		data.ROE = v
	case strings.Contains(lo, "face value"):
		data.FaceValue = v
	case strings.Contains(lo, "52 week high") || (strings.Contains(lo, "high") && strings.Contains(lo, "52")):
		data.High52W = v
	case strings.Contains(lo, "52 week low") || (strings.Contains(lo, "low") && strings.Contains(lo, "52")):
		data.Low52W = v
	case strings.Contains(lo, "pledg"):
		if data.Shareholding == nil {
			data.Shareholding = &ShareholdingData{}
		}
		data.Shareholding.PledgingPct = v
	}
}

// ─── Table Parsers ─────────────────────────────────────────────────────────────

func parseQuarterlyTable(section *html.Node) []QuarterResult {
	table := findNodeByTag(section, "table")
	if table == nil {
		return nil
	}
	headers := extractTableHeaders(table)
	rows := extractTableRows(table)

	// Collect all non-TTM column indices (screener.in orders oldest → newest left-to-right)
	// so we take the LAST 4 to get the most recent quarters.
	allCols := []int{}
	for i, h := range headers {
		if i == 0 {
			continue
		}
		if !strings.Contains(strings.ToLower(h), "ttm") {
			allCols = append(allCols, i)
		}
	}
	cols := allCols
	if len(cols) > 4 {
		cols = cols[len(cols)-4:]
	}

	results := make([]QuarterResult, 0, len(cols))
	for _, ci := range cols {
		qr := QuarterResult{}
		if ci < len(headers) {
			qr.Period = headers[ci]
		}
		for _, row := range rows {
			if len(row) == 0 || ci >= len(row) {
				continue
			}
			label := strings.ToLower(strings.TrimSpace(row[0]))
			v := parseIndianNumber(row[ci])
			switch {
			case strings.Contains(label, "sales") || strings.Contains(label, "revenue"):
				qr.Sales = v
			case strings.Contains(label, "expenses"):
				qr.Expenses = v
			case strings.Contains(label, "net profit"):
				qr.NetProfit = v
			case label == "eps" || strings.HasPrefix(label, "eps ") || strings.Contains(label, "earnings per share"):
				qr.EPS = v
			}
		}
		results = append(results, qr)
	}
	return results
}

func parseAnnualTable(section *html.Node) []AnnualResult {
	table := findNodeByTag(section, "table")
	if table == nil {
		return nil
	}
	headers := extractTableHeaders(table)
	rows := extractTableRows(table)

	// Take the 5 most recent years (oldest → newest, take last 5)
	allCols := []int{}
	for i := range headers {
		if i == 0 {
			continue
		}
		allCols = append(allCols, i)
	}
	cols := allCols
	if len(cols) > 5 {
		cols = cols[len(cols)-5:]
	}

	results := make([]AnnualResult, 0, len(cols))
	for _, ci := range cols {
		ar := AnnualResult{}
		if ci < len(headers) {
			ar.Year = headers[ci]
		}
		for _, row := range rows {
			if len(row) == 0 || ci >= len(row) {
				continue
			}
			label := strings.ToLower(strings.TrimSpace(row[0]))
			v := parseIndianNumber(row[ci])
			switch {
			case strings.Contains(label, "sales") || strings.Contains(label, "revenue"):
				ar.Sales = v
			case strings.Contains(label, "net profit"):
				ar.NetProfit = v
			case label == "eps":
				ar.EPS = v
			}
		}
		results = append(results, ar)
	}
	return results
}

// parseShareholding extracts promoter/FII/DII/public holdings from the
// shareholding pattern section (id="shareholding").
// Screener.in renders it as a table with quarters as columns and entity
// rows (Promoters, FIIs, DIIs, Public, Govt).
func parseShareholding(section *html.Node) *ShareholdingData {
	table := findNodeByTag(section, "table")
	if table == nil {
		return nil
	}
	headers := extractTableHeaders(table)
	rows := extractTableRows(table)

	if len(headers) < 2 {
		return nil
	}

	// We want the two most-recent columns: last = latest quarter, last-1 = previous
	// headers[0] is the row label; actual quarter columns start at index 1
	cols := []int{}
	for i := 1; i < len(headers); i++ {
		cols = append(cols, i)
	}
	// Take last two non-empty columns
	if len(cols) > 2 {
		cols = cols[len(cols)-2:]
	}
	if len(cols) == 0 {
		return nil
	}

	latestCol := cols[len(cols)-1]
	prevCol := -1
	if len(cols) >= 2 {
		prevCol = cols[0]
	}

	sh := &ShareholdingData{}

	// Collect quarter labels
	for _, ci := range cols {
		if ci < len(headers) {
			sh.Quarters = append(sh.Quarters, headers[ci])
		}
	}

	for _, row := range rows {
		if len(row) == 0 {
			continue
		}
		label := strings.ToLower(strings.TrimSpace(row[0]))

		getCol := func(ci int) float64 {
			if ci >= 0 && ci < len(row) {
				return parseIndianNumber(row[ci])
			}
			return 0
		}

		switch {
		case strings.Contains(label, "promoter"):
			sh.PromoterPct = getCol(latestCol)
			if prevCol >= 0 {
				sh.PromoterPrev = getCol(prevCol)
			}
		case label == "fiis" || label == "fii" || strings.Contains(label, "foreign institutional"):
			sh.FIIPct = getCol(latestCol)
			if prevCol >= 0 {
				sh.FIIPrev = getCol(prevCol)
			}
		case label == "diis" || label == "dii" || strings.Contains(label, "domestic institutional"):
			sh.DIIPct = getCol(latestCol)
			if prevCol >= 0 {
				sh.DIIPrev = getCol(prevCol)
			}
		case strings.Contains(label, "public"):
			sh.PublicPct = getCol(latestCol)
		}
	}

	// Compute trend flags
	if sh.PromoterPrev > 0 {
		sh.PromoterIncreasing = sh.PromoterPct > sh.PromoterPrev
	}
	if sh.FIIPrev > 0 {
		sh.FIIIncreasing = sh.FIIPct > sh.FIIPrev
	}
	if sh.DIIPrev > 0 {
		sh.DIIIncreasing = sh.DIIPct > sh.DIIPrev
	}

	return sh
}

// applyPledgingFromRatios copies the pledging percentage that was parsed from
// the top-ratios section into the shareholding struct (if shareholding exists).
func applyPledgingFromRatios(data *CompanyData, name, value string) {
	lo := strings.ToLower(strings.TrimSpace(name))
	if strings.Contains(lo, "pledg") {
		v := parseIndianNumber(value)
		if data.Shareholding == nil {
			data.Shareholding = &ShareholdingData{}
		}
		data.Shareholding.PledgingPct = v
	}
}

func parseLatestFCF(section *html.Node) float64 {
	table := findNodeByTag(section, "table")
	if table == nil {
		return 0
	}
	headers := extractTableHeaders(table)
	rows := extractTableRows(table)
	if len(headers) < 2 {
		return 0
	}
	lastCol := len(headers) - 1
	for _, row := range rows {
		if len(row) == 0 {
			continue
		}
		if strings.Contains(strings.ToLower(row[0]), "free cash") && lastCol < len(row) {
			return parseIndianNumber(row[lastCol])
		}
	}
	return 0
}

// ─── HTML Helpers ─────────────────────────────────────────────────────────────

func findNodeByID(node *html.Node, id string) *html.Node {
	if node.Type == html.ElementNode && getAttr(node, "id") == id {
		return node
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if found := findNodeByID(child, id); found != nil {
			return found
		}
	}
	return nil
}

func findNodeByTag(node *html.Node, tag string) *html.Node {
	if node.Type == html.ElementNode && node.Data == tag {
		return node
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if found := findNodeByTag(child, tag); found != nil {
			return found
		}
	}
	return nil
}

func extractFirstTagText(node *html.Node, tag string) string {
	if node.Type == html.ElementNode && node.Data == tag {
		return strings.TrimSpace(textContent(node))
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if t := extractFirstTagText(child, tag); t != "" {
			return t
		}
	}
	return ""
}

func textContent(node *html.Node) string {
	if node.Type == html.TextNode {
		return node.Data
	}
	var sb strings.Builder
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		sb.WriteString(textContent(child))
	}
	return sb.String()
}

func getAttr(node *html.Node, key string) string {
	for _, a := range node.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func extractTableHeaders(table *html.Node) []string {
	thead := findNodeByTag(table, "thead")
	if thead == nil {
		return nil
	}
	tr := findNodeByTag(thead, "tr")
	if tr == nil {
		return nil
	}
	var headers []string
	for child := tr.FirstChild; child != nil; child = child.NextSibling {
		if child.Type == html.ElementNode && (child.Data == "th" || child.Data == "td") {
			headers = append(headers, strings.TrimSpace(textContent(child)))
		}
	}
	return headers
}

func extractTableRows(table *html.Node) [][]string {
	tbody := findNodeByTag(table, "tbody")
	if tbody == nil {
		return nil
	}
	var rows [][]string
	for tr := tbody.FirstChild; tr != nil; tr = tr.NextSibling {
		if tr.Type != html.ElementNode || tr.Data != "tr" {
			continue
		}
		var row []string
		for td := tr.FirstChild; td != nil; td = td.NextSibling {
			if td.Type == html.ElementNode && (td.Data == "td" || td.Data == "th") {
				row = append(row, strings.TrimSpace(textContent(td)))
			}
		}
		if len(row) > 0 {
			rows = append(rows, row)
		}
	}
	return rows
}

var nonNumericRe = regexp.MustCompile(`[^0-9.\-]`)

// parseIndianNumber converts Indian-formatted numbers like "₹1,23,456" or "1,234 Cr." to float64.
func parseIndianNumber(s string) float64 {
	s = strings.TrimSpace(s)
	clean := nonNumericRe.ReplaceAllString(s, "")
	if clean == "" || clean == "." || clean == "-" {
		return 0
	}
	var f float64
	fmt.Sscanf(clean, "%f", &f)
	return f
}

func (c *Client) setHeaders(req *http.Request) {
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Referer", "https://www.screener.in/")
}
