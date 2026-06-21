-- ============================================================================
-- 23_email_assistant_model.sql — Per-account agent LLM selection
-- ============================================================================
-- Lets each account pick which LiteLLM tier the Email Assistant agent/chat uses
-- (tier-fast | tier-balanced | tier-powerful). Defaults to tier-balanced, which
-- currently resolves to DeepSeek (deepseek-chat) via the LiteLLM tier system.
--
-- Idempotent. Depends on 20_email_assistant_settings.sql.
-- ============================================================================

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS agent_model TEXT NOT NULL DEFAULT 'tier-balanced';
