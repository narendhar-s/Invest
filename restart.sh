#!/usr/bin/env bash
#
# restart.sh — kill, rebuild, and rerun StockWise (backend + frontend).
#
# Usage:
#   ./restart.sh            # backend + frontend (dev)
#   ./restart.sh --backend  # backend only
#   ./restart.sh --frontend # frontend only
#   ./restart.sh --no-db    # skip starting the postgres container
#
set -euo pipefail

# Always operate from the repo root (directory this script lives in).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

DO_BACKEND=1
DO_FRONTEND=1
DO_DB=1
for arg in "$@"; do
  case "$arg" in
    --backend)  DO_FRONTEND=0 ;;
    --frontend) DO_BACKEND=0 ;;
    --no-db)    DO_DB=0 ;;
    *) echo "unknown flag: $arg"; exit 1 ;;
  esac
done

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }

# ── 1. Kill anything currently running ────────────────────────────────────────
log "Stopping running processes…"
pkill -f "bin/stockwise"  2>/dev/null && ok "killed backend (bin/stockwise)" || warn "no backend running"
pkill -f "cmd/main.go"    2>/dev/null || true   # in case it was started with `go run`
if [ "$DO_FRONTEND" -eq 1 ]; then
  pkill -f "vite"         2>/dev/null && ok "killed frontend (vite)" || warn "no frontend running"
fi
# Free the ports as a backstop (ignore failures).
lsof -ti:8080 2>/dev/null | xargs kill -9 2>/dev/null || true
[ "$DO_FRONTEND" -eq 1 ] && { lsof -ti:5173 2>/dev/null | xargs kill -9 2>/dev/null || true; }
sleep 1

# ── 2. Backend: ensure DB, rebuild, run ───────────────────────────────────────
if [ "$DO_BACKEND" -eq 1 ]; then
  if [ "$DO_DB" -eq 1 ]; then
    log "Ensuring PostgreSQL is up…"
    docker compose up -d postgres >/dev/null 2>&1 && ok "postgres up" || warn "could not start postgres (is Docker running?)"
  fi

  log "Building backend…"
  go build -o bin/stockwise ./cmd/main.go
  ok "build succeeded"

  log "Starting backend on :8080…"
  ./bin/stockwise > backend.log 2>&1 &
  BACKEND_PID=$!
  sleep 2
  if kill -0 "$BACKEND_PID" 2>/dev/null; then
    ok "backend running (pid $BACKEND_PID) — logs: backend.log"
  else
    warn "backend exited immediately — check backend.log"
    tail -n 20 backend.log || true
    exit 1
  fi
fi

# ── 3. Frontend: install (fast if cached) + dev server ────────────────────────
if [ "$DO_FRONTEND" -eq 1 ]; then
  log "Installing frontend deps…"
  ( cd frontend && npm install --silent )
  ok "deps ready"

  log "Starting frontend dev server on :5173…"
  ( cd frontend && npm run dev > ../frontend.log 2>&1 & )
  sleep 2
  ok "frontend starting — logs: frontend.log"
fi

echo
ok "Done."
[ "$DO_BACKEND" -eq 1 ]  && echo "  API:      http://localhost:8080"
[ "$DO_FRONTEND" -eq 1 ] && echo "  Frontend: http://localhost:5173"
echo "  Tail logs: tail -f backend.log frontend.log"
