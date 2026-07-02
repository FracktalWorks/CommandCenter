-- 49_gtd_people.sql — the org-knowledge layer for the Task Manager (spec §6.1).
--
-- What: gtd_people — the company's people with roles, departments, skills
--       (org chart + resume-extracted), capacity/load hours, and the person's
--       ClickUp user id (the real assignment target for delegation).
-- Why:  capability-aware processing of the GTD inbox: the assistant proposes
--       WHO should own a task by matching it to skills and availability, not
--       just by a name appearing in the text. Data ported from the
--       agent-project-manager repo (agent-data/hr_structure.json +
--       resume_profiles.json) via scripts/import_hr_people.py — that repo /
--       the HR system stays the source of truth; this table is a synced cache.
-- Sensitivity: HR-adjacent (roles, skills, capacity). Served only through the
--       authenticated gateway; personal phone numbers are deliberately NOT
--       imported.
-- Depends on: nothing (standalone; joined by name/email/clickup_user_id).
-- Idempotent: IF NOT EXISTS everywhere — apply_migrations.sh re-runs 02+ on
--       every deploy.

CREATE TABLE IF NOT EXISTS gtd_people (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT,                          -- may be absent in the org chart
    role TEXT,
    department TEXT,
    team TEXT,
    reports_to TEXT,                     -- the department head (org chart)
    status TEXT DEFAULT 'active',        -- 'active' | 'inactive' | …
    skills TEXT[] DEFAULT '{}',          -- union: org-chart skills + resume-extracted skills
    resume_summary TEXT,                 -- experience summary from the resume profile
    years_experience INT,
    domain TEXT,                         -- resume-inferred domain
    capacity_hours_per_week INT,
    current_load_hours_per_week INT,
    available_hours_per_week INT,
    clickup_user_id TEXT,                -- provider assignment target
    source TEXT DEFAULT 'agent-project-manager',
    synced_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(name)                         -- names are unique in the org chart; the import upserts on this
);
CREATE INDEX IF NOT EXISTS idx_gtd_people_status ON gtd_people(status);
CREATE INDEX IF NOT EXISTS idx_gtd_people_skills ON gtd_people USING GIN(skills);
