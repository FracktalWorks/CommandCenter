-- 165_projects_watchers.sql — watchers, and mentions that behave (WS-27v).
--
-- What: pm_task_watchers — one row per person following one task.
-- Why:  spec §9.1 WS-27v (P-2, P-20 in plane_pm_research_2026-08.md §3.2): the
--       notification audience becomes watchers ∪ assignees, and commenting,
--       editing, assigning or being @mentioned subscribes you — the people who
--       touched a task keep hearing about it without opting in.
-- Depends on: 146_projects.sql (pm_tasks), 152 (pm_notifications, whose
--       recipient constraints this table mirrors), 161 (organization_id and
--       the pm_organization_from_parent trigger function).
--
-- ⚠️ Shape re-derived in this repo's idiom, never translated: the research
-- doc's AGPL wall binds this file. One deliberate divergence is recorded
-- there and restated here: Plane gates delivery on project MEMBERSHIP; our
-- gate stays `resolve_visibility_for` — a watcher row is an intent to hear,
-- never a right to see, and the read path re-checks visibility per recipient.
--
-- **A watcher is a HUMAN address, stored folded (R10).** Same two constraints
-- as pm_notifications' recipient, for the same reasons: an `agent:<name>` row
-- would be an inbox nobody ever opens (agents are handed work by the WS-27f
-- dispatch sink), and every read compares folded, so a mixed-case row would be
-- a subscription that never fires.
--
-- **The tenant key (D-MT-3).** Carried on the row like every pm_* table since
-- migration 161; filled and cross-checked against the task's by the same
-- pm_organization_from_parent trigger, so no INSERT site has to remember it.
--
-- Idempotent per infra/postgres/README.md: IF NOT EXISTS everywhere,
-- CREATE OR REPLACE TRIGGER, and a seed whose ON CONFLICT makes the second
-- run a no-op. Pinned as TEXT by tests/unit/test_projects_watchers.py.

BEGIN;

CREATE TABLE IF NOT EXISTS pm_task_watchers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- CASCADE: a watcher row on a deleted task is a subscription to nothing.
    task_id         UUID NOT NULL REFERENCES pm_tasks (id) ON DELETE CASCADE,
    -- Lowercased email. Never `agent:<name>` — see the header.
    watcher         TEXT NOT NULL,
    organization_id UUID NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pm_task_watchers_watcher_is_human
        CHECK (watcher NOT LIKE 'agent:%' AND watcher <> ''),
    CONSTRAINT pm_task_watchers_watcher_lowercased
        CHECK (watcher = lower(watcher)),
    -- One subscription per person per task. This is what makes every
    -- auto-subscribe site idempotent: ensure_watchers ends in ON CONFLICT
    -- DO NOTHING against this pair, so the fourth comment does not stack a
    -- fourth row.
    UNIQUE (task_id, watcher)
);

-- The fan-out asks "who watches THIS task"; the UNIQUE above already indexes
-- (task_id, watcher) and serves that read, so no second task-leading index.
-- "What do I watch" gets its own when a surface actually asks it (WS-29b's
-- rule: an index earns its place from a query that filters on it).

-- Fill-and-verify the tenant from the task's, exactly as 161 attaches the
-- other 17 pm_* tables. The function is 161's; only the attachment is new.
CREATE OR REPLACE TRIGGER trg_pm_task_watchers_org_from_task
    BEFORE INSERT OR UPDATE ON pm_task_watchers
    FOR EACH ROW EXECUTE FUNCTION
    pm_organization_from_parent('pm_tasks', 'task_id');

-- ── Seed: task creators become watchers of their own tasks ──────────────────
--
-- WS-27j's audience was assignees ∪ the task's author, derived per comment,
-- and its docstring promised "the derived audience is the one a watcher list
-- would be seeded with anyway, so nothing here has to be undone when one
-- arrives". This is that seeding: without it, every task created before this
-- migration would silently stop notifying its author the day the audience
-- switched to watchers ∪ assignees. Assignees need no seed — they stay in the
-- audience in their own right.
--
-- Only human authors: `agent:<name>` and non-address authors would fail the
-- CHECKs above, and an agent cannot receive a notification anyway (152).
INSERT INTO pm_task_watchers (task_id, watcher, organization_id, created_by)
SELECT t.id, lower(t.created_by), t.organization_id, 'system:migration_165'
  FROM pm_tasks t
 WHERE t.created_by LIKE '%@%'
   AND t.created_by NOT LIKE 'agent:%'
ON CONFLICT (task_id, watcher) DO NOTHING;

COMMIT;
