-- ============================================================================
-- 22_email_categorization.sql — Sender categories, cold-email blocker
-- ============================================================================
-- Ports the remaining inbox-zero subsystems:
--   • email_senders        — per-sender category (Newsletter/Marketing/…),
--                            assigned by the LLM categorizer.
--   • email_cold_senders   — cold-email blocker verdicts + user whitelist.
--   • email_rules.category_filters — INCLUDE/EXCLUDE rule conditions by category.
--   • email_assistant_settings.cold_email_blocker — OFF | LABEL | ARCHIVE.
--
-- Reply Zero (needs-reply / awaiting-reply) is computed live from
-- email_messages and needs no table.
--
-- Idempotent. Depends on 17/19/20/21.
-- ============================================================================

-- ── Per-sender category ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_senders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    email TEXT NOT NULL,                 -- Sender email (lowercased)
    name TEXT,
    category TEXT,                       -- Newsletter|Marketing|Receipt|Calendar|
                                         -- Notification|Cold Email|Personal|
                                         -- Support|Unknown
    categorized_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, email)
);

CREATE INDEX IF NOT EXISTS idx_email_senders_account
    ON email_senders(account_id, category);

-- ── Cold-email blocker verdicts + whitelist ─────────────────────────────────
CREATE TABLE IF NOT EXISTS email_cold_senders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    from_email TEXT NOT NULL,            -- Sender email (lowercased)
    status TEXT NOT NULL DEFAULT 'AI_LABELED_COLD',  -- or USER_REJECTED_COLD
    reason TEXT,                         -- LLM rationale
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, from_email)
);

CREATE INDEX IF NOT EXISTS idx_email_cold_senders_account
    ON email_cold_senders(account_id, status);

-- ── Category conditions on rules ────────────────────────────────────────────
ALTER TABLE email_rules
    ADD COLUMN IF NOT EXISTS category_filters TEXT[] NOT NULL DEFAULT '{}';

-- ── Cold-email blocker setting ──────────────────────────────────────────────
ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS cold_email_blocker TEXT NOT NULL DEFAULT 'OFF';
