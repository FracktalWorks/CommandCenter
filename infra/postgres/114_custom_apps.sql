-- ============================================================================
-- 114_custom_apps.sql — Custom Apps / App Workshop data model (Phase 0)
-- ============================================================================
-- The app platform's core tables (RFC: docs/app-workshop/README.md §4.9):
--
--   apps          the editable definition (edit-model): slug, manifest,
--                 workspace pointer, visibility/status, live version pointer
--   app_versions  immutable published snapshots (run-model) — publish inserts
--                 one, rollback repoints apps.live_version at an older one
--   app_grants    sharing + consent; subject is 'org' | an email |
--                 'agent:<name>' | 'agents:*' (forward-compatible with the
--                 org-research role model)
--   app_data      the cc.storage backing store: app-scoped JSON tables keyed
--                 (table, key, user_scope); user_scope '' = shared row, else a
--                 per-user partition
--   app_audit     every bridge call (open/storage/ai/tool/publish/…), cheap and
--                 append-only; the AI-budget + usage aggregates read from here.
--                 Deliberately NO FK to apps so history survives a hard delete.
--
-- Idempotent. Depends on: nothing (self-contained).
-- ============================================================================

CREATE TABLE IF NOT EXISTS apps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '',
    description TEXT DEFAULT '',
    owner_email TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private'
        CHECK (visibility IN ('private', 'people', 'org')),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'live', 'archived')),
    manifest JSONB NOT NULL DEFAULT '{}',
    workspace_path TEXT NOT NULL,
    live_version INT,                       -- NULL until first publish
    builder_session_id TEXT,                -- workshop chat_session id
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    version INT NOT NULL,
    manifest JSONB NOT NULL DEFAULT '{}',
    bundle_html TEXT NOT NULL,              -- the self-contained entry file
    bundle_sha256 TEXT NOT NULL,
    release_notes TEXT DEFAULT '',
    scope_set_hash TEXT DEFAULT '',         -- sha256 of sorted manifest scopes
    published_by TEXT NOT NULL,
    published_at TIMESTAMPTZ DEFAULT now(),
    review_status TEXT NOT NULL DEFAULT 'auto'
        CHECK (review_status IN ('auto', 'pending', 'approved', 'rejected')),
    UNIQUE (app_id, version)
);

CREATE TABLE IF NOT EXISTS app_grants (
    app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,                  -- email | 'agent:<name>' | 'agents:*'
    role TEXT NOT NULL DEFAULT 'use'
        CHECK (role IN ('use', 'edit', 'own')),
    consented_scope_hash TEXT DEFAULT '',
    granted_by TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (app_id, subject)
);

CREATE TABLE IF NOT EXISTS app_data (
    app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    table_name TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL DEFAULT '{}',
    user_scope TEXT NOT NULL DEFAULT '',    -- '' = shared row, else viewer email
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (app_id, table_name, key, user_scope)
);

CREATE TABLE IF NOT EXISTS app_audit (
    id BIGSERIAL PRIMARY KEY,
    app_id UUID NOT NULL,                   -- no FK: audit survives hard delete
    app_version INT,
    user_email TEXT NOT NULL,
    kind TEXT NOT NULL
        CHECK (kind IN ('open', 'storage', 'ai', 'tool',
                        'publish', 'rollback', 'action')),
    detail JSONB NOT NULL DEFAULT '{}',
    tokens_in INT DEFAULT 0,
    tokens_out INT DEFAULT 0,
    cost_usd NUMERIC(12, 6) DEFAULT 0,
    model TEXT DEFAULT '',
    at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_audit_app_at
    ON app_audit(app_id, at DESC);

-- The per-app monthly AI-budget sum filters on kind='ai'; usage lenses slice
-- by kind generally.
CREATE INDEX IF NOT EXISTS idx_app_audit_app_kind_at
    ON app_audit(app_id, kind, at DESC);
