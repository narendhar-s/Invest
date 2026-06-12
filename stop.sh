#!/usr/bin/env bash
#
# stop.sh — stop StockWise (backend + frontend) without rebuilding.
#
# Usage:
#   ./stop.sh            # stop backend + frontend
#   ./stop.sh --backend  # stop backend only
#   ./stop.sh --frontend # stop frontend only
#
set -uo pipefail

DO_BACKEND=1
DO_FRONTEND=1
for arg in "$@"; do
  case "$arg" in
    --backend)  DO_FRONTEND=0 ;;
    --frontend) DO_BACKEND=0 ;;
    *) echo "unknown flag: $arg"; exit 1 ;;
  esac
done

ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }

if [ "$DO_BACKEND" -eq 1 ]; then
  pkill -f "bin/stockwise" 2>/dev/null && ok "killed backend (bin/stockwise)" || warn "no backend running"
  pkill -f "cmd/main.go"   2>/dev/null || true   # in case it was started with `go run`
  lsof -ti:8080 2>/dev/null | xargs kill -9 2>/dev/null && ok "freed port 8080" || true
fi

if [ "$DO_FRONTEND" -eq 1 ]; then
  pkill -f "vite" 2>/dev/null && ok "killed frontend (vite)" || warn "no frontend running"
  lsof -ti:5173 2>/dev/null | xargs kill -9 2>/dev/null && ok "freed port 5173" || true
fi

ok "Done."
