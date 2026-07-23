-- 96_gtd_item_deep_work.sql — the Deep Work / flow axis (task_manager_app.md).
--
-- What:
--   gtd_items.deep_work — this task needs an unbroken FLOW state to do well:
--       creative, design, writing, coding/building, architecture, strategy,
--       research. Csikszentmihalyi's flow conditions (clear goal, feedback,
--       challenge-skill balance, NO interruption; entry costs 10-20 minutes)
--       make these tasks categorically different from shallow/reactive work:
--       they must be planned as long unbroken blocks in peak-energy windows,
--       never squeezed into fragments between meetings.
--
--   AI-prefilled at clarify (the LLM judges it like important/leveraged),
--   manually togglable everywhere the other two flags are. It is a WORK-MODE
--   axis, deliberately NOT an @context: a deep task is usually also @computer,
--   and contexts are single-valued (where/how you act), while deep-vs-shallow
--   is orthogonal (what state you need to be in).
--
-- Why:  the planner, Engage view, and Focus Mode need a first-class signal to
--       protect flow blocks and batch shallow work into the gaps.
-- Depends on: 48_task_manager_gtd.sql. Idempotent.

ALTER TABLE gtd_items
    ADD COLUMN IF NOT EXISTS deep_work BOOLEAN NOT NULL DEFAULT false;
