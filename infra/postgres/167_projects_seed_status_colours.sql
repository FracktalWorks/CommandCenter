-- ============================================================================
-- 167_projects_seed_status_colours.sql — WS-27ad · repaint the seeded status
--                                        colours that nobody ever chose.
--
-- Spec: project-docs/specs/project_management_app.md §9.2 (WS-27ad).
--
-- WHY THIS EXISTS
--
-- `pm_task_statuses.color` has been stored since migration 146 and, until
-- WS-27ad, was rendered NOWHERE — every Projects board column drew the same
-- `bg-muted` grey while the /tasks board next door was colour-coded per stage.
-- So these values were never seen by a human, and never chosen by one: they are
-- whatever `routes/projects/tree.py::_SEED_STATUSES` inserted when the project
-- was created.
--
-- WS-27ad made the column render, through one shared vocabulary
-- (`workbench/control_plane/src/lib/statusAccent.ts`) that both apps consume.
-- In that vocabulary a STORED colour outranks the one derived from the status's
-- category — which is correct, because it is what lets an owner choose. The
-- consequence is the problem this file fixes: a seed that disagrees with the
-- shared vocabulary silently overrides it on every project nobody customised.
--
-- The old seed disagreed on two of its four lanes:
--
--     lane          seeded    shared vocabulary    /tasks draws
--     Backlog       gray      gray                 gray            agree
--     To do         blue      gray                 gray            DISAGREE
--     In progress   amber     blue                 blue            DISAGREE
--     Done          green     green                green           agree
--
-- The seed has moved to agree (same commit as this file, and
-- `test_seed_status_colours_match_the_shared_vocabulary` now fails if the two
-- drift apart again). But the seed only governs projects created AFTER the
-- deploy — so without this migration, every project that already exists keeps
-- rendering two of its four lanes in colours that differ from /tasks, which is
-- the exact divergence the whole change set was written to end.
--
-- WHAT IT WILL NOT TOUCH
--
-- Each UPDATE matches the FULL pre-change seed tuple — name, category AND
-- colour together. If any one of the three differs, the row is left alone:
--
--   * renamed the lane ("To do" → "Up next")           → skipped
--   * moved it to another category                     → skipped
--   * already picked a colour (any colour but the old
--     seed value, including one that happens to equal
--     the new one)                                     → skipped
--
-- A human's decision therefore survives even when it coincidentally matches the
-- value we are replacing, because in that case there is nothing to replace. The
-- only rows that move are rows still carrying, unmodified, a default that was
-- invisible for the whole time it existed.
--
-- This is data, not schema: no column is added, altered or dropped, so R6's
-- expand/contract rule has nothing to bind here and old code meets no new
-- shape. A gateway still running the previous release reads these rows exactly
-- as before — it simply drew them grey anyway.
--
-- Idempotent BY CONSTRUCTION rather than by a guard: after the first run no row
-- matches `color = <old value>` any more, so a second run updates zero rows.
--
-- Tenant note (D15/R5): deliberately unqualified by `organization_id`. This is
-- a migration, run as the schema owner, and the defect it repairs is identical
-- in every tenant — a per-tenant loop here would be a job acting for tenants it
-- was not asked about, which is the shape H4 exists to forbid. Migrations are
-- the one place a cross-tenant write is the correct thing.
--
-- Depends on: 146_projects.sql (pm_task_statuses), 164_projects_intake.sql
-- (the `triage` category — untouched here; it has no seeded row).
-- ============================================================================

-- "To do" was seeded blue; the shared vocabulary says a lane where nothing has
-- started is muted, which is what /tasks has always drawn for it.
UPDATE pm_task_statuses
   SET color = 'gray',
       updated_at = now()
 WHERE name = 'To do'
   AND category = 'todo'
   AND color = 'blue';

-- "In progress" was seeded amber; `bg-primary` is this UI's "active" tone
-- everywhere else, and amber means blocked/waiting throughout the product.
UPDATE pm_task_statuses
   SET color = 'blue',
       updated_at = now()
 WHERE name = 'In progress'
   AND category = 'in_progress'
   AND color = 'amber';
