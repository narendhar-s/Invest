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

# ── Ensure a 4G swapfile exists so the Go+frontend build isn't OOM-killed ────
# Guarded so re-running the script doesn't recreate swap or duplicate the fstab
# line; the commands inside are exactly the manual swap setup.
if ! sudo swapon --show | grep -q '/swapfile'; then
  echo "→ Creating 4G swapfile (build is memory-heavy)..."
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi
free -h        # confirm swap shows up

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
echo "→ Recent app logs:"
docker compose -f "$COMPOSE_FILE" logs --tail=40 app

IP="$(curl -s ifconfig.me 2>/dev/null || echo '<VM_IP>')"
echo ""
echo "✓ Deployed. App: http://${IP}/naren/challenge"
echo "  Follow live logs with:  docker compose -f $COMPOSE_FILE logs -f app"
