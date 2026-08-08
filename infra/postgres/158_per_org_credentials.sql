-- ============================================================================
-- 158_per_org_credentials.sql — MT-0d: credentials stop being deployment-wide
-- ============================================================================
-- Spec: ai-company-brain/specs/saas_multitenancy.md §6.3 / MT-0d · board WS-29.
--
-- `provider_keys` is `provider TEXT PRIMARY KEY` (08_provider_keys.sql:6-7) —
-- one key per provider for the whole box. `mcp_servers`, `plugins` and
-- `model_config` have no owner column at all.
--
-- `tenancy_and_visibility.md` §1.1 called that "exactly the right shape", and it
-- WAS: under D11 one deployment served one tenant, so a deployment-wide
-- credential store was correct by construction. **D15 re-took that decision**
-- (2026-08-08), and under a pooled tenant boundary the same shape means tenant
-- B's agent resolves tenant A's OpenAI key. This migration re-keys all four.
--
-- The lookup side fails CLOSED once a second organization exists: `key_store`
-- and `model_config` resolve an untenanted read to "the sole organization", and
-- there ceases to be one the moment a second is created — see
-- `acb_llm/key_store.py::_resolve_org`. That is deliberate. An untenanted read
-- that kept working after tenant #2 arrived would be the leak this migration
-- exists to prevent, arriving quietly.
--
-- Idempotent. Depends on: 08_provider_keys.sql, 11_integration_credentials.sql,
-- 13_mcp_servers.sql, 14_plugins.sql, 35_model_config.sql,
-- 130_org_access_control.sql (organization).
-- ============================================================================

-- ── Helper: the org every existing row belongs to ───────────────────────────
-- Every row on this box today is the operator's. Backfill is unconditional.

-- ── provider_keys — (organization_id, provider) ─────────────────────────────

ALTER TABLE provider_keys
    ADD COLUMN IF NOT EXISTS organization_id UUID
        REFERENCES organization(id) ON DELETE CASCADE;

UPDATE provider_keys
   SET organization_id = (SELECT id FROM organization WHERE slug = 'default')
 WHERE organization_id IS NULL;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM provider_keys WHERE organization_id IS NULL) THEN
        RAISE EXCEPTION
            'provider_keys has rows with no organization — refusing to re-key. '
            'Resolve them before re-running 158.';
    END IF;
END $$;

ALTER TABLE provider_keys ALTER COLUMN organization_id SET NOT NULL;

-- Re-point the primary key. Dropping first is safe: the column set is a strict
-- superset, so no duplicate can appear.
ALTER TABLE provider_keys DROP CONSTRAINT IF EXISTS provider_keys_pkey;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'provider_keys_org_provider_pkey'
    ) THEN
        ALTER TABLE provider_keys
            ADD CONSTRAINT provider_keys_org_provider_pkey
            PRIMARY KEY (organization_id, provider);
    END IF;
END $$;

-- org_id FIRST — a distribution key, not a filter column
-- (saas_multitenancy.md §1.8a; retrofitting index order later is expensive).
CREATE INDEX IF NOT EXISTS provider_keys_org_type_idx
    ON provider_keys (organization_id, credential_type);

-- ── model_config — (organization_id, key) ───────────────────────────────────

ALTER TABLE model_config
    ADD COLUMN IF NOT EXISTS organization_id UUID
        REFERENCES organization(id) ON DELETE CASCADE;

UPDATE model_config
   SET organization_id = (SELECT id FROM organization WHERE slug = 'default')
 WHERE organization_id IS NULL;

ALTER TABLE model_config ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE model_config DROP CONSTRAINT IF EXISTS model_config_pkey;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'model_config_org_key_pkey'
    ) THEN
        ALTER TABLE model_config
            ADD CONSTRAINT model_config_org_key_pkey
            PRIMARY KEY (organization_id, key);
    END IF;
END $$;

-- ── mcp_servers — (organization_id, name) ───────────────────────────────────

ALTER TABLE mcp_servers
    ADD COLUMN IF NOT EXISTS organization_id UUID
        REFERENCES organization(id) ON DELETE CASCADE;

UPDATE mcp_servers
   SET organization_id = (SELECT id FROM organization WHERE slug = 'default')
 WHERE organization_id IS NULL;

ALTER TABLE mcp_servers ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE mcp_servers DROP CONSTRAINT IF EXISTS mcp_servers_pkey;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'mcp_servers_org_name_pkey'
    ) THEN
        ALTER TABLE mcp_servers
            ADD CONSTRAINT mcp_servers_org_name_pkey
            PRIMARY KEY (organization_id, name);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS mcp_servers_org_enabled_idx
    ON mcp_servers (organization_id, enabled);

-- ── plugins — keeps its UUID pk; the NAME uniqueness becomes per-org ────────
-- `plugins.id` is already a surrogate UUID, so the PK is fine. What is wrong is
-- `name TEXT UNIQUE` — deployment-wide, so tenant B could not install a plugin
-- tenant A already had, and a lookup by name crosses tenants.

ALTER TABLE plugins
    ADD COLUMN IF NOT EXISTS organization_id UUID
        REFERENCES organization(id) ON DELETE CASCADE;

UPDATE plugins
   SET organization_id = (SELECT id FROM organization WHERE slug = 'default')
 WHERE organization_id IS NULL;

ALTER TABLE plugins ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE plugins DROP CONSTRAINT IF EXISTS plugins_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS plugins_org_name_key
    ON plugins (organization_id, name);
