-- 113: Per-account model for MANUAL drafting ("Draft with AI" in the composer).
--
-- What: adds email_assistant_settings.compose_model.
-- Why: interactive drafting (compose-assist / draft-reply) previously ran on
--      draft_model (default tier-powerful → a reasoning model), so the user sat
--      through 20-60s spinners. Manual drafting is latency-sensitive; background
--      rule drafting is not. Splitting the setting lets manual drafts default to
--      the fast tier while automated drafts keep the powerful one.
-- Depends on: 42_email_model_roles.sql (rule/draft/chat model columns).
--
-- Idempotent: re-runs safely on every deploy.

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS compose_model TEXT NOT NULL DEFAULT 'tier-fast';
