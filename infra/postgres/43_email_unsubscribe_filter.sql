-- ============================================================================
-- 43_email_unsubscribe_filter.sql — Bulk Unsubscribe: provider-native filters
-- ============================================================================
-- Bulk Unsubscribe now performs a REAL server-side one-click unsubscribe
-- (RFC 8058) and, for the "auto-archive / block" disposition, creates a
-- provider-native filter (Gmail filter / Outlook message rule) so FUTURE mail
-- skips the inbox at the provider — not just the local sync-time sweep.
--
-- `auto_archive_filter_id` records the provider filter/rule id when one was
-- created, so the UI can show that a sender is blocked at the source and we
-- don't create duplicate filters. NULL = no provider filter (the server-side
-- AUTO_ARCHIVED sweep remains the fallback, e.g. for IMAP).
--
-- Idempotent. Depends on 19_email_automation.sql.
-- ============================================================================

ALTER TABLE email_newsletters
    ADD COLUMN IF NOT EXISTS auto_archive_filter_id TEXT;
