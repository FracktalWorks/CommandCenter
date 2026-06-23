-- Deep-vs-shallow sync gating.
--
-- Splits the one-time INITIAL deep sync (≈1 year of history across all folders)
-- from cheap RECURRING polls. Without this flag every poll re-swept up to 10
-- pages/folder; now the deep sweep runs once per account and recurring polls
-- stay shallow.
--
-- Existing accounts default to false, so each runs exactly one deep 1-year
-- backfill on its next sync cycle (auto-backfills already-connected mailboxes).
-- Idempotent (02+ auto-applied on deploy).

ALTER TABLE email_accounts
    ADD COLUMN IF NOT EXISTS initial_sync_done BOOLEAN NOT NULL DEFAULT false;
