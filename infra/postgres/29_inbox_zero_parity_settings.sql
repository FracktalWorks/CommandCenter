-- ============================================================================
-- 29_inbox_zero_parity_settings.sql — inbox-zero parity for assistant settings
-- ============================================================================
-- Adds the settings inbox-zero exposes on its Assistant > Settings tab so our UI
-- can match it field-for-field:
--
--   draft_confidence          ALL_EMAILS | STANDARD | HIGH_CONFIDENCE — how sure
--                             the AI must be before drafting a reply.
--   follow_up_awaiting_days   remind me when THEY haven't replied after N days
--   follow_up_needs_reply_days remind me when I haven't replied after N days
--   follow_up_auto_draft      draft a nudge automatically for awaiting threads
--   digest_categories         which rule names (+ 'Cold Emails') go in the digest;
--                             empty = everything.
--   digest_day_of_week        0=Sun … 6=Sat — used when digest_frequency=WEEKLY
--   digest_time_of_day        HH:MM (24h, account-local) the digest is sent
--   digest_send_to_email      email the digest to the account address
--
-- The legacy single `follow_up_days` is folded into `follow_up_awaiting_days`.
--
-- Idempotent. Depends on 20_email_assistant_settings.sql + 27_email_reply_tracking.sql.
-- ============================================================================

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS draft_confidence TEXT NOT NULL DEFAULT 'ALL_EMAILS';

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS follow_up_awaiting_days INTEGER NOT NULL DEFAULT 0;

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS follow_up_needs_reply_days INTEGER NOT NULL DEFAULT 0;

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS follow_up_auto_draft BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS digest_categories TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS digest_day_of_week INTEGER NOT NULL DEFAULT 1;

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS digest_time_of_day VARCHAR(5) NOT NULL DEFAULT '09:00';

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS digest_send_to_email BOOLEAN NOT NULL DEFAULT true;

-- Fold the legacy follow_up_days into the new awaiting-days field (one-time, only
-- where the new column is still at its default and the legacy value was set).
UPDATE email_assistant_settings
   SET follow_up_awaiting_days = follow_up_days
 WHERE follow_up_awaiting_days = 0
   AND follow_up_days > 0;

-- Idempotency marker so the follow-up reminder worker labels/nudges each thread
-- once, not every sync cycle. Reset (NULL) whenever a thread's status changes.
ALTER TABLE email_thread_status
    ADD COLUMN IF NOT EXISTS follow_up_reminded_at TIMESTAMPTZ;
