-- 74_gtd_people_editable_and_resumes.sql — make the HR/people layer EDITABLE
-- in-app + store uploaded résumés (spec: task_manager_hr_planning_and_memory.md §3-4).
--
-- What: (1) extra editable columns on gtd_people so the Task Manager app — not
--       just the agent-project-manager seed — can own roles/skills/manager;
--       (2) gtd_person_resumes to hold uploaded CVs (PDF/DOCX) + their parsed
--       skills, linked to a person.
-- Why:  Phase 1 of the HR epic — "update HR structure, edit skills, ingest
--       résumés to auto-update skills". The app becomes the source of truth for
--       people data (user decision 2026-07-16); gtd_people.source distinguishes
--       provenance ('agent-project-manager' seed | 'manual' | 'clickup' | 'resume').
-- Depends on: 49_gtd_people.sql.
-- Idempotent: IF NOT EXISTS everywhere — apply_migrations.sh re-runs 02+ on deploy.

-- ── Editable / structured HR fields ──────────────────────────────────────────
ALTER TABLE gtd_people ADD COLUMN IF NOT EXISTS title TEXT;
-- Structured hierarchy: the free-text reports_to (org-chart display name) stays;
-- manager_id is the resolvable FK the UI edits. Backfilled name→id separately.
ALTER TABLE gtd_people ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES gtd_people(id);
-- Per-skill provenance: {"python": "resume", "leadership": "manual", ...} so the
-- UI can show where a skill came from and a re-import won't clobber manual edits.
ALTER TABLE gtd_people ADD COLUMN IF NOT EXISTS skills_source JSONB DEFAULT '{}'::jsonb;
-- Audit: who last edited this row (user email) — the app is now authoritative.
ALTER TABLE gtd_people ADD COLUMN IF NOT EXISTS updated_by TEXT;

CREATE INDEX IF NOT EXISTS idx_gtd_people_manager ON gtd_people(manager_id);

-- ── Uploaded résumés (one person may have several versions) ───────────────────
CREATE TABLE IF NOT EXISTS gtd_person_resumes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES gtd_people(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime TEXT,
    size_bytes INT,
    storage_path TEXT,          -- file on disk (GTD_ATTACHMENTS_DIR), owner-checked on serve
    parsed_text TEXT,           -- extracted plain text (for re-parse / audit)
    extracted JSONB,            -- {skills[], experience_summary, years_experience, domain}
    uploaded_by TEXT,           -- user email
    uploaded_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gtd_person_resumes_person
    ON gtd_person_resumes(person_id);
