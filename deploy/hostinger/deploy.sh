#!/usr/bin/env bash
# Pull latest images, bring the stack up, wait for healthchecks, run smoke.
# Idempotent. Safe to run on every git pull.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/acb/app}"
cd "$APP_DIR"

say()  { printf "\n==> %s\n" "$*"; }

say "Pulling images"
docker compose -f infra/docker-compose.yml pull

# ── Ensure memory-layer env vars exist in .env (idempotent) ─────────
# MEM0_ENABLED / GRAPHITI_ENABLED were added after initial bootstrap so
# existing .env files may not have them.  Append defaults if missing.
say "Ensuring memory-layer env vars"
ENV_FILE="/opt/acb/app/.env"
for _var in MEM0_ENABLED GRAPHITI_ENABLED NEO4J_URL NEO4J_USER NEO4J_PASSWORD; do
  if ! grep -qE "^${_var}=" "$ENV_FILE" 2>/dev/null; then
    case "$_var" in
      MEM0_ENABLED)       echo "MEM0_ENABLED=true" >> "$ENV_FILE" ;;
      GRAPHITI_ENABLED)   echo "GRAPHITI_ENABLED=true" >> "$ENV_FILE" ;;
      NEO4J_URL)          echo "NEO4J_URL=bolt://localhost:7687" >> "$ENV_FILE" ;;
      NEO4J_USER)         echo "NEO4J_USER=neo4j" >> "$ENV_FILE" ;;
      NEO4J_PASSWORD)     echo "NEO4J_PASSWORD=neo4j_dev_change_me" >> "$ENV_FILE" ;;
    esac
    printf "    + added %s to .env\n" "$_var"
  fi
done

say "Booting stack (core + memory)"
set -a && source /opt/acb/app/.env && set +a
docker compose -f infra/docker-compose.yml --profile core --profile memory up -d --remove-orphans

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