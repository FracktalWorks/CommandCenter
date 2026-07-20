-- 82: live reply-drafting defaults back ON; follow-up auto-draft stays OFF.
--
-- Migration 81 defaulted BOTH auto-draft columns off. That was too broad.
--
-- The user's rule is about the AGE of the thread, not the act of drafting:
--
--   "this should only apply when I am processing past emails ... the regular
--    rules apply as is for new mails that come in"     — 2026-07-20
--
-- A draft on mail that just arrived is the feature — it is waiting when they
-- open the message. A draft on a months-old thread is spend on a conversation
-- that already ended, and a backfill can produce hundreds in a single run. That
-- distinction is enforced where it belongs: RuleProcessPastRequest.draft_replies
-- defaults False and _without_drafting strips REPLY/DRAFT_EMAIL/FORWARD from
-- every backfill match (PR #80).
--
-- So draft_replies goes back to its original default. follow_up_auto_draft
-- stays OFF (set in 81): that feature nudges threads by age, and its scan was
-- dead from the day it shipped until #84 — the first working run on a
-- long-configured account releases the whole window at once, which is the
-- hundreds-at-once case, not the just-arrived case.
--
-- EXISTING ROWS ARE STILL NOT TOUCHED. Idempotent.

ALTER TABLE email_assistant_settings
    ALTER COLUMN draft_replies SET DEFAULT true;
