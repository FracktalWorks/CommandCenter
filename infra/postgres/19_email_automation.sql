-- ============================================================================
-- 19_email_automation.sql — Email Automation (Assistant rules, newsletters)
-- ============================================================================
-- Backs the "Email Automation" section of the email app:
--   • Assistant       — plain-English rules + actions, executed-rule history
--   • Bulk Unsubscribe — newsletter sender tracking (approve/unsub/auto-archive)
--   • Bulk Archive     — uses email_messages directly (no new table)
--   • Analytics        — uses email_messages aggregates (no new table)
--
-- Ported in spirit from inbox-zero (elie222/inbox-zero, AGPLv3): Rule + Action,
-- ExecutedRule, and Newsletter models.
--
-- Idempotent: safe to run repeatedly. Depends on 17_email_accounts.sql.
-- ============================================================================

-- ── List-Unsubscribe capture ───────────────────────────────────────────────
-- Persist the unsubscribe link parsed from the List-Unsubscribe header so the
-- bulk-unsubscribe UI can offer a real one-click unsubscribe (mailto:/https).
ALTER TABLE email_messages
    ADD COLUMN IF NOT EXISTS unsubscribe_link TEXT;

-- ── Assistant: rules ────────────────────────────────────────────────────────
-- A rule is a plain-English instruction the LLM matches incoming mail against,
-- plus static from/to/subject patterns. Matched rules run their actions.
CREATE TABLE IF NOT EXISTS email_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    instructions TEXT,                       -- Natural-language match condition
    enabled BOOLEAN NOT NULL DEFAULT true,
    run_on_threads BOOLEAN NOT NULL DEFAULT false,
    conditional_operator TEXT NOT NULL DEFAULT 'AND',  -- 'AND' | 'OR'
    -- Static conditions (optional; combined with `instructions` per the operator)
    from_pattern TEXT,
    to_pattern TEXT,
    subject_pattern TEXT,
    body_pattern TEXT,
    category_filter_type TEXT,               -- 'INCLUDE' | 'EXCLUDE' | NULL
    system_type TEXT,                        -- 'COLD_EMAIL' | 'REPLY_ZERO' | NULL
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, name)
);

CREATE INDEX IF NOT EXISTS idx_email_rules_account
    ON email_rules(account_id, enabled, sort_order);

-- ── Assistant: actions ──────────────────────────────────────────────────────
-- One or more actions executed when a rule matches.
CREATE TABLE IF NOT EXISTS email_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID NOT NULL REFERENCES email_rules(id) ON DELETE CASCADE,
    type TEXT NOT NULL,   -- ARCHIVE|LABEL|REPLY|FORWARD|DRAFT_EMAIL|MARK_SPAM|
                          -- MARK_READ|STAR|TRASH|MOVE_FOLDER|CALL_WEBHOOK
    label TEXT,           -- Label name (LABEL) or folder key (MOVE_FOLDER)
    subject TEXT,         -- REPLY/FORWARD/DRAFT subject template
    content TEXT,         -- REPLY/FORWARD/DRAFT body template
    to_address TEXT,
    cc_address TEXT,
    bcc_address TEXT,
    url TEXT,             -- CALL_WEBHOOK target
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_actions_rule
    ON email_actions(rule_id);

-- ── Assistant: executed-rule history ────────────────────────────────────────
-- Audit log of which rule fired on which message, with the actions taken.
CREATE TABLE IF NOT EXISTS email_executed_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    rule_id UUID REFERENCES email_rules(id) ON DELETE SET NULL,
    rule_name TEXT,                          -- Denormalized for history display
    message_id UUID REFERENCES email_messages(id) ON DELETE SET NULL,
    provider_message_id TEXT,
    thread_id TEXT,
    subject TEXT,
    from_address TEXT,
    status TEXT NOT NULL DEFAULT 'APPLIED',  -- APPLIED|SKIPPED|PENDING|ERROR
    automated BOOLEAN NOT NULL DEFAULT true,
    actions_taken JSONB NOT NULL DEFAULT '[]',
    reason TEXT,                             -- LLM rationale / error message
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_executed_rules_account
    ON email_executed_rules(account_id, created_at DESC);

-- ── Bulk Unsubscribe: newsletter senders ────────────────────────────────────
-- Tracks the unsubscribe disposition per sender so the UI can show which
-- senders are approved / unsubscribed / auto-archived.
CREATE TABLE IF NOT EXISTS email_newsletters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    email TEXT NOT NULL,                     -- Sender email address (lowercased)
    name TEXT,                               -- Sender display name
    status TEXT NOT NULL DEFAULT 'APPROVED', -- APPROVED|UNSUBSCRIBED|AUTO_ARCHIVED
    unsubscribe_link TEXT,                   -- Last-seen List-Unsubscribe link
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, email)
);

CREATE INDEX IF NOT EXISTS idx_email_newsletters_account
    ON email_newsletters(account_id, status);
