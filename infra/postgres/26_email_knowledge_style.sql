-- ============================================================================
-- 26_email_knowledge_style.sql — Drafting context: writing style, personal
-- instructions, and a per-account knowledge base (inbox-zero parity, Phase 2).
-- ============================================================================
-- Adds the storage the AI drafter needs to write replies that sound like the
-- user and draw on reference material:
--   * personal_instructions — global "always do this" guidance for the assistant
--   * writing_style         — tone/length/style guidance (can be auto-derived)
--   * draft_replies         — whether the assistant auto-drafts replies
--   * email_knowledge       — titled reference snippets injected into drafts
--
-- Idempotent. Depends on 20_email_assistant_settings.sql + 17_email_accounts.sql.
-- ============================================================================

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS personal_instructions TEXT;

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS writing_style TEXT;

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS draft_replies BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS email_knowledge (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, title)
);

CREATE INDEX IF NOT EXISTS idx_email_knowledge_account
    ON email_knowledge(account_id);
