#!/usr/bin/env bash
# Pull latest images, bring the stack up, wait for healthchecks, run smoke.
# Idempotent. Safe to run on every git pull.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/acb/app}"
cd "$APP_DIR"

say()  { printf "\n==> %s\n" "$*"; }

say "Pulling images"
docker compose -f infra/docker-compose.yml pull

say "Booting stack (core + obs)"
docker compose -f infra/docker-compose.yml --profile core --profile obs up -d --remove-orphans

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

say "Reloading Caddy (in case Caddyfile changed)"
sudo systemctl reload caddy || true

say "Probing services"
uv run python scripts/check_infra.py || {
  echo "infra probe failed; check: docker compose -f infra/docker-compose.yml logs --tail=100"
  exit 1
}

echo
echo "Deployed. Visit https://<your-gateway-host>/health to sanity-check."