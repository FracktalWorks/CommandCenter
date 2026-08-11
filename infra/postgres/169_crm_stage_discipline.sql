-- 169_crm_stage_discipline.sql — WS-26h stage discipline: entry requirements + rot
--
-- ⚠️ The number was taken from the directory at BUILD time (R1), not from a
--    spec, and is re-checked at merge. `tests/unit/test_crm_migration.py` finds
--    this file by CONTENT (`required_fields`), so a renumber in review is free.
--
-- What: `crm_deal_statuses` gains two columns —
--
--         required_fields  the deal columns a deal must carry BEFORE it may
--                          enter this stage. A server allowlist
--                          (`core.STAGE_REQUIREABLE_FIELDS`) decides which
--                          names are legal; free text here is how a typo
--                          becomes a lane nobody can enter.
--
--         max_dwell_days   how long a deal may sit in this stage before its
--                          card wears an age badge. NULL = this stage never
--                          rots, which is the default and the only honest
--                          answer for a stage nobody has set a policy on.
--
-- Why:  §5.1 system 3. The mechanism already exists in miniature — a move into
--       a `lost`-type stage demands a `lost_reason_id`, enforced in
--       `pipeline.apply_status_transition` — and this generalizes exactly that
--       one rule. Discipline is enforced by ENTRY and by VISIBILITY, never by
--       locks: `required_fields` gates the move (the same 422, before any of
--       the transition's three effects), and `max_dwell_days` colours a badge
--       and does nothing else. There is deliberately no mechanic that moves,
--       closes or hides a rotted deal — Pipedrive's lesson, adopted on purpose
--       (`crm_app.md` §5.1).
--
-- ⚠️ DEAL statuses only, and `crm_lead_statuses` is deliberately untouched —
--    the same asymmetry `probability` already has. Both columns describe things
--    a lead has not got: the allowlist is deal columns, and rot is measured off
--    `crm_deals.status_changed_at`, the stage-age clock migration 144 gave
--    deals and withheld from leads.
--
-- R6 (expand/contract): additive only. Both columns arrive with a value the
-- currently-running code never names — `required_fields` NOT NULL DEFAULT '{}'
-- (an empty requirement set requires nothing, so every existing lane keeps
-- behaving exactly as it did) and `max_dwell_days` nullable (never rots). The
-- deploy applies migrations BEFORE restarting services, so the old gateway
-- meets this schema for a window; it selects `*`, names neither column on any
-- write, and is unaffected. Nothing is renamed, tightened or dropped here.
--
-- Spec: project-docs/specs/crm_app.md §9 WS-26h · §5.1 system 3.
-- Depends on: 144_crm.sql (creates crm_deal_statuses).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS only. No seed, no backfill, no DROP.

BEGIN;

-- ⚠️ TEXT[] and not JSONB: this is a list of column names from a closed
-- server-side allowlist, never a document, and an array is what the eventual
-- `= ANY(required_fields)` predicate wants. NOT NULL DEFAULT '{}' rather than
-- nullable so the enforcement path reads one shape and never has to spell
-- "no requirements" two ways — an empty array and a NULL would be the same
-- meaning with two code paths, which is how one of them stops being tested.
ALTER TABLE crm_deal_statuses
    ADD COLUMN IF NOT EXISTS required_fields TEXT[] NOT NULL DEFAULT '{}';

-- NULL is the default and it MEANS something: this stage has no rot policy.
-- A 0 would mean "everything here is overdue the moment it arrives", so the
-- route floors the value at 1 and leaves NULL as the only way to say "never".
ALTER TABLE crm_deal_statuses
    ADD COLUMN IF NOT EXISTS max_dwell_days SMALLINT;

COMMIT;
