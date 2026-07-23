-- 96_note_taker_attendees.sql — free-text attendee list on meetings
-- (spec: note_taker_app.md §7 Q5).
--
-- What: meeting.attendees JSONB = [{name, email}] for the follow-up-email
--   recipient list and notes context. Distinct from the existing
--   meeting.attendee_ids UUID[] (org person(id) references) — this holds
--   externals who aren't in the org graph, captured as plain name+email so a
--   recap email can be addressed without first resolving everyone to a person.
-- Why: the Notes→Email loop-closure (§3.9) needs someone to address the
--   follow-up to; attendees are the recipient set.
-- Depends on: 95_note_taker.sql (meeting app fields). ADDITIVE + idempotent.

ALTER TABLE meeting ADD COLUMN IF NOT EXISTS attendees JSONB NOT NULL DEFAULT '[]'::jsonb;
