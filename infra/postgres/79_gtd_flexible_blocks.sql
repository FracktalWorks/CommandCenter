-- 79_gtd_flexible_blocks.sql — fixed vs flexible time-blocks (spec:
-- calendar_ux_review.md §3 P2 / §5.5; roadblock "rigidity vs reality").
--
-- What: a `flexible` flag on a scheduled block. true (default) = the auto-mover
--       may move it — roll-over, "replan the rest of my day", and (later) the
--       auto-scheduler only touch flexible blocks. false = FIXED (a meeting, a
--       hard appointment) that must stay exactly where it is.
-- Why:  a plan that reshuffles a real meeting is worse than useless, and
--       "everything is a hard-looking block" fuels commitment-aversion. A visible
--       fixed/flexible distinction lets the calendar re-flow around reality while
--       leaving true commitments untouched ("it'll re-flow if I slip").
-- Depends on: 76_gtd_scheduling.sql. ADDITIVE + idempotent — existing blocks
--       become flexible (the safe default: they were all task-blocks).

ALTER TABLE gtd_items
    ADD COLUMN IF NOT EXISTS flexible BOOLEAN NOT NULL DEFAULT true;
