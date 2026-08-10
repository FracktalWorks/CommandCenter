-- 156_projects_tags.sql — WS-27m
--
-- Spec: project-docs/specs/project_management_app.md §11.2 item 5, §11.10.
--
-- The fifth row of the parity backlog, and the one the research notes left
-- open on purpose. `paca_pm_research_2026-08.md` row 13 REFUSED Paca's model —
-- "a bare jsonb string array on tasks. No registry, no colors, no rename/merge
-- — the weakest part of Paca's model; don't copy it as-is" — and §5's non-goals
-- shipped `pm_tasks.tags TEXT[]` as the v1 in its place, with a registry named
-- as additive later. This is that registry.
--
-- WHY THE ARRAY STAYS. The obvious "proper" alternative is a join table, and it
-- is the wrong trade here for the same reason 155 gave for custom fields: the
-- array arrives with the task, and its GIN index (146) already answers "tagged
-- X" without touching another relation. A join table would add a row per tag
-- per task and a join to every board paint, to buy referential integrity this
-- app can enforce in one place instead.
--
-- WHAT THE REGISTRY BUYS, given the array is staying:
--   * ONE SPELLING per tag. "Bug", "bug" and "BUG" are one tag, so filtering by
--     it finds all of it. The array stores the registry's display form, which is
--     what makes that true rather than aspirational.
--   * RENAME as one statement instead of a hunt.
--   * MERGE, which is the answer to the real failure mode of free tagging: the
--     set rots into near-duplicates and nobody can fix it.
--   * A COLOUR, so a board can show a tag rather than spell it.

BEGIN;

CREATE TABLE IF NOT EXISTS pm_tags (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- The ROOT project, as statuses, types and custom fields are: configuration
    -- is root-scoped and the subtree inherits, so a task moved between
    -- subprojects keeps tags that still mean something.
    project_id          UUID NOT NULL REFERENCES pm_projects (id) ON DELETE CASCADE,

    -- The display form, and the exact text stored in every `pm_tasks.tags`
    -- entry for this tag. Trimmed on the way in — a leading space would make
    -- ' bug' a second tag that renders identically to the first.
    name                TEXT NOT NULL
                        CHECK (length(trim(name)) > 0 AND name = trim(name)
                               AND length(name) <= 64),

    color               TEXT NOT NULL DEFAULT 'gray',
    description         TEXT,

    created_by          TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Identity is case-INSENSITIVE, display is case-preserving. Somebody typing
-- "Bug" when "bug" exists means the tag they can already see, and a registry
-- that let both in would be a registry with the problem it exists to solve.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_tags_project_name
    ON pm_tags (project_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_pm_tags_project
    ON pm_tags (project_id, name);

-- ── Backfill ────────────────────────────────────────────────────────────────
--
-- Tasks already carry tags — the ClickUp import path writes them, and `tags`
-- has been on `pm_tasks` since 146. An empty registry beside a tagged corpus
-- would mean the first rename found nothing and the manager showed nothing, so
-- the tags that exist are registered here.
--
-- The winning display form is the SPELLING PEOPLE ACTUALLY USE — the most
-- frequent one — with ties broken by `min()` so the result does not depend on
-- scan order. Picking `min()` alone would canonicalise a corpus of 400 "Bug"
-- to a single stray "BUG".
INSERT INTO pm_tags (project_id, name, created_by)
SELECT project_id, name, 'system:migration_156'
  FROM (
      SELECT t.root_project_id AS project_id,
             tag AS name,
             row_number() OVER (
                 PARTITION BY t.root_project_id, lower(tag)
                 ORDER BY count(*) DESC, tag
             ) AS rank
        FROM pm_tasks t, unnest(t.tags) AS tag
       WHERE trim(tag) <> ''
       GROUP BY t.root_project_id, tag
  ) ranked
 WHERE rank = 1
ON CONFLICT DO NOTHING;

-- Now make the tasks agree with the registry.
--
-- This REWRITES data, which is not something a migration should do quietly, so:
-- it only ever replaces a tag with a different CASING of the same tag, the
-- meaning is identical, and the count is reported. Leaving it undone would make
-- the registry's central claim — one spelling per tag — false on day one, and
-- "tagged bug" would silently miss every task that said "Bug".
DO $$
DECLARE
    touched INTEGER;
BEGIN
    WITH exploded AS (
        -- CROSS JOIN LATERAL, not a comma: with the implicit form the LEFT JOIN
        -- binds only to `unnest(...)` and `t` is not in scope for its ON clause.
        -- WITH ORDINALITY, because a tag list is arranged and must not come back
        -- alphabetised — which is exactly what `array_agg(DISTINCT ...)` would
        -- do, since Postgres sorts a DISTINCT aggregate by its own expression.
        SELECT t.id AS task_id, u.ord, coalesce(g.name, u.tag) AS name
          FROM pm_tasks t
          CROSS JOIN LATERAL unnest(t.tags) WITH ORDINALITY AS u(tag, ord)
          LEFT JOIN pm_tags g
                 ON g.project_id = t.root_project_id
                AND lower(g.name) = lower(u.tag)
    ),
    deduped AS (
        -- A task holding both "BUG" and "bug" canonicalises to the same name
        -- twice; first occurrence wins so the position it already had is kept.
        SELECT DISTINCT ON (task_id, lower(name)) task_id, ord, name
          FROM exploded
         ORDER BY task_id, lower(name), ord
    ),
    canonical AS (
        SELECT task_id, array_agg(name ORDER BY ord) AS tags
          FROM deduped
         GROUP BY task_id
    )
    UPDATE pm_tasks t
       SET tags = c.tags
      FROM canonical c
     WHERE t.id = c.task_id
       AND t.tags <> c.tags;
    GET DIAGNOSTICS touched = ROW_COUNT;
    IF touched > 0 THEN
        RAISE NOTICE 'migration 156: canonicalised tag spellings on % task(s)', touched;
    END IF;
END $$;

COMMIT;
