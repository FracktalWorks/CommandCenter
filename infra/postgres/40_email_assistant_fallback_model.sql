-- ============================================================================
-- 40_email_assistant_fallback_model.sql — Per-account fallback LLM selection
-- ============================================================================
-- Adds a second, more-powerful model the Email Assistant falls back to when the
-- primary `agent_model` can't get the job done: the input overflows the primary
-- model's context window even after compression/truncation, or the primary
-- model errors out / mis-executes the rules. Defaults to tier-powerful, which
-- currently resolves to DeepSeek reasoner via the LiteLLM tier system.
--
-- The cheap `agent_model` handles most of the inbox; `fallback_model` is the
-- escape hatch for the hard emails (long threads, dense context).
--
-- Idempotent. Depends on 20_email_assistant_settings.sql + 23_email_assistant_model.sql.
-- ============================================================================

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS fallback_model TEXT NOT NULL DEFAULT 'tier-powerful';
