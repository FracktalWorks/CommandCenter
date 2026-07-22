-- 89: give messages their stable RFC 5322 Message-ID, to dedupe provider re-keys.
--
-- Outlook changes a message's provider_message_id when it moves between folders
-- (and on some server-side operations). The ingest upsert keys on
-- (account_id, provider_message_id), so a re-keyed message did not conflict with
-- its existing row — it was INSERTed again as a duplicate "ghost". The ghosts
-- then get classified a second time and skew per-thread heuristics.
--
-- internet_message_id is the RFC 5322 Message-ID header, stable across a re-key.
-- New syncs populate it ($select=internetMessageId); the upsert reclaims the
-- existing row by (account_id, internet_message_id) before inserting, so a
-- re-keyed message updates its row instead of spawning a ghost.
--
-- The index backs that per-sync reclaim lookup. It is deliberately NOT unique:
-- (1) legacy rows have a NULL id until they are re-synced, and (2) forwarded or
-- duplicated mail can legitimately repeat a Message-ID — a hard constraint would
-- reject the second and lose the message. The app-layer reclaim treats a repeat
-- as the same message, which is the desired dedupe without the data-loss risk.
--
-- Existing ghost rows (NULL internet_message_id today) are NOT merged here: the
-- id has to be backfilled by a sync cycle first, so that cleanup is a separate
-- one-off pass (scripts/, run after ids populate), like the #112 repair.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.

ALTER TABLE email_messages
    ADD COLUMN IF NOT EXISTS internet_message_id TEXT;

CREATE INDEX IF NOT EXISTS idx_email_messages_internet_message_id
    ON email_messages (account_id, internet_message_id)
    WHERE internet_message_id IS NOT NULL;
