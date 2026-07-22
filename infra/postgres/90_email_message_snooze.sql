-- 90: snooze a conversation out of the inbox until a chosen time.
--
-- Snooze is inbox triage: "deal with this later." Setting snoozed_until on a
-- message hides it from every browse view (inbox / all / a folder) until that
-- time passes, at which point it reappears on its own — the wake is at QUERY
-- time (`snoozed_until IS NULL OR snoozed_until <= now()`), so no scheduler or
-- background job is needed. A dedicated "Snoozed" view lists what's still
-- sleeping (`snoozed_until > now()`).
--
-- Snooze is applied per-conversation: the endpoint stamps every message sharing
-- the thread_id, so the whole conversation leaves and returns together (a lone
-- message with no thread is stamped on its own). A thread *load* ignores the
-- flag — opening a snoozed conversation still shows all of it.
--
-- The partial index backs the two predicates above (the exclusion on browses and
-- the Snoozed view); the vast majority of rows are never snoozed, so indexing
-- only the non-NULL rows keeps it tiny.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.

ALTER TABLE email_messages
    ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_email_messages_snoozed
    ON email_messages (account_id, snoozed_until)
    WHERE snoozed_until IS NOT NULL;
