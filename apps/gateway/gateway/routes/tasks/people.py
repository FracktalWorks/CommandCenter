"""Tasks · people — the org-knowledge layer (spec §6.1).

GET /tasks/people serves the company's people with roles, skills (org chart +
resume-extracted), capacity/availability, and their ClickUp user id — imported
from agent-project-manager's agent-data via scripts/import_hr_people.py.

This is what makes Clarify capability-aware: the delegation/assignee pickers
and the proposal heuristic see WHO can do WHAT and who has hours free, not
just names. Personal phone numbers are never stored or served.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends
from gateway.routes.tasks.core import _get_db, router
from pydantic import BaseModel
from sqlalchemy import text


class OrgPersonModel(BaseModel):
    id: str
    name: str
    email: str | None = None
    role: str | None = None
    department: str | None = None
    team: str | None = None
    reports_to: str | None = None
    status: str = "active"
    skills: list[str] = []
    domain: str | None = None
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
        department=row.department,
        team=row.team,
        reports_to=row.reports_to,
        status=row.status or "active",
        skills=list(row.skills or []),
        domain=row.domain,
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
    skills + availability. Used by ai.clarify_item (org people first; the
    caller falls back to provider members when this is empty)."""
    try:
        rows = (await db.execute(text(
            """SELECT name, email, clickup_user_id, skills,
                      available_hours_per_week, role
               FROM gtd_people WHERE status = 'active'"""))).fetchall()
    except Exception:
        return []
    return [
        {
            "name": r.name,
            "email": r.email,
            "provider_user_id": r.clickup_user_id,
            "skills": list(r.skills or []),
            "available_hours_per_week": r.available_hours_per_week,
            "role": r.role,
        }
        for r in rows
    ]
