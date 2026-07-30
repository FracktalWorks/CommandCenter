-- 135_live_transcription_mode.sql — pay for streaming ASR only when something
-- is listening to it.
--
-- Why: streaming speech-to-text is billed per minute of audio, and it runs for
--   the whole meeting. With the copilot off nothing consumes it in real time —
--   the archival recording still goes through the batch pipeline afterwards and
--   produces the same transcript, at batch prices. So a meeting with the copilot
--   off was paying a live rate for a feature nobody was reading.
--
-- Three modes rather than a boolean, because "follow the copilot" is the right
--   default but not the only sensible answer:
--     auto   - stream only while the copilot is on (default; the saving)
--     always - stream regardless, for live captions without an agent
--     never  - never stream; record-and-transcribe-after only
--
-- Tradeoff worth recording: in `auto`, a meeting with the copilot off gets no
--   live captions AND no live agenda coverage, because both are fed by the
--   transcript bus. That is the intended exchange — `always` buys them back.
--
-- Depends on: 126_notes_settings.sql (copilot_config). ADDITIVE + idempotent.

ALTER TABLE copilot_config
    ADD COLUMN IF NOT EXISTS live_transcription TEXT NOT NULL DEFAULT 'auto'
        CHECK (live_transcription IN ('auto', 'always', 'never'));
