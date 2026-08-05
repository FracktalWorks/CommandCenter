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

# --- Take a backup BEFORE replaying the ladder (BO-23 done-when 4) ----------
# The migrations below are idempotent but forward-only: there are no down
# migrations, and they run under ON_ERROR_STOP=1. A migration that corrupts
# data rather than failing outright leaves nothing to roll back to. Taking the
# dump here — rather than in the deploy YAML — means it also covers anyone who
# runs this script by hand, which is exactly when it is most likely to matter.
#
# Fail CLOSED: if the backup cannot be taken, the migrations do not run. The
# escape hatch is explicit and has to be typed on purpose.
BACKUP_SCRIPT="$APP_DIR/scripts/backup_db.sh"
if [ "${SKIP_PRE_MIGRATION_BACKUP:-0}" = "1" ]; then
  say "Pre-migration backup SKIPPED (SKIP_PRE_MIGRATION_BACKUP=1)"
elif [ -x "$BACKUP_SCRIPT" ] || [ -f "$BACKUP_SCRIPT" ]; then
  say "Pre-migration backup"
  # No --verify-restore here: the deploy path is latency-sensitive and the
  # nightly timer already carries the deep check. The cheap pg_restore --list
  # integrity check inside backup_db.sh still runs on every dump.
  if ! bash "$BACKUP_SCRIPT"; then
    echo "ERROR: pre-migration backup FAILED — refusing to apply migrations." >&2
    echo "       Fix the backup, or re-run with SKIP_PRE_MIGRATION_BACKUP=1 if" >&2
    echo "       you accept replaying 140+ forward-only migrations with no" >&2
    echo "       restore point." >&2
    exit 1
  fi
else
  # Not fatal only because this script predates backup_db.sh and may be run
  # from an older checkout; say so loudly rather than passing silently.
  echo "  !! $BACKUP_SCRIPT not found — applying migrations WITHOUT a backup." >&2
fi

say "Applying migrations to db '$PG_DB' as '$PG_USER' (container: $PG_CONTAINER)"

# Apply 02+ in numeric order. Only NUMBERED migration files (NN_*.sql) are
# applied — non-numbered .sql files in this dir are reference artifacts, NOT
# migrations. In particular schema.generated.sql is a full pg_dump snapshot (the
# consolidated schema, for humans/tools) whose raw CREATE TYPE/TABLE statements
# are NOT idempotent and MUST NOT be replayed onto an already-migrated DB (it
# errors with `type "..." already exists`). 00/01 are init-only (handled by
# initdb on first boot) and contain statements that aren't re-runnable.
shopt -s nullglob
applied=0
# Match 2-OR-MORE-digit numeric prefixes (NN_ … NNN_) and apply in NUMERIC
# order. `sort -V` (version sort) is essential now that 3-digit numbers exist:
# plain lexical `sort` puts "100_" BEFORE "99_", which would run a later
# migration before an earlier one. The 2-digit scheme filled up at 99, so
# migrations continue at 100+.
for f in $(ls "$MIGRATIONS_DIR"/[0-9][0-9]*_*.sql | sort -V); do
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
