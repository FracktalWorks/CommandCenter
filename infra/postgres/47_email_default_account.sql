-- ============================================================================
-- 47_email_default_account.sql — User-chosen default mailbox
-- ============================================================================
-- Multi-account users need ONE inbox to land on by default (and a stable hint
-- the frontend can use for its initial selection instead of "first by
-- created_at").  Adds an `is_default` flag with an at-most-one-per-user
-- guarantee, and backfills the earliest account as default for users who have
-- none yet.
--
-- Idempotent.  Depends on 17_email_accounts.sql.
-- ============================================================================

ALTER TABLE email_accounts
    ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

-- At most one default mailbox per user (partial unique index over the flag).
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_accounts_one_default
    ON email_accounts(user_id)
    WHERE is_default;

-- Backfill: for every user who has NO default yet, mark their earliest-created
-- account as the default.  Re-running is a no-op once a default exists.
WITH firsts AS (
    SELECT DISTINCT ON (user_id) id, user_id
    FROM email_accounts
    ORDER BY user_id, created_at, id
)
UPDATE email_accounts a
SET is_default = true
FROM firsts f
WHERE a.id = f.id
  AND NOT EXISTS (
      SELECT 1 FROM email_accounts b
      WHERE b.user_id = a.user_id AND b.is_default
  );
