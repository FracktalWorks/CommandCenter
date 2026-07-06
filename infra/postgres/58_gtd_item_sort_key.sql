-- 58_gtd_item_sort_key.sql — manual (drag-to-reorder) ordering for tasks in the
-- list and Kanban board views (task_manager_app.md).
--
-- What:
--   gtd_items.sort_key — a fractional rank (DOUBLE PRECISION) giving a task an
--       explicit position within its group/column. A drag computes the midpoint
--       between the two neighbours' keys, so a single row moves without
--       rewriting the others. NULL = never manually ordered → the row falls back
--       to created-at ordering (so existing tasks keep today's order until the
--       user first drags one).
-- Why:  the board/list previously ordered only by (source, created_at); Jira/
--       ClickUp-style boards let you reorder cards vertically within a column
--       and that position must persist.
-- Depends on: 48_task_manager_gtd.sql. Idempotent.

ALTER TABLE gtd_items
    ADD COLUMN IF NOT EXISTS sort_key DOUBLE PRECISION;

-- The board/list order rows by (source, sort_key NULLS LAST, created_at); this
-- partial index keeps that ordered scan cheap for the manually-ranked rows.
CREATE INDEX IF NOT EXISTS idx_gtd_items_sort_key
    ON gtd_items(user_id, sort_key)
    WHERE sort_key IS NOT NULL;
