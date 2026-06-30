-- ============================================================================
-- 46_email_org_domains.sql — extra "your organisation" domains for direction
-- ============================================================================
-- Sender direction (identity.sender_scope) already treats the account's OWN
-- email domain as internal/your-organisation, so an invoice your team sent a
-- customer isn't mislabelled as a received Receipt. This adds OPTIONAL extra
-- domains/aliases (multi-brand orgs, secondary domains) that should also count
-- as internal. Empty by default — same-domain detection needs no configuration.
--
-- Idempotent. Depends on 20_email_assistant_settings.sql.
-- ============================================================================

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS org_domains TEXT[] NOT NULL DEFAULT '{}';
