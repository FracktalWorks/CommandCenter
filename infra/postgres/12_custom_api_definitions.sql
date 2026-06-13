-- User-defined custom API definitions.
-- Stores the schema/metadata for APIs added via the AI discovery flow.
-- Actual credentials are stored encrypted in provider_keys
-- (credential_type='integration', service=service_id) as usual.

CREATE TABLE IF NOT EXISTS custom_api_definitions (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    service_id   TEXT UNIQUE NOT NULL,      -- e.g. "notion", "slack-custom"
    label        TEXT NOT NULL,             -- Human-readable name
    category     TEXT NOT NULL DEFAULT 'custom',
    description  TEXT NOT NULL DEFAULT '',
    setup_url    TEXT NOT NULL DEFAULT '',
    docs_url     TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    env_vars     JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_custom_api_service_id ON custom_api_definitions (service_id);
CREATE INDEX IF NOT EXISTS idx_custom_api_category   ON custom_api_definitions (category);
