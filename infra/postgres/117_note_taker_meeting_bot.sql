-- 117_note_taker_meeting_bot.sql — meeting bot (remote-call capture) job state.
--
-- What: adds `meeting_bot`, one row per bot dispatched to join a live
--   Meet/Teams/Zoom call (spec §3.13 / decision D10, Phase 1: on-demand join by
--   link). The bot is run by a provider (Recall.ai by default); on completion
--   its audio is ingested as a normal `meeting_recording` and run through the
--   existing transcription → diarization → speaker-naming → summary pipeline, so
--   a bot recording is just another audio source. The bot's own lifecycle
--   (joining / waiting room / in call / done) lives here; the parent `meeting`
--   keeps using its existing status set.
-- Why: covers meetings the browser/device recorder can't reach, and — because
--   each bot is an independent server-side job — lets one user fan several
--   notetakers out to multiple concurrent meetings.
-- Depends on: 95_note_taker.sql (meeting). ADDITIVE + idempotent.

CREATE TABLE IF NOT EXISTS meeting_bot (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meeting_id      UUID NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL DEFAULT 'recall',
    provider_bot_id TEXT,                       -- id returned by the provider
    meeting_url     TEXT NOT NULL,
    bot_name        TEXT,
    status          TEXT NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested','joining','waiting_room',
                                      'in_call','processing','done','failed',
                                      'left','not_admitted')),
    error           TEXT,
    requested_by    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_bot_meeting_idx ON meeting_bot (meeting_id);

-- Partial index over the still-running bots — the "active notetakers" surface
-- and the resume-on-restart scan both query exactly this set.
CREATE INDEX IF NOT EXISTS meeting_bot_active_idx ON meeting_bot (status)
    WHERE status IN ('requested','joining','waiting_room','in_call','processing');
