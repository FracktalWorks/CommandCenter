-- ============================================================================
-- 61_email_purge_conversation_and_self_patterns.sql
-- ============================================================================
-- One-off cleanup of learned classification patterns (email_rule_patterns) that
-- should never have been created. Until now the label-sync learner
-- (_learn_from_label_changes) lacked the conversation-rule guard that the Fix
-- and auto-learn paths already had, so a manual (or self-inflicted) "To Reply"
-- label change could pin a SENDER to a conversation-status rule — e.g.
-- "always match souradeep@… → To Reply", or even the mailbox's OWN address.
--
-- These are wrong by design:
--   • Conversation status (To Reply / Awaiting / FYI / Actioned) is re-derived
--     from the whole thread and OVERRIDES any learned pattern — so a sender pin
--     is both incorrect ("every mail from X needs a reply") and futile.
--   • A pattern on the mailbox's own address is a meaningless self-reference.
--
-- The code now blocks both at the single write choke point
-- (_upsert_rule_pattern) and routes manual reply-label changes to a direct
-- thread-status correction instead. This migration removes the rows already
-- persisted before that fix. Idempotent (plain DELETEs). Depends on
-- 31_email_rule_patterns.sql, 19_email_automation.sql, 17_email_accounts.sql.
-- ============================================================================

-- (1) Any pattern attached to a conversation-status rule. Mirrors
--     engine._conversation_rule_key: use system_type when set, else the name
--     (UPPER_SNAKE), and keep only the four reply-status keys.
DELETE FROM email_rule_patterns p
USING email_rules r
WHERE p.rule_id = r.id
  AND COALESCE(NULLIF(UPPER(TRIM(r.system_type)), ''),
               REPLACE(UPPER(TRIM(r.name)), ' ', '_'))
      IN ('TO_REPLY', 'AWAITING_REPLY', 'FYI', 'ACTIONED');

-- (2) Any FROM pattern that pins the mailbox's own address (self-reference).
DELETE FROM email_rule_patterns p
USING email_accounts a
WHERE p.account_id = a.id
  AND p.pattern_type = 'FROM'
  AND a.email_address IS NOT NULL
  AND TRIM(a.email_address) <> ''
  AND POSITION(LOWER(TRIM(a.email_address)) IN LOWER(p.value)) > 0;
