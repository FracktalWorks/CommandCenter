-- 126_notes_settings.sql — Note Taker settings, per user.
--
-- What: grows `copilot_config` (added in 125 for the standing instructions)
--   into the app's full settings row, matching how the task manager keeps its
--   GTD settings and the email app its automation settings — one row per user,
--   read through one endpoint.
--
-- Why per-meeting-TYPE copilot instructions (`template_instructions`): what
--   deserves an interruption differs completely by meeting. In a sales call a
--   dropped objection matters; in a 1:1 an unspoken concern does, and a sales
--   nudge would be actively wrong. Defaults ship in `templates.py`; this column
--   holds only the ones a user has overridden, so improved defaults still reach
--   anyone who hasn't customised that type.
--
-- Why `copilot_sensitivity` rather than raw knobs: the underlying controls are a
--   minimum gap between interjections and a per-meeting cap. Exposing those as
--   numbers invites nonsense combinations; three named levels map onto sane
--   pairs and are what a user can actually reason about.
--
-- Depends on: 125_meeting_agenda.sql (copilot_config). ADDITIVE + idempotent.

ALTER TABLE copilot_config
    -- Turn the copilot on automatically for new sessions. Default FALSE keeps
    -- the "never runs unless asked" promise intact.
    ADD COLUMN IF NOT EXISTS copilot_default_on BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS copilot_sensitivity TEXT NOT NULL DEFAULT 'normal'
        CHECK (copilot_sensitivity IN ('low', 'normal', 'high')),
    -- {"one_on_one": "…override…"} — only what the user has customised.
    ADD COLUMN IF NOT EXISTS template_instructions JSONB NOT NULL DEFAULT '{}'::JSONB,
    -- Pre-selected notes template for new meetings.
    ADD COLUMN IF NOT EXISTS default_template TEXT,
    -- Name the meeting bot joins under. Consent-relevant: participants should be
    -- able to tell who is recording them (spec §3.13).
    ADD COLUMN IF NOT EXISTS bot_name TEXT;
