-- ============================================================================
-- 38_email_reply_memory_scopes.sql — scoped reply-memory system (Phase 8 P1)
-- ============================================================================
-- Upgrade email_learned_patterns from a single global preference list into a
-- scoped reply-memory store (inbox-zero parity): memories carry a KIND
-- (FACT | PROCEDURE | PREFERENCE) and a SCOPE (SENDER | DOMAIN | TOPIC | GLOBAL),
-- so a fact about one sender doesn't leak into every draft. GLOBAL memories are
-- always injected (<learned_patterns>); SENDER/DOMAIN/TOPIC ones are injected
-- only when they match the email being drafted (<reply_memories>). PREFERENCE
-- memories double as evidence for the learned writing style (P2).
--
-- Idempotent. Depends on 28_email_learned_patterns.sql.
-- ============================================================================

ALTER TABLE email_learned_patterns
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'PREFERENCE',
    ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'GLOBAL',
    ADD COLUMN IF NOT EXISTS scope_value TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS is_style_evidence BOOLEAN NOT NULL DEFAULT false;

-- The same memory text can now exist under different scopes/kinds, so replace
-- the old (account_id, pattern) unique with a scoped one.
ALTER TABLE email_learned_patterns
    DROP CONSTRAINT IF EXISTS email_learned_patterns_account_id_pattern_key;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_learned_patterns_scoped_key'
  ) THEN
    ALTER TABLE email_learned_patterns
      ADD CONSTRAINT email_learned_patterns_scoped_key
      UNIQUE (account_id, kind, scope_type, scope_value, pattern);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_email_learned_patterns_scope
    ON email_learned_patterns(account_id, scope_type, scope_value);
