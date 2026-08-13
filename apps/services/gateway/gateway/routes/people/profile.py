"""People Center · the profile and the self-service write (WS-28g).

Spec: ``project-docs/specs/people_center_app.md`` §4, §5.3 · D-PC-1…D-PC-5.

    GET   /people/me                → the caller's own row, or WHY there isn't one
    PATCH /people/{id}              → a class-checked write (admin OR the subject)
    POST  /people/{id}/resume       → the same rule, for the CV

**Why a second write door exists, when WS-28b deliberately kept this app
read-only.** The original decision was right for what it decided: the writes
already lived at ``/tasks/people`` under ``admin:members:manage``, and adding
verbs here that forwarded nowhere would have minted a hollow path. What changed
is the *audience*. A person editing their own timezone is not an admin, and
routing them through ``feature:tasks`` would hand every colleague the personal
GTD task manager to change their own phone number — the exact reason the People
Center got its own feature slug in the first place.

**There is still only one write IMPLEMENTATION.** This module authorizes and
then calls the tasks package's route functions directly. A route dependency
(``require_people_write()``) is applied by FastAPI's router, not by Python, so
calling the function is calling the body without the admin gate — which is the
point: the gate this door needs is the field-class check, and it runs first,
here, on every path. What must never happen is a *second* SQL builder; that is
why ``build_person_update`` is shared rather than copied (§13.1's lesson —
a shape change has to be walked against every writer, and there is only value
in that if the writers are countable).
"""

from __future__ import annotations

from typing import Any, Literal

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException, UploadFile
from gateway.routes.people.core import (
    _tenant_session,
    can_manage_people,
    find_self_row,
    is_self,
    person_payload,
    router,
)
from gateway.routes.people.fields import authorize_write, editable_fields
from gateway.routes.tasks import people as tasks_people
from pydantic import BaseModel
from sqlalchemy import text


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

    ⚠️ **Route order matters and is not obvious.** ``/people/{person_id}`` is
    registered by ``directory.py`` and would happily match the literal string
    ``me`` and then fail casting it to a UUID. FastAPI matches in registration
    order, so ``routes/people/__init__`` imports this module FIRST — and
    ``test_people_profile.py`` asserts that order rather than trusting it,
    because the failure mode is a 500 on a route that looks registered.
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


async def _authorized_row(db: Any, person_id: str, user: Any,
                          names: list[str]) -> Any:
    """Fetch the row and prove this caller may write these fields, or refuse.

    The row is fetched BEFORE the authorization, and it has to be: whether the
    caller is the subject is a property of the row's address, so there is no
    way to answer "may you" without first knowing "whose". A person who does
    not exist is a 404 — answering 403 there would let a caller probe which ids
    exist by reading the refusal.
    """
    row = (await db.execute(
        text("SELECT * FROM gtd_people WHERE id = CAST(:id AS uuid)"),
        {"id": person_id},
    )).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No such person")
    authorize_write(
        names,
        is_admin=can_manage_people(user),
        is_self=is_self(user, getattr(row, "email", None)),
    )
    return row


@router.patch("/{person_id}")
async def update_profile(
    person_id: str,
    body: tasks_people.PersonWrite,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Edit a person — an admin may change anything, the subject their own half.

    The payload model is the tasks package's ``PersonWrite``: **one payload,
    one class map, one SQL builder**. What differs between the two doors is the
    authorization in front, not the shape of what may be said.

    ``exclude_unset`` is what makes the class check meaningful. A model dump
    that filled in every unset field with ``None`` would present a self-service
    save as an attempt to write ``manager_id`` and ``status`` — refused, for a
    form that never mentioned them.
    """
    names = list(body.model_dump(exclude_unset=True))
    if not names:
        raise HTTPException(status_code=400, detail="Nothing to change.")
    async with _tenant_session() as db:
        await _authorized_row(db, person_id, user, names)
    # Authorized. The write itself is the tasks package's, unchanged and
    # unduplicated — including the status vocabulary check, the duplicate-address
    # 409, the JSONB/date binding and the capability re-embed. The admin route
    # dependency is a ROUTER concern and does not run on a direct call; the gate
    # that matters for this door already ran above.
    person = await tasks_people.update_person(person_id, body, user)
    async with _tenant_session() as db:
        row = (await db.execute(
            text("SELECT * FROM gtd_people WHERE id = CAST(:id AS uuid)"),
            {"id": str(person.id)},
        )).fetchone()
        # Re-projected for THIS caller: `update_person` answers with the admin
        # shape because its own door is admin-only. Handing that straight back
        # would leak the HR and private halves to a self-editor who may write
        # their timezone and, on somebody else's row, may read nothing.
        return await person_payload(db, row, user)


@router.post("/{person_id}/resume")
async def upload_resume(
    person_id: str,
    file: UploadFile,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Upload and parse a CV — the subject's own, or an admin's on their behalf.

    "Their CV … can be edited" was explicit in the owner's directive, and a
    person is the best available source for their own résumé. Authorized as a
    write of ``skills`` (plus the résumé depth it merges), which is the self
    class — so the check is the same one the PATCH runs and not a new rule.

    The parse → merge → re-embed pipeline is the existing one, untouched.
    """
    async with _tenant_session() as db:
        await _authorized_row(
            db, person_id, user,
            ["skills", "resume_summary", "years_experience", "domain"],
        )
    result = await tasks_people.ingest_resume(person_id, file, user)
    async with _tenant_session() as db:
        row = (await db.execute(
            text("SELECT * FROM gtd_people WHERE id = CAST(:id AS uuid)"),
            {"id": person_id},
        )).fetchone()
        return {
            "resume_id": result.resume_id,
            "added_skills": result.added_skills,
            "extracted": result.extracted,
            "person": await person_payload(db, row, user),
        }


@router.get("/{person_id}/editable")
async def get_editable(
    person_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    """Which fields this caller may write on this row, and nothing else.

    A narrow read for the editor to call before it draws, so a form does not
    have to fetch the whole person to learn what it may offer. The same answer
    ``person_payload`` embeds — from the same function, never recomputed.
    """
    async with _tenant_session() as db:
        row = (await db.execute(
            text("SELECT email FROM gtd_people WHERE id = CAST(:id AS uuid)"),
            {"id": person_id},
        )).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="No such person")
    admin = can_manage_people(user)
    mine = is_self(user, getattr(row, "email", None))
    return {
        "is_self": mine,
        "can_manage": admin,
        "editable_fields": editable_fields(is_admin=admin, is_self=mine),
    }
