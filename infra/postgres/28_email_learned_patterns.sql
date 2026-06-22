-- ============================================================================
-- 28_email_learned_patterns.sql — Phase 7: learn from the user's draft edits
-- ============================================================================
-- email_ai_drafts: the assistant's ORIGINAL draft text per thread, kept so that
--   when the user edits and sends, we can diff intent vs. what they changed.
-- email_learned_patterns: short, distilled preferences ("keep sign-offs short")
--   injected back into the drafter as advisory <learned_patterns>.
--
-- Idempotent. Depends on 17_email_accounts.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS email_ai_drafts (
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    thread_id  TEXT NOT NULL,
    draft_text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (account_id, thread_id)
);

CREATE TABLE IF NOT EXISTS email_learned_patterns (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    pattern    TEXT NOT NULL,
    weight     INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (account_id, pattern)
);

CREATE INDEX IF NOT EXISTS idx_email_learned_patterns_account
    ON email_learned_patterns(account_id, updated_at DESC);
