-- Email search — reliable full-text search over ALL of a message.
--
-- The problem this fixes: the search query in list_messages (and the new
-- /email/search endpoint) builds its tsvector over subject + BODY_TEXT + sender
-- name + sender email, but the only FTS index that existed
-- (idx_email_messages_fts, migration 17) is built over subject + SNIPPET +
-- sender — it does NOT include body_text. Because a Postgres expression index is
-- only used when the query's expression MATCHES the indexed expression, body
-- search fell through to a sequential scan on every query (and the search box
-- fires on every keystroke). On a year of all-folder history that is slow and
-- scales badly.
--
-- The fix is a GIN expression index whose to_tsvector expression is IDENTICAL to
-- the one the search predicate uses, so the planner can use it. We keep the old
-- snippet index too (other call sites may still lean on it) — this just adds the
-- body-inclusive one.
--
-- No new column and no trigger: an expression index stays correct automatically
-- as rows change, and needs zero application writes. Idempotent (IF NOT EXISTS),
-- safe to re-run on every deploy.

-- Body-inclusive FTS index. The expression MUST stay byte-for-byte in sync with
-- the search predicate in
--   apps/services/gateway/gateway/routes/email/transport/messages.py
--   apps/services/gateway/gateway/routes/email/transport/search.py
-- (same functions, same operand order, same 'english' config) or the planner
-- silently reverts to a seq scan.
CREATE INDEX IF NOT EXISTS idx_email_messages_fts_body
    ON email_messages
    USING GIN (
        to_tsvector('english',
            coalesce(subject, '') || ' ' ||
            coalesce(body_text, '') || ' ' ||
            coalesce(from_address->>'name', '') || ' ' ||
            coalesce(from_address->>'email', '')
        )
    );

-- Helps the search backfill (§ Outlook lazy-body gap) find messages that have no
-- stored body yet: a partial index over the empty-body rows so the sweeper's
-- "WHERE body_text IS NULL OR body_text = ''" scan is cheap even on large boxes.
CREATE INDEX IF NOT EXISTS idx_email_messages_missing_body
    ON email_messages (account_id, received_at DESC)
    WHERE body_text IS NULL OR body_text = '';
