-- ============================================================================
-- 30_inbox_zero_multi_rule_sensitive.sql — two more inbox-zero parity settings
-- ============================================================================
-- Adds the remaining inbox-zero Assistant > Settings toggles:
--
--   multi_rule_execution       when on, an email can match & run MORE THAN ONE
--                              rule (inbox-zero "multi-rule"). Default off — the
--                              first matching rule wins, matching today's engine.
--   sensitive_data_protection  when on, the assistant skips auto-drafting on
--                              emails that look like they carry sensitive data
--                              (passwords, OTPs, card/SSN numbers). Default on.
--
-- Idempotent. Depends on 29_inbox_zero_parity_settings.sql.
-- ============================================================================

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS multi_rule_execution BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS sensitive_data_protection BOOLEAN NOT NULL DEFAULT true;
