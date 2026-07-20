-- 81: auto-drafting defaults OFF.
--
-- ``email_assistant_settings.draft_replies`` (migration 26) and
-- ``follow_up_auto_draft`` (migration 29) were both created NOT NULL DEFAULT
-- true. The column default is the REAL default — it decides what an account
-- gets when a settings row is created without naming these columns, whatever
-- the API model says — so an account acquired auto-drafting without anyone
-- choosing it.
--
-- Every draft is a call on the drafting model (tier-powerful), written before
-- anyone has decided the email is worth answering. That has to be a switch the
-- user turns ON, never one they find already running. This matches the backfill
-- ("Process past emails" drafts only when explicitly asked, PR #80) and the
-- API-side defaults in AssistantSettingsModel.
--
-- EXISTING ROWS ARE NOT TOUCHED: a row's value may be a real choice, and
-- rewriting settings under a user is worse than leaving a toggle where they
-- left it. This changes only what a NEW account inherits. Idempotent.

ALTER TABLE email_assistant_settings
    ALTER COLUMN draft_replies SET DEFAULT false;

ALTER TABLE email_assistant_settings
    ALTER COLUMN follow_up_auto_draft SET DEFAULT false;
