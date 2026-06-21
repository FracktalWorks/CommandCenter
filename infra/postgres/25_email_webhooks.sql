-- ============================================================================
-- 25_email_webhooks.sql — Push notifications (Microsoft Graph change subscriptions)
-- ============================================================================
-- Stores the per-account Graph subscription so the gateway can deliver near
-- real-time processing (new mail → webhook → incremental sync → auto-run rules)
-- instead of waiting for the ~5-minute poll. The subscription is renewed before
-- it expires; polling stays on as a fallback.
--
-- Idempotent. Depends on 17_email_accounts.sql.
-- ============================================================================

ALTER TABLE email_accounts
    ADD COLUMN IF NOT EXISTS webhook_subscription_id TEXT;

ALTER TABLE email_accounts
    ADD COLUMN IF NOT EXISTS webhook_client_state TEXT;

ALTER TABLE email_accounts
    ADD COLUMN IF NOT EXISTS webhook_expires_at TIMESTAMPTZ;
