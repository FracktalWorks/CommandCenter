-- 141_seed_center_groups.sql — the six departmental groups (Centers Phase B)
--
-- Spec: project-docs/specs/department_centers.md §1 + §3 Phase B;
--       groups_sessions_authority.md §1 (org_group is the primitive).
--
-- Group slug = center slug, 1:1 — the naming rule in department_centers.md §1:
-- the `center.<slug>` features (140_center_features.sql) pair with org_group
-- rows of the same slug, so granting a department is one feature row plus one
-- membership row, with zero mapping tables. Seeding the groups makes each one
-- a real membership target in the groups admin UI from day one.
--
-- Seed-only and idempotent: no existing table is altered, and re-running moves
-- nothing. Deliberately ON CONFLICT DO NOTHING (not DO UPDATE, unlike 140):
-- display_name and description are admin-editable in the groups UI, and a
-- redeploy must never clobber an admin's edits.

INSERT INTO org_group (organization_id, slug, display_name, description, created_by)
SELECT o.id, g.slug, g.display_name, g.description, 'system:migration'
  FROM organization o
 CROSS JOIN (VALUES
     ('sales',      'Sales',      'Pipeline, quotations, and follow-ups for the sales team'),
     ('marketing',  'Marketing',  'Campaigns, content, and the public face of the company'),
     ('finance',    'Finance',    'Receivables, payments, and the numbers that run the company'),
     ('operations', 'Operations', 'Production, inventory, dispatch, and service for the machines'),
     ('people',     'People',     'The team itself — directory, onboarding, leave, and hiring'),
     ('company',    'Company',    'The whole company — the group behind the Company Center')
 ) AS g(slug, display_name, description)
 WHERE o.slug = 'default'
ON CONFLICT (organization_id, slug) DO NOTHING;
