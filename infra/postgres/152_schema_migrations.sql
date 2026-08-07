-- 152_schema_migrations.sql — the migration ledger (BO-6, first step)
--
-- Until this table, `scripts/apply_migrations.sh` replayed EVERY numbered
-- migration on EVERY deploy — 151 files by the time this landed. That worked
-- only because each file is hand-written to be idempotent, which is a property
-- of 151 separate authors' care rather than of the system, and nobody had ever
-- verified it as a whole.
--
-- It also had a cost that is not theoretical. Replaying the ladder takes
-- ACCESS EXCLUSIVE locks it does not need: an `ALTER TABLE ... ADD COLUMN IF
-- NOT EXISTS` still queues for the lock even when the column is already there.
-- On 2026-08-06 one such queued ALTER, behind a session left `idle in
-- transaction`, froze every later reader of that table and took the app down.
-- Fewer statements asking for fewer locks is the direct mitigation.
--
-- What the ledger is NOT, yet: Alembic. There are still no down-migrations and
-- no autogenerate. This is the piece Alembic would need anyway — its
-- `alembic_version` is the same idea — and it is the piece that pays for itself
-- immediately, which is why BO-6 is being taken in this order.
--
-- Recorded by filename rather than by a serial: the numeric prefix is already
-- the ordering key, and `test_migration_prefixes.py` guarantees it is unique.

CREATE TABLE IF NOT EXISTS schema_migrations (
  --: The file's basename, e.g. '144_crm.sql'. Primary key because applying the
  --: same migration twice is the thing this table exists to prevent.
  filename    text PRIMARY KEY,

  --: sha256 of the file's bytes as applied. Lets the runner tell "already
  --: applied" from "applied, then edited" — the second is a real bug class:
  --: the edit silently never reaches any box that already ran the original.
  checksum    text NOT NULL,

  applied_at  timestamptz NOT NULL DEFAULT now(),

  --: How long it took. Cheap to record, and the only way to answer "which
  --: migration is making deploys slow" without instrumenting a deploy.
  duration_ms integer
);

--: Deploy logs answer "what changed last night?" from this, and the natural
--: query is by time, not by name.
CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at
  ON schema_migrations (applied_at DESC);

COMMENT ON TABLE schema_migrations IS
  'Which numbered migrations have been applied to this database (BO-6). '
  'Written by scripts/apply_migrations.sh. Deleting a row causes that '
  'migration to be re-applied on the next deploy; deleting the table causes '
  'the whole ladder to replay, which is the pre-ledger behaviour and safe '
  'because every file is idempotent.';
