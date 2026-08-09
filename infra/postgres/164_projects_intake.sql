-- ============================================================================
-- 164_projects_intake.sql — WS-27u · intake/triage: the front door.
--
-- Spec: ai-company-brain/specs/project_management_app.md §9.1 (WS-27u),
--       plane_pm_research_2026-08.md §3 (P-1) for the rationale only — the
--       AGPL wall in that doc's header binds this file: the shape is
--       re-derived in this schema's own idiom, never translated.
--
-- A captured task is REAL FROM BIRTH: it is an ordinary `pm_tasks` row, so a
-- comment, an assignee, an attachment or a link is legal on it from the first
-- second. What makes it "intake" is a WRAPPER row here plus a status whose
-- category is `triage` — and the one predicate in `routes/projects/core.py`
-- (`triage_exclusion_clause`) that keeps triage-category tasks out of every
-- board, list, calendar, timeline and search read unless `include_triage` is
-- passed.
--
-- The wrapper is PROVENANCE, and provenance is permanent: accept, decline,
-- duplicate and snooze all UPDATE this row and none of them deletes it. Six
-- months later "where did this task come from, and who ruled on it" is a
-- point read, not an archaeology dig through `pm_activities`.
--
-- Why a join table and not columns on `pm_tasks`: the overwhelming majority
-- of tasks are never captured — they are typed into a board by somebody who
-- has already decided the work is real — and four NULL columns on every one
-- of them would make the common row carry the rare row's bookkeeping. The
-- same trade `pm_task_personal` (147) made, for the same reason.
--
-- Tenancy per D-MT-3, in the shape migration 161 established: the key is
-- carried on the row, filled and cross-checked by 161's
-- `pm_organization_from_parent` trigger (which this migration can attach
-- because 161 replays before it). `duplicate_of_task_id` gets its own
-- attachment for the reason `pm_task_links` has two: a row naming two tasks
-- is a row that could STRADDLE two organizations, and the second attachment
-- is what makes that impossible rather than merely unlikely.
--
-- Idempotent per infra/postgres/README.md: IF NOT EXISTS everywhere,
-- CREATE OR REPLACE TRIGGER, and the category CHECK is widened through the
-- same find-by-shape DROP/ADD pair migration 150 used on `pm_activities.type`
-- — dropping an assumed constraint NAME is a silent no-op that leaves the
-- old, narrower CHECK in force beside the new one.
--
-- Depends on: 146_projects.sql (pm_tasks, pm_task_statuses),
--             161_projects_tenancy.sql (pm_organization_from_parent).
-- ============================================================================

BEGIN;

-- ── The wrapper ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pm_intake (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- UNIQUE: one front door per task. A task is either awaiting a ruling or
    -- it has been ruled on; two wrappers would be two answers to which.
    -- CASCADE with the task — the wrapper is provenance OF the task, and
    -- provenance of a row that no longer exists points at nothing.
    task_id              UUID NOT NULL UNIQUE REFERENCES pm_tasks (id) ON DELETE CASCADE,

    -- The ruling. `pending` and `snoozed` are the queue states; the other
    -- three are terminal and the row survives all of them.
    status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'accepted', 'declined',
                                           'duplicate', 'snoozed')),

    -- `snoozed` only: the instant the item REAPPEARS in the queue. The queue
    -- read is `snoozed_until <= now()`, so nothing has to wake up and flip
    -- the row back — a snooze that needed a worker would be a second
    -- scheduler, which §5's non-goals forbid.
    snoozed_until        TIMESTAMPTZ,

    -- `duplicate` only: the task this one duplicates. SET NULL, not CASCADE —
    -- deleting the original must not delete the record that this capture was
    -- ruled a duplicate; the ruling stands even when its target is gone.
    duplicate_of_task_id UUID REFERENCES pm_tasks (id) ON DELETE SET NULL,

    -- Where the capture came from and how to find it there: free text on
    -- purpose ('email', 'slack', 'api', …) plus an opaque reference
    -- (a message id, a permalink). Deliberately NOT the CHECK'd
    -- `pm_tasks.source` vocabulary — routing rules (§6.5, out of scope here)
    -- will speak in sources nobody has enumerated yet, and a CHECK would put
    -- a migration between every new capture channel and its first row.
    source               TEXT,
    source_ref           TEXT,

    -- D-MT-3 — filled from the task by 161's trigger, attached below.
    organization_id      UUID REFERENCES organization (id) ON DELETE CASCADE,

    created_by           TEXT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The queue read: pending, plus snoozed rows whose time has come.
CREATE INDEX IF NOT EXISTS idx_pm_intake_status
    ON pm_intake (status, snoozed_until);

-- Fill from the task; refuse a wrapper whose org disagrees with its task's.
CREATE OR REPLACE TRIGGER trg_pm_intake_org_from_task
    BEFORE INSERT OR UPDATE ON pm_intake
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_tasks', 'task_id');

-- The straddle guard: when `duplicate_of_task_id` is set, its task must live
-- in the same organization. NULL passes through untouched (the function
-- returns NEW on a NULL parent id), so pending rows cost nothing.
CREATE OR REPLACE TRIGGER trg_pm_intake_org_from_duplicate
    BEFORE INSERT OR UPDATE ON pm_intake
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_tasks', 'duplicate_of_task_id');

-- Belt and braces against a deploy that raced a capture: fill any stragglers
-- from the task before the constraint lands. No-op on an empty table and on
-- every replay (the trigger has already filled the column).
UPDATE pm_intake i
   SET organization_id = t.organization_id
  FROM pm_tasks t
 WHERE t.id = i.task_id AND i.organization_id IS NULL;

ALTER TABLE pm_intake ALTER COLUMN organization_id SET NOT NULL;

-- ── `triage` joins the status-category vocabulary ───────────────────────────
--
-- The category is the machine-readable half of a status (146, §3.3), and
-- `triage` is the value that means "parked at the front door": the one
-- predicate in core.py keys off it, `load_default_status` never lands a
-- normally-created task in it (it is never seeded `is_default`), and
-- crossing OUT of it is what "accept" does.
--
-- Dropped by SHAPE, not by assuming the constraint's default name — the
-- migration-150 lesson: dropping a name that does not exist is a silent
-- no-op, the ADD then succeeds under a second name, BOTH checks apply, and
-- `triage` is still refused while the migration reports success.

DO $$
DECLARE
    cname text;
BEGIN
    FOR cname IN
        SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
         WHERE t.relname = 'pm_task_statuses'
           AND c.contype = 'c'
           AND pg_get_constraintdef(c.oid) LIKE '%in_progress%'
    LOOP
        EXECUTE format('ALTER TABLE pm_task_statuses DROP CONSTRAINT %I', cname);
    END LOOP;

    ALTER TABLE pm_task_statuses
      ADD CONSTRAINT pm_task_statuses_category_check
      CHECK (category IN ('backlog', 'todo', 'in_progress',
                          'done', 'cancelled', 'triage'));
END $$;

COMMIT;
