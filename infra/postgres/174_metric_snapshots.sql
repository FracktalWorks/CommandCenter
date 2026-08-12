-- ============================================================================
-- 174_metric_snapshots.sql — yesterday's numbers, so a delta can be honest.
--
-- Spec: `ProjectApp_Plan.md` §27 · D-OPEN-10 · consumer `ops.py::ops_summary`.
--
-- ## Why this exists
--
-- The Control Center's KPI tiles were specified with deltas ("▲12% vs last
-- month") and shipped WITHOUT them, because nothing stored yesterday's counts
-- and an invented delta is worse than an absent one. This is the store that
-- lets them be real.
--
-- ## Shape
--
-- One row per (organization, date, metric). Long and narrow rather than a
-- column per metric: the tile set has already changed twice in this workstream
-- (`awaiting_client` arrived after the first six), and a wide table would need
-- a migration every time somebody adds a number to a dashboard.
--
-- `value` is NUMERIC, not INTEGER — "average days blocked" is a metric this
-- table should be able to hold without another migration.
--
-- ## R5
--
-- `organization_id` is NOT NULL and part of the key. Unlike the `pm_*` child
-- tables it has no parent row to derive from — a snapshot is ABOUT an
-- organization rather than about a task — so the writer supplies it from the
-- caller's resolved tenant, which is the same source every other write uses.
--
-- ## R6
--
-- A new table, nothing altered. `ON CONFLICT (organization_id, captured_on,
-- metric) DO UPDATE` makes re-capturing a day idempotent: a job that runs twice
-- must not double-count, and a job re-run after a fix must correct the day
-- rather than refuse it.
--
-- ⚠️ **Nothing schedules this.** The capture endpoint exists; wiring a timer to
-- it is deploy reach, which is OWNER-GATE (work_plan.md §6). Until then the
-- table fills only when somebody calls it, and `ops_summary` returns deltas
-- only for days it actually has — never an extrapolation.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS pm_metric_snapshots (
    organization_id UUID NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
    captured_on     DATE NOT NULL,
    metric          TEXT NOT NULL,
    value           NUMERIC(14, 2) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, captured_on, metric)
);

-- The read is always "this metric, this org, over a window", newest first.
CREATE INDEX IF NOT EXISTS idx_pm_metric_snapshots_lookup
    ON pm_metric_snapshots (organization_id, metric, captured_on DESC);

COMMIT;
