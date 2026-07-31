-- 140_center_features.sql — feature slugs for the departmental Centers
--
-- The sidebar's Centers section (workbench/control_plane/src/lib/centers.ts)
-- gates each Center behind a `center.<slug>` feature. Seeding them here makes
-- every Center a grantable row in the admin access UI from day one: owners and
-- admins see all Centers via their `feature:*` baseline; everyone else sees a
-- Center only when a role or per-user override grants it.
--
-- None are member defaults — a Center is granted per department, which is the
-- point. When access-control Phase 2 lands, these features pair with org_group
-- rows of the same slug (sales, marketing, …, exec) for real data scoping;
-- until then they gate navigation and the /centers/<slug> landing pages.

-- 'centers' is a new feature category alongside apps/configure/build.
ALTER TABLE feature_catalog DROP CONSTRAINT IF EXISTS feature_catalog_category_check;
ALTER TABLE feature_catalog ADD CONSTRAINT feature_catalog_category_check
    CHECK (category IN ('apps', 'configure', 'build', 'centers'));

INSERT INTO feature_catalog (slug, label, description, nav_href, category, sort_order, is_default) VALUES
    ('center.sales',      'Sales Center',      'Pipeline, quotations, and follow-ups for the sales team',      '/centers/sales',      'centers', 10, false),
    ('center.marketing',  'Marketing Center',  'Campaigns, content, and the public face of the company',       '/centers/marketing',  'centers', 20, false),
    ('center.finance',    'Finance Center',    'Receivables, payments, and the numbers that run the company',  '/centers/finance',    'centers', 30, false),
    ('center.operations', 'Operations Center', 'Production, inventory, dispatch, and service for the machines','/centers/operations', 'centers', 40, false),
    ('center.people',     'People Center',     'The team itself — directory, onboarding, leave, and hiring',   '/centers/people',     'centers', 50, false),
    ('center.company',    'Company Center',    'The founder''s cockpit — every Center rolled up into one view','/centers/company',    'centers', 60, false)
ON CONFLICT (slug) DO UPDATE
    SET label       = EXCLUDED.label,
        description = EXCLUDED.description,
        nav_href    = EXCLUDED.nav_href,
        category    = EXCLUDED.category,
        sort_order  = EXCLUDED.sort_order;
