"""People Center · your own row, and only your own (WS-28g-2).

Spec: ``project-docs/specs/people_center_app.md`` §4.5 · **D-PC-15**.

    GET   /people/me           → the caller's own row, or WHY there isn't one
    PATCH /people/me           → their own record, class-checked
    POST  /people/me/resume    → their own CV

**This router carries no feature gate, and that is the ticket.** WS-28g put the
self surface on the directory's router, which is gated on ``feature:people`` —
and ``feature:people`` is ``is_default false``. The consequence was that an
ordinary colleague could not open their own profile: the one surface whose
entire purpose is "every person maintains their own record" was reachable only
by people who had been granted the org directory. The rule now is
**the directory is gated; your own row is not** (D-PC-15), and it is the same
argument ``/access`` already won — gating the page that explains a missing
permission hides it from exactly the person who needs it.

**The security property is structural, not a check.** Every path here is the
literal ``/me``: there is no ``{person_id}`` to supply, so an ungated caller has
no way to *address* another person, correct check or not. The self row is
resolved server-side from the authenticated identity. That is a stronger
guarantee than "we validate that the id is yours", because it cannot be
weakened by a later refactor that forgets the validation — there is nothing to
forget. ``tests/unit/test_people_profile.py`` asserts the absence of path
parameters as a fence.

Everything about *other* people — the directory, the person page, the org
chart, search — stays on ``core.router`` behind ``feature:people``, unchanged.
"""

from __future__ import annotations

from typing import Any, Literal

from acb_auth import UserContext, get_current_user
from acb_common import get_logger
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from gateway.routes.people.core import (
    _tenant_session,
    can_manage_people,
    find_self_row,
    person_payload,
)
from gateway.routes.people.fields import authorize_write
from gateway.routes.tasks import people as tasks_people
from pydantic import BaseModel
from sqlalchemy import text

_log = get_logger("gateway.people.self")

#: No ``dependencies=[require_feature_router("people")]`` — deliberately, and
#: the omission is the feature. Registered in
#: ``test_org_access_enforcement.UNGATED_ROUTERS`` with its reason, because a
#: router missing from that file is *unchecked* rather than *deliberately
#: open*, and the two must never look the same to the next reader.
router = APIRouter(prefix="/people", tags=["people"])


class MeResponse(BaseModel):
    """The three honest answers to "which row is mine" (§5.3).

    Collapsing them would be the defect. A 404 cannot distinguish *"the
    directory has no row for your address"* — an admin has to add one — from
    *"you are signed in without an address"*, which is an identity problem and
    is not fixed anywhere in this app. And returning an empty person object for
    either would render a form that silently saves nothing.
    """
    state: Literal["resolved", "no_directory_row", "no_identity"]
    #: The address the lookup used, echoed so the person can see WHICH address
    #: failed to match — usually the whole explanation (work vs personal).
    email: str | None = None
    person: dict[str, Any] | None = None
    #: What a caller can do about it, in the product's own words. Carried by the
    #: response rather than written into the page, because the page cannot know
    #: whether an admin exists to ask.
    detail: str | None = None


@router.get("/me", response_model=MeResponse)
async def get_me(user: UserContext = Depends(get_current_user)) -> MeResponse:
    """The caller's own person record (§5.3).

    ⚠️ **Route order matters and is not obvious.** ``/people/{person_id}`` on
    the gated router would happily match the literal string ``me`` and then fail
    casting it to a UUID — or, worse for this ticket, refuse an ungranted member
    with a 403 from the directory's gate. FastAPI matches in registration order
    across the whole app, so ``main.py`` includes THIS router first, and
    ``test_people_profile.py`` asserts that ordering rather than trusting it.
    """
    email = (user.email or "").strip() or None
    if not email:
        return MeResponse(
            state="no_identity", email=None,
            detail="You are signed in without an email address, so no directory "
                   "row can be matched to you.",
        )
    async with _tenant_session() as db:
        row = await find_self_row(db, user)
        if row is None:
            return MeResponse(
                state="no_directory_row", email=email,
                detail=f"No person in the directory carries {email}. An "
                       "administrator can add you, or correct the address on "
                       "your existing row.",
            )
        return MeResponse(state="resolved", email=email,
                          person=await person_payload(db, row, user))


async def _my_row(db: Any, user: Any) -> Any:
    """The caller's own row, or a 404 that says which address failed to match.

    404 rather than 403: there is nothing being refused here. The caller is
    entitled to their own record; the product simply does not have one for the
    address they signed in with, which is a different sentence and a different
    fix.
    """
    row = await find_self_row(db, user)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No person in the directory carries {user.email or 'your address'}. "
                "An administrator can add you."
            ),
        )
    return row


@router.patch("/me")
async def update_me(
    body: tasks_people.PersonWrite,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Edit your own record — the self class, plus the admin class if you hold it.

    Both flags are passed to :func:`authorize_write`, so an admin editing their
    OWN row through this door can still change their title: admin is a superset
    of self, never a disjoint set (§4.3). Without that, the ungated door would
    be the *narrower* one for the very people who hold the grant, and they would
    have to go find the other URL to fix their own department.
    """
    names = list(body.model_dump(exclude_unset=True))
    if not names:
        raise HTTPException(status_code=400, detail="Nothing to change.")
    async with _tenant_session() as db:
        row = await _my_row(db, user)
        person_id = str(row.id)
        authorize_write(names, is_admin=can_manage_people(user), is_self=True)
    person = await tasks_people.update_person(person_id, body, user)
    async with _tenant_session() as db:
        saved = (await db.execute(
            text("SELECT * FROM gtd_people WHERE id = CAST(:id AS uuid)"),
            {"id": str(person.id)},
        )).fetchone()
        # Re-projected for this caller. `update_person` answers in the admin
        # shape because its own door is admin-only; handing that straight back
        # would be an ungated endpoint returning an admin projection.
        return await person_payload(db, saved, user)


@router.post("/me/resume")
async def upload_my_resume(
    file: UploadFile,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Upload your own CV — *"their CV … can be edited"*, as the directive put it.

    Authorized as a write of ``skills`` and the résumé depth it merges, which is
    the self class — the same check the PATCH runs, not a new rule. The parse →
    merge → re-embed pipeline is the existing one, untouched.
    """
    async with _tenant_session() as db:
        row = await _my_row(db, user)
        person_id = str(row.id)
        authorize_write(
            ["skills", "resume_summary", "years_experience", "domain"],
            is_admin=can_manage_people(user), is_self=True,
        )
    result = await tasks_people.ingest_resume(person_id, file, user)
    async with _tenant_session() as db:
        saved = (await db.execute(
            text("SELECT * FROM gtd_people WHERE id = CAST(:id AS uuid)"),
            {"id": person_id},
        )).fetchone()
        return {
            "resume_id": result.resume_id,
            "added_skills": result.added_skills,
            "extracted": result.extracted,
            "person": await person_payload(db, saved, user),
        }
