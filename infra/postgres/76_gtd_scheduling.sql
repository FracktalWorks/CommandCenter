-- 76_gtd_scheduling.sql — timeboxing: a task can be placed in TIME, not just
-- given a deadline (spec: calendar_timeboxing.md §3).
--
-- What: scheduled_start / scheduled_end on gtd_items — the time BLOCK when the
--       user will actually do the task. Distinct from due_at (a deadline) and
--       from time_estimate_mins (an unanchored duration). null start = the task
--       is unscheduled (lives in Next Actions only).
-- Why:  the Calendar app renders a day/week/month grid; a block is what shows up
--       on it. due_at stays the "hard landscape" deadline lane; a task can have
--       a Friday deadline but be timeboxed on Wednesday.
-- Depends on: 48_task_manager_gtd.sql. ADDITIVE + idempotent — no backfill, all
--       existing rows are simply "unscheduled" (null).
--
-- Phase 2 (see spec §3) promotes this to a gtd_time_blocks table so one task can
-- carry multiple blocks and external calendar events share the grid; the grid UI
-- is written against a TimeBlock abstraction so that swap is non-breaking.

ALTER TABLE gtd_items
    ADD COLUMN IF NOT EXISTS scheduled_start TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS scheduled_end   TIMESTAMPTZ;

-- Range scan for "everything on the grid between X and Y" (the calendar view's
-- GET /tasks/calendar?from&to). Partial: only scheduled rows are ever queried.
CREATE INDEX IF NOT EXISTS ix_gtd_items_scheduled_start
    ON gtd_items (user_id, scheduled_start)
    WHERE scheduled_start IS NOT NULL;
