-- 160_projects_recurrence.sql — WS-27o
--
-- Spec: ai-company-brain/specs/project_management_app.md §11.2 item 7, §11.13.
--
-- "Every operations cadence is recurring. Without it those live in someone's
-- head or in ClickUp."
--
-- NO SCHEDULER, AND THAT IS FORCED RATHER THAN CHOSEN. §5's non-goals:
-- "A second automation engine. ADR-028/D6: /workflows is the only engine; WS-27
-- contributes events and node types to it." A recurrence worker inside this app
-- would be exactly that second engine. So the next instance is created **when a
-- task closes** — `apply_status_transition` already owns that moment — and the
-- whole feature needs no cron, no worker and no new transport.
--
-- WHAT THAT COSTS, STATED: a series only advances when somebody finishes the
-- current one. A monthly report nobody closes does not pile up twelve copies,
-- which is right; a daily standup nobody ticks does not appear tomorrow, which
-- is the honest limitation. Materialising ahead of time is already reachable
-- through the engine that owns scheduling — a cron trigger plus the `pm_task`
-- node WS-27f added — so nothing here has to be undone to get it.

BEGIN;

CREATE TABLE IF NOT EXISTS pm_recurrences (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- The ROOT project, as every other piece of task configuration is. It is
    -- also the scope the successor is created in, so a series cannot quietly
    -- walk into a project nobody granted.
    project_id          UUID NOT NULL REFERENCES pm_projects (id) ON DELETE CASCADE,

    freq                TEXT NOT NULL
                        CHECK (freq IN ('daily', 'weekly', 'monthly', 'yearly')),

    -- "every N". Bounded: an interval of 100000 days is not a cadence, it is a
    -- way to put a date far enough out that nobody notices the series is dead.
    interval            INTEGER NOT NULL DEFAULT 1
                        CHECK (interval BETWEEN 1 AND 365),

    -- ISO weekdays for `weekly`: 1 = Monday … 7 = Sunday. "Every weekday" is
    -- `weekly` with {1,2,3,4,5} rather than a fifth `freq`, because it IS that
    -- and a separate value would need its own interval semantics.
    weekdays            SMALLINT[] NOT NULL DEFAULT '{}'::smallint[]
                        CHECK (weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),

    -- For `monthly` and `yearly`. 31 is legal and is the interesting case: it
    -- is CLAMPED to the length of the target month at computation time, never
    -- stored differently, so "the 31st" stays "the 31st" in the months that
    -- have one instead of silently becoming "the 28th" forever.
    day_of_month        SMALLINT CHECK (day_of_month BETWEEN 1 AND 31),
    month_of_year       SMALLINT CHECK (month_of_year BETWEEN 1 AND 12),

    -- WHAT THE NEXT DUE DATE IS MEASURED FROM, and the two answers mean
    -- genuinely different things:
    --   'due'       — the schedule. "Stock count on the 1st" stays on the 1st
    --                 however late the last one was closed. The series does not
    --                 drift.
    --   'completed' — the interval since it was actually done. "Water the
    --                 plants every 3 days" restarts when you water them.
    -- Neither is a sensible global default, so it is per rule.
    anchor              TEXT NOT NULL DEFAULT 'due'
                        CHECK (anchor IN ('due', 'completed')),

    -- Ending a series. Both optional, both honoured; whichever ends it first
    -- wins. Without either, a cadence runs until somebody turns it off — which
    -- is what an operations cadence actually is.
    until_at            TIMESTAMPTZ,
    max_occurrences     INTEGER CHECK (max_occurrences > 0),
    occurrences_made    INTEGER NOT NULL DEFAULT 0 CHECK (occurrences_made >= 0),

    created_by          TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A weekly rule with no weekdays has no way to pick a day, and a monthly
    -- one with no day-of-month has no way to pick a date. Refused here as well
    -- as in Python, because a rule that cannot produce a date is a series that
    -- silently stops.
    -- `coalesce` is load-bearing, not defensive. `array_length('{}', 1)` returns
    -- NULL rather than 0, `NULL >= 1` is NULL, and a CHECK only FAILS on false —
    -- so without it this constraint evaluates to NULL for exactly the row it
    -- exists to reject, and a weekly rule with no weekdays inserts happily.
    -- Found by running the migration rather than by reading it.
    CONSTRAINT pm_recurrences_weekly_needs_days
        CHECK (freq <> 'weekly' OR coalesce(array_length(weekdays, 1), 0) >= 1),
    CONSTRAINT pm_recurrences_monthly_needs_a_day
        CHECK (freq NOT IN ('monthly', 'yearly') OR day_of_month IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_pm_recurrences_project
    ON pm_recurrences (project_id);

ALTER TABLE pm_tasks
    ADD COLUMN IF NOT EXISTS recurrence_id UUID
        REFERENCES pm_recurrences (id) ON DELETE SET NULL;

-- Stamped when this task has produced its successor.
--
-- THE IDEMPOTENCY GUARD, and it is the whole reason this column exists rather
-- than the spawn being inferred. A task can cross into `done` more than once —
-- somebody closes it, reopens it to add a note, closes it again — and each
-- crossing hits the same seam. Without this, one weekly report becomes three.
-- It is never cleared: reopening undoes `completed_at`, but it does not un-emit
-- a successor that already exists and may already have been worked on.
ALTER TABLE pm_tasks
    ADD COLUMN IF NOT EXISTS recurrence_spawned_at TIMESTAMPTZ;

-- Finding a series. Partial, because the overwhelming majority of tasks carry
-- no recurrence at all and an index over all of them would be mostly nulls.
CREATE INDEX IF NOT EXISTS idx_pm_tasks_recurrence
    ON pm_tasks (recurrence_id)
    WHERE recurrence_id IS NOT NULL;

COMMIT;
