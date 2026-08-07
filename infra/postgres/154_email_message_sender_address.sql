-- ============================================================================
-- 154_email_message_sender_address.sql — index the sender address expression
-- ============================================================================
-- WS-26d-email (specs/crm_app.md §9): the CRM timeline joins email threads to a
-- record by the sender's address —
--
--     LOWER(em.from_address->>'email') = <the record's email>
--
-- and nothing indexed that expression. `from_address` is JSONB, so the address
-- is only reachable through `->>`; the two FTS GINs (17_email_accounts.sql and
-- 72_email_search_fts.sql) bury it inside a `to_tsvector` and are usable only
-- via `@@`. Case is not normalised on write (email_ingestion/persist.py stamps
-- the provider's spelling verbatim), so every reader lowercases at query time
-- and the index has to be on the lowered expression to be usable at all.
--
-- Leading with `account_id` matches how every reader of this table is scoped:
-- the caller's own accounts first (`routes/email/core.py::_account_scope`),
-- then the address. The contact card (routes/email/transport/contacts.py) runs
-- the same predicate unindexed today; the CRM timeline would run it on every
-- record open, which is what turns "slow once" into "slow always".
--
-- Idempotent. Depends on 17_email_accounts.sql.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_email_messages_from_address
    ON email_messages (account_id, LOWER(from_address->>'email'));
