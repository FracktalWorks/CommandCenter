-- ============================================================================
-- 171_project_operations.sql — the Project Operations foundation.
--
-- Spec: project-docs/specs/project_management_app.md (WS-27). Owner brief
-- 2026-08-12: an engineering PROJECT OPERATIONS system, not a generic board —
-- CLIENT → PROGRAM → PROJECT → WORK → TIME, with blockers, next actions,
-- handoffs and an auditable history.
--
-- ## What this does NOT do, deliberately
--
-- It adds **no new hierarchy tables**. D-PM-2 took the hierarchy decision:
-- departments/projects/subprojects are ONE `pm_projects` self-FK, types are
-- data. A `pm_clients` + `pm_programs` pair would be the per-level table zoo
-- that decision rejected (and that the ClickUp importer flattens on the way
-- in). Client and Program are therefore a `kind` on the existing node — the
-- tree already nests three deep and already carries grants, counters, statuses
-- and tenancy. Typing it is additive; forking it is not.
--
-- It adds no second notification table (`pm_notifications` exists), no second
-- attachment table (`pm_task_attachments` exists), no second dependency table
-- (`pm_task_links` exists), and no second activity spine (`pm_activities` is
-- it, §3.8).
--
-- ## R6 — expand/contract
--
-- The deploy applies migrations BEFORE restarting services, so every statement
-- here must be safe against the code currently running. All new columns are
-- NULLABLE, all new tables are additive, and nothing is renamed or dropped.
--
-- The two CHECK constraints below are WIDENED, not tightened. A widening
-- cannot fail on existing data — every stored row already satisfies the larger
-- set — so the `NOT VALID` + `VALIDATE` dance R6 prescribes for tightening does
-- not apply. Old code keeps writing the old values and they stay legal.
--
-- ## R5 — tenant-ready by construction
--
-- All three new tables carry their own `organization_id` and derive it from
-- their parent through `pm_organization_from_parent()`, which migration 161
-- established. Denormalised on purpose (161's own note): an RLS policy runs on
-- every row of every query, and a join in USING() is slow always and wrong
-- under a missing parent. Policies land with H2, as for every other `pm_*`.
--
-- Idempotent per infra/postgres/README.md.
-- ============================================================================

BEGIN;

-- ── 1. The tree gains a type ────────────────────────────────────────────────
--
-- NULL means "untyped", which is what every existing row is and what the code
-- running during the deploy window will keep writing. Nothing reads this as a
-- required field; a client is a node that says it is one.
ALTER TABLE pm_projects ADD COLUMN IF NOT EXISTS kind TEXT;

ALTER TABLE pm_projects DROP CONSTRAINT IF EXISTS pm_projects_kind_check;
ALTER TABLE pm_projects ADD CONSTRAINT pm_projects_kind_check
    CHECK (kind IS NULL OR kind IN ('department', 'client', 'program', 'project'));

-- ── 2. Stage — the SECOND axis, and the point of the whole brief ────────────
--
-- Status answers "what is the lifecycle state" (not started / in progress /
-- paused / blocked / done). Stage answers "where in the development lifecycle"
-- (concept → design → CAD → prototype → fitment → testing → validation →
-- submission). They are orthogonal: a project can be IN_PROGRESS at PROTOTYPE
-- and later BLOCKED at PROTOTYPE without either value being wrong.
--
-- Conflating them is what produced the source spreadsheet's status column,
-- where "Paused", "submitted" and "Prototype needs corrections" sat in one
-- field and could not be counted, filtered or reported on.
--
-- Shaped exactly like `pm_task_statuses` — per root project, ordered, coloured,
-- one default — because stages are data for the same reason statuses are
-- (D-PM-2, types-as-data): every project type has a different pipeline and
-- hard-coding one guarantees it is wrong for the next customer.
CREATE TABLE IF NOT EXISTS pm_stages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID NOT NULL REFERENCES pm_projects (id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    color           TEXT,
    position        INTEGER NOT NULL DEFAULT 0,
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    -- Terminal stages close the pipeline. Kept as a flag rather than a name
    -- match: "Submission" is terminal for one customer and mid-pipeline for
    -- another, and a regex over a user-typed name is not a rule.
    is_terminal     BOOLEAN NOT NULL DEFAULT FALSE,
    organization_id UUID REFERENCES organization (id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pm_stages_project ON pm_stages (project_id, position);

ALTER TABLE pm_tasks ADD COLUMN IF NOT EXISTS stage_id UUID REFERENCES pm_stages (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pm_tasks_stage ON pm_tasks (stage_id) WHERE stage_id IS NOT NULL;

-- ── 3. Health — an assessment, not a state ──────────────────────────────────
--
-- NULL is "not assessed" and is distinct from 'healthy'. The brief asks for
-- manual now and calculated later; leaving the unassessed case addressable is
-- what makes the later rule able to fill only what nobody has judged.
ALTER TABLE pm_tasks ADD COLUMN IF NOT EXISTS health TEXT;
ALTER TABLE pm_tasks DROP CONSTRAINT IF EXISTS pm_tasks_health_check;
ALTER TABLE pm_tasks ADD CONSTRAINT pm_tasks_health_check
    CHECK (health IS NULL OR health IN ('healthy', 'at_risk', 'critical'));

-- ── 4. Next action ──────────────────────────────────────────────────────────
--
-- Denormalised onto the task rather than given its own table. The brief wants
-- ONE next action visible on the card, the list, the dashboard and My Work —
-- i.e. a hot read on every list query. A child table would make the flagship
-- read a join for a single row, and "which of these five is current" becomes a
-- question nothing answers. Its history is not lost: every change writes a
-- `next_action` activity, which is where the audit trail lives (§3.8).
ALTER TABLE pm_tasks ADD COLUMN IF NOT EXISTS next_action TEXT;
ALTER TABLE pm_tasks ADD COLUMN IF NOT EXISTS next_action_owner TEXT;
ALTER TABLE pm_tasks ADD COLUMN IF NOT EXISTS next_action_due TIMESTAMPTZ;

-- "Which active work has nobody's next move written down" is a dashboard tile,
-- so it gets an index rather than a sequential scan over every task.
CREATE INDEX IF NOT EXISTS idx_pm_tasks_no_next_action
    ON pm_tasks (root_project_id)
    WHERE next_action IS NULL AND completed_at IS NULL AND archived_at IS NULL;

-- ── 5. Blockers — first class, because "why" is the management question ─────
--
-- A blocker is not a status and not a comment. It has a type you can count, a
-- party you are waiting on, and an age — "blocked for 9 days waiting on M&M"
-- is the sentence the whole dashboard exists to produce, and free text cannot
-- be aggregated into it.
CREATE TABLE IF NOT EXISTS pm_blockers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id         UUID NOT NULL REFERENCES pm_tasks (id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    -- Who we are waiting ON. Free text, not an FK: it is often a customer
    -- ("Mahindra & Mahindra") or a supplier, and neither is a row in app_user.
    waiting_on      TEXT,
    -- Who owns UNBLOCKING it, on our side. `email | agent:<name>` (D-PM-4).
    owner           TEXT,
    created_by      TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ,
    resolved_by     TEXT,
    resolution      TEXT,
    organization_id UUID REFERENCES organization (id) ON DELETE CASCADE
);

ALTER TABLE pm_blockers DROP CONSTRAINT IF EXISTS pm_blockers_kind_check;
ALTER TABLE pm_blockers ADD CONSTRAINT pm_blockers_kind_check
    CHECK (kind IN (
        'client_input', 'client_approval', 'supplier', 'material', 'prototype',
        'engineering', 'information', 'internal_review', 'capacity',
        'dependency', 'other'
    ));

-- A resolution must say what happened. Enforced here rather than in a handler
-- because "resolved with no reason" is exactly the row that makes a six-month-
-- old audit trail useless, and there are three call paths that can resolve one.
ALTER TABLE pm_blockers DROP CONSTRAINT IF EXISTS pm_blockers_resolution_check;
ALTER TABLE pm_blockers ADD CONSTRAINT pm_blockers_resolution_check
    CHECK (resolved_at IS NULL OR resolution IS NOT NULL);

-- The hot read: every OPEN blocker, newest first. Partial, because resolved
-- blockers are history and the Blocked view never wants them.
CREATE INDEX IF NOT EXISTS idx_pm_blockers_open
    ON pm_blockers (task_id, created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pm_blockers_kind_open
    ON pm_blockers (kind, created_at) WHERE resolved_at IS NULL;

-- ── 6. Time entries — the server owns the clock ─────────────────────────────
--
-- `duration_secs` is GENERATED, never written by a caller. The brief says
-- "never trust a client-provided duration as the source of truth"; making the
-- column derived means no API, no migration and no future handler CAN write a
-- wrong one. That is a structural fence (R7) rather than a rule in prose.
--
-- An open session is `ended_at IS NULL`, and duration is then NULL — the
-- elapsed time of a running timer is computed at read time from `started_at`,
-- so a refresh, a navigation or a closed laptop cannot lose or inflate it.
CREATE TABLE IF NOT EXISTS pm_time_entries (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id         UUID NOT NULL REFERENCES pm_tasks (id) ON DELETE CASCADE,
    -- `email | agent:<name>` (D-PM-4). An agent run is time spent too.
    actor           TEXT NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    duration_secs   INTEGER GENERATED ALWAYS AS (
                        CASE WHEN ended_at IS NULL THEN NULL
                             ELSE GREATEST(0, EXTRACT(EPOCH FROM (ended_at - started_at))::INTEGER)
                        END
                    ) STORED,
    -- Why the session ended. Required on pause/complete by the API, not by the
    -- table: a session ended by a stage change or a handoff has no remark to
    -- give, and a NOT NULL here would make those paths lie to satisfy it.
    end_reason      TEXT,
    remark          TEXT,
    organization_id UUID REFERENCES organization (id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pm_time_entries_order_check CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- ⚠️ THE FENCE THAT MATTERS (R7). One open session per actor, enforced by the
-- database. The brief asks to "prevent multiple simultaneous active timers for
-- the same user"; a handler check loses that race the moment two tabs click
-- START together, and double-counted engineering time is the one bug in this
-- feature nobody would notice until an invoice was wrong.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_time_entries_one_open_per_actor
    ON pm_time_entries (actor) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pm_time_entries_task ON pm_time_entries (task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pm_time_entries_actor ON pm_time_entries (actor, started_at DESC);

-- ── 7. The lifecycle vocabulary gains `paused` and `blocked` ────────────────
--
-- `pm_task_statuses.category` IS the lifecycle status the brief §8 asks for —
-- it is already machine-readable, already what completion and automation key
-- off, and already separate from the owner-facing NAME. It was missing exactly
-- the two states an operations system turns on.
--
-- Neither is a CLOSING category (core.py CLOSING_CATEGORIES stays {done,
-- cancelled}): paused and blocked work is still outstanding, and stamping
-- `completed_at` on it would drop it out of every "what is still open" read —
-- which is the read management actually cares about.
ALTER TABLE pm_task_statuses DROP CONSTRAINT IF EXISTS pm_task_statuses_category_check;
ALTER TABLE pm_task_statuses ADD CONSTRAINT pm_task_statuses_category_check
    CHECK (category IN (
        'backlog', 'todo', 'in_progress', 'done', 'cancelled', 'triage',
        'paused', 'blocked'
    ));

-- ── 8. The activity vocabulary gains five verbs ─────────────────────────────
--
-- ⚠️ `core.py`'s ACTIVITY_TYPES tuple mirrors this CHECK and
-- `test_projects_activity_vocabulary` reads BOTH — the mirror went out of step
-- once (migration 150 added `attachment`, the tuple did not, and every file
-- upload answered 422 because `record_activity` refuses an unknown type before
-- the insert). Update both or the fence fails, which is the point of it.
--
-- Five, not sixteen. The brief lists sixteen event names, but eleven of them
-- are already expressible: COMMENT_ADDED is `comment`, FILE_ADDED is
-- `attachment`, PROJECT_STATUS_CHANGED is `status_change`, PROJECT_ASSIGNED and
-- PROJECT_REASSIGNED are `assignment`. Adding synonyms would give the timeline
-- two words for one event and every reader a choice to get wrong. The verb is
-- the type; the detail goes in `meta`, which is the shape the existing ten
-- already use.
ALTER TABLE pm_activities DROP CONSTRAINT IF EXISTS pm_activities_type_check;
ALTER TABLE pm_activities ADD CONSTRAINT pm_activities_type_check
    CHECK (type IN (
        'comment', 'status_change', 'field_change', 'link', 'assignment',
        'agent_run', 'sync', 'system', 'attachment', 'mention',
        -- started · paused · resumed · completed, in meta.action
        'work_session',
        -- pipeline movement, with meta.from / meta.to
        'stage_change',
        -- raised · resolved, with meta.kind and meta.waiting_on
        'blocker',
        -- set · cleared · completed
        'next_action',
        -- the ceremony: meta.from, meta.to, meta.reason
        'handoff'
    ));

-- ── 9. Tenancy (R5) ─────────────────────────────────────────────────────────
--
-- Each new table derives its key from its parent task, the same way every
-- other `pm_*` child does since 161. `CREATE OR REPLACE TRIGGER` is what makes
-- this idempotent — plain CREATE TRIGGER has no IF NOT EXISTS.
CREATE OR REPLACE TRIGGER trg_pm_blockers_org_from_task
    BEFORE INSERT OR UPDATE ON pm_blockers
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_tasks', 'task_id');

CREATE OR REPLACE TRIGGER trg_pm_time_entries_org_from_task
    BEFORE INSERT OR UPDATE ON pm_time_entries
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_tasks', 'task_id');

CREATE OR REPLACE TRIGGER trg_pm_stages_org_from_project
    BEFORE INSERT OR UPDATE ON pm_stages
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_projects', 'project_id');

COMMIT;
