-- 45_email_fk_indexes.sql
-- Index FK columns that are filtered/joined but were left unindexed, and drop a
-- redundant index. Pure index maintenance — idempotent, no data change.
--
-- - email_executed_rules.message_id / .rule_id are FKs used by the History UI
--   and per-message lookups, but only (account_id, created_at DESC) was indexed,
--   so those lookups (and parent deletes that must null these FKs) scanned.
-- - email_rule_patterns.rule_id is a NOT NULL FK with only an account_id index;
--   pattern-by-rule lookups did a partial scan.
-- - idx_provider_keys_provider duplicates the provider PRIMARY KEY's unique
--   index (provider IS the PK), so it never adds value.
--
-- NOTE: CHECK constraints on the email status columns (email_messages.importance,
-- email_executed_rules.status, email_thread_status.status, email_rules.system_type,
-- email_newsletters.status, email_senders.category, email_cold_senders.status) are
-- deliberately NOT added here. Their allowed values evolved across migrations
-- (18 / 36 / 43) and the application code, so a CHECK built from the creation-time
-- comments could reject valid inserts — and a CHECK applies to NEW inserts even
-- when added NOT VALID. Enforce those at the application layer, or add a CHECK
-- only after confirming each column's CURRENT live value set.
--
-- Depends on: 08 (provider_keys), 19 (email_executed_rules), 31 (email_rule_patterns).

CREATE INDEX IF NOT EXISTS idx_email_executed_rules_message
    ON email_executed_rules (message_id);
CREATE INDEX IF NOT EXISTS idx_email_executed_rules_rule
    ON email_executed_rules (rule_id);
CREATE INDEX IF NOT EXISTS idx_email_rule_patterns_rule
    ON email_rule_patterns (rule_id);

DROP INDEX IF EXISTS idx_provider_keys_provider;
