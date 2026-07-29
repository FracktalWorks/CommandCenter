-- 127_meeting_prep.sql — let a meeting be PREPARED before it starts.
--
-- What: two columns on `meeting` that only make sense before the call.
--
-- Why: the app had surfaces for a meeting in progress and a meeting that
--   finished, but nowhere to get ready. Agenda, briefing and copilot context
--   lived only in the live console, which does not exist until a session is
--   already running — so the only moment you could tell the copilot what the
--   meeting was about was while it was happening, which is exactly when you
--   cannot type. Everything downstream was weaker for it: the copilot walked in
--   cold every time.
--
-- `scheduled_at` vs the existing `start_at`: start_at is when capture actually
--   began (the pipeline and the library sort on it). A meeting you are planning
--   has no such moment yet, and overloading start_at would make an unstarted
--   meeting look like one that ran at the instant you created it.
--
-- `copilot_enabled` is deliberately NULLABLE and defaults to NULL, not FALSE.
--   Three states are needed, not two: on, off, and "not decided for this
--   meeting — follow the account default in copilot_config". A FALSE default
--   would silently pin every existing meeting to off and make the global
--   setting unreachable.
--
-- Depends on: 01_schema.sql (meeting), 95_note_taker.sql. ADDITIVE + idempotent.

ALTER TABLE meeting
    ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS copilot_enabled BOOLEAN;

-- The library's "coming up" band orders by when a meeting is planned for.
CREATE INDEX IF NOT EXISTS idx_meeting_scheduled_at
    ON meeting (scheduled_at)
    WHERE scheduled_at IS NOT NULL;
