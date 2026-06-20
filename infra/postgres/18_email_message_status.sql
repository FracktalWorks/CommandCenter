-- ============================================================================
-- 18_email_message_status.sql — Extra status fields for email messages
-- ============================================================================
-- Adds provider status metadata so the email client can mirror what Outlook /
-- Gmail show: message importance (high/normal/low) and user categories.
--
-- Idempotent: safe to run repeatedly. Depends on 17_email_accounts.sql.
-- ============================================================================

ALTER TABLE email_messages
    ADD COLUMN IF NOT EXISTS importance TEXT NOT NULL DEFAULT 'normal';

ALTER TABLE email_messages
    ADD COLUMN IF NOT EXISTS categories TEXT[] NOT NULL DEFAULT '{}';

-- Index for filtering high-importance mail quickly.
CREATE INDEX IF NOT EXISTS idx_email_messages_importance
    ON email_messages(account_id, importance)
    WHERE importance = 'high';
