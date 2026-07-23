-- 92_gtd_day_state.sql — per-LOCAL-day Focus-OS state (spec:
-- calendar_focus_os.md §5, calendar_ai_review.md §4.1).
--
-- What: the ★ One Thing and the tomorrow-seeds that Focus Mode's rituals set.
--   These were localStorage-only, so server-side AI (the day planner, the chat
--   agent, a future morning digest) could not see the user's committed top
--   priority or their pre-picked next-day tasks. Persisting them here makes the
--   One Thing a first-class planning input everywhere and syncs it across
--   devices.
--     one_thing_id : the item the user committed as today's single priority.
--     seed_ids     : item ids picked during shutdown to pre-load THIS day's
--                    morning plan (yesterday writes tomorrow's row).
-- Keyed by (user_id, LOCAL day) so it rolls over naturally at midnight; the row
-- is created lazily the first time a day gets a One Thing or seeds.
-- Why: the calendar can only "smartly manage the day with AI" if the AI can see
--   what the user decided matters most — this table is that bridge.
-- Depends on: 48_task_manager_gtd.sql (gtd_items). ADDITIVE + idempotent.

CREATE TABLE IF NOT EXISTS gtd_day_state (
    user_id      TEXT NOT NULL,
    day          DATE NOT NULL,               -- the user's LOCAL calendar day
    one_thing_id UUID,                         -- the ★ One Thing for this day
    seed_ids     JSONB DEFAULT '[]'::jsonb,    -- ids seeded for this day's plan
    updated_at   TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, day)
);
