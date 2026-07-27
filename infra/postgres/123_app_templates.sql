-- ============================================================================
-- 123_app_templates.sql — Custom Apps: templates gallery flag
-- ============================================================================
-- `is_template` — any editor can flag their own app as a starting point for
-- others (curated informally, same trust model as everything else on this
-- internal-only platform — no separate admin/moderation tier). The
-- templates gallery is just "apps where is_template AND visible to me",
-- reusing the existing GET /apps list + its can_view gate — a private app
-- flagged as a template still only shows to people who could already see it.
-- Starting a new app FROM a template reuses fork/remix (POST /{slug}/fork,
-- already shipped) — no new copy mechanism needed.
--
-- Idempotent. Depends on: 114_custom_apps.sql (apps table).
-- ============================================================================

ALTER TABLE apps ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT false;

-- The templates gallery's hot query: viewable templates, newest first —
-- mirrors idx pattern of other apps indexes, partial on is_template so it
-- stays tiny (most apps are never templates).
CREATE INDEX IF NOT EXISTS idx_apps_is_template
    ON apps(updated_at DESC) WHERE is_template;
