-- ============================================================================
-- 168_projects_delta_sync.sql — the delta-sync feed's two prerequisites, and
--                               the one small column that had a reader.
--
-- What: spec project-docs/specs/project_management_app.md §9.2 (WS-27ae,
--   delta-sync + small-columns thirds) and §11.27, derived from the Plane
--   research P-27/P-28 (`plane_pm_research_2026-08.md` §3.7 / §8).
--
-- Three things, each with a named consumer in the same change:
--
--   1. `pm_task_tombstones` — the answer to the deletion trap. A feed shaped
--      `WHERE updated_at > :since` can never say a task was DELETED: the row
--      simply stops appearing, and a client that merges what it receives keeps
--      the ghost forever. Plane's own feed cannot express it either. So a
--      delete leaves a row behind, and `GET /projects/delta/tasks` reports it
--      in `removed[]`.
--
--   2. `pm_view_user_state` — P-28's per-user view state. `pm_views` stays the
--      shared, canonical definition of a view; this sibling holds each member's
--      OWN grouping/collapse state, so collapsing a swimlane stops collapsing
--      it for the whole company (WS-27y stored `collapsed_lanes` in the shared
--      config, which is the behaviour this fixes).
--
--   3. `pm_task_types.is_epic` — P-28's flag. `core.assert_epic_has_no_parent`
--      reads it. Until now the one structural rule in §3.4 keyed off
--      `is_system AND name = 'Epic'`, i.e. off a SEED NAME; the flag makes the
--      rule enforceable without knowing what the seed was called.
--
-- ⚠️ **The column with no reader is the failure mode this file is written
--   against.** `pm_task_statuses.color` was stored from migration 146 and
--   rendered nowhere until 167, so every board column drew the same grey for
--   twenty-one migrations. P-28's fourth item — the session `user_id` denorm —
--   is therefore NOT here: `chat_session.user_id` already exists and is already
--   indexed (`chat_session_user_idx`, migration 02) and `public."Session"`
--   already carries a `user_id` with an FK, so the denormalisation P-28 asks
--   for is present in both session stores and there is nothing to add.
--
-- ── R6, expand/contract, and why nothing here needs the new code ───────────
--
-- The deploy applies migrations BEFORE restarting services, so old code always
-- meets this schema first. Every statement below is additive:
--   * two brand-new tables nothing reads yet;
--   * one new column with a constant DEFAULT (Postgres 11+ stores that in the
--     catalog, so `ADD COLUMN … NOT NULL DEFAULT false` is metadata-only and
--     rewrites nothing — this is the one place a NOT NULL is cheaper than a
--     nullable column, because it removes a tri-state a boolean flag should
--     never have);
--   * one AFTER DELETE trigger whose only effect is a row in a table nothing
--     old reads.
-- `SELECT *` readers (`row_to_model`) map by MODEL field, so the new column is
-- ignored by code that predates it. Nothing is renamed and nothing is dropped;
-- there is no contract phase owed.
--
-- ── R5, and where the tenant key comes from ────────────────────────────────
--
-- Both new tables carry `organization_id NOT NULL`, per D-MT-3 (the key on
-- every tenant-owned row, never derived through a parent). `pm_view_user_state`
-- gets migration 161's `pm_organization_from_parent` trigger, so it fills and
-- cross-checks from its view exactly like the other 19 attachments.
-- `pm_task_tombstones` is filled by its own trigger from the row being deleted.
-- `pm_task_types.is_epic` is a COLUMN on a table that already carries the
-- tenant key — it inherits it, and adds no new tenant surface.
--
-- ⚠️ **A tombstone must not be written for a tenant that is being deleted, and
-- this was MEASURED, not reasoned about.** Deleting an `organization` row
-- cascades to `pm_projects` → `pm_tasks`, which fires the AFTER DELETE trigger
-- below, which then inserts a row referencing the organization the same
-- statement has already removed:
--
--     ERROR:  insert or update on table "pm_task_tombstones" violates foreign
--             key constraint … Key (organization_id)=(860f107d…) is not
--             present in table "organization".
--
-- i.e. the naive version makes an organization **undeletable**. The fix is in
-- the trigger, not in the constraint: it skips when the tenant is already gone
-- (a tombstone exists to tell that tenant's clients what vanished, and a tenant
-- with no rows has no clients). So the foreign key STAYS, in the shape
-- migration 161 uses for all 17 `pm_*` tables, and `test_tenancy_boundary.py`'s
-- new-table rule is satisfied on its own terms rather than by an exemption.
--
-- `pm_task_tombstones.project_id` is deliberately a BARE UUID with no
-- reference: a tombstone must OUTLIVE its project, or deleting a project would
-- erase the record that its tasks ever existed — which is precisely the ghost
-- this table exists to prevent.
--
-- ⚠️ **Tombstones are never swept here.** They are small (one row per deleted
-- task) and a retention sweep is a scheduled job that touches real data — the
-- shape WS-27z had to hand to `/workflows` (D6). Recorded in §11.27 as owed,
-- not smuggled in as a cron.
--
-- Idempotent per infra/postgres/README.md: `CREATE TABLE IF NOT EXISTS`,
-- `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
-- `CREATE OR REPLACE FUNCTION/TRIGGER`, and a backfill whose WHERE matches
-- nothing on the second run. Pinned as TEXT by
-- tests/unit/test_projects_migration.py, which runs no database — and against a
-- real Postgres 16 by tests/live/live_ws27ae.py, which runs one.
--
-- Depends on: 130_org_access_control.sql (organization), 146_projects.sql
--             (pm_tasks, pm_views, pm_task_types), 161_projects_tenancy.sql
--             (organization_id + pm_organization_from_parent).
-- ============================================================================

BEGIN;

-- ── 1. Tombstones — how the feed says "this one is GONE" ───────────────────
--
-- `task_id` is the primary key and NOT a foreign key: the task it names does
-- not exist any more, which is the entire point. A UUID is never reissued, so
-- a re-insert cannot resurrect somebody else's tombstone.

CREATE TABLE IF NOT EXISTS pm_task_tombstones (
    task_id         UUID PRIMARY KEY,
    -- Where it lived, so the feed can apply the SAME project-visibility closure
    -- to a removal that it applies to a row. Without it, "task 9f3… is gone"
    -- would be readable by every member of the tenant regardless of grants.
    project_id      UUID,
    root_project_id UUID,
    -- The human id (`RND-42`), kept so a client can tell a person WHICH task
    -- vanished rather than only that a uuid it holds is stale.
    task_number     BIGINT,
    organization_id UUID NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
    deleted_by      TEXT,
    deleted_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The feed's own scan: tenant, then the (deleted_at, task_id) keyset the
-- endpoint orders and pages by. Leading with the tenant for the reason
-- migration 161 §5 gives — it is the one clause every query carries.
CREATE INDEX IF NOT EXISTS idx_pm_task_tombstones_org_deleted
    ON pm_task_tombstones (organization_id, deleted_at, task_id);

-- ⚠️ A TRIGGER, not an INSERT in `delete_task`. `pm_tasks` is deleted from more
-- ways than the endpoint: `pm_projects` CASCADEs to it, and a project delete is
-- precisely the case where a client is holding the most rows that are about to
-- become ghosts. An application-level write would have recorded the one path a
-- test was written for and silently missed the other.
--
-- `SECURITY DEFINER` is deliberately NOT used: the trigger runs as whoever ran
-- the DELETE, which is the same session that was already allowed to destroy the
-- row, and under phase-4 RLS the tenant it writes is the tenant it read.
CREATE OR REPLACE FUNCTION pm_task_tombstone() RETURNS trigger
LANGUAGE plpgsql AS $pm_tomb$
BEGIN
    -- ⚠️ The measured guard (see the header). Under an organization cascade the
    -- tenant row is already gone from this transaction's snapshot, so this
    -- returns false and no tombstone is attempted — which is also the right
    -- ANSWER, not merely the surviving one: a deleted tenant has no clients
    -- left to tell. A project or task delete finds its organization present and
    -- records normally.
    IF NOT EXISTS (
        SELECT 1 FROM organization WHERE id = OLD.organization_id
    ) THEN
        RETURN OLD;
    END IF;
    INSERT INTO pm_task_tombstones (
        task_id, project_id, root_project_id, task_number,
        organization_id, deleted_by
    ) VALUES (
        OLD.id, OLD.project_id, OLD.root_project_id, OLD.task_number,
        OLD.organization_id,
        -- `app.actor` is set by nothing today, so this is NULL in practice and
        -- is read with the missing-ok flag rather than raising. It exists so the
        -- day an actor GUC is bound at the seam (the shape `app.tenant_id`
        -- already has) the tombstone starts carrying it with no schema change.
        nullif(current_setting('app.actor', true), '')
    )
    ON CONFLICT (task_id) DO NOTHING;
    RETURN OLD;
END;
$pm_tomb$;

CREATE OR REPLACE TRIGGER trg_pm_tasks_tombstone
    AFTER DELETE ON pm_tasks
    FOR EACH ROW EXECUTE FUNCTION pm_task_tombstone();

-- ── 2. The delta scan's index ──────────────────────────────────────────────
--
-- `GET /projects/delta/tasks` orders by `(updated_at, id)` inside one tenant
-- and pages by that keyset, so this is the index the whole feed rides on.
-- Migration 146's `idx_pm_tasks_root_status` and 161's `idx_pm_tasks_org_project`
-- both lead with a different column and neither can serve an ordered range.

CREATE INDEX IF NOT EXISTS idx_pm_tasks_org_updated
    ON pm_tasks (organization_id, updated_at, id);

-- ── 3. Per-user view state (P-28) ──────────────────────────────────────────
--
-- The shared `pm_views.config` stays canonical — it is what the view IS. This
-- holds what one MEMBER has done to their own copy of it, and the two are
-- merged at read time by `views.list_views`, never written into each other.
--
-- `member` is a bare string on the D-PM-4 vocabulary (an email, or
-- `agent:<name>`), lower-cased by the writer, for the reason
-- `pm_task_assignees.assignee` is: a human and an agent are the same kind of
-- principal here and a member-row FK would exclude one of them by construction.

CREATE TABLE IF NOT EXISTS pm_view_user_state (
    view_id         UUID NOT NULL REFERENCES pm_views (id) ON DELETE CASCADE,
    member          TEXT NOT NULL,
    config          JSONB NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(config) = 'object'),
    organization_id UUID NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (view_id, member)
);

-- The read is always "this view, this member" (the PK) or "these views, this
-- member" (the list merge), so the PK serves the first and this serves the
-- second without a second index on `member` alone.
CREATE INDEX IF NOT EXISTS idx_pm_view_user_state_member
    ON pm_view_user_state (organization_id, member);

-- Migration 161's shared function, 20th attachment: fill the tenant from the
-- view, and REFUSE a state row whose tenant disagrees with its view's.
CREATE OR REPLACE TRIGGER trg_pm_view_user_state_org_from_view
    BEFORE INSERT OR UPDATE ON pm_view_user_state
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_views', 'view_id');

-- ── 4. `is_epic` on task types (P-28) ──────────────────────────────────────
--
-- §3.4's rule — an Epic-typed task cannot have a parent — is what makes Epic
-- the root level without a `level` column. It used to key off the seeded NAME.
-- The backfill below is what keeps that true across the flag: every type the
-- old rule matched is stamped, so the two agree on the day of the deploy and
-- `assert_epic_has_no_parent` can read either.

ALTER TABLE pm_task_types
    ADD COLUMN IF NOT EXISTS is_epic BOOLEAN NOT NULL DEFAULT false;

-- Matches the OLD predicate exactly (`is_system` AND the seeded name), so it
-- can neither promote a user-created type merely called "Epic" nor miss one the
-- old rule was enforcing. Re-running changes nothing: the WHERE excludes rows
-- that are already stamped.
UPDATE pm_task_types
   SET is_epic = true
 WHERE is_system AND name = 'Epic' AND NOT is_epic;

COMMIT;
