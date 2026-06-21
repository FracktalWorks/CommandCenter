-- ============================================================================
-- 27_email_reply_tracking.sql — Reply Zero: per-thread reply status + follow-ups
-- ============================================================================
-- Replaces the pure folder heuristic with a stored, AI-classified status per
-- thread so "needs reply" excludes FYI/automated mail (inbox-zero's TO_REPLY vs
-- FYI distinction), and adds a follow-up window for sent mail awaiting a reply.
--
--   status: NEEDS_REPLY | AWAITING | FYI | DONE
--   follow_up_days: 0 = off; otherwise remind about AWAITING threads older than N
--
-- Idempotent. Depends on 17_email_accounts.sql + 20_email_assistant_settings.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS email_thread_status (
    account_id      UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    thread_id       TEXT NOT NULL,
    status          TEXT NOT NULL,          -- NEEDS_REPLY | AWAITING | FYI | DONE
    last_message_id UUID,
    last_message_at TIMESTAMPTZ,
    reason          TEXT,
    classified_at   TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (account_id, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_thread_status_account_status
    ON email_thread_status(account_id, status);

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS follow_up_days INTEGER NOT NULL DEFAULT 0;
