"""People Center · the router, the gate, and the seams it borrows.

Spec: ``ai-company-brain/specs/people_center_app.md`` §3, §6 · ticket WS-28b.

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
from gateway.routes.tasks.core import (  # noqa: F401 — re-exports
    PEOPLE_STATUSES,
    can_manage_people,
    can_read_hr_fields,
)
from sqlalchemy import text

_log = get_logger("gateway.people")

router = APIRouter(
    prefix="/people", tags=["people"],
    dependencies=[require_feature_router("people")],
)


async def _get_db() -> Any:
    """The shared engine seam (BO-10) — never ``create_async_engine`` here."""
    from gateway.db import get_session

    return await get_session()


#: Statuses the directory understands — the SAME tuple the write routes
#: validate against, not a copy of it. Listed so a bad filter value is an empty
#: result rather than an error, and so the UI can render the pill set (and the
#: editor's status select) without a second round trip.
STATUSES: tuple[str, ...] = PEOPLE_STATUSES


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
