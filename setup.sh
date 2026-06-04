#!/usr/bin/env bash
# Stockwise (Invest) – one-shot setup & build script for macOS.
#
# What it does:
#   1. Installs Homebrew if missing.
#   2. Installs Go 1.22+, Node 20+, and Docker (Docker Desktop cask) if missing.
#   3. Downloads Go module dependencies and builds the backend binary -> bin/stockwise
#   4. Installs frontend npm dependencies and builds the production bundle -> frontend/dist
#   5. (Optional) starts the postgres container via docker compose.
#
# Usage:
#   chmod +x setup.sh
#   ./setup.sh             # install + build everything
#   ./setup.sh --start     # also start postgres + run the app
#
# Re-running is safe: every step is idempotent.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# ---------- pretty logging ----------
log()  { printf "\033[1;34m[setup]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[warn]\033[0m  %s\n" "$*"; }
err()  { printf "\033[1;31m[err]\033[0m   %s\n" "$*" >&2; }

need_cmd() { command -v "$1" >/dev/null 2>&1; }

# ---------- 1. Homebrew ----------
ensure_brew() {
  if need_cmd brew; then
    log "Homebrew already installed: $(brew --version | head -n1)"
    return
  fi
  log "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # add brew to PATH for the current shell (Apple Silicon vs Intel)
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

# ---------- 2. Toolchain ----------
ensure_go() {
  if need_cmd go; then
    log "Go already installed: $(go version)"
  else
    log "Installing Go..."
    brew install go
  fi
}

ensure_node() {
  if need_cmd node && need_cmd npm; then
    log "Node already installed: $(node --version)  npm $(npm --version)"
  else
    log "Installing Node 20..."
    brew install node@20
    brew link --overwrite --force node@20 || true
  fi
}

ensure_docker() {
  if need_cmd docker; then
    log "Docker CLI already installed: $(docker --version)"
  else
    log "Installing Docker Desktop (cask). You may be prompted for your password."
    brew install --cask docker
    warn "Open Docker Desktop once so the daemon starts, then re-run this script with --start."
  fi
}

# ---------- 3. Backend ----------
build_backend() {
  log "Downloading Go module dependencies..."
  go mod download
  log "Building backend binary -> bin/stockwise"
  mkdir -p bin
  go build -o bin/stockwise ./cmd/main.go
  log "Backend built: $(ls -lh bin/stockwise | awk '{print $5, $9}')"
}

# ---------- 4. Frontend ----------
build_frontend() {
  log "Installing frontend npm dependencies..."
  (cd frontend && npm install --no-audit --no-fund)
  log "Building frontend production bundle..."
  (cd frontend && npm run build)
  log "Frontend built -> frontend/dist"
}

# ---------- 5. Optional: start the stack ----------
start_stack() {
  if ! docker info >/dev/null 2>&1; then
    err "Docker daemon is not running. Open Docker Desktop and re-run with --start."
    exit 1
  fi
  log "Starting postgres via docker compose..."
  docker compose up -d postgres
  log "Waiting for postgres to be healthy..."
  until docker compose exec -T postgres pg_isready -U stockwise -d stockwise_db >/dev/null 2>&1; do
    sleep 1
  done
  log "Postgres is ready. Launching backend on :8080..."
  ./bin/stockwise
}

main() {
  log "Project root: $PROJECT_ROOT"
  ensure_brew
  ensure_go
  ensure_node
  ensure_docker
  build_backend
  build_frontend

  log "Build complete."
  log "  Backend  : ./bin/stockwise"
  log "  Frontend : ./frontend/dist (or run 'cd frontend && npm run dev' for live reload)"
  log "  DB       : 'docker compose up -d postgres' before running the backend"

  if [[ "${1:-}" == "--start" ]]; then
    start_stack
  else
    log "Run './setup.sh --start' to bring up postgres and start the backend."
  fi
}

main "$@"
