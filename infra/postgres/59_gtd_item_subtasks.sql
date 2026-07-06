-- 59_gtd_item_subtasks.sql — subtasks for gtd_items (task_manager_app.md).
--
-- What:
--   gtd_items.parent_item_id — a self-referential FK. When set, this item is a
--       SUBTASK of another gtd_item (its parent). NULL = a top-level task. A
--       subtask inherits its parent's project/account; on a SYNCED parent the
--       subtask maps to a ClickUp subtask (create_task `parent`).
-- Why:  a complex capture can clarify into EITHER a project (many actions) OR a
--       single task broken into concrete subtasks. Until now gtd_items was flat
--       (only project_id grouping); real subtasks need a parent link. Mirrors
--       ClickUp/Jira child-issue hierarchy (Space→Folder→List→Task→Subtask).
-- Depends on: 48_task_manager_gtd.sql. Idempotent.

ALTER TABLE gtd_items
    ADD COLUMN IF NOT EXISTS parent_item_id UUID
        REFERENCES gtd_items(id) ON DELETE CASCADE;

-- Fast "children of this task" lookup (the detail panel + roll-up counts).
CREATE INDEX IF NOT EXISTS idx_gtd_items_parent
    ON gtd_items(parent_item_id)
    WHERE parent_item_id IS NOT NULL;
