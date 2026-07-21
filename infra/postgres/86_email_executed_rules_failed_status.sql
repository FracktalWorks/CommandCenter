-- 86: rule runs that changed nothing stop claiming they applied.
--
-- Surfaced by the Analytics trust panel the day it shipped: 138 rule
-- applications in 30 days returned 404 from Microsoft Graph, every one logged
-- status='APPLIED' with actions_taken='[]'. The rule matched, the mailbox was
-- never touched, and no surface said so.
--
-- APPLIED is load-bearing, which is why this matters beyond cosmetics:
--
--   * _sender_consistent_for_rule counts APPLIED rows as evidence, so three
--     failed runs against one sender were three votes for pinning that sender
--     to a rule permanently — off a mailbox that was never modified. That is a
--     fourth defect in the gate audited in migration 85 / PR #97.
--   * Analytics counts APPLIED as "emails handled for you", overstating the
--     assistant on the one screen built to measure it.
--
-- The code now writes FAILED when every action errored (partial success stays
-- APPLIED, with the errors alongside in action_errors). This backfills the rows
-- already written under the old rule.
--
-- The predicate is exact rather than heuristic: NOTHING was taken AND at least
-- one error was recorded. A row with actions_taken='[]' and no errors is a rule
-- whose action list was empty — a no-op by configuration, not a failure — and
-- is deliberately left alone.
--
-- Idempotent: re-running matches nothing, because the rows it would match no
-- longer have status='APPLIED'.

UPDATE email_executed_rules
   SET status = 'FAILED'
 WHERE status = 'APPLIED'
   AND actions_taken = '[]'::jsonb
   AND jsonb_array_length(COALESCE(action_errors, '[]'::jsonb)) > 0;

-- The History tab and the auto-learn gate both filter on status; keep that
-- lookup cheap now that a fourth value is in play.
CREATE INDEX IF NOT EXISTS idx_email_executed_rules_status
    ON email_executed_rules (account_id, status, created_at DESC);
