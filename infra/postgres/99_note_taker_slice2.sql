-- 99_note_taker_slice2.sql — Note Taker slice-2 schema, consolidated.
--
-- These three additive, idempotent changes were built across slice 2 as
-- separate migrations (96_note_taker_attendees, 97_note_taker_scratch,
-- 98_note_taker_glossary). Numbers 96–98 were taken on main by unrelated
-- gtd/calendar migrations that merged first, and the migration runner +
-- test_migration_prefixes only recognise TWO-digit prefixes ([0-9][0-9]_),
-- so 99 is the only slot left — the three collapse into this one file.
-- Order-independent and safe to move later: each depends only on 95_note_taker
-- (the meeting table) or on base uuid support, both far earlier.
-- Spec: note_taker_app.md §3.9 (attendees), §4 Tier-1 items 3 (scratch) & 6 (glossary).

-- (1) Free-text attendee list on meetings — [{name, email}] for the follow-up
--     email recipient set + notes context. Distinct from meeting.attendee_ids
--     (org person(id) refs): this holds externals not in the org graph.
ALTER TABLE meeting ADD COLUMN IF NOT EXISTS attendees JSONB NOT NULL DEFAULT '[]'::jsonb;

-- (2) The user's own rough notes on a meeting (the "scratch-notes merge" /
--     Granola pattern). Distinct from meeting_note.notes_md (the GENERATED
--     output); generation reads these as emphasis signals, never instructions.
ALTER TABLE meeting ADD COLUMN IF NOT EXISTS scratch_notes TEXT;

-- (3) Per-user vocabulary for the Note Taker — jargon (product names, people,
--     customers, acronyms) injected into the STT prompt so transcription spells
--     them right. Keyed by user_id (email), case-folded uniqueness.
CREATE TABLE IF NOT EXISTS notes_glossary (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     TEXT NOT NULL,
    term        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS notes_glossary_user_term_idx
    ON notes_glossary (user_id, lower(term));
