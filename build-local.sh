#!/usr/bin/env bash
#
# Run this ON YOUR MAC. It builds everything locally (where there's RAM),
# cross-compiles the Go binary for the VM's linux/amd64, commits the artifacts,
# and pushes — so the tiny VM only has to RUN them, never build them.
#
#   ./build-local.sh
#
# Then on the VM:
#   COMPOSE_FILE=docker-compose.oci-runtime.yml ./deploy-oci.sh

set -euo pipefail
cd "$(dirname "$0")"
BRANCH="${BRANCH:-sri-dev}"

echo "→ Building Invest SPA (frontend)…"
( cd frontend && npm install && npm run build )

echo "→ Building Naren SPA (frontend-naren)…"
( cd frontend-naren && npm install && npm run build )

echo "→ Cross-compiling Go binary for linux/amd64…"
mkdir -p bin
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o bin/stockwise-linux-amd64 ./cmd

echo "→ Committing pre-built artifacts (force-add: they're normally gitignored)…"
git add -f bin/stockwise-linux-amd64 frontend/dist frontend-naren/dist
git add -A
git commit -m "prebuilt artifacts $(date +%F-%H%M)" || echo "  (nothing new to commit)"
git push origin "$BRANCH"

echo ""
echo "✓ Built and pushed. Now on the VM run:"
echo "    cd ~/Invest && COMPOSE_FILE=docker-compose.oci-runtime.yml ./deploy-oci.sh"
