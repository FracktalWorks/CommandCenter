-- ============================================================================
-- 62_email_sender_category_source.sql
-- ============================================================================
-- Convergence: the Inbox Cleaner's sender category should be a PROJECTION of the
-- rule engine's per-message categories (email_messages.categories), not an
-- independent LLM classifier. `category_source` records where a sender's
-- category came from:
--   'rule'     — rolled up from the rule engine's per-message labels (dominant
--                cleanup category, or Personal for a reply-active sender).
--   'inferred' — the cold-start heuristic/LLM fallback, used only when the rules
--                haven't labelled enough of the sender's mail yet (provisional).
--   'user'     — reserved for a future manual override (never auto-overwritten).
--
-- Every existing row was produced by the old standalone LLM classifier, so it's
-- 'inferred'; the categorize job upgrades a sender to 'rule' once rule coverage
-- is sufficient. Idempotent. Depends on 22_email_categorization.sql.
-- ============================================================================

ALTER TABLE email_senders ADD COLUMN IF NOT EXISTS category_source TEXT;

UPDATE email_senders
   SET category_source = 'inferred'
 WHERE category IS NOT NULL AND category_source IS NULL;
