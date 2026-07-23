-- 94: Voice & writing-style profile learned from past sent/drafted mail.
--
-- One profile per account: a structured trait set (JSONB) plus a narrative
-- style guide, built by an on-demand background job over a user-chosen date
-- range and source folders ('sent' and/or 'drafts'). The drafter injects it as
-- a <voice_profile> block between the explicit <writing_style> (user-authored,
-- outranks it) and the auto-derived <learned_writing_style> (advisory).
CREATE TABLE IF NOT EXISTS email_voice_profiles (
    account_id UUID PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT true,
    -- EMPTY | BUILDING | READY | FAILED
    status TEXT NOT NULL DEFAULT 'EMPTY',
    style_guide TEXT,
    traits JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Folders the profile was learned from: 'sent' and/or 'drafts'.
    sources TEXT[] NOT NULL DEFAULT ARRAY['sent'],
    range_start DATE,
    range_end DATE,
    analyzed_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    built_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Knowledge entries now carry provenance: the voice-profile builder proposes
-- entries with source='voice_profile' and status='suggested'; they only feed
-- the drafting prompt once the user approves them (status='active'). Every
-- pre-existing row is a user-authored entry, so the defaults backfill them as
-- manual + active.
ALTER TABLE email_knowledge
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_email_knowledge_account_status
    ON email_knowledge(account_id, status);
