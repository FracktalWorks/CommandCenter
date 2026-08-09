-- ============================================================================
-- 131_integration_memory_permissions.sql — per-user integration + org memory
-- ============================================================================
-- Phase 3 (partial) of project-docs/specs/org_access_control.md: extends
-- the seeded roles with two permission families that migration 130 did not
-- have vocabulary for.
--
--   integrations:use:*        which third-party services an agent run may
--                             receive credentials for ON THIS MEMBER'S BEHALF.
--                             Distinct from `integrations:manage`, which is the
--                             right to add/rotate the credentials themselves.
--   memory:read_org           read organisation-wide memory.
--   memory:write_org          WRITE organisation-wide memory. Personal and
--                             agent-scoped memory stay ungated — they are
--                             already keyed to the acting user / running agent,
--                             so there is nothing to authorise. Org memory is
--                             the shared one, which is why writing to it is the
--                             act that needs a permission.
--
-- Purely ADDITIVE. Existing grants are untouched and the INSERTs are
-- ON CONFLICT DO NOTHING, so an admin who has already tuned a role is not
-- re-stomped by a redeploy. Nobody loses access when this applies: before it,
-- every agent run received every configured credential regardless of caller,
-- so granting the seeded roles `integrations:use:*` preserves exactly the
-- behaviour that was already in effect. The restriction only takes hold once
-- an admin sets a per-user deny.
--
-- Idempotent. Depends on: 130_org_access_control.sql.
-- ============================================================================

DO $$
DECLARE
    org_id UUID;
    rid    UUID;
BEGIN
    SELECT id INTO org_id FROM organization WHERE slug = 'default';
    IF org_id IS NULL THEN
        RAISE NOTICE '131: no default organization — run migration 130 first';
        RETURN;
    END IF;

    -- owner already holds '*'; nothing to add.

    -- admin: full use + management of integrations, full org memory.
    SELECT id INTO rid FROM org_role
     WHERE organization_id = org_id AND slug = 'admin';
    IF rid IS NOT NULL THEN
        INSERT INTO org_role_permission (role_id, permission)
        SELECT rid, p FROM unnest(ARRAY[
            'integrations:use:*', 'memory:read_org', 'memory:write_org'
        ]) AS p
        ON CONFLICT DO NOTHING;
    END IF;

    -- manager: uses integrations and can contribute org memory, but does not
    -- manage credentials (that stays `integrations:manage`, admin-only).
    SELECT id INTO rid FROM org_role
     WHERE organization_id = org_id AND slug = 'manager';
    IF rid IS NOT NULL THEN
        INSERT INTO org_role_permission (role_id, permission)
        SELECT rid, p FROM unnest(ARRAY[
            'integrations:use:*', 'memory:read_org', 'memory:write_org'
        ]) AS p
        ON CONFLICT DO NOTHING;
    END IF;

    -- member: uses integrations (their agents need them) and reads org memory,
    -- but does NOT write it. A shared, org-wide fact that every employee's
    -- agent can silently append to is how org memory fills with noise.
    SELECT id INTO rid FROM org_role
     WHERE organization_id = org_id AND slug = 'member';
    IF rid IS NOT NULL THEN
        INSERT INTO org_role_permission (role_id, permission)
        SELECT rid, p FROM unnest(ARRAY[
            'integrations:use:*', 'memory:read_org'
        ]) AS p
        ON CONFLICT DO NOTHING;
    END IF;

    -- guest: neither. An external collaborator gets chat and shared apps.

    -- agent_service: the internal service principal already resolves to '*'
    -- in acb_auth.access.SERVICE_ACCESS, but keep the row consistent for
    -- anyone reading the table directly.
    SELECT id INTO rid FROM org_role
     WHERE organization_id = org_id AND slug = 'agent_service';
    IF rid IS NOT NULL THEN
        INSERT INTO org_role_permission (role_id, permission)
        SELECT rid, p FROM unnest(ARRAY[
            'integrations:use:*', 'memory:read_org', 'memory:write_org'
        ]) AS p
        ON CONFLICT DO NOTHING;
    END IF;
END $$;
