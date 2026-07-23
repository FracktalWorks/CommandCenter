-- 98_note_taker_glossary.sql — per-user vocabulary for the Note Taker
-- (spec: note_taker_app.md §4 Tier-1 item 6, "org glossary boost").
--
-- What: notes_glossary — the org/user's jargon (product names, people,
--   customers, acronyms) that transcription should get right. Terms are
--   injected into the STT prompt (whisper `prompt` / deepgram keyterm) so the
--   engine biases toward the correct spellings — fixing the single most common
--   source of transcript errors, which propagates into notes, action items,
--   and search.
-- Why: "TwinDragon", "Penrose", customer names etc. are otherwise mangled by a
--   generic ASR model; a short domain vocabulary measurably improves accuracy.
-- Keyed by user_id (email) — the same tenant key gtd_items uses. Case-folded
-- uniqueness so the same term isn't stored twice.
-- Depends on: nothing beyond a Postgres with uuid support. ADDITIVE + idempotent.

CREATE TABLE IF NOT EXISTS notes_glossary (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     TEXT NOT NULL,
    term        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS notes_glossary_user_term_idx
    ON notes_glossary (user_id, lower(term));
