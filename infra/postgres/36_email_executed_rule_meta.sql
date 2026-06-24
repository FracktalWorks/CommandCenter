-- Email rule-execution log: match metadata + per-action failures.
--
-- Completes inbox-zero History parity (ResultDisplay): show WHICH condition type
-- matched ("matched via" — pattern / static / ai) and an "Action issues" section
-- listing actions that failed during a run. Idempotent; safe to re-run on deploy.

ALTER TABLE email_executed_rules
    ADD COLUMN IF NOT EXISTS match_source TEXT;            -- pattern | static | ai

ALTER TABLE email_executed_rules
    ADD COLUMN IF NOT EXISTS action_errors JSONB NOT NULL DEFAULT '[]'::jsonb;
    -- list of {"type": <ActionType>, "error": <message>} for failed actions
