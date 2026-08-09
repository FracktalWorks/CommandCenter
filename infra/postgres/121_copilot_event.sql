-- 121_copilot_event.sql — what the live meeting copilot said, and why.
--
-- What: one row per thing the copilot surfaced during a live session — a
--   suggestion, a question it wants answered, a fact it retrieved, or a status
--   note (paused, budget exhausted). `refs` carries the source it was grounded
--   in (transcript window text, speaker ids) so a suggestion is inspectable
--   rather than an oracle.
-- Why persisted at all: the transcript bus and rolling state are in-memory and
--   disposable, but what an agent *said to a human* is different — it's the
--   audit trail ("why did it interrupt with that?"), it survives a console
--   refresh mid-meeting, and it's the raw material for judging whether the
--   copilot is actually useful. Everything else stays ephemeral.
-- Note: `token_cost` lets a session's spend be reconstructed per event, which is
--   what makes the per-meeting budget guardrail auditable rather than a black box.
-- Depends on: 120_live_session.sql (live_session). ADDITIVE + idempotent.
-- Spec: project-docs/specs/live_meeting_copilot.md §10, §13 (Phase B).

CREATE TABLE IF NOT EXISTS copilot_event (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id  UUID NOT NULL REFERENCES live_session(id) ON DELETE CASCADE,
    meeting_id  UUID NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL DEFAULT 'suggestion'
                CHECK (kind IN ('suggestion','question','answer','fact','status')),
    text        TEXT NOT NULL,
    -- What it was grounded in: {"window": "...", "speakers": ["S1"], "topic": "..."}
    refs        JSONB NOT NULL DEFAULT '{}'::JSONB,
    -- Set when the user acts on it (dismissed / spoken into the call / used).
    acted_on    TEXT,
    token_cost  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The console reads a session's stream in order; that's the only hot query.
CREATE INDEX IF NOT EXISTS copilot_event_session_idx
    ON copilot_event (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS copilot_event_meeting_idx
    ON copilot_event (meeting_id, created_at DESC);
