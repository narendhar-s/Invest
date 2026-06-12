# NarenInvestment → Invest merge

NarenInvestment is now bundled inside the Invest project as an isolated, additive
feature set. Invest's own code, routes, and behaviour are unchanged — everything
Naren adds lives under separate namespaces so the two can't collide.

## What was added (all additive)

**Backend (single binary, module `stockwise`)**
- `internal/naren/**` — the entire NarenInvestment Go backend, namespaced. Every
  import was rewritten `stockwise/internal/...` → `stockwise/internal/naren/...`
  and `stockwise/pkg/config` → `stockwise/internal/naren/config`, so Naren's
  packages are fully independent of Invest's same-named packages.
- `internal/naren/api/router.go` — Naren's old `NewRouter` was refactored into
  `Mount(r, repo, engine, cfg, news, logger)`, which registers all Naren routes
  on the existing Gin engine under **`/api/naren/v1`** (no `/api/v1` collisions).
  The paper-trade safety guard (blocks any `/orders`, `/gtt`, `/basket`) is kept,
  but scoped to the Naren group so it can never affect Invest routes.
- `cmd/naren_integration.go` — `mountNaren(...)`: loads `config.naren.yaml`,
  opens a Naren DB repo (same Postgres, migrates Naren's extra tables),
  mounts the routes, serves the Naren SPA assets, and bridges the shared Kite
  token. Best-effort: if it fails, Invest still boots normally.
- `config.naren.yaml` — Naren's services (Angel One, Kite, Mongo, markets).

**Frontend (separate sub-app)**
- `frontend-naren/**` — NarenInvestment's React app, served by the backend at
  **`/naren`**. `vite base` is `/naren/`, `BrowserRouter basename` is `/naren`,
  and every API call was rewritten `/api/v1` → `/api/naren/v1`.

**Edits to existing Invest files (additive only — 4 files)**
- `cmd/main.go` — one call: `mountNaren(router, repo, cfg)`.
- `internal/api/router.go` — `NoRoute` serves the Naren SPA shell for `/naren/*`.
- `frontend/src/components/Navbar.tsx` — Naren tabs (⚡ 1-Lot, 🪁 Kite,
  🏆 Challenge, 🔎 Screener, 🚀 Naren Suite) as full-page links into `/naren`.
- `frontend/vite.config.ts` — dev proxy for `/naren` → backend.
- `go.mod` / `go.sum` — adopted Naren's superset (adds mongo-driver, gorilla
  websocket, pquerna/otp, excelize; bumps `golang.org/x/*`). Go 1.24.

## Shared Zerodha Kite credentials

Both halves now use **Invest's Kite app key** (`rhwcpeoekvr0j875`). Because the
key is shared, a single Zerodha login produces one access token valid for both.
On startup `mountNaren` copies Invest's saved token (if issued today) into
`kite_token.json`, which the Naren side reads — so connecting Zerodha once on the
Invest side lights up the Naren Kite features. (If you connect Invest *after*
startup, restart once, or use the Naren Kite Terminal's own login.)

## Build & run (on your Mac)

```bash
cd Invest
./restart.sh           # builds frontend-naren/dist, builds ./cmd, runs on :8080
# Invest dev UI:  http://localhost:5173   (Naren tabs proxy through to the backend)
# Everything also served by the binary at http://localhost:8080
#   Invest:  http://localhost:8080/
#   Naren:   http://localhost:8080/naren/
```

API namespaces: Invest `=/api/v1/...`, Naren `=/api/naren/v1/...`.

> Note: the merged Go backend was assembled but could **not** be compiled in this
> environment (no Go toolchain / network here). Run `go build ./cmd` once on your
> Mac to confirm; both frontends already pass `tsc` type-checking.
