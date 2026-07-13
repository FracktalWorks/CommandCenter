-- 67_gtd_item_soft_delete.sql — soft-delete tombstone for tasks so deletion is
-- undoable and (for SYNCED tasks) can propagate to the connected tool AFTER the
-- undo window, not before (task_manager_app.md).
--
-- What:
--   gtd_items.deleted_at — when set, the task is soft-deleted: hidden from every
--       view (including Archive) and excluded from every count. DELETE /items
--       now sets this instead of removing the row, so an Undo can restore the
--       task losslessly (its ClickUp linkage, notes, disposition all intact).
--       The row is only physically removed — and the ClickUp task deleted — by
--       an explicit purge once the undo window has passed.
-- Why:  a hard DELETE made Undo lossy (it re-created a bare task via capture,
--       losing provider linkage / history) and gave no safe point to propagate
--       an irreversible upstream ClickUp deletion. A tombstone fixes both.
-- Depends on: 48_task_manager_gtd.sql. Idempotent.

ALTER TABLE gtd_items
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Fast "not soft-deleted" filtering (every active read excludes tombstoned rows).
CREATE INDEX IF NOT EXISTS idx_gtd_items_deleted
    ON gtd_items(user_id, deleted_at);
