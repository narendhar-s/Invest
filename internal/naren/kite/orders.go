package kite

// ─── LIVE ORDER PLACEMENT ─────────────────────────────────────────────────────
//
// ⚠️  This file is the ONE place that can place REAL orders on Zerodha with REAL
// money. It exists only to support the explicitly user-enabled "Live Trading"
// mode on the 90-day challenge. It must remain gated behind:
//   1. the server config master switch  kite.live_trading_enabled  (default false)
//   2. the per-challenge live toggle in the UI (defaults OFF, and OFF on restart)
//
// Everything else in this package stays read-only. Do not call PlaceMarketOrder
// from any path that isn't behind both gates above.

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// nfoMarketProtectionPct is the price buffer used to emulate a market order on
// F&O contracts. Zerodha rejects plain MARKET orders for F&O via the API, so a
// requested MARKET order is sent as a LIMIT priced this far past the current
// LTP (above for BUY, below for SELL). This mirrors Zerodha's own ~3% market
// protection: it fills like a market order while capping worst-case slippage.
// Increase it if fast-moving or illiquid contracts miss fills; decrease it to
// tighten slippage at the risk of non-fills.
const nfoMarketProtectionPct = 0.03

// nfoTickSize is the NFO price tick; limit prices must be a multiple of it.
const nfoTickSize = 0.05

func roundToTick(p float64) float64 {
	return math.Round(p/nfoTickSize) * nfoTickSize
}

// LiveOrder describes a real regular order to send to Zerodha.
type LiveOrder struct {
	TradingSymbol   string // e.g. "NIFTY2661623400CE" (no exchange prefix)
	Exchange        string // default NFO
	TransactionType string // BUY | SELL
	Quantity        int
	Product         string // default MIS (intraday)
	OrderType       string // default MARKET
}

// PlaceMarketOrder places a real regular order on Zerodha and returns the
// order_id. THIS MOVES REAL MONEY. Callers must already have verified that both
// the server master switch and the per-challenge live toggle are ON.
func (c *Client) PlaceMarketOrder(o LiveOrder) (string, error) {
	if !c.IsConnected() {
		return "", fmt.Errorf("kite not connected — login required")
	}
	if o.Exchange == "" {
		o.Exchange = "NFO"
	}
	if o.Product == "" {
		o.Product = "MIS"
	}
	if o.OrderType == "" {
		o.OrderType = "MARKET"
	}
	if o.Quantity <= 0 {
		return "", fmt.Errorf("invalid order quantity %d", o.Quantity)
	}
	tt := strings.ToUpper(o.TransactionType)
	if tt != "BUY" && tt != "SELL" {
		return "", fmt.Errorf("invalid transaction_type %q", o.TransactionType)
	}
	if o.TradingSymbol == "" {
		return "", fmt.Errorf("missing tradingsymbol")
	}

	// Zerodha does NOT accept plain MARKET orders for F&O via the API
	// ("Market orders without market protection are not allowed"). Convert a
	// requested MARKET order on NFO into a protective LIMIT priced past the LTP.
	orderType := strings.ToUpper(o.OrderType)
	limitPrice := 0.0
	if orderType == "MARKET" && strings.EqualFold(o.Exchange, "NFO") {
		inst := o.Exchange + ":" + o.TradingSymbol
		ltpMap, err := c.LTP(inst)
		if err != nil {
			return "", fmt.Errorf("fetching LTP to build protective limit for %s: %w", inst, err)
		}
		ltp := ltpMap[inst].LastPrice
		if ltp <= 0 {
			return "", fmt.Errorf("no live LTP for %s — cannot build protective limit order", inst)
		}
		if tt == "BUY" {
			limitPrice = roundToTick(ltp * (1 + nfoMarketProtectionPct))
		} else {
			limitPrice = roundToTick(ltp * (1 - nfoMarketProtectionPct))
		}
		orderType = "LIMIT"
	}

	form := url.Values{}
	form.Set("tradingsymbol", o.TradingSymbol)
	form.Set("exchange", o.Exchange)
	form.Set("transaction_type", tt)
	form.Set("order_type", orderType)
	form.Set("quantity", fmt.Sprintf("%d", o.Quantity))
	form.Set("product", o.Product)
	form.Set("validity", "DAY")
	if orderType == "LIMIT" {
		form.Set("price", strconv.FormatFloat(limitPrice, 'f', 2, 64))
	}

	body, status, err := c.postForm("/orders/regular", form)
	if err != nil {
		return "", err
	}

	var r struct {
		Status    string `json:"status"`
		Message   string `json:"message"`
		ErrorType string `json:"error_type"`
		Data      struct {
			OrderID string `json:"order_id"`
		} `json:"data"`
	}
	if e := json.Unmarshal(body, &r); e != nil {
		return "", fmt.Errorf("kite order: HTTP %d, unreadable response: %s", status, string(body))
	}
	if r.Status != "success" || r.Data.OrderID == "" {
		// Surface Kite's REAL reason (e.g. PermissionException, TokenException,
		// InputException, NetworkException) instead of a generic label.
		msg := r.Message
		if msg == "" {
			msg = string(body)
		}
		hint := ""
		switch r.ErrorType {
		case "PermissionException":
			hint = " — usually the static-IP rule: whitelist your public IPv4 at developers.kite.trade → Profile → IP Whitelist (orders are now forced over IPv4). If it persists, ensure the app has trading enabled."
		case "TokenException":
			hint = " — re-login to Zerodha."
		case "InputException":
			hint = " — order parameters were rejected (symbol/qty/product). Check lot size and that the contract is tradable."
		}
		return "", fmt.Errorf("kite order rejected (HTTP %d, %s): %s%s", status, r.ErrorType, msg, hint)
	}
	return r.Data.OrderID, nil
}

// postForm issues an authenticated form-encoded POST to the Kite REST API and
// returns the raw body and HTTP status. It does NOT translate error codes — the
// caller inspects Kite's JSON (status/error_type/message) so the real reason for
// a rejection is never masked.
func (c *Client) postForm(path string, form url.Values) ([]byte, int, error) {
	req, err := http.NewRequest(http.MethodPost, BaseURL+path, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("X-Kite-Version", "3")
	req.Header.Set("Authorization", c.authHeader())
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return b, resp.StatusCode, nil
}
