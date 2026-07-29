-- ============================================================================
-- 128_org_access_control.sql — Organization membership, roles, permissions
-- ============================================================================
-- Phase 1 of ai-company-brain/specs/org_access_control.md. Turns the
-- single-tenant deployment into a real multi-user organization:
--
--   organization              the tenant boundary (one row today; the column is
--                             carried everywhere so a second org is data, not a
--                             migration)
--   app_user + org columns    membership lifecycle on the EXISTING user table —
--                             deliberately not a rename to `user_account`,
--                             because every user-scoped table in the schema keys
--                             by email (app_grants.subject, app_tool_grants
--                             .user_email, apps.owner_email, app_audit
--                             .user_email), so re-keying to UUID would be a
--                             large migration that buys nothing in Phase 1
--   org_role                  a named permission bundle (5 seeded system roles)
--   org_role_permission       the bundle's contents
--   user_role                 assignment; a member may hold several (union)
--   user_permission_override  per-user allow/deny ON TOP of roles — this is what
--                             makes "member, but no WhatsApp and no app creator,
--                             plus these two agents" expressible without cloning
--                             a role per person. Deny wins (AWS IAM rule).
--   feature_catalog           the nav-pane registry the admin UI renders from,
--                             so adding a pane is a seeded row, not a code
--                             change in the gateway AND the frontend
--
-- Back-compat: app_user.role is KEPT and still honoured. This migration
-- backfills executive→admin and employee→member so no one's access changes on
-- deploy. See spec §7.
--
-- Idempotent. Depends on: 09_app_user.sql.
-- ============================================================================

-- ── Organization ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organization (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            TEXT UNIQUE NOT NULL,
    display_name    TEXT NOT NULL,
    domain          TEXT,
    settings        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The single default organization. Display name/domain are editable from the
-- admin UI; the slug is the stable handle the resolver looks up.
INSERT INTO organization (slug, display_name, domain)
VALUES ('default', 'Fracktal Works', 'fracktal.in')
ON CONFLICT (slug) DO NOTHING;

-- ── Membership lifecycle on app_user ────────────────────────────────────────

ALTER TABLE app_user
    ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS invited_by     TEXT,
    ADD COLUMN IF NOT EXISTS invited_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS joined_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'app_user_status_check'
    ) THEN
        ALTER TABLE app_user ADD CONSTRAINT app_user_status_check
            CHECK (status IN ('invited', 'active', 'suspended', 'removed'));
    END IF;
END $$;

-- Existing users join the default org as active members.
UPDATE app_user
   SET organization_id = (SELECT id FROM organization WHERE slug = 'default'),
       joined_at       = COALESCE(joined_at, created_at)
 WHERE organization_id IS NULL;

CREATE INDEX IF NOT EXISTS app_user_org_status_idx
    ON app_user (organization_id, status);

-- ── Roles ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS org_role (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    slug            TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    -- System roles are seeded here and are neither editable nor deletable from
    -- the admin UI: they are the floor the bootstrap path depends on.
    is_system       BOOLEAN NOT NULL DEFAULT false,
    -- Lower rank = more privileged. Used for display ordering and to stop an
    -- admin from assigning a role above their own.
    rank            INT NOT NULL DEFAULT 100,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS org_role_permission (
    role_id         UUID NOT NULL REFERENCES org_role(id) ON DELETE CASCADE,
    permission      TEXT NOT NULL,
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS user_role (
    user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    role_id         UUID NOT NULL REFERENCES org_role(id) ON DELETE CASCADE,
    assigned_by     TEXT,
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS user_role_role_idx ON user_role (role_id);

-- ── Per-user overrides (deny wins) ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_permission_override (
    user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    permission      TEXT NOT NULL,
    effect          TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
    -- Why this exists. An access model nobody can explain gets switched off.
    reason          TEXT NOT NULL DEFAULT '',
    set_by          TEXT,
    set_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, permission)
);

-- ── Feature catalog ─────────────────────────────────────────────────────────
-- Mirrors workbench/control_plane/src/lib/nav.ts. The admin UI renders its
-- feature checklist from here so the gateway never imports frontend nav config.

CREATE TABLE IF NOT EXISTS feature_catalog (
    slug            TEXT PRIMARY KEY,
    label           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    nav_href        TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT 'apps'
                        CHECK (category IN ('apps', 'configure', 'build')),
    sort_order      INT NOT NULL DEFAULT 100,
    -- Whether a brand-new `member` gets this by default. Kept in sync with the
    -- seeded `member` role below.
    is_default      BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO feature_catalog (slug, label, description, nav_href, category, sort_order, is_default) VALUES
    ('chat',          'Chat',          'AI conversations · sessions · memory',        '/chat',             'apps',      10, true),
    ('email',         'Email',         'AI-powered inbox',                            '/email',            'apps',      20, true),
    ('whatsapp',      'WhatsApp',      'AI-powered WhatsApp inbox',                   '/whatsapp',         'apps',      30, false),
    ('memory',        'Memories',      'Facts · episodic · knowledge graph',          '/memory',           'apps',      40, true),
    ('tasks',         'Tasks',         'AI task manager',                             '/tasks',            'apps',      50, true),
    ('notes',         'Notes',         'AI note taker',                               '/notes',            'apps',      60, true),
    ('dashboard',     'Dashboard',     'Company overview',                            '/dashboard',        'apps',      70, true),
    ('observability', 'Live Activity', 'Agent & model activations in real time',      '/observability',    'apps',      80, false),
    ('artifacts',     'Artifacts',     'All agent files · inputs · outputs · data',   '/artifacts',        'apps',      90, true),
    ('models',        'Models',        'LLMs · tiers · providers',                    '/settings/models',  'configure', 10, false),
    ('agents',        'Agents',        'Register · manage · commits · remove',        '/agents',           'configure', 20, false),
    ('approvals',     'Approvals',     'Action Broker · outward writes awaiting review', '/approvals',     'configure', 30, false),
    ('integrations',  'Integrations',  'APIs · MCP servers · plugins',                '/integrations',     'configure', 40, false),
    ('build.agents',  'Agent Workbench', 'MAF agents & skills',                       '/build/agents',     'build',     10, false),
    ('build.apps',    'Custom Apps',   'User-created applications',                   '/build/apps',       'build',     20, false)
ON CONFLICT (slug) DO UPDATE
    SET label       = EXCLUDED.label,
        description = EXCLUDED.description,
        nav_href    = EXCLUDED.nav_href,
        category    = EXCLUDED.category,
        sort_order  = EXCLUDED.sort_order;
        -- is_default is intentionally NOT overwritten: an admin may have
        -- retuned the default set and a redeploy must not stomp that.

-- ── Seed the system roles ───────────────────────────────────────────────────

DO $$
DECLARE
    org_id UUID;
    rid    UUID;
BEGIN
    SELECT id INTO org_id FROM organization WHERE slug = 'default';

    -- owner ------------------------------------------------------------------
    INSERT INTO org_role (organization_id, slug, display_name, description, is_system, rank)
    VALUES (org_id, 'owner', 'Owner',
            'Full control of the organization, including roles and billing.', true, 0)
    ON CONFLICT (organization_id, slug) DO NOTHING;
    SELECT id INTO rid FROM org_role WHERE organization_id = org_id AND slug = 'owner';
    INSERT INTO org_role_permission (role_id, permission)
    VALUES (rid, '*')
    ON CONFLICT DO NOTHING;

    -- admin ------------------------------------------------------------------
    INSERT INTO org_role (organization_id, slug, display_name, description, is_system, rank)
    VALUES (org_id, 'admin', 'Admin',
            'Runs the platform: members, agents, integrations, and settings.', true, 10)
    ON CONFLICT (organization_id, slug) DO NOTHING;
    SELECT id INTO rid FROM org_role WHERE organization_id = org_id AND slug = 'admin';
    INSERT INTO org_role_permission (role_id, permission)
    SELECT rid, p FROM unnest(ARRAY[
        'admin:members:read', 'admin:members:invite', 'admin:members:manage',
        'admin:roles:manage', 'admin:access:manage', 'admin:settings:manage',
        'admin:audit:read',
        'feature:*', 'agents:run:*', 'agents:manage',
        'apps:use:*', 'apps:create', 'apps:publish',
        'integrations:manage', 'data:org:read'
    ]) AS p
    ON CONFLICT DO NOTHING;

    -- manager ----------------------------------------------------------------
    INSERT INTO org_role (organization_id, slug, display_name, description, is_system, rank)
    VALUES (org_id, 'manager', 'Manager',
            'Org-wide visibility across the apps; cannot change platform config.', true, 20)
    ON CONFLICT (organization_id, slug) DO NOTHING;
    SELECT id INTO rid FROM org_role WHERE organization_id = org_id AND slug = 'manager';
    INSERT INTO org_role_permission (role_id, permission)
    SELECT rid, p FROM unnest(ARRAY[
        'feature:chat', 'feature:email', 'feature:whatsapp', 'feature:tasks',
        'feature:notes', 'feature:memory', 'feature:dashboard',
        'feature:observability', 'feature:artifacts', 'feature:approvals',
        'agents:run:*', 'apps:use:*', 'apps:create',
        'data:org:read', 'admin:members:read'
    ]) AS p
    ON CONFLICT DO NOTHING;

    -- member (the default for a new employee) ---------------------------------
    -- Deliberately omits WhatsApp, Approvals, Integrations, Models and both
    -- Build panes: access is added, not taken away.
    INSERT INTO org_role (organization_id, slug, display_name, description, is_system, rank)
    VALUES (org_id, 'member', 'Member',
            'Day-to-day access to the core apps and shared agents.', true, 30)
    ON CONFLICT (organization_id, slug) DO NOTHING;
    SELECT id INTO rid FROM org_role WHERE organization_id = org_id AND slug = 'member';
    INSERT INTO org_role_permission (role_id, permission)
    SELECT rid, p FROM unnest(ARRAY[
        'feature:chat', 'feature:email', 'feature:tasks', 'feature:notes',
        'feature:memory', 'feature:dashboard', 'feature:artifacts',
        'agents:run:*', 'apps:use:*'
    ]) AS p
    ON CONFLICT DO NOTHING;

    -- guest ------------------------------------------------------------------
    INSERT INTO org_role (organization_id, slug, display_name, description, is_system, rank)
    VALUES (org_id, 'guest', 'Guest',
            'External collaborator: chat and explicitly shared apps only.', true, 40)
    ON CONFLICT (organization_id, slug) DO NOTHING;
    SELECT id INTO rid FROM org_role WHERE organization_id = org_id AND slug = 'guest';
    INSERT INTO org_role_permission (role_id, permission)
    SELECT rid, p FROM unnest(ARRAY['feature:chat', 'apps:use:*']) AS p
    ON CONFLICT DO NOTHING;

    -- agent_service (service-to-service; never assigned to a person) ----------
    INSERT INTO org_role (organization_id, slug, display_name, description, is_system, rank)
    VALUES (org_id, 'agent_service', 'Agent Service',
            'Internal service-to-service principal. Not assignable to people.', true, 90)
    ON CONFLICT (organization_id, slug) DO NOTHING;
    SELECT id INTO rid FROM org_role WHERE organization_id = org_id AND slug = 'agent_service';
    INSERT INTO org_role_permission (role_id, permission)
    SELECT rid, p FROM unnest(ARRAY['agents:run:*', 'data:org:read']) AS p
    ON CONFLICT DO NOTHING;
END $$;

-- ── Backfill role assignments from the legacy app_user.role column ──────────
-- executive → admin, employee → member. Runs only for users who have no
-- assignment yet, so an admin's later changes are never re-stomped by a
-- redeploy of this idempotent migration.

INSERT INTO user_role (user_id, role_id, assigned_by)
SELECT u.id, r.id, 'migration:128'
  FROM app_user u
  JOIN org_role r
    ON r.organization_id = u.organization_id
   AND r.slug = CASE WHEN u.role = 'executive' THEN 'admin' ELSE 'member' END
 WHERE NOT EXISTS (SELECT 1 FROM user_role ur WHERE ur.user_id = u.id)
ON CONFLICT DO NOTHING;

-- ── Ownership bootstrap ─────────────────────────────────────────────────────
-- A deployment with no owner is one where nobody can grant access back. If the
-- backfill left the org ownerless, promote the oldest admin (else the oldest
-- member) so there is always exactly one way back in.

DO $$
DECLARE
    org_id     UUID;
    owner_rid  UUID;
    candidate  UUID;
BEGIN
    SELECT id INTO org_id FROM organization WHERE slug = 'default';
    SELECT id INTO owner_rid FROM org_role
     WHERE organization_id = org_id AND slug = 'owner';

    IF NOT EXISTS (SELECT 1 FROM user_role WHERE role_id = owner_rid) THEN
        SELECT u.id INTO candidate
          FROM app_user u
          LEFT JOIN user_role ur ON ur.user_id = u.id
          LEFT JOIN org_role r   ON r.id = ur.role_id
         WHERE u.organization_id = org_id
           AND u.status = 'active'
         ORDER BY (r.slug = 'admin') DESC NULLS LAST, u.created_at ASC
         LIMIT 1;

        IF candidate IS NOT NULL THEN
            INSERT INTO user_role (user_id, role_id, assigned_by)
            VALUES (candidate, owner_rid, 'migration:128')
            ON CONFLICT DO NOTHING;
        END IF;
    END IF;
END $$;
