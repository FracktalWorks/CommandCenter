"""Tasks · people — the org-knowledge layer (spec §6.1).

GET /tasks/people serves the company's people with roles, skills (org chart +
resume-extracted), capacity/availability, and their ClickUp user id — imported
from agent-project-manager's agent-data via scripts/import_hr_people.py.

This is what makes Clarify capability-aware: the delegation/assignee pickers
and the proposal heuristic see WHO can do WHAT and who has hours free, not
just names. Personal phone numbers are never stored or served.

Access (colleague_onboarding.md §4 N4, owner-answered 2026-08-04 — "directory
open, HR fields restricted"): the roster is org data, so the *directory* stays
readable by anyone holding `feature:tasks`, but the HR-sensitive half
(:data:`HR_FIELDS`) is projected away for a caller without
``admin:members:read``, and every write here is gated on
``admin:members:manage``. Both permissions and the two seams live in
``core.py``. ``fetch_people_for_clarify`` is deliberately OUTSIDE that rule —
see its docstring.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException, UploadFile
from gateway.routes.tasks.attachments import _safe_name, _storage_dir
from gateway.routes.tasks.core import (
    PEOPLE_STATUSES,
    _get_db,
    _uid,
    can_read_hr_fields,
    require_people_write,
    router,
)
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


#: The HR-sensitive half of a person record — everything the owner's N4
#: answer restricts to `admin:members:read`. The rest of `OrgPersonModel`
#: (name, email, role, title, department, team, reports_to/manager_id,
#: status, domain, provider_user_id) is the basic directory and stays visible
#: to every holder of `feature:tasks`.
HR_FIELDS: tuple[str, ...] = (
    "skills",
    "skills_source",
    "resume_summary",
    "years_experience",
    "capacity_hours_per_week",
    "current_load_hours_per_week",
    "available_hours_per_week",
)


def _blank_hr() -> dict[str, Any]:
    """A fresh empty value per HR field — the projected-away form.

    Fresh containers, not a module-level dict: a shared `[]`/`{}` would be
    aliased into every projected model on every request.
    """
    return {
        "skills": [],
        "skills_source": {},
        "resume_summary": None,
        "years_experience": None,
        "capacity_hours_per_week": None,
        "current_load_hours_per_week": None,
        "available_hours_per_week": None,
    }


def _row_to_person(row: Any, *, include_hr: bool) -> OrgPersonModel:
    """Row → model, with the HR half carried or projected away.

    ``include_hr`` is keyword-only and has **no default**: every call site has
    to state which audience it is serving, so a route added later cannot
    inherit the permissive answer by omission.

    The projection is at the SERIALIZATION layer, never in the SQL, for two
    reasons. (1) ``fetch_people_for_clarify`` runs its own query and must keep
    seeing everything — a WHERE/SELECT-level projection would silently degrade
    agent delegation. (2) The response SHAPE is unchanged: restricted fields
    come back null/empty rather than absent, so the frontend mapper and the
    generated TS type read the same object either way.
    """
    person = OrgPersonModel(
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
    if include_hr:
        return person
    return person.model_copy(update=_blank_hr())


@router.get("/people", response_model=list[OrgPersonModel])
async def list_people(
    q: str = "",
    include_inactive: bool = False,
    user: UserContext = Depends(get_current_user),
):
    """The org's people. `q` filters by name/role/department — and by skill,
    but only for a caller who may see skills: matching on a column that is
    then stripped from the response turns the search box into an oracle for
    the field the projection exists to hide."""
    hr = can_read_hr_fields(user)
    clauses = ["true"] if include_inactive else ["status = 'active'"]
    params: dict[str, Any] = {}
    if q.strip():
        match = "(name ILIKE :q OR role ILIKE :q OR department ILIKE :q"
        if hr:
            match += " OR EXISTS (SELECT 1 FROM unnest(skills) s WHERE s ILIKE :q)"
        clauses.append(match + ")")
        params["q"] = f"%{q.strip()}%"
    db = await _get_db()
    try:
        rows = (await db.execute(
            text("SELECT * FROM gtd_people WHERE " + " AND ".join(clauses)
                 + " ORDER BY department, name"),
            params,
        )).fetchall()
        return [_row_to_person(r, include_hr=hr) for r in rows]
    finally:
        await db.close()


async def fetch_people_for_clarify(db: Any) -> list[dict[str, Any]]:
    """People dicts for the proposal heuristic: name/email/provider id +
    skills + availability + the reporting line (§5, Phase 2). Used by
    ai.clarify_item (org people first; the caller falls back to provider
    members when this is empty).

    ⚠️ **Deliberately outside the N4 read projection.** It takes ``db`` and no
    user because it is never reached through the router: every caller is an
    in-process server-side path (``ai.py``, ``capture_email.py``,
    ``planning.py``). It must keep returning FULL data — this is the
    capability-aware delegation the roster exists for, and narrowing it would
    degrade agent delegation silently rather than protect anybody.

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
#
# Being the source of truth for HR data is exactly why these are ADMIN writes:
# every route below carries `require_people_write()` (`admin:members:manage`)
# as a route dependency — N4, owner-answered 2026-08-04. `POST /people/embed`
# in capability.py is the fourth; count routes, not call sites.


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


def _validate_status(status: str | None) -> None:
    """Refuse a status the database will refuse, and say what is allowed.

    Migration 148 gave `gtd_people.status` a CHECK. Without this the route
    would hand an illegal value straight to Postgres, which answers with a
    `CheckViolation` — a 500 whose text names a constraint rather than the four
    words the caller may type. The vocabulary is imported (never re-listed), so
    a fifth status cannot be accepted here and rejected there.
    """
    if status is not None and status not in PEOPLE_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown status '{status}'. One of: {list(PEOPLE_STATUSES)}.",
        )


def _clean_email(email: str | None) -> str | None:
    """Trim, and turn a blank into NULL.

    `''` is not NULL to Postgres, so two people saved with an empty address
    would collide under 148's partial unique index — the one case the migration
    had to clean up in the existing data, and it is worth not re-creating it
    one row at a time. A trailing space is the same defect wearing a disguise:
    it makes two identical addresses look distinct to `lower(email)`.
    """
    clean = (email or "").strip()
    return clean or None


async def _email_taken_by(db: Any, email: str | None, *,
                          exclude_id: str | None = None) -> str | None:
    """The name of the person already holding this address, or ``None``.

    Migration 148 put a partial UNIQUE on `lower(email)` so an email→person
    join is unambiguous. That makes a duplicate address a *database* error —
    an opaque 500 at exactly the moment an admin is typing somebody in. Checked
    here so the answer is a 409 that names the other row, which is the only
    form of this message anyone can act on.

    Case-insensitive on both sides (R10), matching the index's `lower(email)`.
    ``exclude_id`` is what lets a PATCH re-save a person's own address.
    """
    clean = (email or "").strip().lower()
    if not clean:
        return None
    sql = "SELECT name FROM gtd_people WHERE lower(email) = :email"
    params: dict[str, Any] = {"email": clean}
    if exclude_id:
        sql += " AND id <> CAST(:exclude AS UUID)"
        params["exclude"] = exclude_id
    row = (await db.execute(text(sql + " LIMIT 1"), params)).fetchone()
    return str(row.name) if row is not None else None


@router.post("/people", response_model=OrgPersonModel, status_code=201,
             dependencies=[require_people_write()])
async def create_person(
    body: PersonWrite,
    user: UserContext = Depends(get_current_user),
):
    """Add a person to the org (manual entry). `name` is required; the EMAIL is
    what has to be unique.

    Admin-only (`admin:members:manage`)."""
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    _validate_status(body.status)
    skills = [s.strip() for s in (body.skills or []) if s and s.strip()]
    skills_source = {s: "manual" for s in skills}
    available = _available(body.capacity_hours_per_week, body.current_load_hours_per_week)
    pid = str(uuid4())
    db = await _get_db()
    try:
        # Duplicate NAMES are allowed, and refusing them was the bug.
        # Migration 148 dropped `UNIQUE(name)` on the argument that two real
        # people share a name and one of them was being locked out of the
        # directory; keeping a route-level 409 would have preserved exactly the
        # behaviour the migration was written to remove. What must be unique is
        # the address, because that is the join key.
        holder = await _email_taken_by(db, body.email)
        if holder:
            raise HTTPException(
                status_code=409,
                detail=f"{body.email} already belongs to {holder}.")
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
            {"id": pid, "name": name, "email": _clean_email(body.email),
             "role": body.role,
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
        # include_hr: the route gate already proved this caller is an admin.
        return _row_to_person(await _get_person_row(db, pid), include_hr=True)
    finally:
        await db.close()


@router.patch("/people/{person_id}", response_model=OrgPersonModel,
              dependencies=[require_people_write()])
async def update_person(
    person_id: str,
    body: PersonWrite,
    user: UserContext = Depends(get_current_user),
):
    """Edit a person (title/role/manager/skills/capacity/ClickUp link). Skills
    replace the array; each skill keeps its prior provenance, new ones = manual.

    Admin-only (`admin:members:manage`)."""
    fields = body.model_dump(exclude_unset=True)
    if "status" in fields:
        _validate_status(fields["status"])
    if "email" in fields:
        fields["email"] = _clean_email(fields["email"])
    db = await _get_db()
    try:
        row = await _get_person_row(db, person_id)
        # `exclude_id` is why this is not the create-path check: re-saving a
        # person without touching their address must not report them as their
        # own duplicate.
        if "email" in fields:
            holder = await _email_taken_by(db, fields["email"], exclude_id=person_id)
            if holder:
                raise HTTPException(
                    status_code=409,
                    detail=f"{fields['email']} already belongs to {holder}.")
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
        return _row_to_person(
            await _get_person_row(db, person_id), include_hr=True)
    finally:
        await db.close()


class ResumeIngestResult(BaseModel):
    resume_id: str
    added_skills: list[str]
    extracted: dict[str, Any]
    person: OrgPersonModel


@router.post("/people/{person_id}/resume", response_model=ResumeIngestResult,
             dependencies=[require_people_write()])
async def ingest_resume(
    person_id: str,
    file: UploadFile,
    user: UserContext = Depends(get_current_user),
):
    """Upload a résumé (PDF/DOCX/TXT), parse it, and MERGE the extracted skills +
    profile into the person — 'ingest résumés to automatically update skills'.

    Admin-only (`admin:members:manage`)."""
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
            person=_row_to_person(
                await _get_person_row(db, person_id), include_hr=True))
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
