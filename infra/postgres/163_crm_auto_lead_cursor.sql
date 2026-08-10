-- 163_crm_auto_lead_cursor.sql — renumbered from 158 (taken by per_org_credentials, PR #404) after #399 took 160-162 — WS-26d-autolead
--
-- ⚠️ Numbered 158, not 157: open PR #399 (`157_projects_recurrence.sql`) holds
--    157. Two migrations sharing a number replay in filename order against the
--    wrong schema, so the ladder carries a deliberate reservation gap at 157
--    until that PR lands. `tests/unit/test_crm_auto_lead.py` finds this file by
--    CONTENT rather than by number, so a further renumber in review is free.
--
-- What: one row per email account recording the current auto-lead ON epoch for
--       that mailbox, how far the step has processed, and when it last ran.
-- Why:  the auto-lead step hangs off `process_new_mail`, and that hook is
--       reached by DEEP RESYNCS as well as by new mail. `resync_account` runs
--       a ~1-year all-folder backfill and then fires the hook; a first-ever
--       sync of a newly connected mailbox is deep by the same heuristic; and
--       neither path stamps `rules_held_back_at` (its only writer is
--       `_backfill_and_clean_job`, which does not go through this hook). A
--       candidate query of "everything classified" would therefore mint a lead
--       per unknown external sender across a YEAR of mail the moment a second
--       mailbox connects — each born `zoho_dirty`, each queued for the live
--       Zoho tenant within one 600s cycle (D-CRM-9), with no confirmation card
--       anywhere on a scheduler hook and no delete tool to take them back.
--
--       THREE columns, because that is three different questions and no one
--       column answers more than one of them:
--
--         activated_at         the start of the CURRENT ON epoch. The backfill
--                              discriminator is `received_at > activated_at`:
--                              mail that ARRIVED before this epoch began mints
--                              nothing, no matter when a resync gets around to
--                              classifying it.
--
--         processed_watermark  the incremental cursor, compared against
--                              `rules_processed_at`. It advances only over the
--                              contiguous prefix of a batch that actually
--                              wrote its leads, so a failure is never mistaken
--                              for work done.
--
--         last_run_at          when the step last RAN — stamped at the end of
--                              every cycle, including the ones that considered
--                              nothing and the ones that stalled. This is what
--                              detects dormancy: an OFF window, or an outage.
--
--                              ⚠️ It is its own column for a NARROW reason, and
--                              not the one you might expect. Both it and the
--                              watermark freeze on a mailbox that receives
--                              nothing, because the step is NOT invoked once
--                              per scheduler period — `email_ingestion/
--                              scheduler.py:463-472` reads `synced` off the
--                              sync result and fires the hook only when mail
--                              was actually PERSISTED. What separates the two
--                              columns is a cycle that ran and found no
--                              CANDIDATES (mail outside the inbox, held back,
--                              or predating the anchor): that advances
--                              `last_run_at` and not the watermark. It is also
--                              the state a deliberate stall holds the watermark
--                              in, so keying dormancy on the watermark would
--                              re-anchor past a stall and quietly undo it.
--
--       WHAT HAPPENS ON A GAP. When `now() - last_run_at` exceeds the step's
--       REANCHOR_GAP_SECONDS, the step CLAMPS `activated_at` forward to
--       `now() - REANCHOR_GAP_SECONDS` — it does NOT re-stamp all three, it
--       does NOT set anything to `now()`, and it does NOT skip the batch:
--
--         * `activated_at`        moves forward to the start of the gap window.
--         * `processed_watermark` is deliberately left ALONE. OFF-window mail
--                                 is already excluded by the anchor predicate
--                                 whatever its `rules_processed_at` says, and
--                                 moving it would skip the triggering batch a
--                                 second way.
--         * `last_run_at`         is advanced by the ordinary end-of-cycle
--                                 stamp, like any other cycle.
--
--       Clamp rather than reset, because the step runs only when a sync
--       persisted mail — so the cycle that DETECTS the gap is always the cycle
--       carrying the message that woke it. Resetting the anchor to `now()` and
--       returning early therefore excluded that message permanently: measured
--       as no mail 22:00→07:30, a prospect writes at 07:30:50, the step runs at
--       07:31:05, and the one lead it existed to catch fell fifteen seconds the
--       wrong side of the anchor its own arrival created. Every night, every
--       weekend.
--
--       ⚠️ ACCEPTED RESIDUAL, and it is not "nothing": mail received in the
--       FINAL REANCHOR_GAP_SECONDS of the window IS minted — one gap-width of
--       mail (an hour), drained across however many cycles the per-cycle cap
--       takes. Everything older stays excluded, which is the fail-closed
--       property that matters: a missed lead is hand-creatable and visible in
--       the mailbox; 27 unattended pushes into a live tenant are neither.
--
--       ⚠️ There is deliberately NO unique index on `crm_leads.email` to go
--       with this. Two concurrent `process_new_mail` invocations for one
--       account can read the same watermark and double-mint; the cost is one
--       visible, hand-deletable duplicate lead, and the alternative — a UNIQUE
--       constraint minted on a column where 1,516 imported rows may already
--       carry duplicates — is a deploy-blocking constraint of exactly the shape
--       migration 148 had to defuse. The accepted race is recorded in
--       `crm_app.md` §9 WS-26d-autolead. Do not "fix" it with that index.
--
-- Spec: project-docs/specs/crm_app.md §9 WS-26d-autolead (the cursor
--       paragraph) · D-CRM-9.
-- Depends on: 17_email_accounts.sql (email_accounts, the FK target) and
--       144_crm.sql (the CRM spine this cursor guards writes into).
--
-- Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only. No seed, no
-- ALTER, nothing dropped.

BEGIN;

CREATE TABLE IF NOT EXISTS crm_auto_lead_cursors (
    -- The mailbox, not the CRM record: the step is per account because
    -- `process_new_mail` is. CASCADE because a disconnected mailbox's cursor
    -- describes nothing — the leads it already minted are CRM rows and are
    -- untouched by this.
    account_id          UUID PRIMARY KEY
                            REFERENCES email_accounts (id) ON DELETE CASCADE,

    -- The start of the current ON epoch. Re-stamped on re-anchor, never
    -- advanced by ordinary progress. See above.
    activated_at        TIMESTAMPTZ NOT NULL,

    -- Advanced to MAX(rules_processed_at) of each batch's successful prefix.
    processed_watermark TIMESTAMPTZ NOT NULL,

    -- Stamped at the end of EVERY cycle, including the ones that considered
    -- nothing and the ones that stalled. The dormancy clock.
    last_run_at         TIMESTAMPTZ NOT NULL,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ⚠️ `CREATE TABLE IF NOT EXISTS` above is a NO-OP against a database that
-- already has the table, so it cannot add a column to one. A scratch or dev
-- database that applied this file while it was still the two-column version
-- (it was numbered 157 then, and briefly had no `last_run_at`) would keep the
-- old shape and every cycle would fail on the missing column. These three
-- statements are the repair, and they are all no-ops on a fresh database:
--   * ADD COLUMN IF NOT EXISTS — nullable, because an existing row has no
--     value to give it and NOT NULL would refuse the ALTER outright;
--   * the backfill takes the best answer available, in order: the row already
--     tells us how far the step got, and failing that when it was activated;
--   * SET NOT NULL then restores the invariant, and is itself a no-op when
--     the column was created NOT NULL by the CREATE TABLE above.
ALTER TABLE crm_auto_lead_cursors
    ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ;

UPDATE crm_auto_lead_cursors
   SET last_run_at = COALESCE(processed_watermark, activated_at, now())
 WHERE last_run_at IS NULL;

ALTER TABLE crm_auto_lead_cursors
    ALTER COLUMN last_run_at SET NOT NULL;

-- The candidate query reads this row by primary key, so no second index is
-- needed here. This one supports the operator question the log line raises —
-- "which mailboxes has auto-lead run on, and when?" — without a seq scan
-- growing with the number of connected accounts.
CREATE INDEX IF NOT EXISTS idx_crm_auto_lead_cursors_last_run_at
    ON crm_auto_lead_cursors (last_run_at);

COMMIT;
