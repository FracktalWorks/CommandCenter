-- 80_gtd_actuals.sql — planned-vs-actual: record when a time-block was actually
-- worked, not just when it was planned (spec: calendar_ux_review.md §3 P3 / §4
-- "No actuals"; roadblocks "planning fallacy" + "plan≠reality drift").
--
-- What: actual_start / actual_end on gtd_items — stamped by the focus timer
--       (Start on the current block) and completion. Distinct from
--       scheduled_start/end (the PLAN) and time_estimate_mins (the GUESS).
-- Why:  without actuals we can't show planned-vs-actual, run an honest
--       end-of-day review, or learn a per-user estimate fudge factor — the loop
--       that builds trust and fixes chronic under-estimation over time. Pairs
--       naturally with a Pomodoro/focus timer.
-- Depends on: 76_gtd_scheduling.sql. ADDITIVE + idempotent — existing rows have
--       null actuals (never timed); nothing to backfill.

ALTER TABLE gtd_items
    ADD COLUMN IF NOT EXISTS actual_start TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS actual_end   TIMESTAMPTZ;
