-- 149_people.sql — register the People Center's directory as a feature.
--
-- What: the `feature_catalog` row for `people` (`/people`), the surface WS-28b
--       builds: directory, person page, org chart.
-- Why:  the directory has to be reachable and grantable on its own. It cannot
--       ride `feature:tasks`, which is what gates the existing
--       `/tasks/people` API, because the People Center is a different audience:
--       a manager who needs the org chart and the assignee picker should not
--       have to be given the personal GTD task manager to get them.
--       Spec: project-docs/specs/people_center_app.md §6.
--       Registration is FIVE places and this is one of them — the others are
--       `acb_auth.permissions.FEATURES`, `nav.ts`, `access.ts` and
--       `centers.ts`; a both-ways test fails if this row and FEATURES disagree.
-- Depends on: the feature_catalog table (130), 148_people_key_shape.sql.
--
-- Posture: `is_default false`, exactly like `crm` and `projects`. The directory
--       is open to HOLDERS of the feature; the HR-sensitive half of a person
--       record (skills, résumé, capacity) stays restricted by
--       `admin:members:read` — a projection WS-24 N4 already shipped and which
--       WS-28 must not re-implement.
-- Idempotent: ON CONFLICT DO UPDATE, and `is_default` is deliberately NOT
--       overwritten (the rule 130/144/146 already follow): an admin may have
--       retuned the default set and a redeploy must not stomp it.

INSERT INTO feature_catalog (slug, label, description, nav_href, category, sort_order, is_default) VALUES
    ('people', 'People', 'Directory, skills and org chart', '/people', 'apps', 57, false)
ON CONFLICT (slug) DO UPDATE
    SET label       = EXCLUDED.label,
        description = EXCLUDED.description,
        nav_href    = EXCLUDED.nav_href,
        category    = EXCLUDED.category,
        sort_order  = EXCLUDED.sort_order;
