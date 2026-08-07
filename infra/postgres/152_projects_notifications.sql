-- 152_projects_notifications.sql — somebody hears about it (WS-27j).
--
-- What: pm_notifications — one row per person per thing that happened to them,
--       plus `mention` in the pm_activities type vocabulary.
-- Why:  spec §11.2 item 2, the second ClickUp-parity gap: "assignment is
--       silent. A tool nobody hears from is a tool nobody opens, and the whole
--       assignment→agent chain assumes somebody noticed."
--       Spec: ai-company-brain/specs/project_management_app.md §11.
-- Depends on: 146_projects.sql (pm_tasks, pm_activities), 150 (which last
--       edited the activity CHECK).
--
-- **A row per RECIPIENT, not a row per event.** The alternative — one event row
-- plus a per-person read marker — is smaller and wrong: the audience for an
-- event is computed from who could see the task AT THE TIME, and recomputing it
-- on every read would silently rewrite history as grants change. Materialising
-- the audience once is what makes "you were mentioned on this" a fact rather
-- than a re-derivation.
--
-- **Read access is still checked at READ time**, over this table's `task_id`.
-- The two are not in tension: the audience is fixed when the event happens, but
-- a person who has since lost access to the project stops seeing the row. A
-- notification is a pointer to a task, and a pointer that outlives the
-- permission is a title leak.
--
-- Idempotent: IF NOT EXISTS everywhere; the activity CHECK is replaced through
--       a guarded DROP/ADD pair because Postgres has no ADD CONSTRAINT IF NOT
--       EXISTS.

CREATE TABLE IF NOT EXISTS pm_notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Lowercased email. **Never `agent:<name>`** — the CHECK below is the
    -- fence. Agents are handed work by the WS-27f dispatch sink, which starts
    -- a run; a notification row for one would be an inbox nobody ever opens,
    -- and it would inflate the badge of whoever went looking.
    recipient       TEXT NOT NULL,
    kind            TEXT NOT NULL
                        CHECK (kind IN ('assigned', 'mention', 'comment')),
    -- CASCADE, deliberately: a notification whose task is gone is a link to a
    -- 404, and leaving it behind makes the badge count things that no longer
    -- exist.
    task_id         UUID NOT NULL REFERENCES pm_tasks (id) ON DELETE CASCADE,
    -- The comment this came from, when there is one. CASCADE for the same
    -- reason — a deleted comment must not stay quotable from the bell.
    activity_id     UUID REFERENCES pm_activities (id) ON DELETE CASCADE,
    -- Who caused it. An email or `agent:<name>`: an agent CANNOT receive a
    -- notification but absolutely can cause one, which is the point of letting
    -- it comment at all.
    actor           TEXT NOT NULL,
    -- A short excerpt, snapshotted. Not a join to the comment: the bell has to
    -- render after the comment is edited or deleted, and re-reading the live
    -- body would make an old notification say something new.
    excerpt         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at         TIMESTAMPTZ,
    CONSTRAINT pm_notifications_recipient_is_human
        CHECK (recipient NOT LIKE 'agent:%' AND recipient <> ''),
    CONSTRAINT pm_notifications_recipient_lowercased
        CHECK (recipient = lower(recipient))
);

-- The badge count — by far the most frequent query, and it only ever asks
-- about ONE person's unread rows. Partial, so the index holds the unread tail
-- rather than every notification the org has ever produced.
CREATE INDEX IF NOT EXISTS idx_pm_notifications_unread
    ON pm_notifications (recipient, created_at DESC)
    WHERE read_at IS NULL;

-- The list, which includes read rows.
CREATE INDEX IF NOT EXISTS idx_pm_notifications_recipient
    ON pm_notifications (recipient, created_at DESC);

-- `mention` joins the activity vocabulary so an @mention is visible on the
-- timeline and not only in the recipient's bell. Someone reading the task
-- later has to be able to see that a person was pulled in — otherwise the
-- reason a colleague turned up in the thread is only recorded in a row that
-- person alone can read.
--
-- Dropped by SHAPE, not by assuming Postgres's `pm_activities_type_check`
-- default. Dropping a name that does not exist is a silent no-op, and the ADD
-- below would then succeed under a *second* name — leaving the old, narrower
-- CHECK in force alongside the new one. Both would apply, `mention` would still
-- be rejected, and the migration would report success. (150 established this
-- pattern for `attachment`; the hunt is by `status_change` because that value
-- is in every version of the vocabulary.)
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
                      'sync', 'system', 'attachment', 'mention'));
END $$;
