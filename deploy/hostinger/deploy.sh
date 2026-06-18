#!/usr/bin/env bash
# Pull latest images, bring the stack up, wait for healthchecks, run smoke.
# Idempotent. Safe to run on every git pull.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/acb/app}"
cd "$APP_DIR"

say()  { printf "\n==> %s\n" "$*"; }

# ── Preserve runtime agent registry ───────────────────────────────────────
# agents.json is mutated by the Control Plane UI (Add Agent).  If the caller
# did a `git reset --hard` before this script, the runtime registrations
# would be lost.  Restore from a pre-reset backup when available.
if [ -s /tmp/acb-agents.json.bak ]; then
  cp /tmp/acb-agents.json.bak apps/gateway/agents.json
  say "Restored runtime agents.json ($(wc -l < apps/gateway/agents.json) lines)"
fi

say "Pulling images"
docker compose -f infra/docker-compose.yml pull

# ── Memory-layer: disabled by default on 4GB VPS to save ~500MB RAM ──
# MEM0 (episodic) still works via Postgres+pgvector without Neo4j.
# Re-enable GRAPHITI_ENABLED=true + --profile memory after upgrading VPS.
say "Ensuring memory-layer env vars (Neo4j disabled for low-memory VPS)"
ENV_FILE="/opt/acb/app/.env"
for _var in MEM0_ENABLED GRAPHITI_ENABLED; do
  if ! grep -qE "^${_var}=" "$ENV_FILE" 2>/dev/null; then
    case "$_var" in
      MEM0_ENABLED)       echo "MEM0_ENABLED=true" >> "$ENV_FILE" ;;
      GRAPHITI_ENABLED)   echo "GRAPHITI_ENABLED=false" >> "$ENV_FILE" ;;
    esac
    printf "    + added %s to .env\n" "$_var"
  fi
done
# Ensure GRAPHITI stays off for this VPS size (idempotent)
if grep -qE '^GRAPHITI_ENABLED=true' "$ENV_FILE" 2>/dev/null; then
  sed -i 's/^GRAPHITI_ENABLED=true/GRAPHITI_ENABLED=false/' "$ENV_FILE"
  say "Disabled GRAPHITI (Neo4j) — saves ~500MB RAM; re-enable after VPS upgrade"
fi

say "Booting stack (core only — memory profile disabled for 4GB VPS)"
set -a && source /opt/acb/app/.env && set +a
docker compose -f infra/docker-compose.yml --profile core up -d --remove-orphans

say "Waiting for healthchecks (up to 90s)"
deadline=$(( $(date +%s) + 90 ))
while [ $(date +%s) -lt $deadline ]; do
  unhealthy=$(docker ps --filter "label=com.docker.compose.project=acb" --format '{{.Names}}\t{{.Status}}' \
              | awk '$0 ~ /unhealthy|starting/ {print $1}')
  if [ -z "$unhealthy" ]; then break; fi
  sleep 3
done
docker ps --filter "label=com.docker.compose.project=acb" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

if [ ! -d .venv ]; then
  say "First run: installing uv + python deps"
  if ! command -v uv >/dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
  fi
  uv sync
fi

say "Restarting Caddy"
sudo systemctl restart caddy || true

say "Probing services"
uv run python scripts/check_infra.py || {
  echo "infra probe failed; check: docker compose -f infra/docker-compose.yml logs --tail=100"
  exit 1
}

echo
echo "Deployed. Visit https://<your-gateway-host>/health to sanity-check."