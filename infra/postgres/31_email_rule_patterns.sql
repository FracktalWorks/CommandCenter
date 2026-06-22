-- ============================================================================
-- 31_email_rule_patterns.sql — learned classification patterns (inbox-zero parity)
-- ============================================================================
-- Sender / subject include-exclude patterns attached to a rule. These are the
-- real "Learned Patterns": when the user corrects a classification (via the Fix
-- flow, or by adding/removing a category), we record a deterministic pattern so
-- the same sender is matched (or skipped) for that rule next time — bypassing
-- the LLM. Mirrors inbox-zero's Group / GroupItem model.
--
--   pattern_type  FROM | SUBJECT — which field `value` matches against.
--   value         the literal to match (sender email/domain, or subject text).
--   exclude       true  → NEVER match this rule when value matches (skip rule).
--                 false → ALWAYS match this rule when value matches (short-circuit).
--   source        FIX | LABEL_ADDED | LABEL_REMOVED | AI | USER — how it was learned.
--
-- Idempotent. Depends on 19_email_automation.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS email_rule_patterns (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    rule_id      UUID NOT NULL REFERENCES email_rules(id) ON DELETE CASCADE,
    pattern_type TEXT NOT NULL DEFAULT 'FROM',   -- FROM | SUBJECT
    value        TEXT NOT NULL,
    exclude      BOOLEAN NOT NULL DEFAULT false,
    source       TEXT NOT NULL DEFAULT 'FIX',
    reason       TEXT,
    message_id   UUID,
    thread_id    TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One pattern per (rule, type, value, exclude); re-learning just upserts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_rule_patterns
    ON email_rule_patterns(account_id, rule_id, pattern_type, lower(value), exclude);

CREATE INDEX IF NOT EXISTS ix_email_rule_patterns_account
    ON email_rule_patterns(account_id);
