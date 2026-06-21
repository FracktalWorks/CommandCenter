-- ============================================================================
-- 24_email_digest.sql — Scheduled inbox digests
-- ============================================================================
-- Adds digest scheduling to the assistant settings: a frequency (OFF | DAILY |
-- WEEKLY) and the timestamp of the last digest sent, so the background sync loop
-- can deliver a summary email when one is due.
--
-- Idempotent. Depends on 20_email_assistant_settings.sql.
-- ============================================================================

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS digest_frequency TEXT NOT NULL DEFAULT 'OFF';

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS last_digest_at TIMESTAMPTZ;
