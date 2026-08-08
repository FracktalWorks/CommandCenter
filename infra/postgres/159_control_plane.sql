-- ============================================================================
-- 159_control_plane.sql — MT-1a: the tenant catalog
-- ============================================================================
-- Spec: ai-company-brain/specs/saas_multitenancy.md §1.5 / §0.9.5 / MT-1a ·
-- shapes in saas_multitenancy_implementation.md §3 · board WS-29 · D15.
--
-- Three things a pooled deployment needs that a single-tenant one never did:
--
--   tenant_placement   WHERE a tenant's data lives. Day one every row resolves
--                      to the same target — the INDIRECTION is the point, not
--                      the values. It is what turns "move this customer to
--                      their own database" (§1.6) into a data move rather than
--                      an architecture change, and it is the one mechanism that
--                      answers all three of: the silo tier (§1.5), the
--                      competitor objection (§1.8a) and version pinning (§1.4b).
--
--   user_identity      One row per HUMAN, globally. Today `app_user` conflates
--                      "who is this person" with "what may they do in this
--                      org", which is correct for one org and wrong for two:
--                      your own support staff need membership in more than one
--                      tenant on day two, and partners on day thirty (§1.5).
--
--   org_membership     The tenant-scoped half of that split.
--
-- ⚠️ ADDITIVE AND INERT. `app_user` is UNTOUCHED and remains the authoritative
-- identity table. Nothing reads these tables yet. Cutting the auth path over is
-- MT-1a-2 and is deliberately NOT bundled here: `acb_auth/access.py` carries
-- two `ON CONFLICT (email)` upserts (`:205`, `:509`) on the live sign-in path,
-- and a half-migrated identity is worse than an unmigrated one.
--
-- ⚠️ NOT VERIFIED AGAINST A LIVE DATABASE — no Docker daemon was available when
-- this was written. Run it against a scratch Postgres before deploying;
-- `apply_migrations.sh` fails the deploy on error.
--
-- Idempotent. Depends on: 130_org_access_control.sql (organization).
-- ============================================================================

-- ── Placement: which data plane serves this tenant ──────────────────────────

CREATE TABLE IF NOT EXISTS tenant_placement (
    organization_id UUID PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
    -- pool   — shared Postgres, RLS-isolated (the standard tier, ~95% of customers)
    -- bridge — own database or schema, shared app fleet (compliance-sensitive)
    -- silo   — own everything (enterprise, regulated, data residency)
    tier            TEXT NOT NULL DEFAULT 'pool'
                        CHECK (tier IN ('pool', 'bridge', 'silo')),
    -- A connection ALIAS the app resolves, never a raw URL with a password in
    -- it. A credential in this column would be a credential in every backup.
    target          TEXT NOT NULL DEFAULT 'primary',
    region          TEXT NOT NULL DEFAULT 'ap-south-1',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenant_placement IS
    'MT-1a: which data plane serves each tenant. Day one every row is '
    '(pool, primary) — the indirection is what makes a later move a data move.';

-- Every existing organization is placed. A tenant with no placement row is
-- unresolvable, so this must never be allowed to drift.
INSERT INTO tenant_placement (organization_id, tier, target)
SELECT id, 'pool', 'primary' FROM organization
ON CONFLICT (organization_id) DO NOTHING;

-- ── Identity: one row per human, across all tenants ─────────────────────────

CREATE TABLE IF NOT EXISTS user_identity (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Globally unique, and case-insensitively so: an IdP that changes UPN
    -- casing between sessions must not mint a second human
    -- (user_management_contract.md R10, learned by breaking it).
    email         TEXT NOT NULL,
    display_name  TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_identity_email_key
    ON user_identity (lower(email));

-- ── Membership: the tenant-scoped half ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS org_membership (
    organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES user_identity(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
    invited_by      TEXT,
    invited_at      TIMESTAMPTZ,
    joined_at       TIMESTAMPTZ,
    last_active_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- organization_id FIRST — a distribution key, not a filter column (§1.8a).
    -- Retrofitting key order after data exists means rewriting every FK.
    PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS org_membership_user_idx
    ON org_membership (user_id);

COMMENT ON TABLE org_membership IS
    'MT-1a: a human''s membership in ONE tenant. Splitting this out of app_user '
    'is what lets one person belong to two organizations — support staff need '
    'it on day two, partners on day thirty.';

-- ── Seed from app_user, WITHOUT changing app_user ───────────────────────────
-- Mirrors today's members so the tables are populated and inspectable from the
-- moment they exist. app_user remains authoritative until MT-1a-2 cuts the auth
-- path over; this is a shadow copy, not a replacement.

-- NOTE: the column is `display_name` (09_app_user.sql:16), not `name`. Verified
-- against schema.generated.sql:1579 — an earlier draft of this migration used
-- `u.name` and would have failed on apply.
INSERT INTO user_identity (email, display_name)
SELECT DISTINCT ON (lower(u.email)) u.email, COALESCE(u.display_name, '')
  FROM app_user u
 WHERE u.email IS NOT NULL AND u.email <> ''
 ORDER BY lower(u.email), u.created_at ASC
ON CONFLICT DO NOTHING;

INSERT INTO org_membership (organization_id, user_id, status, joined_at, last_active_at)
SELECT u.organization_id,
       i.id,
       COALESCE(u.status, 'active'),
       COALESCE(u.joined_at, u.created_at),
       u.last_active_at
  FROM app_user u
  JOIN user_identity i ON lower(i.email) = lower(u.email)
 WHERE u.organization_id IS NOT NULL
ON CONFLICT (organization_id, user_id) DO NOTHING;
