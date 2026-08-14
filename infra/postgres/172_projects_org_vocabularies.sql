-- ─────────────────────────────────────────────────────────────────────────────
-- 172 · Projects — org-wide vocabularies (WS-27bj, D-PM-16)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `project_id` becomes NULLABLE on the three vocabulary tables. **NULL means
-- org-wide**; a non-NULL value keeps meaning exactly what it means today, which
-- is the ROOT project (these three are already root-scoped — their own headers
-- say so, and the subtree inherits).
--
-- WHY NOW, when dropping NOT NULL later would be trivial. The cost here is
-- asymmetric. Widening the column is cheap whenever it happens; what is NOT
-- cheap is merging the duplicate rows a dozen root projects will each have
-- accumulated by then — their own "Bug", their own "urgent", their own
-- "Client" — because choosing which duplicate survives, and repointing the
-- tasks that reference the losers, is a judgement call nobody can automate.
-- Taking the decision today is what stops that merge ever becoming necessary.
--
-- ✅ THERE IS NO TENANCY HOLE, and this is what makes the change cheap.
-- All three tables already carry `organization_id NOT NULL` from migration 161
-- (added at 109/120/121, backfilled at 341/352/353, tightened at 368/379/380),
-- so a row with `project_id IS NULL` is org-wide **within one organization**,
-- never global. Had tenancy been reachable only through `project_id ->
-- pm_projects`, nulling this column would have produced untenanted rows visible
-- to every customer, and that would have had to be fixed first.
--
-- R6 — THIS IS AN EXPAND AND IT CONTRACTS NOTHING.
--   * Dropping NOT NULL only widens what is accepted. Old code always sends a
--     `project_id` and keeps working unchanged.
--   * Old readers filtering `WHERE project_id = :x` simply do not see org-wide
--     rows — invisible, not broken.
--   * Each whole-table UNIQUE is replaced by a PARTIAL unique covering exactly
--     the same rows (`WHERE project_id IS NOT NULL`), so no existing row loses
--     a constraint it has today. The second partial is new surface, not a
--     relaxation.
-- No contraction is owed by a later release: the shape below is the end state.
--
-- Idempotent by construction: every statement is IF EXISTS / IF NOT EXISTS, and
-- `DROP NOT NULL` is a no-op once applied.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── pm_task_types — identity is (scope, name) ───────────────────────────────

ALTER TABLE pm_task_types  ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE pm_task_types  DROP CONSTRAINT IF EXISTS pm_task_types_project_id_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_task_types_project_name
    ON pm_task_types (project_id, name)
    WHERE project_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_task_types_org_name
    ON pm_task_types (organization_id, name)
    WHERE project_id IS NULL;

-- ── pm_custom_fields — identity is (scope, field_key) ───────────────────────
--
-- `field_key`, NOT `name`: the key is the stable identity values are stored
-- under, and the display name is free to change. Two fields may read "Priority"
-- and be different fields; two may not share a key.

ALTER TABLE pm_custom_fields ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE pm_custom_fields
    DROP CONSTRAINT IF EXISTS pm_custom_fields_project_id_field_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_custom_fields_project_key
    ON pm_custom_fields (project_id, field_key)
    WHERE project_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_custom_fields_org_key
    ON pm_custom_fields (organization_id, field_key)
    WHERE project_id IS NULL;

-- ── pm_tags — identity is (scope, lower(name)) ──────────────────────────────
--
-- Case-INSENSITIVE, exactly as `idx_pm_tags_project_name` already was: somebody
-- typing "Bug" when "bug" exists means the tag they can already see. The org
-- half inherits that rule rather than inventing a second one.

ALTER TABLE pm_tags ALTER COLUMN project_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_pm_tags_project_name;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_tags_project_name
    ON pm_tags (project_id, lower(name))
    WHERE project_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_tags_org_name
    ON pm_tags (organization_id, lower(name))
    WHERE project_id IS NULL;

-- ── Read-path support ───────────────────────────────────────────────────────
--
-- The effective vocabulary for a project is `org-wide ∪ root-local`, so every
-- read gains an "or the org-wide ones" arm. These partial indexes serve that
-- arm directly; without them it is a filtered scan of the whole table per read.

CREATE INDEX IF NOT EXISTS idx_pm_task_types_org_wide
    ON pm_task_types (organization_id) WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_pm_custom_fields_org_wide
    ON pm_custom_fields (organization_id) WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_pm_tags_org_wide
    ON pm_tags (organization_id) WHERE project_id IS NULL;

COMMIT;
