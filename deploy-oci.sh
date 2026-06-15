#!/usr/bin/env bash
#
# One-shot (re)deploy for the OCI VM: pull latest code, rebuild the image,
# and (re)start the stack. Safe to run repeatedly — it's your "ship it" button.
#
#   ./deploy-oci.sh
#
# Optional env overrides:
#   BRANCH=sri-dev                 git branch to deploy
#   COMPOSE_FILE=docker-compose.oci-http.yml   compose file (use docker-compose.oci.yml for HTTPS+domain)
#   POSTGRES_PASSWORD=...          DB password (defaults to stockwise123 if unset)

set -euo pipefail

BRANCH="${BRANCH:-sri-dev}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.oci-http.yml}"
: "${POSTGRES_PASSWORD:=stockwise123}"
export POSTGRES_PASSWORD

cd "$(dirname "$0")"

# ── Ensure some swap exists so the Go+frontend build doesn't get OOM-killed ──
if [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
  echo "→ No swap detected — adding 4G swapfile (build is memory-heavy)..."
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# ── Pull latest code ─────────────────────────────────────────────────────────
echo "→ Pulling latest from origin/$BRANCH..."
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull origin "$BRANCH"

# Daily Zerodha token file must exist for the bind-mount
touch kite_token.json

# ── Build + (re)start ────────────────────────────────────────────────────────
echo "→ Building image and starting containers ($COMPOSE_FILE)..."
docker compose -f "$COMPOSE_FILE" up -d --build

echo "→ Pruning old dangling images..."
docker image prune -f >/dev/null 2>&1 || true

echo "→ Status:"
docker compose -f "$COMPOSE_FILE" ps

echo ""
echo "✓ Deployed. App: http://$(curl -s ifconfig.me 2>/dev/null || echo '<VM_IP>')/naren/challenge"
echo "  Tailing app logs (Ctrl+C to stop)…"
docker compose -f "$COMPOSE_FILE" logs -f app
