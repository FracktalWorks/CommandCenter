"""People Center · the router, the gate, and the seams it borrows.

Spec: ``project-docs/specs/people_center_app.md`` §3, §6 · ticket WS-28b.

**Two permissions, and they answer different questions.**
``feature:people`` decides whether the directory is reachable at all;
``admin:members:read`` decides whether the HR-sensitive half of a person record
comes back filled in or nulled. The second one is **not defined here** — it is
imported from ``routes/tasks/core`` where WS-24 N4 put it. A second definition
of "may this caller see skills" is a second answer waiting to drift from the
first, and the projection is a boundary.
"""

from __future__ import annotations

from typing import Any

from acb_auth import require_feature_router
from acb_common import get_logger
from fastapi import APIRouter

# The shared seam (BO-10 → MT-1c/H2). `_tenant_session` IS
# `acb_common.db.tenant_session`, aliased here for the same reason every
# converted package aliases it: submodules import it from this module BY NAME,
# which is the seam the hermetic tests patch per module. The tenant comes from
# the request context — bound centrally in `_with_resolved_access` — so no
# call site passes one (H2). A call outside a bound request raises
# `TenantUnbound` rather than defaulting: fail closed, never "the usual org".
from gateway.db import tenant_session as _tenant_session  # noqa: F401
from gateway.routes.people.fields import editable_fields
from gateway.routes.tasks.core import (
    PEOPLE_STATUSES,
    can_manage_people,
    can_read_hr_fields,
)
from gateway.routes.tasks.people import _row_to_person
from gateway.work_schedule import (
    capacity_disagreement,
    contracted_hours_per_week,
    load_policy,
    person_schedule,
)
from sqlalchemy import text

_log = get_logger("gateway.people")

router = APIRouter(
    prefix="/people", tags=["people"],
    dependencies=[require_feature_router("people")],
)


#: Statuses the directory understands — the SAME tuple the write routes
#: validate against, not a copy of it. Listed so a bad filter value is an empty
#: result rather than an error, and so the UI can render the pill set (and the
#: editor's status select) without a second round trip.
STATUSES: tuple[str, ...] = PEOPLE_STATUSES


def is_self(user: Any, person_email: str | None) -> bool:
    """Is the caller the person this row is about? (spec §2, **D-PC-1**)

    The self predicate, computed in exactly ONE place. It is not a permission —
    a new slug is nobody's grant until an admin creates it — it is a row match
    on the same lowercased address ``has_login`` joins on, seen from the other
    side. The badge the person page draws and the right to edit that row are
    therefore the same fact, and cannot disagree.

    **It is safe only because migration 148 made ``lower(email)`` partially
    unique.** Before it, two rows could carry one address and "edit yourself"
    could have edited somebody else. Do not weaken that index.

    Fails closed on every missing half: no caller address, no row address, or an
    unresolved principal all answer False. A directory-only person has no self
    by construction (D-PC-12) — there is no caller to match.
    """
    mine = (getattr(user, "email", None) or "").strip().lower()
    theirs = (person_email or "").strip().lower()
    return bool(mine and theirs and mine == theirs)


async def find_self_row(db: Any, user: Any) -> Any:
    """The caller's own ``gtd_people`` row, or ``None``.

    The self predicate run as a query rather than over rows already in hand —
    used by ``/people/me`` and by the directory's ``self_person_id``. Resolved
    independently of whatever list is being rendered, because "which row is me"
    must not depend on whether my row survived the caller's search filter.

    At most one row can match: 148's partial unique index on ``lower(email)``
    is what makes that a guarantee rather than a hope, and ``LIMIT 1`` here is
    belt-and-braces against a database where the index was never applied.
    """
    mine = (getattr(user, "email", None) or "").strip().lower()
    if not mine:
        return None
    return (await db.execute(
        text("SELECT * FROM gtd_people WHERE lower(email) = :email LIMIT 1"),
        {"email": mine},
    )).fetchone()


async def has_login(db: Any, email: str | None) -> bool:
    """Does this person have an ``app_user`` row — i.e. can they sign in?

    The visible half of §2's two-store split. Case-insensitive on both sides
    (R10), and a person with no address is directory-only by construction
    rather than by lookup.
    """
    if not (email or "").strip():
        return False
    row = (await db.execute(
        text("SELECT 1 FROM app_user WHERE lower(email) = :email LIMIT 1"),
        {"email": email.strip().lower()},
    )).fetchone()
    return row is not None


# ── The shared read seam ────────────────────────────────────────────────────
#
# `person_payload` and its two helpers live HERE, in the leaf module, and not
# beside the route that first needed them, for a reason that is easy to trip
# over: `directory.py` registers `/people/{person_id}`, and FastAPI matches in
# REGISTRATION order, so `/people/me` has to be registered first or the literal
# string "me" is matched as a person id and fails casting to a UUID. That means
# `profile.py` must be imported before `directory.py` — which it cannot be if
# it imports anything FROM `directory.py`, because the import would drag the
# routes in first anyway. A leaf module both can read breaks the knot.
#
# `directory.py` re-exports all three, so every existing caller and test keeps
# its import path.

#: A working week, used to turn estimate minutes into the load bar's hours.
#: A constant rather than a setting: the bar is a rough signal, and a tunable
#: nobody tunes is a config surface pretending to be a feature.
MINUTES_PER_HOUR = 60


async def person_payload(db: Any, row: Any, user: Any) -> dict:
    """One person row → the wire shape, with every tier decided here.

    **The one assembler**, used by ``GET /people/{id}`` and by
    ``GET /people/me`` alike. `/people/me` is not a second page with a second
    layout — it is this page resolved through the self predicate — so a field
    added here cannot be missing there (spec §5.3).

    Three access questions, and they are three (§4):

    * ``hr`` — the WS-24 N4 projection, **now with a second door**: the grant
      ``admin:members:read``, *or* being the subject. Without the second door,
      "edit your own skills" would be a form whose current values you cannot
      read.
    * ``private`` — §3.5, keyed to ``admin:members:manage`` or self (D-PC-3),
      deliberately NOT to the read grant a manager may hold.
    * ``editable_fields`` — what this caller may WRITE, from the one field-class
      authority. The UI renders from this and never from its own copy (D-PC-4).
    """
    mine = is_self(user, getattr(row, "email", None))
    admin = can_manage_people(user)
    hr = can_read_hr_fields(user) or mine
    person = _row_to_person(row, include_hr=hr,
                            include_private=admin or mine).model_dump()
    person["has_login"] = await has_login(db, getattr(row, "email", None))
    # An address moved aside by migration 148 because another row claimed it.
    # Surfaced rather than hidden: it means a human still has to decide which
    # row is the real person.
    person["email_conflict"] = getattr(row, "email_conflict", None)
    person["manager"] = await _manager_name(db, getattr(row, "manager_id", None))
    person["load"] = (
        await compute_load(db, getattr(row, "email", None)) if hr else None
    )
    # WS-28p — the schedule layering, resolved in ONE place (D-PC-16).
    #
    # `schedule` is DIRECTORY tier: when a colleague works is what stops a
    # 9am call being rude, and §3.1 already put `working_hours` there.
    # `contracted_hours_per_week` is HR tier: it is a capacity figure, and
    # capacity has been behind `admin:members:read` since WS-24 N4.
    policy = await load_policy(db)
    schedule = person_schedule(policy, row)
    person["schedule"] = schedule
    person["contracted_hours_per_week"] = (
        contracted_hours_per_week(schedule) if hr else None)
    # The typed column is NOT rewritten (R6 — the importer writes it), and the
    # disagreement is surfaced rather than resolved: quietly preferring one is
    # how two numbers start disagreeing where nobody can see them (D-PC-18).
    person["capacity_conflict"] = (
        capacity_disagreement(
            schedule, getattr(row, "capacity_hours_per_week", None))
        if hr else None)
    person["hr_visible"] = hr
    # Independent of `hr_visible` on purpose. The two permissions are separate
    # grants, and an admin who may edit a record but not read its HR half is a
    # real principal — the editor has to open with the skills strip restricted
    # and the save button present.
    person["can_manage"] = admin
    person["is_self"] = mine
    person["editable_fields"] = editable_fields(is_admin=admin, is_self=mine)
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
