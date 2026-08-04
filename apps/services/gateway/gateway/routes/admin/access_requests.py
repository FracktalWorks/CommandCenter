"""Sign-in requests — the queue of people knocking at a door nobody opened.

Spec: ``ai-company-brain/specs/colleague_onboarding.md`` §6 (WS-24 / N6a).

``/admin/members`` is push-only: the only way an ``app_user`` row was ever
created is an admin typing an address into Invite. Somebody arriving at the
front door created nothing an admin could see — the refusal was logged and
then discarded, so the owner's only way to learn that a colleague was locked
out was for that colleague to say so. One address knocked 53 times over 18
hours on 2026-08-03/04 and the system told nobody.

``acb_auth.access.resolve_access`` now files that knock into ``access_request``
(migration 143) when — and only when — it comes from the sign-in path. This
module is the other half: the owner sees the queue and answers it.

Two things worth knowing before editing:

1. **The ``/admin`` auth floor is per-route, not a package property.**
   ``_common.py`` creates the router with **no** ``dependencies=``; every route
   declares ``Depends(require_admin_user)`` in its own signature. A route added
   here that omits it inherits no floor at all and is reachable by any
   authenticated member. ``tests/unit/test_signin_requests.py`` pins that.
2. **No new permission slug.** Approve and deny reuse
   ``admin:members:invite``, which the roles seed already grants. A brand-new
   slug is nobody's grant until an admin creates it — which would switch the
   feature off for the owner too (the N4 lesson, spec §4).
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, require_permission
from fastapi import Depends, HTTPException
from gateway.routes.admin._common import (
    _iso,
    _log,
    get_db,
    get_org_id,
    invalidate_for,
    provision_member,
    record_admin_change,
    require_admin_user,
    roles_for_user,
    router,
)
from pydantic import BaseModel, Field
from sqlalchemy import text

#: A request is only ever in one of these. `pending` is the owner's inbox;
#: the other two are the record of a decision, kept rather than deleted so a
#: repeat knock from a denied address does not read as a new one.
REQUEST_STATUSES = ("pending", "approved", "denied")

_REQUEST_COLUMNS = (
    "SELECT id::text AS id, email, display_name, first_seen_at, last_seen_at, "
    "       attempt_count, status, decided_by, decided_at "
    "  FROM access_request "
)


# ── Models ──────────────────────────────────────────────────────────────────

class AccessRequestEntry(BaseModel):
    email: str
    display_name: str = ""
    first_seen_at: str = ""
    last_seen_at: str = ""
    #: How many times they tried. The number is what makes a row legible as
    #: somebody stuck rather than somebody curious.
    attempt_count: int = 0
    status: str = "pending"


class ApproveRequest(BaseModel):
    #: Role slugs to assign. Empty means the seeded default `member` — the same
    #: default the invite path applies.
    roles: list[str] = Field(default_factory=list)


class ApproveResult(BaseModel):
    email: str
    #: The member's status AFTER provisioning — normally `active`. It is echoed
    #: rather than assumed because provisioning refuses to un-suspend anybody.
    status: str = ""
    roles: list[str] = Field(default_factory=list)


def _entry(row: dict[str, Any]) -> AccessRequestEntry:
    return AccessRequestEntry(
        email=row["email"],
        display_name=row["display_name"] or "",
        first_seen_at=_iso(row["first_seen_at"]),
        last_seen_at=_iso(row["last_seen_at"]),
        attempt_count=int(row["attempt_count"] or 0),
        status=row["status"],
    )


async def _load_request(db: Any, email: str) -> dict[str, Any]:
    """Fetch one request by email, or 404."""
    row = (
        await db.execute(
            text(_REQUEST_COLUMNS + " WHERE lower(email) = :email"),
            {"email": (email or "").strip().lower()},
        )
    ).mappings().first()
    if row is None:
        raise HTTPException(
            status_code=404, detail=f"No sign-in request from '{email}'."
        )
    return dict(row)


async def _decide(db: Any, email: str, status: str, admin: UserContext) -> None:
    """Stamp the decision. The status vocabulary is closed, and enforced here
    rather than only in the migration — a typo'd status would silently drop the
    row out of both the pending list and the decided record."""
    if status not in REQUEST_STATUSES:
        raise ValueError(f"unknown access_request status {status!r}")
    await db.execute(
        text(
            "UPDATE access_request SET status = :status, decided_by = :by, "
            "       decided_at = now() "
            " WHERE lower(email) = :email"
        ),
        {"status": status, "by": admin.email or "", "email": email},
    )


# ── Routes ──────────────────────────────────────────────────────────────────

@router.get("/members/requests", summary="Pending sign-in requests")
async def list_access_requests(
    admin: UserContext = Depends(require_admin_user),
) -> list[AccessRequestEntry]:
    """Everyone who authenticated and found no door, newest knock first.

    Sits on the package's ``admin:members:read`` floor like every other read —
    seeing who is locked out is part of reading the roster, not a new right.
    """
    db = await get_db()
    async with db:
        rows = (
            await db.execute(
                text(
                    _REQUEST_COLUMNS
                    + " WHERE status = 'pending' ORDER BY last_seen_at DESC"
                ),
            )
        ).mappings().all()
    return [_entry(dict(r)) for r in rows]


@router.post("/members/requests/{email}/approve",
             summary="Approve a sign-in request",
             dependencies=[require_permission("admin:members:invite")])
async def approve_access_request(
    email: str,
    req: ApproveRequest,
    admin: UserContext = Depends(require_admin_user),
) -> ApproveResult:
    """Provision the member **and activate them**, in one action.

    Deliberately `active`, not `invited`: an approval IS the admin's decision
    to let this person in, and they are already standing at the door. Leaving
    them `invited` would re-create §2's two-click trap — the exact failure this
    ticket exists to close — inside the fix for it.

    Provisioning goes through ``_common.provision_member``, the same helper
    ``POST /admin/members`` uses, so there is one provisioning path and
    invariant 2 ("nobody grants above themselves") applies here too: an admin
    cannot approve somebody straight into `owner`.

    Idempotent. Two admins clicking the same row is a normal race, not an
    error, and it must not produce two members.
    """
    db = await get_db()
    async with db:
        request = await _load_request(db, email)
        org_id = await get_org_id(db)

        member, _assigned = await provision_member(
            db, org_id,
            email=request["email"],
            display_name=request["display_name"] or "",
            roles=req.roles,
            admin=admin,
            status="active",
        )
        await _decide(db, member["email"].lower(), "approved", admin)
        await db.commit()
        roles = await roles_for_user(db, member["id"])

    # Their refusal is cached for up to 60s; without this they would be
    # approved and still bounced, which reads as the approval not working.
    invalidate_for(member["email"])
    _log.info("access_request_approved", email=member["email"], by=admin.email,
              roles=roles, attempts=request["attempt_count"])
    record_admin_change(admin.email, "org.access_request_approved",
                        f"user:{member['email']}", roles=roles,
                        attempts=request["attempt_count"])
    return ApproveResult(
        email=member["email"], status=member["status"], roles=roles,
    )


@router.post("/members/requests/{email}/deny",
             summary="Deny a sign-in request",
             dependencies=[require_permission("admin:members:invite")])
async def deny_access_request(
    email: str,
    admin: UserContext = Depends(require_admin_user),
) -> dict[str, str]:
    """Mark the request denied. Nothing is provisioned.

    A denied address that keeps signing in still bumps ``last_seen_at`` and
    ``attempt_count`` — that is the resolver's upsert, which never touches
    ``status`` — so the row stays out of the owner's queue rather than
    reappearing on the next sign-in.
    """
    db = await get_db()
    async with db:
        request = await _load_request(db, email)
        await _decide(db, request["email"].lower(), "denied", admin)
        await db.commit()

    _log.info("access_request_denied", email=request["email"], by=admin.email,
              attempts=request["attempt_count"])
    record_admin_change(admin.email, "org.access_request_denied",
                        f"user:{request['email']}",
                        attempts=request["attempt_count"])
    return {"status": "denied", "email": request["email"]}
