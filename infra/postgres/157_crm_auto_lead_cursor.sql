-- 157_crm_auto_lead_cursor.sql — WS-26d-autolead
--
-- What: one row per email account recording when CRM auto-lead first became
--       active on that mailbox, and how far the step has processed.
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
--       Two timestamps, because "is this message history?" and "have I already
--       looked at this message?" are different questions and one column cannot
--       answer both:
--
--         activated_at         set ONCE, on the step's first ON-state run for
--                              the account, and NEVER advanced. The backfill
--                              discriminator is `received_at > activated_at`:
--                              mail that ARRIVED before auto-lead was first
--                              active mints nothing, no matter when a resync
--                              gets around to classifying it. A moving cursor
--                              cannot express that — it would let a resync
--                              re-present year-old mail as newly processed.
--
--         processed_watermark  the incremental cursor, compared against
--                              `rules_processed_at` and advanced only after a
--                              batch has been written. It is what makes a
--                              re-run of the same sync consider nothing.
--
--       Both predicates apply together. `processed_watermark` starts equal to
--       `activated_at`, so the activating run itself mints nothing.
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

    -- Written once, by the first ON-state run. Never advanced. See above.
    activated_at        TIMESTAMPTZ NOT NULL,

    -- Advanced to MAX(rules_processed_at) of each committed batch.
    processed_watermark TIMESTAMPTZ NOT NULL,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The candidate query reads this row by primary key, so no second index is
-- needed here. This one supports the operator question the log line raises —
-- "which mailboxes has auto-lead ever been active on?" — without a seq scan
-- growing with the number of connected accounts.
CREATE INDEX IF NOT EXISTS idx_crm_auto_lead_cursors_activated_at
    ON crm_auto_lead_cursors (activated_at);

COMMIT;
