-- ============================================================================
-- 173_person_capacity.sql — how many hours a week a person is available.
--
-- Spec: `ProjectApp_Plan.md` §26 (owed to S14) · consumer
-- `routes/projects/ops.py::ops_workload`.
--
-- ## The problem this closes
--
-- `/ops/workload` divides tracked time by a DEFAULT of 40h that no column
-- holds, and says so in its `basis` string. Saying so is honest, but it is
-- still a percentage whose denominator is invented — and the People/Workload
-- screen is meant to answer "who is overloaded", which is not a question a
-- guessed denominator can answer for a part-timer, a contractor, or anybody on
-- leave.
--
-- ## Why on `app_user` and not in `org_settings`
--
-- `org_settings` is a key/value store with **no `organization_id`** — it
-- predates the tenancy work. Putting a per-organization default there would
-- either be global across tenants (wrong) or need the table keyed first, which
-- is WS-29's business and not this slice's. `app_user` is already tenant-scoped
-- (`organization_id`, migration 158), so the per-person value lands where the
-- tenant boundary already holds and the org-wide default stays a named constant
-- in `operations.py` until somebody needs to change it per customer.
--
-- ## R6
--
-- NULLABLE with no default, and NULL is meaningful: "nobody has said", which
-- the API reports distinctly from "40" so a reader can tell an assumption from
-- a fact. Old code neither writes nor reads it; the column is inert until
-- `ops_workload` looks.
--
-- ## R5
--
-- No new table. `app_user` carries `organization_id` already, so the value is
-- inside the tenant boundary by construction.
--
-- Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE app_user
    ADD COLUMN IF NOT EXISTS weekly_capacity_hours NUMERIC(5, 2);

-- A negative week is not a thing, and 168 is the number of hours in one. The
-- ceiling is not pedantry: a fat-fingered 400 silently makes somebody look
-- permanently idle on every capacity report.
ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_capacity_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_capacity_check
    CHECK (weekly_capacity_hours IS NULL
           OR (weekly_capacity_hours > 0 AND weekly_capacity_hours <= 168));

COMMIT;
