-- ============================================================================
-- 133_workflow_catalog_index.sql — semantic index over the workflow catalog
-- ============================================================================
-- Spec: ai-company-brain/specs/workflows_app.md (catalog search / copilot).
--
-- One row per palette capability (agent, tool action, integration, module,
-- node type). `content_hash` keys the lazy embed sync: an entry is re-embedded
-- only when its label/description changed. `embedding` is a JSONB float array
-- (NULL when no embedding provider is configured — search degrades to keyword
-- scoring). The catalog is small (tens of entries), so similarity is computed
-- in-process; no pgvector column needed here.
--
-- Idempotent. Depends on: 132_workflows.sql (the app it serves).
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_catalog_index (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL
        CHECK (kind IN ('agent', 'tool', 'integration', 'module', 'node')),
    key TEXT NOT NULL,                      -- agent name | action | service | module id | node type
    label TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL,
    embedding JSONB,                        -- float[] | NULL (keyword-only)
    embed_model TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (kind, key)
);

CREATE INDEX IF NOT EXISTS idx_workflow_catalog_index_kind
    ON workflow_catalog_index(kind);
