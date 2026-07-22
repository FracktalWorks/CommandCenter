-- 91_gtd_item_assignees.sql — multiple assignees per task (task_manager_app.md).
--
-- What:
--   gtd_items.assignees — the FULL set of owners as a JSONB array of
--       {name, email, provider_user_id}. ClickUp (and most PM tools) allow a
--       task to have several assignees; until now we kept only the first, so a
--       shared task looked single-owner and a second owner couldn't be added.
--
--   The existing single `assignee` column stays as the PRIMARY/display owner
--       (the me-preferred one, else the first of `assignees`) so everything that
--       reads one owner — the card avatar, the Waiting-For "who", the delegate
--       flow — keeps working unchanged. Writes keep the two in step:
--       assignee = assignees[0] (or NULL when the set is emptied).
--
-- Backfill: seed the array from the current single assignee so existing rows
-- read back with a one-element set instead of an empty one.
--
-- Why:  a task is often owned by more than one person; the app should mirror
--       that instead of silently dropping every owner but one on sync.
-- Depends on: 48_task_manager_gtd.sql. Idempotent.

ALTER TABLE gtd_items
    ADD COLUMN IF NOT EXISTS assignees JSONB NOT NULL DEFAULT '[]'::jsonb;

-- One-time backfill: rows that predate this column but carry a single assignee
-- become a one-element set. Only touches still-empty arrays, so it's safe to
-- re-run.
UPDATE gtd_items
   SET assignees = jsonb_build_array(assignee)
 WHERE assignee IS NOT NULL
   AND (assignees IS NULL OR assignees = '[]'::jsonb);
