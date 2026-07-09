-- ============================================================================
-- 63_email_rename_reply_done_labels.sql
-- ============================================================================
-- Rename the two conversation-status (Reply Zero) labels for clarity:
--     "To Reply" → "Reply"      (system_type TO_REPLY → REPLY)
--     "Actioned" → "Done"       (system_type ACTIONED → DONE)
-- "Awaiting Reply" and "FYI" are unchanged. The DERIVED thread-status codes in
-- email_thread_status (NEEDS_REPLY / AWAITING / DONE / FYI) are internal and are
-- NOT touched — only the user-facing rule name, the rule key (system_type), the
-- LABEL action value, and the label strings already stamped on messages.
--
-- The application also folds the legacy tokens/labels at every normalization
-- boundary (_LEGACY_STATUS_KEYS / _LEGACY_CONVERSATION_LABELS), so this migration
-- is a data cleanup, not a correctness gate — but running it makes the rename
-- immediate (rules, actions and existing tags all read the new names at once)
-- and lets a resync sweep the old provider labels.
--
-- Idempotent: after it runs no old value remains to match. Depends on
-- 19_email_automation.sql (email_rules, email_actions) and the email_messages
-- table (18_email_message_status.sql).
-- ============================================================================

-- (1) Rule name + key. Match a rule the way the engine does: system_type when
--     set, else the name folded to UPPER_SNAKE. Preserve a NULL system_type as
--     NULL (seeded presets store it NULL and match by name) — only rewrite an
--     already-populated key. The UNIQUE(account_id, name) constraint is safe:
--     an account never carries both the old and the new name.
UPDATE email_rules
   SET name = 'Reply',
       system_type = CASE WHEN system_type IS NOT NULL THEN 'REPLY'
                          ELSE system_type END,
       updated_at = now()
 WHERE COALESCE(NULLIF(UPPER(TRIM(system_type)), ''),
                REPLACE(UPPER(TRIM(name)), ' ', '_')) = 'TO_REPLY';

UPDATE email_rules
   SET name = 'Done',
       system_type = CASE WHEN system_type IS NOT NULL THEN 'DONE'
                          ELSE system_type END,
       updated_at = now()
 WHERE COALESCE(NULLIF(UPPER(TRIM(system_type)), ''),
                REPLACE(UPPER(TRIM(name)), ' ', '_')) = 'ACTIONED';

-- (2) LABEL action values that name the conversation label.
UPDATE email_actions
   SET label = 'Reply'
 WHERE type = 'LABEL' AND label = 'To Reply';

UPDATE email_actions
   SET label = 'Done'
 WHERE type = 'LABEL' AND label = 'Actioned';

-- (3) Old label strings already stamped on messages (email_messages.categories
--     is a text[]). Rewrite in place so existing mail shows the new tag without
--     waiting for a resync. Only rows that actually carry an old label are
--     touched (idempotent via the overlap guard).
UPDATE email_messages
   SET categories = ARRAY(
         SELECT CASE c WHEN 'To Reply' THEN 'Reply'
                       WHEN 'Actioned' THEN 'Done'
                       ELSE c END
         FROM unnest(categories) AS c
       ),
       updated_at = now()
 WHERE categories && ARRAY['To Reply', 'Actioned']::text[];
