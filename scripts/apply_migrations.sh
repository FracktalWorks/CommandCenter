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
#         MIGRATION_LOCK_TIMEOUT (default 5s), MIGRATION_LOCK_RETRIES (default 5)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/acb/app}"
PG_CONTAINER="${PG_CONTAINER:-acb-postgres}"
MIGRATIONS_DIR="$APP_DIR/infra/postgres"

# --- Never WAIT for a lock. This is the whole outage, in one setting. ---------
#
# 2026-08-06: a gateway session sat `idle in transaction` on
# email_assistant_settings for 14h44m (a hung LLM call, with a SQLAlchemy session
# open across it). This runner then asked for ACCESS EXCLUSIVE on that table to
# replay `39_email_learned_writing_style.sql` — and waited.
#
# Waiting is what made it an outage rather than a slow deploy. Postgres's lock
# queue is FIFO: once an ACCESS EXCLUSIVE request is QUEUED, every later reader
# queues behind it, even though the reader would not have conflicted with the
# stale transaction it is ultimately waiting on. So one idle session plus one
# patient ALTER froze the table for the entire application. Sending mail reads
# email_assistant_settings for the signature; it stopped. Blocked readers each
# pinned a pooled connection until the pool drained, and endpoints with nothing
# to do with email started answering 500.
#
# With a lock_timeout the ALTER gives up in seconds and never enters the queue,
# so a stale reader can delay a migration but can no longer freeze a table.
# Retries absorb the ordinary case (a long-running query holding the table for a
# moment); exhausting them fails the deploy LOUDLY, which is the correct outcome
# and the one that used to be indistinguishable from a hang.
MIGRATION_LOCK_TIMEOUT="${MIGRATION_LOCK_TIMEOUT:-5s}"
MIGRATION_LOCK_RETRIES="${MIGRATION_LOCK_RETRIES:-5}"

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

# --- Prove the prelude PARSES before betting the whole ladder on it ----------
#
# Learned the hard way on the very first deploy that carried it: the prelude
# shipped as `SET lock_timeout = 5s;` — unquoted — and Postgres answers
# "trailing junk after numeric literal". Under ON_ERROR_STOP=1 that failed the
# FIRST migration, so a guard whose entire purpose was to stop a stalled session
# blocking deploys blocked every deploy itself. The tests missed it because they
# asserted the string was PRESENT, not that it was valid SQL, and the harness's
# fake psql drained stdin without parsing it.
#
# Two lessons, both encoded here:
#   1. Quote the value. '5s' and '5000' are both accepted; a bare 5s is not.
#   2. A safety feature must not be able to brick the thing it protects. If the
#      prelude does not parse — a typo'd MIGRATION_LOCK_TIMEOUT, a server that
#      spells it differently — say so LOUDLY and fall back to running without
#      it. Degrading to the previous behaviour is survivable; making the box
#      undeployable is not.
LOCK_PRELUDE="SET lock_timeout = '$MIGRATION_LOCK_TIMEOUT';"
if ! printf '%s\n' "$LOCK_PRELUDE" \
     | docker exec -i "$PG_CONTAINER" \
         psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -q \
         >/dev/null 2>/tmp/lock_probe_err; then
  echo "  !! lock_timeout prelude REJECTED by this server:" >&2
  sed 's/^/     /' /tmp/lock_probe_err >&2
  echo "  !! MIGRATION_LOCK_TIMEOUT='$MIGRATION_LOCK_TIMEOUT' is not a value it" >&2
  echo "     accepts. Applying migrations WITHOUT a lock timeout — a stale" >&2
  echo "     reader can once again freeze a table for every later query." >&2
  echo "     Fix the value; do not leave this in place." >&2
  LOCK_PRELUDE=""
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
  attempt=1
  while :; do
    # The prelude is prepended to the stream rather than passed as a psql flag so
    # it lands in the SAME session as the migration, ahead of any BEGIN the file
    # opens. Session-level, so one SET covers every statement in it. Empty when
    # the probe above rejected it, in which case the migration runs exactly as it
    # did before this guard existed.
    if { [ -n "$LOCK_PRELUDE" ] && printf '%s\n' "$LOCK_PRELUDE"; cat "$f"; } \
         | docker exec -i "$PG_CONTAINER" \
             psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -q \
             >/dev/null 2>/tmp/migrate_err; then
      echo "ok"
      applied=$((applied + 1))
      break
    fi
    # Only a LOCK timeout is retryable. Any other psql error is a real migration
    # failure and must not be papered over by trying it four more times.
    if grep -qi 'lock timeout' /tmp/migrate_err \
       && [ "$attempt" -lt "$MIGRATION_LOCK_RETRIES" ]; then
      printf "lock busy, retry %d/%d ... " "$attempt" "$MIGRATION_LOCK_RETRIES"
      sleep $((attempt * 5))
      attempt=$((attempt + 1))
      continue
    fi
    echo "FAILED"
    if grep -qi 'lock timeout' /tmp/migrate_err; then
      echo "      Could not acquire a lock on this table after $MIGRATION_LOCK_RETRIES tries." >&2
      echo "      Something is holding it. Find the holder before re-running:" >&2
      echo "        SELECT pid, state, now()-state_change AS dur, query" >&2
      echo "          FROM pg_stat_activity" >&2
      echo "         WHERE datname = '$PG_DB' AND state <> 'idle'" >&2
      echo "         ORDER BY state_change;" >&2
      echo "      A session 'idle in transaction' for minutes is a wedged app" >&2
      echo "      handler; pg_terminate_backend(<pid>) releases it." >&2
    fi
    echo "      ----- psql error -----" >&2
    sed 's/^/      /' /tmp/migrate_err >&2
    exit 1
  done
done

say "Migrations complete ($applied file(s) applied idempotently)"
