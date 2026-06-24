-- ============================================================================
-- 41_email_chat_model.sql — Per-account chat-only LLM selection
-- ============================================================================
-- Splits the model used by the interactive Email chat (the AI chat panel inside
-- the email app) from the model the background assistant agent uses for
-- automation (rules, drafts, follow-ups, digests).
--
-- `agent_model` (migration 23) → automation/agent runs.
-- `chat_model`  (this migration) → the email chat panel.
--
-- Empty string means "inherit the Assistant model": the chat endpoint resolves
-- chat_model -> agent_model -> tier-balanced. Defaulting to '' keeps existing
-- accounts on their current behaviour until they pick a distinct chat model.
--
-- Idempotent. Depends on 20_email_assistant_settings.sql + 23_email_assistant_model.sql.
-- ============================================================================

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS chat_model TEXT NOT NULL DEFAULT '';
