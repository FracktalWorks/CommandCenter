-- ============================================================================
-- 171_projects_run_state.sql — WS-27bg slice 1: the project run state becomes
--                              an axis, and "archived" leaves it.
--
-- ⚠️ The number was taken from the directory at BUILD time (R1) and is
--    re-checked at merge. `tests/unit/test_projects_run_state.py` finds this
--    file by CONTENT (`archived_root_id`), never by number, so a renumber in
--    review costs nothing.
--
-- Spec: project-docs/specs/project_management_app.md §9.8.3, and the three
--       decisions taken before it was minted — D-PM-25 (two axes), D-PM-26
--       (derive, never cascade onto tasks), D-PM-27 (the hue map).
--
-- What: `pm_projects.status` widens to carry `queued` and `stopped`, and gains
--       `archived_root_id` so that archiving a subtree is REVERSIBLE.
--
-- ── The defect this corrects (D-PM-25) ──────────────────────────────────────
--
-- Migration 146 shipped BOTH of these on the same table:
--
--     status      TEXT NOT NULL DEFAULT 'active'
--                     CHECK (status IN ('active','on_hold','done','archived')),
--     archived_at TIMESTAMPTZ
--
-- so "this project is archived" has two representations, and the enum answers
-- two unrelated questions with one value: *is work flowing?* and *do you want
-- to see this?* A project can be done-and-visible (just finished, still on the
-- board) or paused-and-filed (shelved indefinitely). One column cannot say
-- both, which is why neither half was ever wired to anything.
--
-- After this migration:
--
--   * `status` is the RUN STATE  — queued · active · on_hold · stopped · done
--   * archive is `archived_at IS NOT NULL`, and nothing else
--
-- ── R6, expand/contract — and what is deliberately NOT done here ────────────
--
-- The CHECK widens to the **union** of the old and new values. `'archived'` is
-- still accepted after this migration even though nothing will write it again.
-- That is the expand half and it is not laziness: the deploy applies migrations
-- BEFORE restarting services, so for a window the OLD gateway is running
-- against THIS schema, and that gateway's `PROJECT_STATUSES` still contains
-- 'archived'. Tightening in the same change would 500 every project write in
-- that window. **We cannot roll back**, so the contraction
--
--     ALTER TABLE pm_projects DROP CONSTRAINT pm_projects_status_check;
--     ALTER TABLE pm_projects ADD  CONSTRAINT pm_projects_status_check
--         CHECK (status IN ('queued','active','on_hold','stopped','done'));
--
-- is a LATER release, and its trigger is named rather than implied: once this
-- migration is live and `SELECT count(*) FROM pm_projects WHERE status =
-- 'archived'` is zero on the box, the drop is safe and is a migration of its
-- own. Naming it here is what stops it becoming folklore.
--
-- `active` and `on_hold` are NOT renamed to the labels the UI shows (Ongoing,
-- Paused). R6 forbids renaming in place; `active` is the DEFAULT on every
-- existing row; and display-label-over-stored-value is already how
-- `pm_task_statuses` works (name and colour are the owner's, `category` is the
-- machine-readable half). A rename would touch every call site to buy a word.
--
-- ── The backfill, and the honest thing about it ─────────────────────────────
--
-- Every surviving `status = 'archived'` row moves onto the two axes: stamped
-- `archived_at`, and given a run state.
--
-- ⚠️ **The run state it gets is a GUESS, and it is recorded as one.** The old
-- schema threw the information away — a project marked 'archived' has no
-- surviving record of whether it was running, paused or finished when somebody
-- filed it. `on_hold` is chosen as the least-wrong answer: it is the only value
-- that claims nothing (`done` would assert a success that may not have
-- happened, `stopped` an abandonment). The project is out of every default
-- surface anyway while `archived_at` is set, so the value is visible only to
-- somebody browsing archived projects, who is exactly the person able to
-- correct it.
--
-- ⚠️ **The population is NOT known to be zero.** Reading the live database is
-- owner-gated reach (work_plan.md §6), so an agent claiming "this affects no
-- rows" would be reporting a guess as a measurement. No UI has ever written
-- this column, but the API has accepted it on create AND patch since 146. The
-- statement below is therefore set-based and idempotent: correct at zero rows
-- and at ten thousand, and a replay is a no-op because it selects on the very
-- value it removes. The count is asked of the owner at review.
--
-- ── Why `archived_root_id` exists ───────────────────────────────────────────
--
-- Archiving a project archives its subtree. The subtree is stamped at WRITE
-- time rather than walked at READ time, and that choice is deliberate: archive
-- is rare, task reads are hot, and a recursive CTE on every task list to
-- discover whether some ancestor is archived would put the walk on the wrong
-- side of the ratio. Stamping keeps the read a plain indexed join.
--
-- ⚠️ This does NOT contradict D-PM-26. That decision forbids cascading onto
-- `pm_tasks` — thousands of rows, a timeline entry each, a delta-sync bump
-- each. A project subtree is tens of rows of the entity actually being
-- archived, and **no task row is written by any of it**.
--
-- The column is what makes the cascade reversible. Archiving P stamps
-- `archived_root_id = P` on P and every descendant; unarchiving P clears
-- exactly the rows carrying `archived_root_id = P`. A subproject that somebody
-- had ALREADY archived on its own carries its own id there, so it survives the
-- parent's unarchive instead of being silently un-filed — the class of quiet
-- data loss that shows up months later as "who un-archived this?".
--
-- Depends on: 146_projects.sql (pm_projects).
-- Idempotent per infra/postgres/README.md: DROP CONSTRAINT IF EXISTS before
-- ADD, ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, and a backfill
-- that cannot match its own output.
-- ============================================================================

BEGIN;

-- ── 1. Widen the run-state CHECK to the union (the expand half of R6) ───────
--
-- `pm_projects_status_check` is the name Postgres generated for the inline
-- CHECK in 146. IF EXISTS covers a database where it was never created under
-- that name; the ADD then establishes it either way.
ALTER TABLE pm_projects DROP CONSTRAINT IF EXISTS pm_projects_status_check;
ALTER TABLE pm_projects ADD CONSTRAINT pm_projects_status_check
    CHECK (status IN (
        -- The run-state axis, in lifecycle order.
        'queued', 'active', 'on_hold', 'stopped', 'done',
        -- Retained ONLY so the pre-restart gateway keeps working through the
        -- deploy window. Dropped in a later release; see the header.
        'archived'
    ));

-- ── 2. The archive origin, which is what makes unarchive reversible ─────────
--
-- NULL for a project that is not archived. Self-referencing for the project
-- somebody actually archived; pointing AT that project for every descendant
-- the archive swept in.
--
-- ON DELETE SET NULL rather than CASCADE: deleting the origin must not delete
-- the projects it once filed. (In practice `parent_project_id`'s own CASCADE
-- gets there first, since the origin is always an ancestor — but a foreign key
-- that would be wrong if reached is worth not writing.)
ALTER TABLE pm_projects
    ADD COLUMN IF NOT EXISTS archived_root_id UUID
        REFERENCES pm_projects (id) ON DELETE SET NULL;

COMMENT ON COLUMN pm_projects.archived_root_id IS
    'WS-27bg. The project whose archive filed this row: itself when archived '
    'directly, an ancestor when swept in as part of that ancestor''s subtree. '
    'Unarchiving clears only the rows it stamped, so a subproject archived on '
    'its own survives its parent''s unarchive. NULL when not archived.';

-- Serves the unarchive sweep (`WHERE archived_root_id = :id`). Partial,
-- because the overwhelming majority of rows are NULL and never participate.
CREATE INDEX IF NOT EXISTS idx_pm_projects_archived_root
    ON pm_projects (archived_root_id)
    WHERE archived_root_id IS NOT NULL;

-- ── 3. Move the old 'archived' status onto the two axes ─────────────────────
--
-- Idempotent by construction: the predicate selects `status = 'archived'` and
-- the update removes that value, so a replay matches nothing. `archived_at` is
-- coalesced rather than overwritten — a row that somehow carries both keeps the
-- timestamp it already had, because a real filing date outranks now().
UPDATE pm_projects
   SET status           = 'on_hold',
       archived_at      = coalesce(archived_at, now()),
       archived_root_id = coalesce(archived_root_id, id)
 WHERE status = 'archived';

COMMIT;
