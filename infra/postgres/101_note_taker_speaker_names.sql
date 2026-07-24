-- 101_note_taker_speaker_names.sql — human names for diarized speakers
-- (spec: note_taker_app.md §4; the "named speakers" UX follow-on to Deepgram
-- diarization). First 3-digit migration — the runner + test went numeric-order
-- / length-agnostic in #202.
--
-- What: meeting.speaker_names JSONB = { "S1": "Alex Rivera", "S2": "Priya Menon" }.
--   Deepgram returns anonymous S1/S2/S3 labels on each transcript_segment; this
--   maps them to real people. Resolved at DISPLAY and PROMPT time — the raw
--   segment labels are never rewritten, so re-transcription stays idempotent and
--   a name can be corrected without touching the transcript.
-- Why: raw "S1" reads as robotic and makes notes/actions/email impersonal. One
--   rename back-fills the transcript, the generated notes, action owners and the
--   follow-up email.
-- Depends on: 95_note_taker.sql (meeting table). ADDITIVE + idempotent.

ALTER TABLE meeting
    ADD COLUMN IF NOT EXISTS speaker_names JSONB NOT NULL DEFAULT '{}'::jsonb;
