-- 150_projects_attachments.sql — files on a project task (WS-27i).
--
-- What: pm_task_attachments — a thin join from a task to a row in the EXISTING
--       `gtd_attachments` file registry, plus `attachment` added to the
--       `pm_activities` type vocabulary.
-- Why:  spec §11.2 item 1, the first ClickUp-parity gap: "a task with a photo
--       of the failed print is the normal case in a hardware company, and today
--       there is nowhere to put it."
--       Spec: project-docs/specs/project_management_app.md §11.
-- Depends on: 52_gtd_attachments.sql (the file registry), 146_projects.sql.
--
-- **One file store, not two.** Paca's shape is a central `files` registry plus
-- a thin per-domain join (research §2.7), and `gtd_attachments` already IS that
-- registry — owner, name, mime, size, disk path. A second table with a second
-- storage directory would mean two places to back up, two size limits to keep
-- in step, and two answers to "is this extension allowed".
--
-- **What differs is who may READ, and that is the whole reason for the join.**
-- `gtd_attachments` is owner-scoped end to end: `/tasks/attachments/{id}/{name}`
-- serves only to the uploader, which is right for a personal capture and wrong
-- for a shared task. This join is what makes a file readable by everyone who
-- can see the task — so the *join*, not the file row, carries the access
-- decision, and the personal serve route is left exactly as it was.
--
-- Idempotent: IF NOT EXISTS everywhere; the CHECK is replaced through a guarded
--       DROP/ADD pair because Postgres has no ADD CONSTRAINT IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS pm_task_attachments (
    task_id         UUID NOT NULL REFERENCES pm_tasks (id) ON DELETE CASCADE,
    -- No FK to gtd_attachments ON DELETE CASCADE by accident: deleting the file
    -- row should not silently remove the task's record that a file was there.
    -- The API detaches explicitly, and a dangling id serves a 404 rather than
    -- rewriting history.
    attachment_id   UUID NOT NULL,
    added_by        TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS idx_pm_task_attachments_task
    ON pm_task_attachments (task_id);
-- The serve route asks "is this attachment on ANY task I can see", which is a
-- lookup by attachment rather than by task.
CREATE INDEX IF NOT EXISTS idx_pm_task_attachments_attachment
    ON pm_task_attachments (attachment_id);

-- `attachment` joins the activity vocabulary so adding a file lands on the same
-- timeline as a comment or a status move. A file that appears with no trace of
-- who added it or when is the kind of gap the single activity spine exists to
-- close (§3.8).
-- Dropped by SHAPE, not by assuming Postgres's `pm_activities_type_check`
-- default. Dropping a name that does not exist is a silent no-op, and the ADD
-- below would then succeed under a *second* name — leaving the old, narrower
-- CHECK in force alongside the new one. Both would apply, `attachment` would
-- still be rejected, and the migration would report success. Finding every
-- CHECK that constrains this vocabulary is the only version that cannot do
-- that.
DO $$
DECLARE
    cname text;
BEGIN
    FOR cname IN
        SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
         WHERE t.relname = 'pm_activities'
           AND c.contype = 'c'
           AND pg_get_constraintdef(c.oid) LIKE '%status_change%'
    LOOP
        EXECUTE format('ALTER TABLE pm_activities DROP CONSTRAINT %I', cname);
    END LOOP;

    ALTER TABLE pm_activities
      ADD CONSTRAINT pm_activities_type_check
      CHECK (type IN ('comment', 'status_change', 'field_change',
                      'link', 'assignment', 'agent_run',
                      'sync', 'system', 'attachment'));
END $$;
