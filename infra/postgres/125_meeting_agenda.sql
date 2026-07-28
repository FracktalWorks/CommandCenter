-- 125_meeting_agenda.sql — the agenda, and the copilot's standing instructions.
--
-- What:
--   `meeting.agenda`               — the plan for this meeting, as an ordered
--                                    JSONB list of {title, notes}. Built
--                                    conversationally with the copilot before
--                                    the call.
--   `copilot_config.instructions`  — a per-user system prompt prepended to
--                                    EVERY copilot run ("I run a 3D-printing
--                                    company; prefer commercial framing; never
--                                    suggest discounts").
--
-- Why the agenda is first-class rather than more free text in `copilot_brief`:
--   during the call it's the thing the copilot measures against. Structured
--   items can be marked covered, so the copilot can say "you haven't touched
--   pricing and you're 40 minutes in" — which is impossible against prose.
--
-- Why per-user instructions: the brief changes per meeting, but how you want
--   the copilot to behave doesn't. Re-typing that every time is how a feature
--   stops being used.
--
-- Depends on: 95_note_taker.sql (meeting). ADDITIVE + idempotent.
-- Spec: ai-company-brain/specs/live_meeting_copilot.md §6 (bidirectional).

ALTER TABLE meeting
    ADD COLUMN IF NOT EXISTS agenda JSONB NOT NULL DEFAULT '[]'::JSONB;

CREATE TABLE IF NOT EXISTS copilot_config (
    owner_email  TEXT PRIMARY KEY,
    instructions TEXT,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
