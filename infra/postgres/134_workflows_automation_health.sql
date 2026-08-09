-- ============================================================================
-- 134_workflows_automation_health.sql — why a workflow stopped, and since when
-- ============================================================================
-- Mitigates risk R2 of project-docs/specs/workflows_app.md ("silent
-- automation drift"): a published workflow keeps firing on its schedule /
-- webhook / event binding long after the business around it changed. The
-- named mitigation is "disabled-on-repeated-failure policy with notification";
-- run-history visibility and per-workflow owner_email already shipped.
--
--   disabled_reason  why the workflow is not live — free text written by the
--                    auto-disable policy ("5 consecutive failed runs …") or by
--                    a human hitting Disable. NULL whenever status <> disabled.
--   disabled_at      when that happened.
--   health_since     the failure streak is counted only over runs started
--                    AFTER this instant. Publish, rollback, and re-enable all
--                    reset it, which is what makes the policy recoverable: a
--                    workflow auto-disabled after five failures would otherwise
--                    re-disable on its very next failure, because those five
--                    are still the most recent rows in workflow_runs.
--
-- The streak itself is deliberately NOT a counter column. It is derived from
-- workflow_runs on demand, so it cannot drift out of sync with the history a
-- human reads in the run list, and a succeeded run breaks it with no bookkeeping.
--
-- Idempotent. Depends on: 132_workflows.sql.
-- ============================================================================

ALTER TABLE workflows
    ADD COLUMN IF NOT EXISTS disabled_reason TEXT,
    ADD COLUMN IF NOT EXISTS disabled_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS health_since    TIMESTAMPTZ;

-- Existing workflows get a health window starting now: runs recorded before
-- this migration were never subject to the policy, so they must not be able to
-- auto-disable a live workflow the moment it ships.
UPDATE workflows
   SET health_since = now()
 WHERE health_since IS NULL;

-- The policy's read: "the last N unattended terminal runs of this workflow,
-- newest first, started after health_since". idx_workflow_runs_workflow already
-- covers (workflow_id, started_at DESC); this partial index keeps the scan off
-- the manual/api rows, which are the bulk of run history on a workflow under
-- active development.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_unattended
    ON workflow_runs(workflow_id, started_at DESC)
    WHERE trigger_kind IN ('schedule', 'webhook', 'event');
