-- 44_chat_message_index_desc.sql
-- Align the chat_message index direction with how the table is actually queried.
--
-- The hot path (apps/gateway/gateway/routes/chat.py :: _get_messages) reads:
--     WHERE session_id = :sid [AND timestamp_ms < :before]
--     ORDER BY timestamp_ms DESC LIMIT :limit
-- i.e. the newest-first windowed lazy-load plus the `before` backwards-paging
-- cursor.  The original index (02_chat_history.sql) was created ASC — the
-- opposite of the dominant read.  Postgres can scan a btree backwards, so the
-- ASC index was not broken, but a DESC index matches the DESC windowed read
-- directly AND still serves the ASC full-history read via a backward scan, so it
-- is strictly >= the ASC index for every query against this table.
--
-- Idempotent: drop the old index and (re)create it DESC.
-- Depends on: 02_chat_history.sql (chat_message table + the original index).

DROP INDEX IF EXISTS chat_message_session_ts_idx;
CREATE INDEX IF NOT EXISTS chat_message_session_ts_idx
    ON chat_message (session_id, timestamp_ms DESC);
