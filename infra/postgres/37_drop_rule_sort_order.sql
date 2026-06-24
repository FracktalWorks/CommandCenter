-- ============================================================================
-- 37_drop_rule_sort_order.sql — remove the obsolete rule "priority" column
-- ============================================================================
-- Rule order is no longer user-controlled. Rules are presented to the classifier
-- and applied (multi-rule) in a fixed canonical system order computed in code
-- (inbox-zero parity), so `sort_order` drives nothing. Drop it.
--
-- Dropping the column also drops idx_email_rules_account (it included
-- sort_order), so recreate that index without it.
--
-- Idempotent: safe to re-run on every deploy.
-- Depends on: 19_email_automation.sql
-- ============================================================================

ALTER TABLE email_rules DROP COLUMN IF EXISTS sort_order;

CREATE INDEX IF NOT EXISTS idx_email_rules_account
    ON email_rules(account_id, enabled);
