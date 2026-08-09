-- ============================================================================
-- 166_projects_lifecycle.sql — WS-27z · lifecycle policy: auto-archive and
--                              auto-close, as three ROOT-project columns.
--
-- Spec: ai-company-brain/specs/project_management_app.md §9.1 (WS-27z),
--       plane_pm_research_2026-08.md §3 (P-4, and the P-28 timezone part) for
--       the rationale only — the AGPL wall in that doc's header binds this
--       file: the shape is re-derived in this schema's own idiom, never
--       translated from Plane.
--
-- What: `pm_projects` gains `archive_after_months`, `close_after_months`
--       (nullable INT, NULL = the policy is OFF — the default, because a
--       sweeper that touches real data must be opted into per project) and a
--       `timezone` (an IANA name, default 'UTC') so "a month untouched" is
--       measured against a midnight the project's owner would recognise
--       rather than against Greenwich.
--
-- Why columns and not a workflow config: D6 — `/workflows` is the only
-- engine, so the SWEEP runs as a scheduled workflow (never a PM-app cron),
-- but the POLICY is per-project data the Projects app owns and edits. The
-- workflow supplies nothing but the trigger and the sweep node; everything
-- it does is read from these columns at run time.
--
-- ⚠️ ROOT-project settings, like every other piece of per-project
-- configuration here (statuses, types, custom fields, tags are all keyed to
-- the ROOT and the subtree inherits). The columns exist on every
-- `pm_projects` row because the table is one self-FK tree, but the sweep
-- reads them from ROOT rows only and acts on `pm_tasks.root_project_id` —
-- so the root's policy governs its whole subtree, and a value written on a
-- child row is inert. The API refuses to write one (422), keeping the inert
-- case unreachable rather than merely documented.
--
-- The months CHECKs live on the columns: zero or negative months would make
-- the cutoff "now or the future" and sweep live work. NULL passes any CHECK,
-- which is exactly the OFF state. `timezone` cannot be CHECK-validated
-- against the IANA database from SQL; the API validates it the same way the
-- workflows app validates a schedule trigger's timezone (zoneinfo), and the
-- sweep falls back to UTC rather than skipping a project if a bad name ever
-- reaches a row.
--
-- Idempotent per infra/postgres/README.md: ADD COLUMN IF NOT EXISTS
-- throughout (the column-level CHECKs ride inside the guarded ADDs, so a
-- replay never re-adds a constraint). Pinned as TEXT by
-- tests/unit/test_projects_lifecycle.py.
--
-- Depends on: 146_projects.sql (pm_projects).
-- ============================================================================

BEGIN;

-- Archive: tasks whose status CATEGORY is done/cancelled and untouched
-- (updated_at) for this many months leave every default surface. NULL = off.
ALTER TABLE pm_projects
    ADD COLUMN IF NOT EXISTS archive_after_months INT
        CHECK (archive_after_months > 0);

-- Close: OPEN tasks untouched for this many months move to the project's
-- closing status (its `cancelled`-category lane, else its `done` one) via the
-- ordinary status transition — never a column write. Triage-category tasks
-- (WS-27u) are exempt: the front-door queue is a place work WAITS. NULL = off.
ALTER TABLE pm_projects
    ADD COLUMN IF NOT EXISTS close_after_months INT
        CHECK (close_after_months > 0);

-- The midnight "a month untouched" is measured against (P-28). An IANA name;
-- API-validated, see the header.
ALTER TABLE pm_projects
    ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

COMMIT;
