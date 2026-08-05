# Backup & Restore — BO-23

**Status:** scripts SHIPPED (agent-safe); scheduling + off-box copy OWNER-GATE
**Owner row:** FOUNDATION_BUILDOUT_CHECKLIST.md §BO-23
**Last measured:** 2026-08-03 against the live VPS (srv1747539)

---

## 1. What the recovery position actually was

Measured, not assumed — via the Hostinger API on 2026-08-03:

| | |
|---|---|
| Application-level backup | **none** — no dump, no cron, no script anywhere in the repo or on the box |
| Hostinger VM images | **2 retained**: `2026-07-22`, `2026-07-29` |
| Cadence | weekly |
| Age of newest image when measured | **5 days** |
| Worst-case RPO | **~7 days of data loss** |
| Restore time | `restore_time: 3457` ≈ **58 minutes** |
| Granularity | the **whole machine** — code, `.env`, Docker volumes, everything |
| VPS snapshot | **none** (`id: 0`, `created_at == expires_at`) |

Two consequences that matter more than the numbers:

1. **"Recover one dropped table" was not a thing this system could do.** The
   only lever reverted the entire VPS to a point up to a week earlier, taking
   the code and every other database with it.
2. **140+ migrations replay forward-only on every deploy** (`scripts/apply_migrations.sh`).
   A migration that corrupts data had no granular undo.

The databases are small — `acb` 193 MB, `litellm_proxy` 11 MB, 67 GB free — so
nightly full logical dumps are cheap. There was no cost reason for the gap.

## 2. What shipped

| File | Role |
|---|---|
| `scripts/backup_db.sh` | dump every non-template DB + globals, integrity-check, manifest, retention, optional off-box copy |
| `scripts/restore_db.sh` | restore — **to a scratch DB by default**, live only behind `--force` |

Both talk to Postgres through `docker exec acb-postgres`, so `pg_dump` is
always the same major version as the server. Credentials are read from
`/opt/acb/app/.env` exactly as `apply_migrations.sh` reads them, so the two can
never disagree about which cluster is "the" database.

### Design decisions worth not re-litigating

- **`-Fc` (custom format), not plain SQL.** A plain dump can only be replayed
  whole. Custom format lets `pg_restore --table gtd_task` pull one table out,
  which is the case that motivated the ticket.
- **Globals are dumped separately** (`pg_dumpall --globals-only`). Roles and
  passwords live in the cluster, not in any database. A per-database dump
  restored into a fresh cluster comes up with no roles and every `GRANT` in it
  fails — so a bare-metal rebuild would have been impossible from database
  dumps alone.
- **Databases are enumerated, not hardcoded.** `litellm_proxy` holds API keys
  and spend records and would have been silently missed by an `acb`-only backup.
- **Backups live in `/opt/acb/backups`, deliberately NOT under `/opt/acb/app`.**
  The deploy runs `git reset --hard`, which has already destroyed tracked
  runtime state in this repo's history. Anything under the app dir is one
  deploy away from being gone.
- **Every run integrity-checks the dump** with `pg_restore --list`. A truncated
  or half-written file fails at backup time rather than during an incident.
  This is the difference between having a backup and believing you have one.
- **`--verify-restore` proves a different claim.** The cheap check proves the
  file is *readable*; the deep check restores it into a scratch database and
  compares `public` table counts against live, proving it is *restorable*.
  ~20s on a 193 MB database.
- **Restore defaults to safe.** With no flags it builds `acb_restored_<ts>` and
  touches nothing live. Overwriting live needs `--target acb --force`, takes an
  unconditional pre-restore dump first, and stops the gateway so users are not
  served half-restored state.

## 3. Runbook

```bash
# what have we got?
scripts/restore_db.sh --list

# take one now
scripts/backup_db.sh --verify-restore

# incident: inspect last night's data without touching production
scripts/restore_db.sh
docker exec -it acb-postgres psql -U acb -d acb_restored_<ts>

# recover a single table
scripts/restore_db.sh --table gtd_task

# full rollback — DESTRUCTIVE, takes a safety dump first, stops the app
scripts/restore_db.sh --target acb --force
```

## 3a. 🔴 Merge precondition — read before landing the PR

`scripts/apply_migrations.sh` now **fails closed** without a pre-migration
dump, and that runner is on the release path. **`backup_db.sh` has never been
executed** — no agent was permitted to run it against the production database.

So the fail-closed gate is, until proven, an untested script that can break
every release. Run it by hand **once** before merging:

```bash
ssh <box> 'bash /opt/acb/app/scripts/backup_db.sh --verify-restore'
```

Expect `restore verified` and `public tables: live=N restored=N`. If it fails,
either fix it or land the PR with `SKIP_PRE_MIGRATION_BACKUP=1` set in the
release environment until it passes — do not merge and hope.

The script's own failure modes are bounded (it writes to a fresh timestamped
directory, and exits non-zero before touching anything), so a failed run costs
a directory, not data.

## 4. Still open — OWNER-GATE

These could not be completed by an agent. Two independent guards refused:
`plan-guard` blocks writes under `deploy/`, and the runtime classifier blocks
live VPS configuration changes. Both refusals were correct.

### 4.1 Schedule it (nothing runs automatically yet)

`scripts/backup_db.sh` exists but **no timer invokes it**. Until these two unit
files land in `deploy/hostinger/` and are enabled, backups happen only when
someone runs the script by hand. Contents are in §5 of this document.

```bash
sudo install -m 0644 /opt/acb/app/deploy/hostinger/acb-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now acb-backup.timer
sudo systemctl start acb-backup.service   # prove it works now, do not wait for 02:30
sudo systemctl status acb-backup.service
```

### 4.2 Off-box copy — the gap that still matters most

`BACKUP_REMOTE` is unset, so backups sit on the same disk as the database they
protect. That covers bad migrations and dropped tables. It does **not** cover
losing the disk, the box, or the provider account — and the Hostinger images
are still the only off-box copy, still weekly, still two deep.

Set `BACKUP_REMOTE` to an rsync destination on different infrastructure. The
script already implements the copy and warns loudly on every run while it is
unset.

### 4.3 PITR — deliberately NOT attempted

Point-in-time recovery needs `archive_mode = on`, an `archive_command`, a WAL
destination with real capacity, and **a Postgres restart**. That is a
production database restart plus a storage commitment, and it is a poor trade
before §4.1 and §4.2 exist. Nightly verified dumps take the RPO from ~7 days to
≤24 hours; PITR would take it to ~minutes, and is the right *next* step, not
the first one.

## 5. Unit files to create under `deploy/`

Blocked by `plan-guard`. Create verbatim.

**`deploy/hostinger/acb-backup.service`**

```ini
[Unit]
# BO-23 — nightly application-level Postgres backup.
# See scripts/backup_db.sh for why the Hostinger VM image is not sufficient.
Description=CommandCenter database backup (pg_dump + integrity check)
# The dump talks to the acb-postgres container, so Docker must be up first.
# Without this the unit races the Docker daemon on boot and exits 1 on
# "container is not running" — a failure that looks like a broken backup
# rather than a mis-ordered unit.
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
# Root: needs `docker exec` and write access to /opt/acb/backups.
User=root
# Invoked through bash on purpose — a checkout that loses the executable bit
# (Windows contributors, archive exports) would otherwise fail with a bare
# "Permission denied" and backups would silently never run. Same reasoning as
# acb-health-watchdog.service.
ExecStart=/bin/bash /opt/acb/app/scripts/backup_db.sh --verify-restore
TimeoutStartSec=1800
```

**`deploy/hostinger/acb-backup.timer`**

```ini
[Unit]
Description=Nightly CommandCenter database backup
Documentation=file:///opt/acb/app/ai-company-brain/specs/backup_and_restore.md

[Timer]
# 02:30 UTC — clear of the 05:00 UTC Monday codebase-health job, so a long
# verify restore cannot contend with it.
OnCalendar=*-*-* 02:30:00
# The box does get rebooted. Persistent=true runs a missed backup on the next
# boot instead of silently skipping a day — the exact gap you would only
# discover while trying to restore it.
Persistent=true
RandomizedDelaySec=5min
AccuracySec=1min
Unit=acb-backup.service

[Install]
WantedBy=timers.target
```

## 6. Verification owed

Once §4.1 is done, the ticket is closed by evidence, not by the files existing:

```bash
# 1. a backup exists and self-verified
sudo systemctl start acb-backup.service && journalctl -u acb-backup -n 40 --no-pager
#    expect: "restore verified" and "public tables: live=N restored=N"

# 2. a restore actually produces the data
scripts/restore_db.sh
docker exec acb-postgres psql -U acb -d acb_restored_<ts> \
  -tAc "select count(*) from app_user"
#    expect: matches MANIFEST.txt's app_user count

# 3. the timer is armed
systemctl list-timers acb-backup.timer
```

Until step 2 has been run once against a real dump, this system has scripts,
not a tested restore path — which is the state BO-23 exists to end.
