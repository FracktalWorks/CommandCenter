#!/usr/bin/env bash
# BO-23 — restore a Postgres backup taken by scripts/backup_db.sh.
#
# The default is deliberately the SAFE one
# ----------------------------------------
# With no flags this restores into a scratch database named acb_restored_<ts>
# and touches nothing live. That is the operation you actually want during an
# incident: get the old data somewhere you can query it, compare, and copy out
# the rows you need. Overwriting the live database is a much rarer and much
# more destructive act, so it requires saying so explicitly (--target acb
# --force) and it takes a safety dump first.
#
# Usage:
#   scripts/restore_db.sh --list
#   scripts/restore_db.sh                             # newest -> scratch DB
#   scripts/restore_db.sh --from 2026-08-03T151500Z   # a specific backup
#   scripts/restore_db.sh --db litellm_proxy          # a different database
#   scripts/restore_db.sh --table gtd_task            # one table only
#   scripts/restore_db.sh --target acb --force        # DESTRUCTIVE, see below
#
# Env: BACKUP_DIR (default /opt/acb/backups), PG_CONTAINER (default acb-postgres)
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/acb/backups}"
PG_CONTAINER="${PG_CONTAINER:-acb-postgres}"
APP_DIR="${APP_DIR:-/opt/acb/app}"
FROM=""; DB="acb"; TARGET=""; FORCE=0; TABLE=""; LIST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --list)   LIST=1; shift ;;
    --from)   FROM="$2"; shift 2 ;;
    --db)     DB="$2"; shift 2 ;;
    --table)  TABLE="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --force)  FORCE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say()  { printf "\n==> %s\n" "$*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }

ENV_FILE="$APP_DIR/.env"
PG_USER="acb"
if [ -f "$ENV_FILE" ]; then
  PG_USER="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  PG_USER="${PG_USER:-acb}"
fi

if [ "$LIST" = "1" ]; then
  say "Backups in $BACKUP_DIR"
  for d in "$BACKUP_DIR"/[0-9]*Z; do
    [ -d "$d" ] || continue
    printf "  %s  (%s)\n" "$(basename "$d")" "$(du -sh "$d" | cut -f1)"
    grep -E '^(app_commit|migration_files|app_user|email_message|gtd_task):' \
      "$d/MANIFEST.txt" 2>/dev/null | sed 's/^/      /'
  done
  exit 0
fi

# Newest backup unless one was named. Lexical == chronological (ISO-8601 UTC).
if [ -z "$FROM" ]; then
  FROM="$(ls -1d "$BACKUP_DIR"/[0-9]*Z 2>/dev/null | tail -1 | xargs -r basename)"
  [ -n "$FROM" ] || die "no backups found in $BACKUP_DIR"
fi
SRC="$BACKUP_DIR/$FROM/$DB.dump"
[ -f "$SRC" ] || die "no dump for database '$DB' in $BACKUP_DIR/$FROM"

# Re-check integrity before doing anything. The backup script checked this when
# it was written; disks rot, and a restore is exactly when you find out.
docker exec -i "$PG_CONTAINER" pg_restore --list > /dev/null < "$SRC" 2>/dev/null \
  || die "$SRC is unreadable — pick an older backup"

say "Source: $SRC"
sed -n '1,8p' "$BACKUP_DIR/$FROM/MANIFEST.txt" 2>/dev/null | sed 's/^/    /'

# --- Destructive path --------------------------------------------------------
if [ -n "$TARGET" ] && [ "$TARGET" = "$DB" ]; then
  [ "$FORCE" = "1" ] || die "refusing to overwrite live database '$TARGET' without --force"

  # A restore over a live database is itself a chance to lose data — if the
  # dump turns out to be older or thinner than you thought, the current state
  # is already gone. Take a safety dump FIRST, unconditionally.
  say "Safety dump of CURRENT '$TARGET' before overwriting"
  PRE="$BACKUP_DIR/pre-restore-$(date -u '+%Y-%m-%dT%H%M%SZ')"
  mkdir -p "$PRE"
  docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$TARGET" -Fc > "$PRE/$TARGET.dump"
  echo "    saved -> $PRE/$TARGET.dump"

  # Stop the app before swapping the database under it. Left running, the
  # gateway holds connections (blocking the drop) and serves half-restored
  # state to users while the restore is in flight.
  say "Stopping gateway + workbench"
  systemctl stop acb-gateway acb-workbench || true

  say "Restoring into '$TARGET' (clean)"
  # --clean --if-exists drops each object before recreating it, so this is a
  # true replacement rather than a merge into whatever is already there.
  docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$TARGET" \
      --clean --if-exists --no-owner --no-acl < "$SRC" 2>&1 | tail -20 || true

  say "Restarting gateway + workbench"
  systemctl start acb-gateway acb-workbench
  echo "    if anything looks wrong, the pre-restore state is at $PRE"
  exit 0
fi

# --- Safe path (default) -----------------------------------------------------
SCRATCH="${TARGET:-acb_restored_$(date -u +%Y%m%d%H%M%S)}"
say "Restoring into SCRATCH database '$SCRATCH' — nothing live is touched"
docker exec "$PG_CONTAINER" createdb -U "$PG_USER" "$SCRATCH" 2>/dev/null || true

if [ -n "$TABLE" ]; then
  # Single-table extraction is the whole reason for the -Fc custom format.
  say "Restoring only table '$TABLE'"
  docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$SCRATCH" \
      --no-owner --no-acl --table "$TABLE" < "$SRC" 2>&1 | tail -20 || true
else
  docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$SCRATCH" \
      --no-owner --no-acl < "$SRC" 2>&1 | tail -20 || true
fi

say "Done — '$SCRATCH' is populated and the live database is untouched."
cat <<EOF
    Inspect it:
      docker exec -it $PG_CONTAINER psql -U $PG_USER -d $SCRATCH

    Copy rows back into live (example):
      INSERT INTO gtd_task SELECT * FROM ${SCRATCH}.public.gtd_task WHERE ...
      -- cross-database SELECT needs postgres_fdw or dblink; the usual route is
      -- pg_dump -t <table> the scratch DB and psql it into live.

    Drop it when finished:
      docker exec $PG_CONTAINER dropdb -U $PG_USER $SCRATCH
EOF
