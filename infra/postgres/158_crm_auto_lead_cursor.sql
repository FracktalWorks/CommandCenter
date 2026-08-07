-- 158_crm_auto_lead_cursor.sql — WS-26d-autolead
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
--         last_run_at          when the step last RAN. This is what detects
--                              dormancy — an OFF window, or an outage — and it
--                              has to be its own column: the watermark tracks
--                              MAIL, so a mailbox that is merely quiet over a
--                              weekend has a 60-hour-old watermark while the
--                              step has run faithfully every 600s. Re-anchoring
--                              such an account would drop Monday's first
--                              message, which is exactly the message this
--                              feature exists to catch. (It also keeps a
--                              deliberate stall on a poison message stalled,
--                              instead of quietly re-anchoring past it.)
--
--       When `now() - last_run_at` exceeds the step's REANCHOR_GAP_SECONDS,
--       all three are re-stamped to now: the ON epoch restarts and the gap's
--       backlog mints nothing. Fail-closed in both directions — a missed lead
--       is hand-creatable and visible in the mailbox; 27 unattended pushes
--       into a live tenant are neither.
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
-- Spec: ai-company-brain/specs/crm_app.md §9 WS-26d-autolead (the cursor
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

-- The candidate query reads this row by primary key, so no second index is
-- needed here. This one supports the operator question the log line raises —
-- "which mailboxes has auto-lead run on, and when?" — without a seq scan
-- growing with the number of connected accounts.
CREATE INDEX IF NOT EXISTS idx_crm_auto_lead_cursors_last_run_at
    ON crm_auto_lead_cursors (last_run_at);

COMMIT;
