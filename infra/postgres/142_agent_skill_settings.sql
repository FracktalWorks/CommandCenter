-- 142_agent_skill_settings.sql — per-agent skill-family toggles (WS-23 S2)
--
-- Spec: project-docs/specs/skills_registry.md §3. One row = one explicit
-- admin decision about one skill family for one agent. The three rules the
-- enforcement seam (orchestrator/_tool_injection.py::_resolve_injected_scope)
-- lives by:
--   1. Intersection, never union — a row can only NARROW what the agent's
--      code/manifest declares, never grant a tool the code never asked for.
--   2. The core floor (_CORE_STANDARD_TOOL_NAMES) is not toggleable — the
--      API refuses rows for the 'core' family (and 'apps', which is managed
--      via app_grants), and the loader ignores them defensively.
--   3. No rows ⇒ today's behavior. Absent settings change nothing; the
--      fail-open default flip is S3, owner-gated, never implicit.
--
-- Shape mirrors user_permission_override (130): the *why* is a column —
-- reason / set_by / set_at — so the admin UI can explain every toggle.
--
-- `instance` is '' for agent-wide settings today; 't:<slug>' / 'u:<email>'
-- per-instance profiles arrive with Centers (spec §6) on the same PK.
--
-- Depends on: nothing (additive, standalone table).

CREATE TABLE IF NOT EXISTS agent_skill_setting (
    agent_name  TEXT NOT NULL,
    instance    TEXT NOT NULL DEFAULT '',
    family      TEXT NOT NULL,
    enabled     BOOLEAN NOT NULL,
    -- Why this exists. A toggle nobody can explain gets switched off.
    reason      TEXT NOT NULL DEFAULT '',
    set_by      TEXT NOT NULL,
    set_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_name, instance, family)
);

-- The enforcement hot path reads "disabled families for this agent" once per
-- run start; the partial index keeps that read cheap as settings accumulate.
CREATE INDEX IF NOT EXISTS idx_agent_skill_setting_disabled
    ON agent_skill_setting (agent_name, instance)
    WHERE enabled = false;
