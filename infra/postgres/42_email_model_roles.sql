-- ============================================================================
-- 42_email_model_roles.sql — three task-specific assistant models
-- ============================================================================
-- Replaces the single agent_model + fallback_model pair with three explicit,
-- independently-selectable models, one per task:
--
--   rule_model   (was agent_model)  — rule evaluation / classification / labeling
--                                     default: tier-fast  (cheap, high-volume)
--   draft_model  (new)              — draft writing
--                                     default: tier-powerful (quality replies)
--   chat_model   (migration 41)     — the email chat panel
--                                     default: tier-balanced
--
-- The fallback_model (escalation) concept is removed — each task picks one model.
--
-- Data is preserved: agent_model is RENAMED to rule_model (existing per-account
-- choices survive); draft_model backfills to its default. Idempotent.
-- Depends on 20/23 (agent_model) + 40 (fallback_model) + 41 (chat_model).
-- ============================================================================

-- 1) Rename agent_model -> rule_model (guarded so re-runs are no-ops).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'email_assistant_settings' AND column_name = 'agent_model'
  ) THEN
    ALTER TABLE email_assistant_settings RENAME COLUMN agent_model TO rule_model;
  END IF;
END $$;

-- Ensure the column exists (fresh installs) and carries the new default.
ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS rule_model TEXT NOT NULL DEFAULT 'tier-fast';
ALTER TABLE email_assistant_settings
    ALTER COLUMN rule_model SET DEFAULT 'tier-fast';

-- 2) New draft_model (default tier-powerful). Backfills existing rows.
ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS draft_model TEXT NOT NULL DEFAULT 'tier-powerful';

-- 3) chat_model: drop the legacy "inherit" sentinel ('') for a real default.
ALTER TABLE email_assistant_settings
    ALTER COLUMN chat_model SET DEFAULT 'tier-balanced';
UPDATE email_assistant_settings
    SET chat_model = 'tier-balanced'
    WHERE chat_model IS NULL OR chat_model = '';

-- 4) Remove the fallback_model concept.
ALTER TABLE email_assistant_settings DROP COLUMN IF EXISTS fallback_model;
