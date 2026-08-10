"""People Center · the directory and the person page (WS-28b).

Spec: ``project-docs/specs/people_center_app.md`` §3.1, §3.2, §5.2.

Three reads. Every one of them answers the same two questions in the same
order — *may this caller reach the surface at all* (``feature:people``, on the
router) and *may they see the HR half* (``admin:members:read``, projected) —
and neither answer is computed here. Both are imported.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.people.core import (
    STATUSES,
    _tenant_session,
    can_manage_people,
    can_read_hr_fields,
    has_login,
    router,
)
from gateway.routes.tasks.people import _row_to_person
from pydantic import BaseModel
from sqlalchemy import text

#: A working week, used to turn estimate minutes into the load bar's hours.
#: A constant rather than a setting: the bar is a rough signal, and a tunable
#: nobody tunes is a config surface pretending to be a feature.
MINUTES_PER_HOUR = 60


class DirectoryResponse(BaseModel):
    rows: list[dict[str, Any]]
    total: int
    #: False when the HR half came back nulled. The UI needs this to say
    #: "restricted" rather than "none" — a blank skills strip meaning "you may
    #: not see this" and one meaning "nobody filled it in" are different facts,
    #: and a UI that cannot tell them apart will pick the wrong one (§3.1).
    hr_visible: bool
    #: True when the caller holds `admin:members:manage`. The third of this
    #: app's "say what the answer's shape is" flags, and the one the editor
    #: needs: §3.2 renders write controls **absent** rather than disabled, and
    #: the only alternative to being told is drawing the button and letting the
    #: click discover a 403 — which teaches people to hunt for permissions they
    #: may never get.
    can_manage: bool = False


class WorkResponse(BaseModel):
    rows: list[dict[str, Any]]
    total: int
    #: False when the caller does not hold `feature:projects`. Same distinction
    #: as `hr_visible`: "this surface is not yours" is not "they have no work".
    available: bool


def build_directory_filters(
    *,
    hr: bool,
    q: str = "",
    department: str | None = None,
    team: str | None = None,
    status: str | None = None,
    skill: str | None = None,
    has_capacity: bool = False,
) -> tuple[list[str], dict[str, Any]]:
    """The directory's WHERE clauses and binds — pure, so the rules are testable.

    Extracted from the route deliberately: the interesting decisions here are
    all *whether a clause is included at all*, and that is a question about
    permissions, not about rows. Proving it through a database fake would prove
    it about the fake.

    Three of them are the same rule wearing different hats — **an HR-derived
    filter is dropped entirely without `admin:members:read`**:

    - the ``q`` skills clause, because matching on a column that is then
      stripped from the response turns the search box into an oracle for the
      very field the projection exists to hide;
    - ``skill``, for the same reason, more directly;
    - ``has_capacity``, which is derived from the restricted capacity trio.

    Dropping them silently would be wrong on its own, which is why the response
    carries ``hr_visible``: the UI must be able to say the filter did not apply
    rather than present an unfiltered list as a filtered one.
    """
    clauses: list[str] = ["true"]
    params: dict[str, Any] = {}
    if (q or "").strip():
        match = "(name ILIKE :q OR role ILIKE :q OR title ILIKE :q OR department ILIKE :q"
        if hr:
            match += " OR EXISTS (SELECT 1 FROM unnest(skills) s WHERE s ILIKE :q)"
        clauses.append(match + ")")
        params["q"] = f"%{q.strip()}%"
    if department:
        clauses.append("lower(department) = :department")
        params["department"] = department.strip().lower()
    if team:
        clauses.append("lower(team) = :team")
        params["team"] = team.strip().lower()
    if status:
        clauses.append("status = :status")
        params["status"] = status
    if hr and skill:
        clauses.append("EXISTS (SELECT 1 FROM unnest(skills) s WHERE s ILIKE :skill)")
        params["skill"] = f"%{skill.strip()}%"
    if hr and has_capacity:
        clauses.append("COALESCE(available_hours_per_week, 0) > 0")
    return clauses, params


@router.get("/", response_model=DirectoryResponse)
async def list_directory(
    user: UserContext = Depends(get_current_user),
    q: str = "",
    department: str | None = None,
    team: str | None = None,
    status: str | None = None,
    skill: str | None = None,
    has_capacity: bool = False,
) -> DirectoryResponse:
    """The directory (§3.1).

    ``q`` matches name, title/role and department for everyone — and skills
    **only** for a caller who may see skills. Matching on a column that is then
    stripped from the response turns the search box into an oracle for the very
    field the projection exists to hide; ``/tasks/people`` already made that
    call and this repeats it deliberately rather than diverging.

    ``skill`` and ``has_capacity`` are HR-derived filters, so they are ignored
    outright without ``admin:members:read`` — for the same reason, and stated
    in the response via ``hr_visible`` so the UI does not silently show an
    unfiltered list as though the filter had applied.
    """
    hr = can_read_hr_fields(user)
    if status is not None and status not in STATUSES:
        raise HTTPException(
            status_code=422, detail=f"Unknown status. One of: {list(STATUSES)}.",
        )
    clauses, params = build_directory_filters(
        hr=hr, q=q, department=department, team=team, status=status,
        skill=skill, has_capacity=has_capacity,
    )

    async with _tenant_session() as db:
        rows = (await db.execute(
            text(
                "SELECT * FROM gtd_people WHERE " + " AND ".join(clauses)
                + " ORDER BY department NULLS LAST, name"
            ),
            params,
        )).fetchall()
        people = [_row_to_person(r, include_hr=hr).model_dump() for r in rows]
    return DirectoryResponse(rows=people, total=len(people), hr_visible=hr,
                             can_manage=can_manage_people(user))


@router.get("/facets")
async def list_facets(user: UserContext = Depends(get_current_user)) -> dict:
    """The filter vocabulary, derived from the rows rather than configured.

    A department list somebody has to maintain is a department list that goes
    stale the first time the org changes — the same call ``/projects/my/contexts``
    made for GTD contexts.
    """
    async with _tenant_session() as db:
        rows = (await db.execute(
            text(
                "SELECT department, team, count(*) AS total FROM gtd_people "
                "WHERE department IS NOT NULL GROUP BY department, team "
                "ORDER BY department, team"
            ),
        )).fetchall()
    departments: dict[str, int] = {}
    teams: list[dict[str, Any]] = []
    for row in rows:
        departments[row.department] = departments.get(row.department, 0) + int(row.total)
        if row.team:
            teams.append({"department": row.department, "team": row.team,
                          "total": int(row.total)})
    return {
        "departments": [{"department": d, "total": t} for d, t in departments.items()],
        "teams": teams,
        "statuses": list(STATUSES),
    }


@router.get("/{person_id}")
async def get_person(
    person_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    """One person (§3.2 panels 1-3).

    404 for a person who does not exist. There is deliberately no 403 anywhere
    in this app: the directory is open to feature holders, and what varies is
    the *shape* of the answer, not whether one comes back.
    """
    hr = can_read_hr_fields(user)
    async with _tenant_session() as db:
        row = (await db.execute(
            text("SELECT * FROM gtd_people WHERE id = CAST(:id AS uuid)"),
            {"id": person_id},
        )).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="No such person")
        person = _row_to_person(row, include_hr=hr).model_dump()
        person["has_login"] = await has_login(db, getattr(row, "email", None))
        # An address moved aside by migration 148 because another row claimed
        # it. Surfaced rather than hidden: it means a human still has to decide
        # which row is the real person.
        person["email_conflict"] = getattr(row, "email_conflict", None)
        person["manager"] = await _manager_name(db, getattr(row, "manager_id", None))
        person["load"] = (
            await compute_load(db, getattr(row, "email", None)) if hr else None
        )
    person["hr_visible"] = hr
    # Independent of `hr_visible` on purpose. The two permissions are separate
    # grants, and an admin who may edit a record but not read its HR half is a
    # real principal — the editor has to open with the skills strip restricted
    # and the save button present.
    person["can_manage"] = can_manage_people(user)
    return person


async def _manager_name(db: Any, manager_id: Any) -> str | None:
    if not manager_id:
        return None
    row = (await db.execute(
        text("SELECT name FROM gtd_people WHERE id = CAST(:id AS uuid)"),
        {"id": str(manager_id)},
    )).fetchone()
    return str(row.name) if row is not None else None


async def compute_load(db: Any, email: str | None) -> dict[str, Any]:
    """Load from OPEN ASSIGNED TASKS, not from the typed column (§5.2).

    ``gtd_people.current_load_hours_per_week`` is a number somebody typed once;
    it is stale the moment anyone assigns anything. This counts what the person
    is actually holding.

    The honest part is ``unestimated``: a task with no estimate contributes
    nothing to the hours, so a bar built only from the sum would show somebody
    with thirty un-estimated tasks as completely free. The count travels with
    the number so the UI can say "plus 30 with no estimate" instead of lying.
    """
    if not (email or "").strip():
        return {"open_tasks": 0, "estimated_hours": 0.0, "unestimated": 0}
    row = (await db.execute(
        text(
            """SELECT count(*)                                   AS open_tasks,
                      COALESCE(sum(t.estimate_mins), 0)           AS mins,
                      count(*) FILTER (WHERE t.estimate_mins IS NULL)
                                                                  AS unestimated
                 FROM pm_tasks t
                 JOIN pm_task_statuses s ON s.id = t.status_id
                 JOIN pm_task_assignees a ON a.task_id = t.id
                WHERE lower(a.assignee) = :who
                  AND t.archived_at IS NULL
                  AND s.category NOT IN ('done', 'cancelled')"""
        ),
        {"who": email.strip().lower()},
    )).fetchone()
    mins = int(getattr(row, "mins", 0) or 0)
    return {
        "open_tasks": int(getattr(row, "open_tasks", 0) or 0),
        "estimated_hours": round(mins / MINUTES_PER_HOUR, 1),
        "unestimated": int(getattr(row, "unestimated", 0) or 0),
    }


@router.get("/{person_id}/work", response_model=WorkResponse)
async def get_person_work(
    person_id: str, user: UserContext = Depends(get_current_user),
) -> WorkResponse:
    """This person's open tasks, scoped by the **viewer's** grants (§3.2 panel 4).

    Scoped by the viewer and not the subject, deliberately: a Sales lead looking
    at an Operations colleague should see the work they share, not that
    person's whole life. The Projects grant model already answers exactly that
    question, so it is imported rather than approximated.

    A caller without ``feature:projects`` gets ``available: false`` and an empty
    list rather than a bare empty list — "this surface is not yours" and "they
    have nothing open" must not render identically.
    """
    from gateway.routes.projects.core import resolve_visibility

    if not user.has_permission("feature:projects"):
        return WorkResponse(rows=[], total=0, available=False)

    async with _tenant_session() as db:
        person = (await db.execute(
            text("SELECT email FROM gtd_people WHERE id = CAST(:id AS uuid)"),
            {"id": person_id},
        )).fetchone()
        if person is None:
            raise HTTPException(status_code=404, detail="No such person")
        email = str(getattr(person, "email", "") or "").strip().lower()
        if not email:
            # Directory-only with no address: assignment targets are addresses,
            # so there is nothing to look up rather than nothing assigned.
            return WorkResponse(rows=[], total=0, available=True)

        vis = await resolve_visibility(db, user)
        params: dict[str, Any] = {"who": email}
        clauses = [
            "t.archived_at IS NULL",
            "s.category NOT IN ('done', 'cancelled')",
            "EXISTS (SELECT 1 FROM pm_task_assignees a "
            "WHERE a.task_id = t.id AND lower(a.assignee) = :who)",
        ]
        if not vis.unrestricted:
            clauses.append(vis.project_clause("t.root_project_id"))
            params.update(vis.params)
        rows = (await db.execute(
            text(
                "SELECT t.id, t.title, t.task_number, t.due_at, t.project_id, "
                "       s.name AS status_name, s.category AS status_category, "
                "       p.name AS project_name "
                "  FROM pm_tasks t "
                "  JOIN pm_task_statuses s ON s.id = t.status_id "
                "  LEFT JOIN pm_projects p ON p.id = t.project_id "
                " WHERE " + " AND ".join(clauses)
                + " ORDER BY t.due_at NULLS LAST, t.created_at"
            ),
            params,
        )).fetchall()

    items = [
        {
            "id": str(r.id), "title": r.title, "task_number": r.task_number,
            "due_at": r.due_at.isoformat() if getattr(r, "due_at", None) else None,
            "project_id": str(r.project_id) if r.project_id else None,
            "project_name": getattr(r, "project_name", None),
            "status_name": r.status_name, "status_category": r.status_category,
        }
        for r in rows
    ]
    return WorkResponse(rows=items, total=len(items), available=True)
