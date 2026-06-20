#!/usr/bin/env bash
# Apply incremental Postgres migrations against the running stack.
#
# Why this exists
# ---------------
# infra/docker-compose.yml only mounts 00_create_databases.sql and
# 01_schema.sql into the container's /docker-entrypoint-initdb.d — and those
# *only* run on first DB init (empty data volume). Every numbered migration
# after 01 (02_*, …, 18_*) must therefore be applied explicitly on each
# deploy, or new columns/tables silently never reach the live database
# (symptom: gateway 500s on SELECTs referencing the new columns).
#
# All migrations 02+ are written to be idempotent (ADD COLUMN IF NOT EXISTS,
# CREATE TABLE/INDEX IF NOT EXISTS, INSERT … ON CONFLICT DO NOTHING), so this
# runner is safe to execute on every deploy.
#
# Usage:  scripts/apply_migrations.sh
# Env:    APP_DIR (default /opt/acb/app), PG_CONTAINER (default acb-postgres)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/acb/app}"
PG_CONTAINER="${PG_CONTAINER:-acb-postgres}"
MIGRATIONS_DIR="$APP_DIR/infra/postgres"

# Pull DB credentials from .env when present, else fall back to compose defaults.
ENV_FILE="$APP_DIR/.env"
PG_USER="acb"
PG_DB="acb"
if [ -f "$ENV_FILE" ]; then
  PG_USER="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  PG_DB="$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  PG_USER="${PG_USER:-acb}"
  PG_DB="${PG_DB:-acb}"
fi

say() { printf "\n==> %s\n" "$*"; }

if ! docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
  echo "ERROR: Postgres container '$PG_CONTAINER' is not running." >&2
  exit 1
fi

say "Applying migrations to db '$PG_DB' as '$PG_USER' (container: $PG_CONTAINER)"

# Apply 02+ in numeric order. 00/01 are init-only (handled by initdb on first
# boot) and contain statements that aren't re-runnable (CREATE DATABASE etc.).
shopt -s nullglob
applied=0
for f in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  base="$(basename "$f")"
  case "$base" in
    00_*|01_*) continue ;;  # init-only, skip
  esac
  printf "    - %s ... " "$base"
  if docker exec -i "$PG_CONTAINER" \
       psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -q < "$f" >/dev/null 2>/tmp/migrate_err; then
    echo "ok"
    applied=$((applied + 1))
  else
    echo "FAILED"
    echo "      ----- psql error -----" >&2
    sed 's/^/      /' /tmp/migrate_err >&2
    exit 1
  fi
done

say "Migrations complete ($applied file(s) applied idempotently)"
