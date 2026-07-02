#!/usr/bin/env python3
"""Import the company org chart + resume capabilities into gtd_people.

Reads the seed snapshot (infra/seed/hr/) — a copy of agent-project-manager's
agent-data/hr_structure.json + resume_profiles.json — merges each person's
org-chart skills with their resume-extracted skills, and upserts one
gtd_people row per person (keyed by unique name). Idempotent: re-run any time
the snapshot is refreshed.

Usage:
    .venv/bin/python scripts/import_hr_people.py [--seed-dir infra/seed/hr]
Env:
    DATABASE_URL (default: the acb-postgres compose default)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

UPSERT = """
INSERT INTO gtd_people
    (name, email, role, department, team, reports_to, status, skills,
     resume_summary, years_experience, domain,
     capacity_hours_per_week, current_load_hours_per_week,
     available_hours_per_week, clickup_user_id, synced_at, updated_at)
VALUES
    (:name, :email, :role, :department, :team, :reports_to, :status, :skills,
     :resume_summary, :years_experience, :domain,
     :capacity, :load, :available, :clickup_user_id, now(), now())
ON CONFLICT (name) DO UPDATE SET
    email = COALESCE(EXCLUDED.email, gtd_people.email),
    role = EXCLUDED.role,
    department = EXCLUDED.department,
    team = EXCLUDED.team,
    reports_to = EXCLUDED.reports_to,
    status = EXCLUDED.status,
    skills = EXCLUDED.skills,
    resume_summary = COALESCE(EXCLUDED.resume_summary, gtd_people.resume_summary),
    years_experience = COALESCE(EXCLUDED.years_experience, gtd_people.years_experience),
    domain = COALESCE(EXCLUDED.domain, gtd_people.domain),
    capacity_hours_per_week = EXCLUDED.capacity_hours_per_week,
    current_load_hours_per_week = EXCLUDED.current_load_hours_per_week,
    available_hours_per_week = EXCLUDED.available_hours_per_week,
    clickup_user_id = COALESCE(EXCLUDED.clickup_user_id, gtd_people.clickup_user_id),
    synced_at = now(), updated_at = now()
"""


def build_rows(hr: dict, resumes: dict) -> list[dict]:
    """Flatten the org chart and merge resume skills (public + testable)."""
    # Resume profiles are keyed by person name (see agent-data/INDEX.md);
    # index by lowercase name AND email for tolerant matching.
    by_name: dict[str, dict] = {}
    by_email: dict[str, dict] = {}
    for p in resumes.get("profiles", []) or []:
        if p.get("name"):
            by_name[p["name"].strip().lower()] = p
        if p.get("email"):
            by_email[p["email"].strip().lower()] = p

    rows: list[dict] = []
    for dept in hr.get("departments", []) or []:
        head = dept.get("head")
        for team in dept.get("teams", []) or []:
            for m in team.get("members", []) or []:
                name = (m.get("name") or "").strip()
                if not name:
                    continue
                prof = (
                    by_name.get(name.lower())
                    or by_email.get((m.get("email") or "").strip().lower())
                    or {}
                )
                # Merge skills: org chart first, then resume extras (deduped,
                # case-insensitively, order-preserving).
                skills: list[str] = []
                for s in (m.get("skills") or []) + (prof.get("skills") or []):
                    s = (s or "").strip()
                    if s and s.lower() not in (x.lower() for x in skills):
                        skills.append(s)
                rows.append({
                    "name": name,
                    "email": m.get("email") or prof.get("email"),
                    "role": m.get("role"),
                    "department": dept.get("name"),
                    "team": team.get("name"),
                    # the department head reports to no one within their dept
                    "reports_to": head if head and head != name else None,
                    "status": m.get("status") or "active",
                    "skills": skills,
                    "resume_summary": (prof.get("experience_summary") or None),
                    "years_experience": prof.get("years_experience"),
                    "domain": (
                        prof.get("domain")
                        if prof.get("domain") not in (None, "", "Unknown")
                        else None
                    ),
                    "capacity": m.get("capacity_hours_per_week"),
                    "load": m.get("current_load_hours_per_week"),
                    "available": m.get("available_hours_per_week"),
                    "clickup_user_id": (
                        str(m["clickup_user_id"])
                        if m.get("clickup_user_id") is not None else None
                    ),
                })
    return rows


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed-dir", default=str(REPO_ROOT / "infra" / "seed" / "hr"))
    args = ap.parse_args()
    seed = Path(args.seed_dir)

    hr = json.loads((seed / "hr_structure.json").read_text())
    resumes_file = seed / "resume_profiles.json"
    resumes = json.loads(resumes_file.read_text()) if resumes_file.exists() else {}
    rows = build_rows(hr, resumes)
    print(f"{len(rows)} people in {hr.get('company', 'the org chart')}")

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    db_url = os.environ.get(
        "DATABASE_URL", "postgresql://acb:acb@localhost:5432/acb"
    )
    if "+asyncpg" not in db_url:
        db_url = db_url.replace("postgresql://", "postgresql+asyncpg://")
    engine = create_async_engine(db_url)
    async with engine.begin() as conn:
        for r in rows:
            await conn.execute(text(UPSERT), r)
        count = (await conn.execute(
            text("SELECT count(*) FROM gtd_people"))).scalar()
    await engine.dispose()
    print(f"upserted {len(rows)} → gtd_people now has {count} rows")


if __name__ == "__main__":
    asyncio.run(main())
