-- 60_gtd_local_hierarchy.sql — local Space→Folder→Project hierarchy so LOCAL
-- projects nest like the connected PM tool (task_manager_app.md, Process
-- deepening Phase 3).
--
-- What (LOCAL only — SYNCED projects mirror the provider's own hierarchy via
-- task_accounts.schema_cache / the accordion, and are NOT stored here):
--   gtd_spaces  — top-level local grouping (a ClickUp "Space" analogue).
--   gtd_folders — a folder inside a space (optional middle level).
--   gtd_projects.space_id / .folder_id — a LOCAL project's place in the tree.
--       A project can sit directly under a space (folder_id NULL) or in a
--       folder. SYNCED projects leave both NULL (their tree is the provider's).
-- Full local depth = Space → Folder → Project → Task (gtd_items.project_id)
--   → Subtask (gtd_items.parent_item_id, migration 59).
-- Why:  the Projects view showed a flat list; local work deserves the same
--       navigable hierarchy as ClickUp so spaces/folders/projects/tasks/subtasks
--       read consistently across both sources.
-- Depends on: 48_task_manager_gtd.sql, 59_gtd_item_subtasks.sql. Idempotent.

CREATE TABLE IF NOT EXISTS gtd_spaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sort_key DOUBLE PRECISION,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gtd_spaces_user ON gtd_spaces(user_id);

CREATE TABLE IF NOT EXISTS gtd_folders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    space_id UUID NOT NULL REFERENCES gtd_spaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort_key DOUBLE PRECISION,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gtd_folders_space ON gtd_folders(space_id);

-- A LOCAL project's place in the tree. Both NULL = an ungrouped local project
-- (shown under a synthetic "No space" bucket) or a SYNCED project.
ALTER TABLE gtd_projects
    ADD COLUMN IF NOT EXISTS space_id UUID
        REFERENCES gtd_spaces(id) ON DELETE SET NULL;
ALTER TABLE gtd_projects
    ADD COLUMN IF NOT EXISTS folder_id UUID
        REFERENCES gtd_folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_gtd_projects_space ON gtd_projects(space_id)
    WHERE space_id IS NOT NULL;
