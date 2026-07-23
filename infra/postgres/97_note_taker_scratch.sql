-- 97_note_taker_scratch.sql — the user's own rough notes on a meeting
-- (spec: note_taker_app.md §4 Tier-1 item 3, the "scratch-notes merge" /
-- Granola pattern).
--
-- What: meeting.scratch_notes TEXT — free-text notes the user jots DURING or
--   after the meeting (distinct from meeting_note.notes_md, which is the
--   GENERATED output). Notes generation reads these as *emphasis signals*:
--   topics the user flagged get depth, their shorthand gets expanded/corrected
--   from the transcript, and gaps get filled. They are the user's priorities —
--   never treated as instructions to the model.
-- Why: the single highest-leverage note-taker UX idea (research §3) — the
--   user's attention during the meeting steers a far better summary than the
--   transcript alone.
-- Depends on: 95_note_taker.sql (meeting app fields). ADDITIVE + idempotent.

ALTER TABLE meeting ADD COLUMN IF NOT EXISTS scratch_notes TEXT;
