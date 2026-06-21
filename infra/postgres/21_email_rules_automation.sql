-- ============================================================================
-- 21_email_rules_automation.sql — Auto-run + per-rule automation
-- ============================================================================
-- Enables inbox-zero-style automatic rule processing:
--   • email_messages.rules_processed_at — marks mail the rule engine has seen,
--     so auto-run only processes new arrivals (no re-processing every sync).
--   • email_rules.automated — whether a rule applies its actions automatically
--     (true) or only proposes them for approval (false → PENDING in history).
--
-- Idempotent. Depends on 17_email_accounts.sql, 19_email_automation.sql.
-- ============================================================================

ALTER TABLE email_messages
    ADD COLUMN IF NOT EXISTS rules_processed_at TIMESTAMPTZ;

-- Partial index to quickly find unprocessed inbox mail per account.
CREATE INDEX IF NOT EXISTS idx_email_messages_unprocessed
    ON email_messages(account_id)
    WHERE rules_processed_at IS NULL;

ALTER TABLE email_rules
    ADD COLUMN IF NOT EXISTS automated BOOLEAN NOT NULL DEFAULT true;
