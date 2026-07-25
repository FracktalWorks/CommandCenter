-- ============================================================================
-- 114_app_files.sql — Custom Apps draft durability (Phase 1)
-- ============================================================================
-- Postgres mirror of every app's DRAFT workspace text files. Published bundles
-- are already durable in app_versions, but the draft workspace under
-- apps_root()/{slug}/ lived only on disk — a volume wipe or box move lost
-- unpublished work. The gateway upserts eligible workspace files here on every
-- file write / publish / explicit sync, and lazily rehydrates a missing
-- workspace from these rows on the next read
-- (apps/services/gateway/gateway/routes/apps/durability.py, RFC §4.9).
--
--   app_files   one row per (app, relative path): full text content + sha256
--               (the sha lets the sync skip unchanged files). Rows for paths
--               deleted on disk are removed on the next full sync.
--
-- Idempotent. Depends on: 113_custom_apps.sql (apps).
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_files (
    app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    path TEXT NOT NULL,                     -- workspace-relative, '/'-separated
    content TEXT NOT NULL,                  -- UTF-8 text (binaries are skipped)
    sha256 TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (app_id, path)
);

-- "What changed recently in this app's draft" — the Workshop's saved-state
-- indicator and future checkpoint UIs read newest-first per app.
CREATE INDEX IF NOT EXISTS idx_app_files_app_updated
    ON app_files(app_id, updated_at DESC);
