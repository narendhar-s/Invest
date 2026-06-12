package kite

// ─── TRADING SAFETY CONTRACT — PAPER BY DEFAULT ──────────────────────────────
//
// This app is paper-trading by default. A single, explicitly gated exception
// exists: the 90-day options challenge's "Live Trading" mode, which places REAL
// Zerodha orders via Client.PlaceMarketOrder (see orders.go).
//
// WHAT IS ALWAYS ALLOWED (read-only Kite API):
//   GET  /instruments            — download instrument master
//   GET  /quote                  — fetch live prices
//   GET  /instruments/historical — fetch OHLCV candles
//   GET  /ltp                    — fetch last-traded prices
//   POST /session/token          — exchange OAuth token (authentication only)
//   WS   wss://ws.kite.trade     — stream real-time ticks
//
// REAL ORDERS — POST /orders/regular via PlaceMarketOrder — are permitted ONLY
// when BOTH gates are on:
//   1. server master switch  config kite.live_trading_enabled = true (default false)
//   2. the per-challenge Live toggle in the UI (default OFF, and OFF after restart)
// With either gate off, no order method is ever reached and the app is paper-only.
//
// STILL FORBIDDEN (never implemented): order modify/cancel, GTT, basket, and any
// portfolio write. The router's middleware also blocks inbound /orders /gtt
// /basket URL patterns. The Ticker remains read-only. All paper positions live
// only in the local PostgreSQL database.

const (
	// PaperTradeOnly is a compile-time constant that documents the safety contract.
	// It cannot be set to false — removing this file would break the build.
	PaperTradeOnly = true

	// ForbiddenEndpoints lists the Kite API paths that must never be called.
	ForbiddenEndpoints = "/orders /gtt /basket /portfolio (write)"
)

// OrdersAreForbidden is a no-op guard that serves as an explicit marker.
// Any future developer who accidentally adds order logic should search
// for this constant and read the safety contract above.
func assertNeverOrders() {
	// This function intentionally left empty.
	// The safety is in NOT having PlaceOrder/ModifyOrder methods on Client,
	// in the router middleware, and in this file being in the package.
	_ = PaperTradeOnly
}
