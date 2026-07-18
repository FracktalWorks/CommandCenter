-- 78_gtd_calendar_rollover.sql — automatic nightly roll-over of incomplete
-- time-blocks (spec: calendar_timeboxing.md §6, roadmap P3).
--
-- What:
--   gtd_settings.timezone           IANA tz name (e.g. 'Asia/Kolkata') so the
--                                   server can compute each user's LOCAL day.
--   gtd_settings.auto_rollover      opt-out toggle (default on).
--   gtd_settings.last_rollover_date guard so the job rolls at most once per
--                                   local day (idempotent boundary trigger).
--   gtd_rollover_log                audit/history: which block moved, from→to.
-- Why: falling behind is timeboxing's #1 failure. The manual banner covers
--   intraday; this handles the day boundary automatically. It APPLIES (not a
--   proposal) from a background loop, so it needs server-side tz + prefs (the
--   calendar prefs from migration 77 are already stored).
-- Depends on: 48_task_manager_gtd.sql, 77_gtd_calendar_prefs.sql. ADDITIVE +
--   idempotent. getattr-style defaults keep pre-migration rows working.

ALTER TABLE gtd_settings
    ADD COLUMN IF NOT EXISTS timezone           TEXT DEFAULT 'UTC',
    ADD COLUMN IF NOT EXISTS auto_rollover       BOOLEAN DEFAULT true,
    ADD COLUMN IF NOT EXISTS last_rollover_date  DATE;

CREATE TABLE IF NOT EXISTS gtd_rollover_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     TEXT NOT NULL,
    item_id     UUID NOT NULL,
    title       TEXT,
    rolled_from TIMESTAMPTZ,
    rolled_to   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gtd_rollover_log_user
    ON gtd_rollover_log (user_id, created_at DESC);
