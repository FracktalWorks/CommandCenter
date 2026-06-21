-- ============================================================================
-- 20_email_assistant_settings.sql — Assistant per-account settings
-- ============================================================================
-- Backs the Assistant > Settings tab: "About you" context + signature used for
-- AI drafting, and an auto-run toggle for processing new mail with rules.
--
-- Ported in spirit from inbox-zero's EmailAccount assistant settings.
-- Idempotent. Depends on 17_email_accounts.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS email_assistant_settings (
    account_id UUID PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
    about TEXT,                              -- Free-text context about the user
    signature TEXT,                          -- Signature appended to AI drafts
    auto_run BOOLEAN NOT NULL DEFAULT false, -- Run rules automatically on new mail
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
