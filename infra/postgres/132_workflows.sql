-- ============================================================================
-- 132_workflows.sql — Workflows app data model (visual automation builder)
-- ============================================================================
-- Spec: ai-company-brain/specs/workflows_app.md §4
-- RFC:  docs/workflow-editor/README.md §4 (edit-model vs run-model split)
--
--   workflows           the editable definition (edit-model): React-Flow JSON
--                       graph persisted verbatim, plus the webhook hook token
--   workflow_versions   immutable published snapshots (run-model) — publish
--                       compiles the draft graph to a flat serialized DAG and
--                       inserts one; runs execute a version, never the draft
--   workflow_triggers   user-configurable trigger bindings (manual/api/webhook/
--                       schedule/event) — the successor to the hard-coded
--                       agent_registry.json webhook_routes binding
--   workflow_runs       execution instances with per-node results
--   workflow_run_pauses snapshot rows for human-in-the-loop / wait resume
--                       (Slice 2 — table ships now so pause/resume needs no
--                       schema change later)
--   workflow_modules    the org module library (Module Studio): conversationally
--                       generated, AST-validated pure-transform code modules
--
-- Also seeds the `workflows` feature_catalog row (nav pane + access gate).
--
-- Idempotent. Depends on: 130_org_access_control.sql (feature_catalog).
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    owner_email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'published', 'disabled')),
    graph JSONB NOT NULL DEFAULT '{"nodes": [], "edges": []}',
    variables JSONB NOT NULL DEFAULT '{}',
    hook_token TEXT UNIQUE,                 -- webhook trigger URL credential
    latest_version INT,                     -- NULL until first publish
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflows_owner
    ON workflows(owner_email, updated_at DESC);

CREATE TABLE IF NOT EXISTS workflow_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    version INT NOT NULL,
    serialized JSONB NOT NULL,              -- compiled flat DAG (run-model)
    graph JSONB NOT NULL DEFAULT '{}',      -- the edit-model as published
    published_by TEXT NOT NULL,
    published_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (workflow_id, version)
);

CREATE TABLE IF NOT EXISTS workflow_triggers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    kind TEXT NOT NULL
        CHECK (kind IN ('manual', 'api', 'schedule', 'webhook', 'event')),
    config JSONB NOT NULL DEFAULT '{}',     -- cron expr | source+event_type | …
    enabled BOOLEAN NOT NULL DEFAULT true,
    last_fired_at TIMESTAMPTZ,              -- schedule loop CAS-claims on this
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_triggers_kind
    ON workflow_triggers(kind, enabled);

CREATE TABLE IF NOT EXISTS workflow_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL,              -- no FK: run history survives delete
    workflow_name TEXT NOT NULL DEFAULT '',
    version INT NOT NULL,
    trigger_kind TEXT NOT NULL DEFAULT 'manual',
    trigger_payload JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'paused',
                          'succeeded', 'failed', 'cancelled')),
    variables JSONB NOT NULL DEFAULT '{}',  -- final merged state
    node_results JSONB NOT NULL DEFAULT '{}',
    output JSONB,                           -- yielded workflow outputs
    error TEXT,
    started_by TEXT NOT NULL DEFAULT '',
    started_at TIMESTAMPTZ DEFAULT now(),
    finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow
    ON workflow_runs(workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
    ON workflow_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS workflow_run_pauses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    snapshot JSONB NOT NULL DEFAULT '{}',
    reason TEXT NOT NULL DEFAULT 'approval'
        CHECK (reason IN ('approval', 'wait', 'oauth')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'resolved', 'rejected')),
    created_at TIMESTAMPTZ DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS workflow_modules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '',
    language TEXT NOT NULL DEFAULT 'python',
    code TEXT NOT NULL,
    input_schema JSONB NOT NULL DEFAULT '{}',
    output_schema JSONB NOT NULL DEFAULT '{}',
    provenance JSONB NOT NULL DEFAULT '{}', -- prompt, model, generated_at, …
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'ready', 'disabled')),
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Nav pane + access gate registration (pattern: 130_org_access_control.sql).
-- is_default false: the pane is granted per-role/member, not on by default.
INSERT INTO feature_catalog (slug, label, description, nav_href, category, sort_order, is_default)
VALUES ('workflows', 'Workflows', 'Visual automation across agents, tools and integrations', '/workflows', 'apps', 95, false)
ON CONFLICT (slug) DO UPDATE SET
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    nav_href = EXCLUDED.nav_href,
    category = EXCLUDED.category,
    sort_order = EXCLUDED.sort_order;
