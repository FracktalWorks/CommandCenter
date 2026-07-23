-- 94_note_taker.sql — AI Note Taker app: recordings, transcript segments,
-- notes, and pipeline runs (spec: ai-company-brain/specs/note_taker_app.md §3.6).
--
-- What: activates the dormant meeting/action_item tables from 01_schema.sql as
--   the store for the /notes app. `meeting` gains title/status/summary fields
--   and two new platforms ('in_person', 'upload' — the browser-recorder and
--   retro-import capture paths). New tables:
--     meeting_recording  — one row per captured/uploaded audio stream (a meeting
--                          can have a 'mic' and a 'system' channel recorded
--                          separately for echo-safe capture, or one 'upload').
--     transcript_segment — the click-to-seek unit: per-utterance text with
--                          start/end offsets into the recording, speaker label
--                          from diarization, optional resolved person, optional
--                          word timings and embedding (pgvector, dim 1024 to
--                          match the platform's message.embedding).
--     meeting_note       — the editable notes doc, dual markdown+JSON so a rich
--                          editor round-trips losslessly.
--     summary_run        — per-meeting pipeline job state machine (transcribe /
--                          summary / actions / translate / title), with
--                          result_backup so a failed regeneration never loses
--                          the previous good result.
--   action_item gains segment_ids (grounding: which transcript segments justify
--   the item) and due_hint (free-text until a task is created via HITL).
-- Why: record → transcribe → grounded notes → HITL action-items→tasks is the
--   Note Taker core loop; every downstream feature keys off these rows.
-- Depends on: 01_schema.sql (meeting, action_item, person, task; pgvector ext).
-- ADDITIVE + idempotent.

-- ── meeting: widen platform, add app fields ─────────────────────────────────
ALTER TABLE meeting DROP CONSTRAINT IF EXISTS meeting_platform_check;
ALTER TABLE meeting ADD CONSTRAINT meeting_platform_check
    CHECK (platform IN ('meet','zoom','teams','other','in_person','upload'));

ALTER TABLE meeting ADD COLUMN IF NOT EXISTS title        TEXT;
ALTER TABLE meeting ADD COLUMN IF NOT EXISTS status       TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE meeting ADD COLUMN IF NOT EXISTS language     TEXT;
ALTER TABLE meeting ADD COLUMN IF NOT EXISTS duration_s   DOUBLE PRECISION;
ALTER TABLE meeting ADD COLUMN IF NOT EXISTS owner_email  TEXT;
ALTER TABLE meeting ADD COLUMN IF NOT EXISTS template_key TEXT;
ALTER TABLE meeting ADD COLUMN IF NOT EXISTS summary_json JSONB;
ALTER TABLE meeting ADD COLUMN IF NOT EXISTS summary_md   TEXT;

ALTER TABLE meeting DROP CONSTRAINT IF EXISTS meeting_status_check;
ALTER TABLE meeting ADD CONSTRAINT meeting_status_check
    CHECK (status IN ('draft','recording','processing','ready','failed'));

CREATE INDEX IF NOT EXISTS meeting_owner_created_idx
    ON meeting (owner_email, created_at DESC);

-- ── meeting_recording ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meeting_recording (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meeting_id    UUID NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
    channel       TEXT NOT NULL DEFAULT 'upload'
                  CHECK (channel IN ('mic','system','mixed','upload')),
    artifact_path TEXT NOT NULL,           -- server-side path (NOTES_MEDIA_DIR)
    mime          TEXT NOT NULL DEFAULT 'application/octet-stream',
    duration_s    DOUBLE PRECISION,
    byte_size     BIGINT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_recording_meeting_idx
    ON meeting_recording (meeting_id);

-- ── transcript_segment ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transcript_segment (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meeting_id        UUID NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
    recording_id      UUID REFERENCES meeting_recording(id) ON DELETE SET NULL,
    idx               INTEGER NOT NULL DEFAULT 0,
    start_s           DOUBLE PRECISION NOT NULL DEFAULT 0,
    end_s             DOUBLE PRECISION NOT NULL DEFAULT 0,
    text              TEXT NOT NULL,
    speaker_label     TEXT,                -- diarization label ('S1', 'S2', …)
    speaker_person_id UUID REFERENCES person(id),
    channel           TEXT,                -- capture channel prior ('mic'|'system')
    confidence        DOUBLE PRECISION,
    words             JSONB,               -- [{w, s, e}] word timings if available
    embedding         vector(1024),        -- ask-the-meeting semantic search
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transcript_segment_meeting_idx
    ON transcript_segment (meeting_id, idx);

-- ── meeting_note ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meeting_note (
    meeting_id UUID PRIMARY KEY REFERENCES meeting(id) ON DELETE CASCADE,
    notes_md   TEXT,
    notes_json JSONB,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── summary_run ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS summary_run (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meeting_id    UUID NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL DEFAULT 'summary'
                  CHECK (kind IN ('transcribe','summary','actions','translate','title')),
    status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','done','failed','cancelled')),
    stage         TEXT,
    chunk_done    INTEGER NOT NULL DEFAULT 0,
    chunk_total   INTEGER NOT NULL DEFAULT 0,
    model         TEXT,
    error         TEXT,
    result        JSONB,
    result_backup JSONB,
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS summary_run_meeting_idx
    ON summary_run (meeting_id, created_at DESC);

-- ── action_item: grounding + due hint ───────────────────────────────────────
ALTER TABLE action_item ADD COLUMN IF NOT EXISTS segment_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE action_item ADD COLUMN IF NOT EXISTS due_hint    TEXT;
