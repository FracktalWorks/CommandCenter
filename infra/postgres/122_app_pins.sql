-- ============================================================================
-- 122_app_pins.sql — Custom Apps: per-viewer pinned apps (App Workshop)
-- ============================================================================
-- A viewer's personal "pin this app to my sidebar" preference — deliberately
-- separate from app_grants (which is about WHO CAN ACCESS an app, an owner/
-- admin decision); a pin is the viewer's own bookmark and requires no grant
-- beyond being able to see the app already.
--
-- Idempotent. Depends on: 114_custom_apps.sql (apps table).
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_pins (
    app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_email TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (app_id, user_email)
);

-- The sidebar's hot query: this viewer's pins, most-recently-pinned first.
CREATE INDEX IF NOT EXISTS idx_app_pins_user
    ON app_pins(user_email, created_at DESC);
