-- 51_gtd_settings.sql — per-user Task Manager settings (AI tiers + toggles).
--
-- What: gtd_settings — one row per user: which model tier each AI function
--       of the tasks app uses (assistant chat · mind-dump atomizer/dedup ·
--       email→task drafting · clarify cognition), plus behaviour toggles
--       (duplicate check on quick capture, auto-sync on open).
-- Why:  parity with the email app's per-account model roles (42_email_model_
--       roles.sql): the user picks cost/quality per function instead of one
--       global model. GTD settings are per USER (the GTD system is personal),
--       not per connected workspace.
-- Depends on: nothing (standalone). Idempotent.

CREATE TABLE IF NOT EXISTS gtd_settings (
    user_id TEXT PRIMARY KEY,
    chat_model TEXT,              -- assistant rail (default tier-powerful)
    clarify_model TEXT,           -- clarify cognition when the agent takes it over (default tier-balanced)
    atomize_model TEXT,           -- mind-dump splitting + duplicate judgment (default tier-fast)
    email_capture_model TEXT,     -- email→task capture drafting (default tier-fast)
    capture_dedup BOOLEAN NOT NULL DEFAULT true,   -- background duplicate check on quick capture
    auto_sync_on_open BOOLEAN NOT NULL DEFAULT true, -- incremental provider pull when /tasks opens
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
