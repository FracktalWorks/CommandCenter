-- ============================================================================
-- 161_projects_tenancy.sql — the tenant key on all 17 `pm_*` tables (WS-29a).
--
-- Spec: project-docs/specs/multi_tenancy.md §3 (D-MT-1, D-MT-3) and §5.
--
-- WHY NOW, AND ONLY NOW. §2 is blunt about it: `POST /projects/import/clickup`
-- is the next thing WS-27 wants, and it writes hundreds of rows into these 17
-- tables. Adding the column afterwards is a backfill and an ALTER on live rows;
-- adding it first is a one-line default on empty ones. "The cost of waiting is a
-- few days. The cost of not waiting is paid once per table, forever."
--
-- D-MT-1 (ANSWERED, (a)): one person, one organization. `app_user.email` stays
-- globally UNIQUE, so a request's tenant is DERIVED from `X-User-Email` through
-- `app_user.organization_id`. Nothing here needs a tenant discriminator on the
-- wire, and no auth seam changes.
--
-- D-MT-3: the key is carried on EVERY tenant-owned table, even where it is
-- derivable through a parent. Deriving it was rejected for three reasons that
-- are all true here — RLS policies cannot afford a join, a derived key cannot be
-- indexed, and "derivable" stops being true the moment a parent is nullable,
-- which `pm_tasks.parent_task_id` (ON DELETE SET NULL) already is.
--
-- D-MT-2 was OPEN when this file was written, so it adds NO row-level security.
-- The column is shaped so RLS can be layered on later without touching it
-- again: one plain `UUID NOT NULL` per row, never a lookup.
--
-- ── ⚠️ D-MT-2 IS NOW ANSWERED, ON `main`, AND NOT BY ME (2026-08-09) ────────
--
-- A parallel workstream landed the answer in PR #404 while this branch was open:
-- **D15 — pooled, enforced by RLS** against a `app.tenant_id` GUC that
-- `acb_common.db.tenant_session()` sets (`SET LOCAL`, inside a transaction).
-- `specs/saas_multitenancy.md` is canonical; `specs/multi_tenancy.md` in this
-- branch is the earlier, narrower record and now defers to it.
--
-- MT-1b generated the same column for **135 tables** — these 17 included — into
-- `infra/postgres/generated/{01_add_columns,02_backfill,03_constraints,04_policies}.sql`.
--
-- **This file still stands, and here is the seam.** That generated set is
-- deliberately NOT a numbered migration: `apply_migrations.sh` does not replay
-- it, and promoting it is an act taken by hand in a maintenance window (its
-- generator's docstring names the 14h44m outage that makes that non-negotiable).
-- Meanwhile `routes/projects/core.py` reads `pm_*.organization_id` on every
-- request. A column the Projects app requires cannot wait on a maintenance
-- window, so the numbered path is what puts it there.
--
-- The two compose, because both sides are `ADD COLUMN IF NOT EXISTS` — whichever
-- runs second finds the column and no-ops. **One difference is worth stating
-- rather than discovering:** the generated column carries
-- `DEFAULT current_setting('app.tenant_id', true)::uuid` and this one carries no
-- default. On a database where THIS migration ran first, the 17 `pm_*` tables
-- therefore fill `organization_id` from the parent-consistency trigger below
-- rather than from the session GUC. Both arrive at the same value under a bound
-- session; the trigger additionally REFUSES a child whose org disagrees with its
-- parent, which the GUC default cannot check. Nothing needs undoing when
-- `04_policies.sql` is promoted — RLS layers on top of a column that is already
-- NOT NULL and already correct.
--
-- ── The backfill, and what was actually in the tables ───────────────────────
--
-- §2 predicted these tables would be EMPTY (this deployment has never run the
-- ClickUp import). CHECKED against the live Postgres before choosing, and the
-- prediction was WRONG: 2 `pm_projects`, 1 `pm_project_grants`, 2
-- `pm_task_statuses` and 10 `pm_tasks` rows were present — fixture residue from
-- WS-27's live verification runs, not a real import, but rows all the same and
-- `SET NOT NULL` does not care which. So every table is backfilled to the
-- `slug='default'` organization before the constraint lands. The UPDATE is a
-- no-op on an empty table and re-running it changes nothing, so it costs
-- nothing on a deployment where §2's prediction WAS right.
--
-- If `organization` has no `slug='default'` row the backfill sets NULL and the
-- following `SET NOT NULL` fails the deploy LOUDLY. That is deliberate: a
-- silent guess at which organization owns somebody's work is worse than a
-- failed migration.
--
-- Idempotent per infra/postgres/README.md — `ADD COLUMN IF NOT EXISTS`,
-- `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION/TRIGGER`, and a
-- backfill whose WHERE makes the second run match nothing. Pinned as TEXT by
-- tests/unit/test_projects_migration.py, which runs no database.
--
-- Depends on: 130_org_access_control.sql (organization), 146_projects.sql,
--             147, 150, 152, 155, 156, 160 (the other `pm_*` tables).
-- ============================================================================

BEGIN;

-- ── 1. The column, on all 17 ────────────────────────────────────────────────
--
-- ON DELETE CASCADE matches how `app_user`, `org_group` and `org_role` already
-- reference `organization` (§6). Nullable for now; §3 backfills and §4 makes it
-- NOT NULL, because SET NOT NULL on a table with rows needs those rows filled
-- first and this deployment turned out to have some.

ALTER TABLE pm_projects            ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization (id) ON DELETE CASCADE;
ALTER TABLE pm_project_grants      ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization (id) ON DELETE CASCADE;
ALTER TABLE pm_task_statuses       ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization (id) ON DELETE CASCADE;
ALTER TABLE pm_task_types          ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization (id) ON DELETE CASCADE;
ALTER TABLE pm_task_counters       ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization (id) ON DELETE CASCADE;
ALTER TABLE pm_tasks               ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization (id) ON DELETE CASCADE;
ALTER TABLE pm_task_assignees      ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization (id) ON DELETE CASCADE;
ALTER TABLE pm_task_links          ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization (id) ON DELETE CASCADE;
ALTER TABLE pm_activities          ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization (id) ON DELETE CASCADE;
ALTER TABLE pm_views               ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization (id) ON DELETE CASCADE;
ALTER TABLE pm_view_task_positions ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization (id) ON DELETE CASCADE;
ALTER TABLE pm_task_personal       ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization (id) ON DELETE CASCADE;
ALTER TABLE pm_task_attachments    ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization (id) ON DELETE CASCADE;
ALTER TABLE pm_notifications       ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization (id) ON DELETE CASCADE;
ALTER TABLE pm_custom_fields       ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization (id) ON DELETE CASCADE;
ALTER TABLE pm_tags                ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization (id) ON DELETE CASCADE;
ALTER TABLE pm_recurrences         ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization (id) ON DELETE CASCADE;

-- ── 2. Keeping a child's tenant equal to its parent's ───────────────────────
--
-- D-MT-3 names this as the cost of carrying the key on every row: "the column
-- must be kept true on write, which is one more thing an INSERT can get wrong;
-- a CHECK against the parent's value is the cheap guard."
--
-- ⚠️ A `CHECK` CANNOT DO THIS. A CHECK constraint may only read the row it is
-- on; comparing against another table's column is exactly what Postgres refuses
-- ("cannot use subquery in check constraint"). So the guard is a BEFORE trigger,
-- which is the only in-database mechanism that can see both rows.
--
-- It does two jobs, and the first is the one that matters most:
--
--   FILL. A child inserted with a NULL tenant inherits its parent's. This is
--   what makes the retrofit safe across 43 INSERT sites in 16 modules without
--   editing 43 call sites — and editing 43 call sites is precisely the
--   discipline D-MT-2 (b) says this system does not have ("correctness rests on
--   143 tables' worth of query authors never forgetting, which is the discipline
--   that produced 137 unscoped tables in the first place"). The absence of code
--   is safe here, which is the property the system needs.
--
--   REFUSE. A child inserted or updated with a tenant that DISAGREES with its
--   parent's is rejected, naming both. That is the case a fill-only default
--   would silently accept: a task moved into another organization's project, a
--   grant written against somebody else's project id.
--
-- What it deliberately does NOT do: invent a tenant. A ROOT `pm_projects` row
-- has no parent, so nothing fills it, and `NOT NULL` refuses the insert. The
-- application must decide the tenant exactly once — at the root project — and
-- everything beneath it is derived. One decision point, checked; not 43.
--
-- The parent lookup is a primary-key point read, and it is dynamic (`EXECUTE`)
-- so that ONE function serves all 19 trigger attachments. Nineteen bespoke
-- functions would plan marginally better and would be nineteen places for the
-- rule to drift.

CREATE OR REPLACE FUNCTION pm_organization_from_parent() RETURNS trigger
LANGUAGE plpgsql AS $pm_org$
DECLARE
    parent_table CONSTANT TEXT := TG_ARGV[0];
    parent_column CONSTANT TEXT := TG_ARGV[1];
    parent_id UUID;
    parent_org UUID;
BEGIN
    -- `to_jsonb(NEW) ->> …` rather than a dynamic field reference, because
    -- plpgsql has no syntax for "the column named by this variable" on a record.
    parent_id := (to_jsonb(NEW) ->> parent_column)::uuid;
    IF parent_id IS NULL THEN
        -- A root project, or an activity attached to a project rather than a
        -- task. Its OTHER trigger (or NOT NULL) decides.
        RETURN NEW;
    END IF;

    EXECUTE format('SELECT organization_id FROM %I WHERE id = $1', parent_table)
        INTO parent_org USING parent_id;

    IF parent_org IS NULL THEN
        -- The parent does not exist, or predates this migration. Say nothing
        -- and let the foreign key (or NOT NULL) produce the real complaint —
        -- a trigger that raised here would mask the actual error.
        RETURN NEW;
    END IF;

    IF NEW.organization_id IS NULL THEN
        NEW.organization_id := parent_org;
    ELSIF NEW.organization_id <> parent_org THEN
        RAISE EXCEPTION
            '%.organization_id (%) does not match %.organization_id (%)',
            TG_TABLE_NAME, NEW.organization_id, parent_table, parent_org
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$pm_org$;

-- `CREATE OR REPLACE TRIGGER` (Postgres 14+) is what makes this idempotent;
-- plain `CREATE TRIGGER` has no `IF NOT EXISTS` and would fail the second
-- deploy, which is the deploy nobody watches.
--
-- Several tables carry TWO attachments. That is not redundancy: the second one
-- cross-checks a relationship the first cannot see. `pm_tasks` is the clearest
-- case — `project_id` fills the tenant and `root_project_id` then has to agree
-- with it, so a task whose root lives in another organization is refused rather
-- than stored. Triggers fire in name order and each one is fill-or-verify, so
-- the order between them does not change the answer.

CREATE OR REPLACE TRIGGER trg_pm_projects_org_from_parent
    BEFORE INSERT OR UPDATE ON pm_projects
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_projects', 'parent_project_id');

CREATE OR REPLACE TRIGGER trg_pm_project_grants_org_from_project
    BEFORE INSERT OR UPDATE ON pm_project_grants
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_projects', 'project_id');

CREATE OR REPLACE TRIGGER trg_pm_task_statuses_org_from_project
    BEFORE INSERT OR UPDATE ON pm_task_statuses
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_projects', 'project_id');

CREATE OR REPLACE TRIGGER trg_pm_task_types_org_from_project
    BEFORE INSERT OR UPDATE ON pm_task_types
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_projects', 'project_id');

CREATE OR REPLACE TRIGGER trg_pm_task_counters_org_from_project
    BEFORE INSERT OR UPDATE ON pm_task_counters
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_projects', 'project_id');

CREATE OR REPLACE TRIGGER trg_pm_tasks_org_from_project
    BEFORE INSERT OR UPDATE ON pm_tasks
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_projects', 'project_id');

-- The cross-check described above: a task's denormalised root must live in the
-- same organization as the project it sits in.
CREATE OR REPLACE TRIGGER trg_pm_tasks_org_from_root
    BEFORE INSERT OR UPDATE ON pm_tasks
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_projects', 'root_project_id');

CREATE OR REPLACE TRIGGER trg_pm_task_assignees_org_from_task
    BEFORE INSERT OR UPDATE ON pm_task_assignees
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_tasks', 'task_id');

CREATE OR REPLACE TRIGGER trg_pm_task_links_org_from_source
    BEFORE INSERT OR UPDATE ON pm_task_links
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_tasks', 'source_task_id');

-- ⚠️ A link is the one row that names two tasks, so it is the one row that
-- could STRADDLE two organizations. Verifying the target as well is what makes
-- a cross-tenant dependency edge impossible.
CREATE OR REPLACE TRIGGER trg_pm_task_links_org_from_target
    BEFORE INSERT OR UPDATE ON pm_task_links
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_tasks', 'target_task_id');

-- `pm_activities` may hang off either a task or a project (its CHECK requires
-- at least one). Both attachments are declared; whichever column is populated
-- fills, and when both are, they must agree.
CREATE OR REPLACE TRIGGER trg_pm_activities_org_from_project
    BEFORE INSERT OR UPDATE ON pm_activities
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_projects', 'project_id');

CREATE OR REPLACE TRIGGER trg_pm_activities_org_from_task
    BEFORE INSERT OR UPDATE ON pm_activities
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_tasks', 'task_id');

CREATE OR REPLACE TRIGGER trg_pm_views_org_from_project
    BEFORE INSERT OR UPDATE ON pm_views
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_projects', 'project_id');

CREATE OR REPLACE TRIGGER trg_pm_view_task_positions_org_from_view
    BEFORE INSERT OR UPDATE ON pm_view_task_positions
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_views', 'view_id');

-- Same reason as the link's two ends: a position row names a view and a task,
-- and both have to be the same tenant's.
CREATE OR REPLACE TRIGGER trg_pm_view_task_positions_org_from_task
    BEFORE INSERT OR UPDATE ON pm_view_task_positions
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_tasks', 'task_id');

CREATE OR REPLACE TRIGGER trg_pm_task_personal_org_from_task
    BEFORE INSERT OR UPDATE ON pm_task_personal
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_tasks', 'task_id');

CREATE OR REPLACE TRIGGER trg_pm_task_attachments_org_from_task
    BEFORE INSERT OR UPDATE ON pm_task_attachments
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_tasks', 'task_id');

CREATE OR REPLACE TRIGGER trg_pm_notifications_org_from_task
    BEFORE INSERT OR UPDATE ON pm_notifications
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_tasks', 'task_id');

CREATE OR REPLACE TRIGGER trg_pm_custom_fields_org_from_project
    BEFORE INSERT OR UPDATE ON pm_custom_fields
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_projects', 'project_id');

CREATE OR REPLACE TRIGGER trg_pm_tags_org_from_project
    BEFORE INSERT OR UPDATE ON pm_tags
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_projects', 'project_id');

CREATE OR REPLACE TRIGGER trg_pm_recurrences_org_from_project
    BEFORE INSERT OR UPDATE ON pm_recurrences
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_projects', 'project_id');

-- ── 3. Backfill ────────────────────────────────────────────────────────────
--
-- See the header: these tables were NOT empty. Everything already here belongs
-- to the one organization this deployment has ever had.
--
-- `pm_projects` first and on its own, because the triggers above then carry the
-- value down: a `pm_tasks` UPDATE re-reads its project. The per-table UPDATEs
-- that follow are therefore mostly belt-and-braces — they are what catches a
-- row whose parent was deleted between the two statements, and what makes each
-- table's fill independent of trigger firing order.

UPDATE pm_projects SET organization_id = (SELECT id FROM organization WHERE slug = 'default')
    WHERE organization_id IS NULL;

UPDATE pm_project_grants      SET organization_id = (SELECT id FROM organization WHERE slug = 'default') WHERE organization_id IS NULL;
UPDATE pm_task_statuses       SET organization_id = (SELECT id FROM organization WHERE slug = 'default') WHERE organization_id IS NULL;
UPDATE pm_task_types          SET organization_id = (SELECT id FROM organization WHERE slug = 'default') WHERE organization_id IS NULL;
UPDATE pm_task_counters       SET organization_id = (SELECT id FROM organization WHERE slug = 'default') WHERE organization_id IS NULL;
UPDATE pm_tasks               SET organization_id = (SELECT id FROM organization WHERE slug = 'default') WHERE organization_id IS NULL;
UPDATE pm_task_assignees      SET organization_id = (SELECT id FROM organization WHERE slug = 'default') WHERE organization_id IS NULL;
UPDATE pm_task_links          SET organization_id = (SELECT id FROM organization WHERE slug = 'default') WHERE organization_id IS NULL;
UPDATE pm_activities          SET organization_id = (SELECT id FROM organization WHERE slug = 'default') WHERE organization_id IS NULL;
UPDATE pm_views               SET organization_id = (SELECT id FROM organization WHERE slug = 'default') WHERE organization_id IS NULL;
UPDATE pm_view_task_positions SET organization_id = (SELECT id FROM organization WHERE slug = 'default') WHERE organization_id IS NULL;
UPDATE pm_task_personal       SET organization_id = (SELECT id FROM organization WHERE slug = 'default') WHERE organization_id IS NULL;
UPDATE pm_task_attachments    SET organization_id = (SELECT id FROM organization WHERE slug = 'default') WHERE organization_id IS NULL;
UPDATE pm_notifications       SET organization_id = (SELECT id FROM organization WHERE slug = 'default') WHERE organization_id IS NULL;
UPDATE pm_custom_fields       SET organization_id = (SELECT id FROM organization WHERE slug = 'default') WHERE organization_id IS NULL;
UPDATE pm_tags                SET organization_id = (SELECT id FROM organization WHERE slug = 'default') WHERE organization_id IS NULL;
UPDATE pm_recurrences         SET organization_id = (SELECT id FROM organization WHERE slug = 'default') WHERE organization_id IS NULL;

-- ── 4. NOT NULL ────────────────────────────────────────────────────────────
--
-- The constraint that makes the tenant key a fact rather than a convention. It
-- is what turns "the application forgot" into a refused write instead of a row
-- that belongs to nobody and is therefore visible to nobody — or, worse, to
-- everybody, depending on how the predicate is written.
--
-- SET NOT NULL on a column that is already NOT NULL is a no-op, so this replays.

ALTER TABLE pm_projects            ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pm_project_grants      ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pm_task_statuses       ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pm_task_types          ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pm_task_counters       ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pm_tasks               ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pm_task_assignees      ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pm_task_links          ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pm_activities          ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pm_views               ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pm_view_task_positions ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pm_task_personal       ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pm_task_attachments    ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pm_notifications       ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pm_custom_fields       ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pm_tags                ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pm_recurrences         ALTER COLUMN organization_id SET NOT NULL;

-- ── 5. Indexes — three, not seventeen ──────────────────────────────────────
--
-- An index earns its place from a query that filters on it. WS-29b's predicate
-- filters on exactly three of these tables, and every other `pm_*` read reaches
-- its rows through `project_id`/`task_id`, which are already indexed and are far
-- more selective than a tenant key ever is.
--
-- Seventeen single-column indexes on a column with ONE distinct value in this
-- deployment would be seventeen indexes the planner never picks and every write
-- has to maintain. When WS-29c adds RLS policies to the rest, the index each
-- policy needs should be added with that policy, sized to the plan it actually
-- produces.
--
-- Both composites lead with `organization_id` because the tenant predicate is
-- the one clause EVERY query carries — a leading tenant column also serves the
-- bare `organization_id = …` lookup, so one index does both jobs.

-- ⚠️ The hottest of the three. `_VISIBLE_PROJECTS_SQL`'s seed step is
-- `WHERE organization_id = :vis_org AND (subject = 'org' OR …)`, run once per
-- request on the read path of the entire app. Supersedes nothing: migration
-- 146's `idx_pm_project_grants_subject` still serves a subject-only lookup.
CREATE INDEX IF NOT EXISTS idx_pm_project_grants_org_subject
    ON pm_project_grants (organization_id, subject);

-- The closure's recursive step (`p.parent_project_id = a.id AND
-- p.organization_id = :vis_org`) and the unrestricted `data:org:read` clause
-- (`SELECT id FROM pm_projects WHERE organization_id = :vis_org`).
CREATE INDEX IF NOT EXISTS idx_pm_projects_org_parent
    ON pm_projects (organization_id, parent_project_id);

-- `task_visibility_clause`'s outer AND, on every task list, board, search and
-- calendar read.
CREATE INDEX IF NOT EXISTS idx_pm_tasks_org_project
    ON pm_tasks (organization_id, project_id);

-- ── 6. What this migration deliberately does NOT do ────────────────────────
--
-- * NO ROW-LEVEL SECURITY. D-MT-2 is open (§3). Adding policies now would
--   settle by default a decision the spec says is unsettled, and would need
--   every connection — ingestion workers, the broker, the migration runner —
--   to set a GUC that nothing sets today.
-- * `pm_projects.clickup_id` and `pm_tasks.clickup_id` stay GLOBALLY UNIQUE.
--   Under multi-tenancy that means two organizations cannot import the same
--   ClickUp workspace. Widening them to `UNIQUE (organization_id, clickup_id)`
--   is the right end state, but it is a change to the importer's conflict
--   handling as well as to the constraint, and it belongs with the ticket that
--   onboards the second tenant rather than smuggled in here.
-- * `pm_task_assignees.assignee` and `pm_project_grants.subject` stay bare
--   strings (D-PM-4). D-MT-1 (a) is what keeps that safe: one email, one
--   person, one organization. If D-MT-1 is ever revisited, these two columns
--   are where it lands first.

COMMIT;
