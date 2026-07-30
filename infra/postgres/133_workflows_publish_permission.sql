-- ============================================================================
-- 133_workflows_publish_permission.sql — who may make a workflow LIVE
-- ============================================================================
-- Resolves spec question Q3 of ai-company-brain/specs/workflows_app.md: "any
-- `workflows`-granted member may draft; publish requires `workflows:publish`
-- (default: executives)".
--
--   workflows:publish   publish a version, roll back to an earlier one, or
--                       disable a workflow — i.e. every act that changes what
--                       runs UNATTENDED against production systems.
--
-- Why this one act is gated while drafting is not: `feature:workflows` lets a
-- member build and TEST a draft, which is bounded — a draft run's writes are
-- still held by the Action Broker, and no trigger fires for it. Publishing is
-- the step that arms webhooks, cron ticks, and event bindings to run without a
-- human present, so it is the natural authority boundary. Rollback and disable
-- ride the same permission because they change the live version just as surely
-- as publish does (and a rollback republishes an old version verbatim).
--
-- Purely ADDITIVE, and NOT retroactive-safe by accident: before this migration
-- anyone with the workflows feature could publish. Granting owner/admin/manager
-- keeps the people who realistically hold that responsibility working, while
-- `member` and `guest` drop to draft-and-test. That narrowing is the point of
-- the change; admins can hand the permission back per-user with an override.
--
-- Idempotent. Depends on: 130_org_access_control.sql, 132_workflows.sql.
-- ============================================================================

DO $$
DECLARE
    org_id UUID;
    rid    UUID;
BEGIN
    SELECT id INTO org_id FROM organization WHERE slug = 'default';
    IF org_id IS NULL THEN
        RAISE NOTICE '133: no default organization — run migration 130 first';
        RETURN;
    END IF;

    -- owner already holds '*'; nothing to add.

    -- admin + manager: the executives of spec Q3. An admin runs the platform;
    -- a manager owns the business processes these workflows automate.
    SELECT id INTO rid FROM org_role
     WHERE organization_id = org_id AND slug = 'admin';
    IF rid IS NOT NULL THEN
        INSERT INTO org_role_permission (role_id, permission)
        VALUES (rid, 'workflows:publish')
        ON CONFLICT DO NOTHING;
    END IF;

    SELECT id INTO rid FROM org_role
     WHERE organization_id = org_id AND slug = 'manager';
    IF rid IS NOT NULL THEN
        INSERT INTO org_role_permission (role_id, permission)
        VALUES (rid, 'workflows:publish')
        ON CONFLICT DO NOTHING;
    END IF;

    -- member/guest: draft and test freely, but do not arm automations.

    -- agent_service resolves to '*' in acb_auth.access.SERVICE_ACCESS; the row
    -- is kept consistent for anyone reading the table directly.
    SELECT id INTO rid FROM org_role
     WHERE organization_id = org_id AND slug = 'agent_service';
    IF rid IS NOT NULL THEN
        INSERT INTO org_role_permission (role_id, permission)
        VALUES (rid, 'workflows:publish')
        ON CONFLICT DO NOTHING;
    END IF;
END $$;
