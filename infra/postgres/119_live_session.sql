-- 119_live_session.sql — presence for in-progress meetings (Live Meeting Copilot).
--
-- What: adds `live_session`, one row per meeting that is CURRENTLY being
--   captured — whether by the meeting bot (§3.13) or the in-browser recorder
--   (§3.3). It is the registry behind (a) the global "live now" presence dock,
--   (b) reattaching the copilot console after a refresh/navigation, and (c) the
--   per-session opt-in state for the copilot (off by default).
-- Why: the live-transcript bus is in-memory and per-process, so it can answer
--   "what is being said" but not "what is running, since when, and who owns it".
--   Presence + the opt-in toggle must survive a reconnect (and a gateway
--   restart), so they live in Postgres while the transcript stream does not.
-- Note: `copilot_enabled`/`mode` are written by Phase A but only ACTED ON from
--   Phase B (the orchestrator). Off by default — the copilot never runs unless
--   explicitly enabled for a session.
-- Depends on: 95_note_taker.sql (meeting). ADDITIVE + idempotent.
-- Spec: ai-company-brain/specs/live_meeting_copilot.md §7, §8, §10.

CREATE TABLE IF NOT EXISTS live_session (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meeting_id      UUID NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
    source          TEXT NOT NULL DEFAULT 'browser'
                    CHECK (source IN ('bot','browser')),
    owner_email     TEXT,
    status          TEXT NOT NULL DEFAULT 'live'
                    CHECK (status IN ('live','ended')),
    -- Opt-in copilot state (Phase A stores it; Phase B acts on it).
    copilot_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    mode            TEXT NOT NULL DEFAULT 'listening'
                    CHECK (mode IN ('listening','interactive','speaking')),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS live_session_meeting_idx ON live_session (meeting_id);

-- The presence surface polls exactly this set (usually 0-2 rows).
CREATE INDEX IF NOT EXISTS live_session_active_idx ON live_session (started_at DESC)
    WHERE status = 'live';

-- A meeting can only be live once at a time — makes "begin" an idempotent
-- upsert, so a reconnect or a duplicate start can't fork presence.
CREATE UNIQUE INDEX IF NOT EXISTS live_session_one_live_per_meeting
    ON live_session (meeting_id) WHERE status = 'live';
