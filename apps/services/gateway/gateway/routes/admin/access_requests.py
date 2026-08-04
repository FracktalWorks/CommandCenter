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

Three things worth knowing before editing:

1. **The ``/admin`` auth floor is per-route, not a package property.**
   ``_common.py`` creates the router with **no** ``dependencies=``; every route
   declares ``Depends(require_admin_user)`` in its own signature. A route added
   here that omits it inherits no floor at all and is reachable by any
   authenticated member. ``tests/unit/test_signin_requests.py`` pins that.
2. **No new permission slug.** Approve and deny reuse
   ``admin:members:invite``, which the roles seed already grants. A brand-new
   slug is nobody's grant until an admin creates it — which would switch the
   feature off for the owner too (the N4 lesson, spec §4).
3. **A decided request is not a re-usable handle.** Both writes are gated on
   ``admin:members:invite``, which is *weaker* than the
   ``admin:members:manage`` that suspends or off-boards somebody. Rows are kept
   after a decision (§6 done-when 9) and the tab renders only `pending`, so a
   decided row is invisible **and** still findable — exactly the shape that
   lets a weaker permission quietly reverse a stronger one. ``_load_request``
   takes the statuses it will act on as a required argument, and
   ``_common._PROVISION_MEMBER_SQL`` refuses to activate anything that is not
   `invited`. Two locks, because either alone is one edit away from open.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, is_company_email, require_permission
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

#: The owner's inbox. Held as a constant so the fence can read it: the fake DB
#: in ``tests/unit/test_signin_requests.py`` ignores ``ORDER BY`` entirely, so
#: "newest knock first" (§6 done-when 6) is only ever a claim about THIS STRING.
_PENDING_REQUESTS_SQL = (
    _REQUEST_COLUMNS + " WHERE status = 'pending' ORDER BY last_seen_at DESC"
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
    #: The address is outside ``ALLOWED_EMAIL_DOMAIN``. Resolved on the server
    #: because the domain is server policy and the browser must not re-derive
    #: it. See :func:`_entry` for why the row has to say so.
    is_external: bool = False


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
    """Project one row, flagging an address from outside the company domain.

    **Why the flag exists.** ``deps.get_current_user`` branch 1a only *logs* an
    off-domain identity (`auth.identity_domain_mismatch`) and passes it into
    the resolve that files this row — deliberately, so a member whose sign-in
    address is off-domain is not locked out. Nor does the Entra tenant pin
    exclude these addresses: a **B2B guest is a directory member** and
    authenticates against the tenant like anybody else, so "tenant-pinned"
    bounds who can authenticate, not who works here. Approve provisions
    `active` immediately, so the one place that difference can still be seen is
    this row — an unmarked queue makes a guest look like a colleague.
    """
    return AccessRequestEntry(
        email=row["email"],
        display_name=row["display_name"] or "",
        first_seen_at=_iso(row["first_seen_at"]),
        last_seen_at=_iso(row["last_seen_at"]),
        attempt_count=int(row["attempt_count"] or 0),
        status=row["status"],
        is_external=not is_company_email(row["email"]),
    )


async def _load_request(
    db: Any, email: str, *, allowed_statuses: tuple[str, ...]
) -> dict[str, Any]:
    """Fetch one request by email, or 404 — and refuse an already-decided row.

    ``allowed_statuses`` is keyword-only with **no default**, the same shape as
    ``routes/tasks/people._row_to_person(row, *, include_hr)``: a route added
    later must state which rows it is entitled to act on rather than inherit
    the permissive answer by omission.

    **This filter is a security boundary, not tidiness.** A decided row
    outlives its decision — that is the point of keeping it (§6 done-when 9) —
    so without this check the decided row is still findable and re-POSTing
    approve re-runs provisioning. Combined with an off-boarding
    (``DELETE /admin/members/{email}``, gated ``admin:members:manage``) that
    turned a `removed` row back into `active` on the weaker
    ``admin:members:invite``: a decision taken under the stronger permission,
    reversed by the weaker one, and invisible because the Requests tab renders
    only `pending`. ``_common._PROVISION_MEMBER_SQL`` closes the same hole from
    the other end; both are here on purpose.

    The refusal is checked in Python rather than bound into the ``WHERE``
    clause deliberately: the fake DB the tests run against matches SQL on
    substrings and does not evaluate predicates, so a filter hidden in the SQL
    would be unfenceable by a behavioural test, and an admin looking at a stale
    tab deserves "already approved by X" rather than "no such request".
    """
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
    request = dict(row)
    if request["status"] not in allowed_statuses:
        raise HTTPException(
            status_code=409,
            detail=(
                f"This sign-in request was already {request['status']}"
                + (f" by {request['decided_by']}" if request["decided_by"] else "")
                + ". A decided request cannot be decided again — manage the "
                  "member from the roster instead."
            ),
        )
    return request


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
        rows = (await db.execute(text(_PENDING_REQUESTS_SQL))).mappings().all()
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
    invariants 1 and 2 apply here too: an admin cannot approve somebody
    straight into `owner`, and approving the last owner with the default
    `member` role cannot silently drop the org's only owner grant.

    **Only a `pending` request can be approved.** Two admins clicking the same
    row is a normal race and must never produce two members; the loser now
    learns *why* (409, naming the decision) instead of receiving a 200 that
    silently did nothing. That 200 was also the vehicle for a real escalation —
    a request approved, the member later off-boarded under
    ``admin:members:manage``, and the same row re-approved under the weaker
    ``admin:members:invite`` to put them back. See ``_load_request``.
    """
    db = await get_db()
    async with db:
        request = await _load_request(db, email, allowed_statuses=("pending",))
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

    **Re-denying a denied row is harmless and stays allowed**, so a stale tab
    or a double click answers 200 rather than an error nobody can act on: deny
    provisions nobody, revokes nothing and takes no access away, so replaying
    it changes only ``decided_by``/``decided_at``. Denying an **approved**
    request is refused (409): it would not touch the live member it created,
    so the only thing it could achieve is a queue record that contradicts the
    roster. Suspend or remove them from the roster instead.
    """
    db = await get_db()
    async with db:
        request = await _load_request(
            db, email, allowed_statuses=("pending", "denied"),
        )
        await _decide(db, request["email"].lower(), "denied", admin)
        await db.commit()

    _log.info("access_request_denied", email=request["email"], by=admin.email,
              attempts=request["attempt_count"])
    record_admin_change(admin.email, "org.access_request_denied",
                        f"user:{request['email']}",
                        attempts=request["attempt_count"])
    return {"status": "denied", "email": request["email"]}
