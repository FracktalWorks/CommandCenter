"""Tasks · people — the org-knowledge layer (spec §6.1).

GET /tasks/people serves the company's people with roles, skills (org chart +
resume-extracted), capacity/availability, and their ClickUp user id — imported
from agent-project-manager's agent-data via scripts/import_hr_people.py.

This is what makes Clarify capability-aware: the delegation/assignee pickers
and the proposal heuristic see WHO can do WHAT and who has hours free, not
just names. Personal phone numbers are never stored or served.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException, UploadFile
from gateway.routes.tasks.attachments import _safe_name, _storage_dir
from gateway.routes.tasks.core import _get_db, _uid, router
from gateway.routes.tasks.resume_parse import parse_resume
from pydantic import BaseModel
from sqlalchemy import text

_RESUME_MAX_BYTES = 15 * 1024 * 1024  # 15 MB
_RESUME_EXT = {".pdf", ".docx", ".txt", ".md"}


class OrgPersonModel(BaseModel):
    id: str
    name: str
    email: str | None = None
    role: str | None = None
    title: str | None = None
    department: str | None = None
    team: str | None = None
    reports_to: str | None = None
    manager_id: str | None = None
    status: str = "active"
    skills: list[str] = []
    skills_source: dict[str, str] = {}
    domain: str | None = None
    # Résumé-extracted depth (from the CVs, via agent-project-manager's
    # ingest_resumes.py → import_hr_people.py). Served so delegation can weigh
    # seniority/experience, not just skill keywords.
    resume_summary: str | None = None
    years_experience: int | None = None
    capacity_hours_per_week: int | None = None
    current_load_hours_per_week: int | None = None
    available_hours_per_week: int | None = None
    provider_user_id: str | None = None   # ClickUp user id (assignment target)


def _row_to_person(row: Any) -> OrgPersonModel:
    return OrgPersonModel(
        id=str(row.id),
        name=row.name,
        email=row.email,
        role=row.role,
        title=getattr(row, "title", None),
        department=row.department,
        team=row.team,
        reports_to=row.reports_to,
        manager_id=str(row.manager_id) if getattr(row, "manager_id", None) else None,
        status=row.status or "active",
        skills=list(row.skills or []),
        skills_source=dict(getattr(row, "skills_source", None) or {}),
        domain=row.domain,
        resume_summary=row.resume_summary,
        years_experience=row.years_experience,
        capacity_hours_per_week=row.capacity_hours_per_week,
        current_load_hours_per_week=row.current_load_hours_per_week,
        available_hours_per_week=row.available_hours_per_week,
        provider_user_id=row.clickup_user_id,
    )


@router.get("/people", response_model=list[OrgPersonModel])
async def list_people(
    q: str = "",
    include_inactive: bool = False,
    _user: UserContext = Depends(get_current_user),
):
    """The org's people. `q` filters by name/role/department/skill."""
    clauses = ["true"] if include_inactive else ["status = 'active'"]
    params: dict[str, Any] = {}
    if q.strip():
        clauses.append(
            "(name ILIKE :q OR role ILIKE :q OR department ILIKE :q "
            "OR EXISTS (SELECT 1 FROM unnest(skills) s WHERE s ILIKE :q))"
        )
        params["q"] = f"%{q.strip()}%"
    db = await _get_db()
    try:
        rows = (await db.execute(
            text("SELECT * FROM gtd_people WHERE " + " AND ".join(clauses)
                 + " ORDER BY department, name"),
            params,
        )).fetchall()
        return [_row_to_person(r) for r in rows]
    finally:
        await db.close()


async def fetch_people_for_clarify(db: Any) -> list[dict[str, Any]]:
    """People dicts for the proposal heuristic: name/email/provider id +
    skills + availability + the reporting line (§5, Phase 2). Used by
    ai.clarify_item (org people first; the caller falls back to provider
    members when this is empty).

    ``manager_name`` resolves the structured ``manager_id`` FK (a self-join),
    falling back to the free-text ``reports_to`` display name — so the clarify
    LLM can prefer same-team owners or route approvals up the chain."""
    try:
        rows = (await db.execute(text(
            """SELECT p.id, p.name, p.email, p.clickup_user_id, p.skills,
                      p.available_hours_per_week, p.capacity_hours_per_week,
                      p.current_load_hours_per_week, p.role, p.title, p.domain,
                      p.years_experience, p.reports_to, p.department, p.team,
                      m.name AS manager_name
                 FROM gtd_people p
                 LEFT JOIN gtd_people m ON m.id = p.manager_id
                WHERE p.status = 'active'"""))).fetchall()
    except Exception:
        return []
    return [
        {
            "id": str(r.id),
            "name": r.name,
            "email": r.email,
            "provider_user_id": r.clickup_user_id,
            "skills": list(r.skills or []),
            "available_hours_per_week": r.available_hours_per_week,
            "capacity_hours_per_week": r.capacity_hours_per_week,
            "current_load_hours_per_week": r.current_load_hours_per_week,
            "role": r.role,
            "title": getattr(r, "title", None),
            "domain": r.domain,
            "years_experience": r.years_experience,
            "department": r.department,
            "team": r.team,
            "reports_to": (r.manager_name or r.reports_to),
        }
        for r in rows
    ]


# ── Write surface: the app is now the source of truth for HR data ─────────────
# (user decision 2026-07-16). Edits stamp source='manual'/'resume' + updated_by.


class PersonWrite(BaseModel):
    """Create/update payload. All optional on PATCH; `name` required on create."""
    name: str | None = None
    email: str | None = None
    role: str | None = None
    title: str | None = None
    department: str | None = None
    team: str | None = None
    reports_to: str | None = None
    manager_id: str | None = None
    status: str | None = None
    skills: list[str] | None = None
    domain: str | None = None
    resume_summary: str | None = None
    years_experience: int | None = None
    capacity_hours_per_week: int | None = None
    current_load_hours_per_week: int | None = None
    clickup_user_id: str | None = None


def _available(capacity: int | None, load: int | None) -> int | None:
    """Free hours = capacity - load, floored at 0. None when capacity unknown."""
    if capacity is None:
        return None
    return max(0, capacity - (load or 0))


async def _get_person_row(db: Any, person_id: str) -> Any:
    row = (await db.execute(
        text("SELECT * FROM gtd_people WHERE id = :id"), {"id": person_id}
    )).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Person not found")
    return row


@router.post("/people", response_model=OrgPersonModel, status_code=201)
async def create_person(
    body: PersonWrite,
    user: UserContext = Depends(get_current_user),
):
    """Add a person to the org (manual entry). `name` is required + unique."""
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    skills = [s.strip() for s in (body.skills or []) if s and s.strip()]
    skills_source = {s: "manual" for s in skills}
    available = _available(body.capacity_hours_per_week, body.current_load_hours_per_week)
    pid = str(uuid4())
    db = await _get_db()
    try:
        dup = (await db.execute(
            text("SELECT 1 FROM gtd_people WHERE LOWER(name) = LOWER(:n)"),
            {"n": name})).fetchone()
        if dup:
            raise HTTPException(status_code=409,
                                detail=f"A person named '{name}' already exists.")
        await db.execute(text(
            """INSERT INTO gtd_people
               (id, name, email, role, title, department, team, reports_to,
                manager_id, status, skills, skills_source, domain, resume_summary,
                years_experience, capacity_hours_per_week,
                current_load_hours_per_week, available_hours_per_week,
                clickup_user_id, source, updated_by, updated_at)
               VALUES
               (:id, :name, :email, :role, :title, :department, :team, :reports_to,
                CAST(:manager_id AS UUID), :status, :skills,
                CAST(:skills_source AS JSONB), :domain, :resume_summary,
                :years_experience, :capacity, :load, :available,
                :clickup_user_id, 'manual', :updated_by, now())"""),
            {"id": pid, "name": name, "email": body.email, "role": body.role,
             "title": body.title, "department": body.department, "team": body.team,
             "reports_to": body.reports_to, "manager_id": body.manager_id,
             "status": body.status or "active", "skills": skills,
             "skills_source": json.dumps(skills_source), "domain": body.domain,
             "resume_summary": body.resume_summary,
             "years_experience": body.years_experience,
             "capacity": body.capacity_hours_per_week,
             "load": body.current_load_hours_per_week, "available": available,
             "clickup_user_id": body.clickup_user_id, "updated_by": _uid(user)})
        await db.commit()
        await _reembed_capability(db, pid)
        return _row_to_person(await _get_person_row(db, pid))
    finally:
        await db.close()


@router.patch("/people/{person_id}", response_model=OrgPersonModel)
async def update_person(
    person_id: str,
    body: PersonWrite,
    user: UserContext = Depends(get_current_user),
):
    """Edit a person (title/role/manager/skills/capacity/ClickUp link). Skills
    replace the array; each skill keeps its prior provenance, new ones = manual."""
    fields = body.model_dump(exclude_unset=True)
    db = await _get_db()
    try:
        row = await _get_person_row(db, person_id)
        set_parts: list[str] = ["updated_at = now()", "updated_by = :updated_by"]
        params: dict[str, Any] = {"id": person_id, "updated_by": _uid(user)}
        # Plain columns (name/email/role/title/…): pass straight through.
        for col in ("name", "email", "role", "title", "department", "team",
                    "reports_to", "status", "domain", "resume_summary",
                    "years_experience", "clickup_user_id"):
            if col in fields:
                set_parts.append(f"{col} = :{col}")
                params[col] = fields[col]
        if "manager_id" in fields:
            set_parts.append("manager_id = CAST(:manager_id AS UUID)")
            params["manager_id"] = fields["manager_id"] or None
        if "skills" in fields:
            skills = [s.strip() for s in (fields["skills"] or []) if s and s.strip()]
            prior = dict(row.skills_source or {})
            src = {s: prior.get(s, "manual") for s in skills}
            set_parts.append("skills = :skills")
            set_parts.append("skills_source = CAST(:skills_source AS JSONB)")
            params["skills"] = skills
            params["skills_source"] = json.dumps(src)
        # Recompute free hours whenever capacity or load moves.
        cap = fields.get("capacity_hours_per_week", row.capacity_hours_per_week)
        load = fields.get("current_load_hours_per_week",
                          row.current_load_hours_per_week)
        if "capacity_hours_per_week" in fields:
            set_parts.append("capacity_hours_per_week = :capacity")
            params["capacity"] = fields["capacity_hours_per_week"]
        if "current_load_hours_per_week" in fields:
            set_parts.append("current_load_hours_per_week = :load")
            params["load"] = fields["current_load_hours_per_week"]
        if "capacity_hours_per_week" in fields or "current_load_hours_per_week" in fields:
            set_parts.append("available_hours_per_week = :available")
            params["available"] = _available(cap, load)
        await db.execute(
            text(f"UPDATE gtd_people SET {', '.join(set_parts)} WHERE id = :id"),
            params)
        await db.commit()
        await _reembed_capability(db, person_id)
        return _row_to_person(await _get_person_row(db, person_id))
    finally:
        await db.close()


class ResumeIngestResult(BaseModel):
    resume_id: str
    added_skills: list[str]
    extracted: dict[str, Any]
    person: OrgPersonModel


@router.post("/people/{person_id}/resume", response_model=ResumeIngestResult)
async def ingest_resume(
    person_id: str,
    file: UploadFile,
    user: UserContext = Depends(get_current_user),
):
    """Upload a résumé (PDF/DOCX/TXT), parse it, and MERGE the extracted skills +
    profile into the person — 'ingest résumés to automatically update skills'."""
    fname = _safe_name(file.filename or "resume")
    ext = Path(fname).suffix.lower()
    if ext not in _RESUME_EXT:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported résumé type '{ext}'. Use PDF, DOCX or TXT.")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(content) > _RESUME_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Résumé too large (max 15 MB).")

    db = await _get_db()
    try:
        row = await _get_person_row(db, person_id)
        # Vocabulary = every skill the org already knows (broadens keyword hits).
        vocab_rows = (await db.execute(text(
            "SELECT DISTINCT unnest(skills) AS s FROM gtd_people"))).fetchall()
        known = [r.s for r in vocab_rows if r.s]
        parsed = await parse_resume(content, fname, file.content_type, known)

        current = list(row.skills or [])
        cur_lower = {s.lower() for s in current}
        added = [s for s in parsed["skills"] if s.lower() not in cur_lower]
        merged = current + added
        prior_src = dict(row.skills_source or {})
        for s in added:
            prior_src[s] = "resume"

        # Store the file next to task attachments (owner-checked dir).
        rid = str(uuid4())
        dest = _storage_dir() / f"resume_{rid}{ext}"
        dest.write_bytes(content)

        extracted = {
            "skills": parsed["skills"],
            "experience_summary": parsed.get("experience_summary"),
            "years_experience": parsed.get("years_experience"),
            "domain": parsed.get("domain"),
        }
        await db.execute(text(
            """INSERT INTO gtd_person_resumes
               (id, person_id, filename, mime, size_bytes, storage_path,
                parsed_text, extracted, uploaded_by)
               VALUES (:id, :pid, :fn, :mime, :size, :path, :ptext,
                       CAST(:extracted AS JSONB), :by)"""),
            {"id": rid, "pid": person_id, "fn": fname,
             "mime": file.content_type, "size": len(content),
             "path": str(dest), "ptext": parsed.get("text", "")[:200000],
             "extracted": json.dumps(extracted), "by": _uid(user)})

        # Merge skills + fill summary/years/domain only when currently empty.
        await db.execute(text(
            """UPDATE gtd_people SET
                 skills = :skills,
                 skills_source = CAST(:src AS JSONB),
                 resume_summary = COALESCE(resume_summary, :summary),
                 years_experience = COALESCE(years_experience, :years),
                 domain = COALESCE(domain, :domain),
                 updated_by = :by, updated_at = now()
               WHERE id = :id"""),
            {"skills": merged, "src": json.dumps(prior_src),
             "summary": parsed.get("experience_summary"),
             "years": parsed.get("years_experience"),
             "domain": parsed.get("domain"), "by": _uid(user), "id": person_id})
        await db.commit()
        # New skills / résumé depth change the capability text → re-embed.
        await _reembed_capability(db, person_id)
        return ResumeIngestResult(
            resume_id=rid, added_skills=added, extracted=extracted,
            person=_row_to_person(await _get_person_row(db, person_id)))
    finally:
        await db.close()


async def _reembed_capability(db: Any, person_id: str) -> None:
    """Refresh a person's semantic capability vector after an edit (best-effort,
    no-op when semantic matching is off). Isolated + swallowed so an embedding
    hiccup never fails the write that already committed."""
    try:
        from gateway.routes.tasks.capability import embed_person
        await embed_person(db, person_id)
    except Exception:
        pass
