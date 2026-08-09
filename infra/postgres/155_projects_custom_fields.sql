-- 155_projects_custom_fields.sql — WS-27l
--
-- Spec: project-docs/specs/project_management_app.md §11.2 item 4, §11.9.
--
-- ClickUp's signature feature, and the fourth row of the parity backlog. The
-- shape is the one recorded as the additive path back in §5's non-goals:
-- definitions in a table, values denormalised onto the task as JSONB keyed by
-- `field_key` — Paca's pattern, which is proven and portable.
--
-- WHY VALUES ARE NOT A ROW PER (task, field). That is the textbook EAV answer
-- and it costs a join per field on every board paint. A board showing five
-- custom fields across two hundred imported tasks is a thousand rows to gather
-- and re-pivot, per render. The JSONB column arrives with the task for free,
-- which is the whole reason the denormalisation is worth its cost.
--
-- WHAT THE DENORMALISATION COSTS, stated rather than discovered: a value is not
-- referentially tied to its definition, so the DATABASE cannot stop a key that
-- no definition owns from being written. `routes/projects/custom_fields.py`
-- refuses one with a 422 naming it, and deleting a definition strips its values
-- rather than leaving them behind — which is where this deliberately departs
-- from Paca, whose research notes record "deleting a definition does not clean
-- task data" as an accepted cost. It is not accepted here: a key left in the
-- JSONB resurfaces with new meaning the day somebody recreates a field with the
-- same name, and a value nobody can see is a value nobody can correct.

BEGIN;

CREATE TABLE IF NOT EXISTS pm_custom_fields (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- The ROOT project. Configuration is root-scoped and the subtree inherits,
    -- exactly as statuses and types are (`admin._root_for`): otherwise every
    -- subproject would need its own duplicated set of fields, and a task moved
    -- between subprojects would arrive somewhere its values mean nothing.
    project_id          UUID NOT NULL REFERENCES pm_projects (id) ON DELETE CASCADE,

    -- The stable identity, and the key values are stored under. Lowercase, no
    -- spaces: it is a JSONB object key that ends up in query strings and in
    -- automation graphs, so it may not depend on how somebody capitalised the
    -- display name this week.
    field_key           TEXT NOT NULL
                        CHECK (field_key ~ '^[a-z][a-z0-9_]{0,62}$'),

    -- What a human reads. Free to change; `field_key` is not.
    name                TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description         TEXT,

    field_type          TEXT NOT NULL
                        CHECK (field_type IN ('text', 'number', 'date', 'select',
                                              'multi_select', 'boolean', 'url')),

    -- The choices, for `select` and `multi_select`. A JSON array of strings;
    -- empty for every other type. Not a side table: an option has no identity
    -- worth referencing, and values store the option's TEXT so renaming one
    -- through this column alone would silently change what every task says.
    options             JSONB NOT NULL DEFAULT '[]'::jsonb
                        CHECK (jsonb_typeof(options) = 'array'),

    position            INTEGER NOT NULL DEFAULT 0,

    created_by          TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One definition per key per project. This is what makes `field_key` an
    -- identity rather than a label, and what lets a value be resolved back to
    -- its definition with no join key of its own.
    UNIQUE (project_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_pm_custom_fields_project
    ON pm_custom_fields (project_id, position, name);

-- Values live on the task, keyed by `field_key`.
--
-- NOT NULL DEFAULT '{}' rather than a nullable column: "this task has no custom
-- values" and "this task's values have not loaded" would otherwise be the same
-- NULL, and every reader would need the same defensive coalesce.
ALTER TABLE pm_tasks
    ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE pm_tasks
    DROP CONSTRAINT IF EXISTS pm_tasks_custom_fields_is_object;
ALTER TABLE pm_tasks
    ADD CONSTRAINT pm_tasks_custom_fields_is_object
    CHECK (jsonb_typeof(custom_fields) = 'object') NOT VALID;

-- Validated separately so an unanticipated legacy value leaves a NOTICE rather
-- than stopping a deploy — the pattern migration 148 established after main was
-- bitten twice by a constraint added in one step.
DO $$
BEGIN
    ALTER TABLE pm_tasks VALIDATE CONSTRAINT pm_tasks_custom_fields_is_object;
EXCEPTION WHEN others THEN
    RAISE NOTICE 'pm_tasks.custom_fields holds a non-object row; constraint left NOT VALID: %',
        SQLERRM;
END $$;

-- GIN, for the containment queries a `?custom.<key>=<value>` filter will use.
-- `jsonb_path_ops` is the smaller, faster index and supports exactly `@>`,
-- which is the only operator that filter needs.
CREATE INDEX IF NOT EXISTS idx_pm_tasks_custom_fields
    ON pm_tasks USING GIN (custom_fields jsonb_path_ops);

COMMIT;
