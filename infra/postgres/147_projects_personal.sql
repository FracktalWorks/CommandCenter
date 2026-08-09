-- ============================================================================
-- 147_projects_personal.sql — the personal lens, on the SAME task store.
--
-- What: spec project-docs/specs/project_management_app.md §3.11–§3.12 and
--   §6.1 (WS-27e). Two additions to migration 146's spine:
--     * pm_projects.personal_owner — a project that belongs to one member
--     * pm_task_personal           — that member's GTD overlay on a task
--
-- Why: **D-PM-6 was superseded on 2026-08-06** (owner-directed: "the personal
--   task manager should be a proper extension of the project system … a
--   cohesive whole"). The original decision mirrored pm_tasks into gtd_items as
--   SYNCED rows. A mirror is two rows for one fact, and every feature built on
--   top of it — search, calendar, agents, reporting — then has to know about
--   both. So there is now ONE task table: assigning a task to somebody does not
--   *copy* it into their inbox, it IS the row in their inbox.
--
-- The two things that made a separate personal store look necessary, and how
-- they are answered here instead:
--
--   1. "Private todos aren't org work." They are now a **personal project** — an
--      ordinary pm_projects row with `personal_owner` set, granted to that one
--      email. Nothing about the task, board, timeline or automation machinery
--      needs a special case; it is a project like any other whose grant happens
--      to name a person.
--   2. "The GTD overlay is mine, not the team's." It is, so it lives in a
--      **per-member** side table. Two people assigned the same task can hold
--      different dispositions — one is doing it (NEXT), one is waiting on it
--      (WAITING) — which a single column on pm_tasks could never express. That
--      is not an edge case; it is what delegation looks like.
--
-- gtd_items is now LEGACY. `/tasks` reads a union of both during coexistence
-- and WS-27h retires it (spec §7.5). This migration does not touch it.
--
-- Idempotent per infra/postgres/README.md. Pinned by
-- tests/unit/test_projects_personal.py, which reads this file as TEXT.
--
-- Depends on: 146_projects.sql (pm_projects, pm_tasks).
-- ============================================================================

-- ── A project that belongs to one person ───────────────────────────────── §3.11
--
-- NULL = an ordinary team project. Non-null = somebody's personal project, and
-- the address IS the meaning — there is no `kind` column beside it, because two
-- columns that must agree are two columns that can disagree.
--
-- The row still gets an ordinary `pm_project_grants` entry naming the same
-- email. This column is not the ACL; it is how "find MY personal project"
-- resolves in one indexed read rather than by scanning grants.

ALTER TABLE pm_projects
    ADD COLUMN IF NOT EXISTS personal_owner TEXT;

-- One personal project per member, enforced case-insensitively because every
-- read compares folded (R10). Partial, so the millions of team projects that
-- will never carry the column cost nothing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_projects_personal_owner
    ON pm_projects (lower(personal_owner))
    WHERE personal_owner IS NOT NULL;

-- ── The per-member GTD overlay ─────────────────────────────────────────── §3.12
--
-- The vocabulary is migration 48's, unchanged and deliberately so: WS-27h has
-- to move ~every gtd_items row onto these columns, and a renamed disposition
-- would make that migration a translation instead of a copy.
--
-- Every column is NULLABLE and NULL means "not stated". That is what preserves
-- the contract the ClickUp sync has always kept — the overlay is never
-- clobbered — now made structural: the org side of a task cannot write here at
-- all, and the personal side cannot write to pm_tasks' shared columns except
-- through the ordinary task routes.
--
-- ⚠️ `disposition` NULL is not INBOX. A member who has never triaged a task
-- assigned to them has no disposition, and the read DERIVES one from the task's
-- status category (the same lens the ClickUp pull applies today). Defaulting
-- the column to 'INBOX' would make "never triaged" and "deliberately filed to
-- the inbox" the same state, and the weekly review cannot tell them apart.

CREATE TABLE IF NOT EXISTS pm_task_personal (
    task_id             UUID NOT NULL REFERENCES pm_tasks (id) ON DELETE CASCADE,
    -- An email, folded on write. Never `agent:<name>`: an agent has no GTD
    -- practice, and a CHECK is not used because the API is the writer and a
    -- constraint here would duplicate a rule that lives with the identity.
    member_email        TEXT NOT NULL,
    disposition         TEXT CHECK (disposition IN (
                            'INBOX', 'NEXT', 'WAITING', 'SOMEDAY',
                            'PROJECT', 'REFERENCE', 'DONE', 'TRASH')),
    -- The clarified physical next action, in this member's words.
    next_action         TEXT,
    context             TEXT,
    energy              TEXT CHECK (energy IN ('low', 'medium', 'high')),
    time_estimate_mins  INT,
    is_two_minute       BOOLEAN NOT NULL DEFAULT false,
    -- Tickler: hidden from the active inbox until this instant.
    defer_until         TIMESTAMPTZ,
    -- When this member last triaged it. The Weekly Review's "what have I not
    -- looked at" question is this column, and it is why triage is recorded even
    -- when the member changes nothing.
    clarified_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, member_email)
);

-- The inbox read is "my rows, by disposition, oldest first" — the same shape as
-- migration 48's idx_gtd_items_user_disposition, for the same query.
CREATE INDEX IF NOT EXISTS idx_pm_task_personal_member
    ON pm_task_personal (member_email, disposition);
-- The tickler sweep: "what has become due to resurface".
CREATE INDEX IF NOT EXISTS idx_pm_task_personal_defer
    ON pm_task_personal (defer_until) WHERE defer_until IS NOT NULL;
-- Context lists ("@calls, next actions only") — partial, because that is the
-- only disposition the context picker is ever asked about.
CREATE INDEX IF NOT EXISTS idx_pm_task_personal_context
    ON pm_task_personal (member_email, context)
    WHERE disposition = 'NEXT';
