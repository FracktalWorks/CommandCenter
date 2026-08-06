"""Org administration routes — shared kernel.

DB access, the org lookup, and the invariants every write path in this package
has to respect. Spec: ``ai-company-brain/specs/org_access_control.md``.

The four invariants, stated once here because they are the difference between
an access model and an outage:

1. **The org always has an owner.** Every path that could remove the last
   `owner` assignment refuses. A deployment with no owner is one where nobody
   can grant access back, and the only recovery is SQL on the production box.
2. **Nobody grants above themselves.** Role assignment is checked against the
   caller's own lowest rank, so an `admin` cannot mint an `owner`.
3. **System roles are immutable.** The five seeded roles are the floor the
   bootstrap path depends on; custom roles are where admins express local
   policy.
4. **Nobody locks themselves out**, by any of the **four** doors that reach it.
   A caller may not put their own row into any status other than `active`
   (:func:`assert_not_self_lockout`, called by ``PATCH`` and ``DELETE`` on
   ``/admin/members/{email}`` **and by ``DELETE /members/{email}/purge``**),
   and may not strip their own row of ``admin:members:manage``
   (:func:`assert_not_self_demotion`, called by ``PUT /members/{email}/roles``)
   — that door leaves `status` alone and takes the *permission* instead,
   reaching the same lockout without touching the column the others guard.
   Invariant 1 is not a substitute for any of them: it refuses only while the
   caller is the *last* owner, which is a coincidence of org size, not a rule.

   ⚠️ A **fifth** route reaches the same outcome and guards it with its own
   inline comparison: ``PUT /members/{email}/overrides`` refuses a caller who
   denies themselves ``admin:access:manage``. It is not routed through the
   helper below and is therefore invisible to the door-enumeration test.
   Recorded, not fixed here — see ``colleague_onboarding.md`` §2 Step 5.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

from acb_auth import (
    UserContext,
    get_current_user,
    invalidate_access,
    permission_matches,
)
from acb_common import get_logger, get_settings
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text

_log = get_logger("gateway.admin")

router = APIRouter(prefix="/admin", tags=["admin"])

#: Slug of the single organization this deployment serves. The column exists on
#: every table so a second org is a data change; resolving it through one
#: constant keeps that future honest without shipping an org switcher today.
DEFAULT_ORG_SLUG = "default"

#: Never assignable to a person — it is the internal service principal.
NON_ASSIGNABLE_ROLES = frozenset({"agent_service"})


# ── DB (shared pooled async engine, same recipe as routes/apps/_common.py) ───

_ENGINE = None
_SESSION_FACTORY = None


def _get_session_factory() -> Any:
    global _ENGINE, _SESSION_FACTORY
    if _SESSION_FACTORY is None:
        from sqlalchemy.ext.asyncio import (  # noqa: PLC0415
            async_sessionmaker,
            create_async_engine,
        )

        from gateway.db import engine_connect_args
        settings = get_settings()
        db_url = os.environ.get("DATABASE_URL", settings.database_url)
        if "postgresql+psycopg" in db_url:
            db_url = db_url.replace("postgresql+psycopg", "postgresql+asyncpg")
        elif db_url.startswith("postgresql://"):
            db_url = db_url.replace("postgresql://", "postgresql+asyncpg://")
        _ENGINE = create_async_engine(
            db_url, echo=False, pool_pre_ping=True,
            pool_size=5, max_overflow=10, pool_recycle=1800,
            connect_args=engine_connect_args(),
        )
        _SESSION_FACTORY = async_sessionmaker(_ENGINE, expire_on_commit=False)
    return _SESSION_FACTORY


async def get_db() -> Any:
    """Return a new async session from the shared, pooled engine."""
    return _get_session_factory()()


# ── Auth gate ───────────────────────────────────────────────────────────────

async def require_admin_user(
    user: UserContext = Depends(get_current_user),
) -> UserContext:
    """Any admin surface: 401 anonymous, 403 without ``admin:members:read``.

    Read access is the floor for the whole package; individual write routes
    add their own narrower `require_permission`.
    """
    if not user.email:
        raise HTTPException(status_code=401, detail="Authentication required")
    if not user.has_permission("admin:members:read"):
        raise HTTPException(
            status_code=403, detail="Forbidden: missing permission 'admin:members:read'."
        )
    return user


# ── Org + role lookups ──────────────────────────────────────────────────────

async def get_org_id(db: Any) -> str:
    """Resolve the deployment's organization id, or 503 if unprovisioned."""
    row = (
        await db.execute(
            text("SELECT id::text AS id FROM organization WHERE slug = :slug"),
            {"slug": DEFAULT_ORG_SLUG},
        )
    ).mappings().first()
    if row is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "Organization not provisioned. Apply "
                "infra/postgres/130_org_access_control.sql."
            ),
        )
    return row["id"]


async def find_member(db: Any, email: str) -> dict[str, Any] | None:
    """Fetch one member row by email, or ``None``.

    The non-raising half of :func:`get_member`. Provisioning needs it: it has
    to know whether the address already has a row *before* it writes one, and
    a 404 is the wrong answer there — an absent row is the normal case.
    """
    row = (
        await db.execute(
            text(
                "SELECT id::text AS id, email, display_name, avatar_url, status, "
                "       role AS legacy_role, invited_by, invited_at, joined_at, "
                "       last_login_at, last_active_at, created_at "
                "  FROM app_user WHERE lower(email) = :email"
            ),
            {"email": email.lower().strip()},
        )
    ).mappings().first()
    return dict(row) if row is not None else None


async def get_member(db: Any, email: str) -> dict[str, Any]:
    """Fetch one member row by email, or 404."""
    row = await find_member(db, email)
    if row is None:
        raise HTTPException(status_code=404, detail=f"No member '{email}'.")
    return row


async def get_role(db: Any, org_id: str, slug: str) -> dict[str, Any]:
    """Fetch one role row by slug, or 404."""
    row = (
        await db.execute(
            text(
                "SELECT id::text AS id, slug, display_name, description, "
                "       is_system, rank "
                "  FROM org_role WHERE organization_id = CAST(:org AS uuid) AND slug = :slug"
            ),
            {"org": org_id, "slug": slug},
        )
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail=f"No role '{slug}'.")
    return dict(row)


async def roles_for_user(db: Any, user_id: str) -> list[str]:
    rows = (
        await db.execute(
            text(
                "SELECT r.slug FROM user_role ur "
                "  JOIN org_role r ON r.id = ur.role_id "
                " WHERE ur.user_id = CAST(:uid AS uuid) ORDER BY r.rank"
            ),
            {"uid": user_id},
        )
    ).scalars().all()
    return list(rows)


async def caller_rank(db: Any, org_id: str, user: UserContext) -> int:
    """The caller's most-privileged rank (lower = more privileged).

    The internal service principal and anyone holding ``*`` rank as owner;
    everyone else is bounded by the roles actually on their row.
    """
    if user.has_permission("*"):
        return 0
    rows = (
        await db.execute(
            text(
                "SELECT MIN(r.rank) AS rank "
                "  FROM app_user u "
                "  JOIN user_role ur ON ur.user_id = u.id "
                "  JOIN org_role r   ON r.id = ur.role_id "
                " WHERE lower(u.email) = :email AND r.organization_id = CAST(:org AS uuid)"
            ),
            {"email": (user.email or "").lower(), "org": org_id},
        )
    ).mappings().first()
    rank = rows["rank"] if rows else None
    return int(rank) if rank is not None else 1000


async def owner_count(db: Any, org_id: str, *, excluding_user_id: str | None = None) -> int:
    """How many active members would still hold `owner`."""
    sql = (
        "SELECT count(*) FROM user_role ur "
        "  JOIN org_role r ON r.id = ur.role_id "
        "  JOIN app_user u ON u.id = ur.user_id "
        " WHERE r.organization_id = CAST(:org AS uuid) AND r.slug = 'owner' "
        "   AND u.status = 'active'"
    )
    params: dict[str, Any] = {"org": org_id}
    if excluding_user_id:
        sql += " AND u.id <> CAST(:uid AS uuid)"
        params["uid"] = excluding_user_id
    return int((await db.execute(text(sql), params)).scalar() or 0)


async def assert_owner_survives(
    db: Any, org_id: str, *, excluding_user_id: str
) -> None:
    """Refuse a change that would leave the organization ownerless."""
    if await owner_count(db, org_id, excluding_user_id=excluding_user_id) == 0:
        raise HTTPException(
            status_code=409,
            detail=(
                "This would leave the organization with no owner. "
                "Assign another owner first."
            ),
        )


#: The outcome name a purge passes to :func:`assert_not_self_lockout`. It is
#: deliberately **not** a member of ``members.VALID_STATUSES``: a purge does not
#: set ``app_user.status``, it deletes the row. The helper's rule is "anything
#: that is not `active`", so a door that reaches ``is_active = False`` by
#: destroying the row is covered by the same sentence as one that writes a
#: column — which is the entire reason the rule was written that way and not as
#: a list of destructive statuses. Held as a constant so the route and the
#: wording table below cannot drift to two different spellings.
PURGE_OUTCOME = "purged"

#: How the refusal reads back to the caller who asked for it. Only the outcomes
#: a human actually chooses are worded; anything else falls through to the
#: generic message, because the RULE below is ``status != "active"`` and not
#: this table — a fifth `app_user.status` is guarded the day it is added rather
#: than the day somebody remembers to list it here.
_SELF_LOCKOUT_WORDING = {
    "removed": "You cannot remove yourself.",
    "suspended": "You cannot suspend yourself.",
    PURGE_OUTCOME: "You cannot permanently delete yourself.",
}

_SELF_LOCKOUT_ADVICE = "Ask another owner or admin to do it."


def assert_not_self_lockout(
    admin: UserContext, member: dict[str, Any], *, status: str | None
) -> None:
    """Refuse a caller who is taking their own access away — invariant 4.

    **One rule, two call sites.** ``PATCH /admin/members/{email}`` with a
    status and ``DELETE /admin/members/{email}`` reach the same
    ``is_active = False`` by the same mechanism, and the version of this check
    that lived *inside* the DELETE handler alone is exactly how the two doors
    came to disagree: the PATCH had no self-check at all, and its only
    invariant — :func:`assert_owner_survives` — refuses self-suspension solely
    by coincidence in an org that has one owner. Add a second owner (which §2
    Step 2 of ``colleague_onboarding.md`` exists to do) and either owner could
    suspend themselves out of the admin surface in one click, with
    ``admin:members:manage`` the floor for getting back in.

    The rule is stated as **"any status that is not `active`"**, never as a list
    of destructive ones: ``EffectiveAccess.is_active`` is ``status ==
    "active"`` exactly, so `invited` locks the caller out just as `suspended`
    does. ``status=None`` — a display-name-only patch — changes no access and
    passes.

    Case-insensitive on both sides. ``app_user.email`` and ``X-User-Email``
    come from the same directory but not necessarily with the same casing, and
    an IdP that returns a UPN cased differently between sessions must not
    silently switch the guard off (the property ``core.load_owned_meeting``
    preserves for Notes). An empty address on either side matches nothing — a
    caller with no identity of their own is not everybody.
    """
    if status is None or status == "active":
        return
    me = (admin.email or "").strip().lower()
    them = (member.get("email") or "").strip().lower()
    if not me or not them or me != them:
        return
    wording = _SELF_LOCKOUT_WORDING.get(
        status,
        f"You cannot set your own membership to '{status}' — "
        "it would take away your own access.",
    )
    raise HTTPException(status_code=409, detail=f"{wording} {_SELF_LOCKOUT_ADVICE}")


#: The capability a caller needs to undo whatever they just did to themselves.
#: It is the gate on all three doors — ``PATCH``, ``DELETE`` and ``PUT
#: …/roles`` — so a caller who no longer holds it cannot restore their own row
#: by any route.
SELF_RECOVERY_PERMISSION = "admin:members:manage"

#: Read as the third door's fence. Held as a constant for the same reason
#: ``_PROVISION_MEMBER_SQL`` is: the test fake answers it from a Python mapping,
#: and a mirror can only ever agree with itself.
_ROLE_PERMISSIONS_SQL = (
    "SELECT permission FROM org_role_permission "
    " WHERE role_id = ANY(CAST(:ids AS uuid[]))"
)


async def assert_not_self_demotion(
    db: Any,
    admin: UserContext,
    member: dict[str, Any],
    *,
    role_ids: list[tuple[str, str]],
) -> None:
    """Invariant 4's **third door**: ``PUT /admin/members/{email}/roles``.

    :func:`assert_not_self_lockout` closes the two doors that set
    ``status``. This one closes the door that leaves the status alone and
    takes the *permission* away instead — the outcome is the same lockout,
    reached by a route that never touches ``app_user.status``.

    Measured before this existed, in the two-owner world that
    ``colleague_onboarding.md`` §2 Step 2 exists to create: an owner calling
    ``PUT /admin/members/<their own address>/roles {"roles": ["member"]}`` was
    **accepted**. They kept `status = 'active'` and lost
    ``admin:members:manage``, which is the floor for undoing it — so recovery
    was the other owner, or hand-run SQL. With a single owner the call
    happened to be refused, but by :func:`assert_owner_survives` and its
    wording, i.e. by the same coincidence invariant 4 was written to stop
    relying on.

    ``{"roles": []}`` is **not** the sequence — a separate check rejects an
    empty set. The reachable one is a self-demotion to any role that does not
    carry the recovery permission.

    Checked against the permissions the *new* roles actually grant rather than
    against a list of role slugs, because a custom role may carry
    ``admin:members:manage`` and a seeded-slug allowlist would refuse a
    legitimate self-edit. Wildcards resolve through
    :func:`acb_auth.permission_matches`, so an owner holding ``*`` passes.
    """
    me = (admin.email or "").strip().lower()
    them = (member.get("email") or "").strip().lower()
    if not me or not them or me != them:
        return

    ids = [rid for rid, _slug in role_ids]
    if ids:
        granted = (
            await db.execute(text(_ROLE_PERMISSIONS_SQL), {"ids": ids})
        ).scalars().all()
        if any(
            permission_matches(str(p), SELF_RECOVERY_PERMISSION)
            for p in granted
        ):
            return

    raise HTTPException(
        status_code=409,
        detail=(
            "You cannot take your own member-management rights away — you "
            "would not be able to give them back. " + _SELF_LOCKOUT_ADVICE
        ),
    )


# ── Provisioning: the one path from an address to a member ──────────────────

def _iso(value: Any) -> str:
    """Timestamps on the wire are UTC ISO-8601, and absence is ``""``."""
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return "" if value is None else str(value)


async def resolve_assignable_roles(
    db: Any, org_id: str, slugs: list[str], admin: UserContext
) -> list[tuple[str, str]]:
    """Validate role slugs and return ``[(role_id, slug)]``.

    Enforces invariant 2: an admin cannot assign a role more privileged than
    their own, so `admin` cannot mint an `owner` and escalate laterally. Lives
    in the leaf because it IS one of this package's invariants — every path
    that hands somebody a role goes through it.
    """
    if not slugs:
        raise HTTPException(status_code=400, detail="At least one role is required.")

    rows = (
        await db.execute(
            text(
                "SELECT id::text AS id, slug, rank FROM org_role "
                " WHERE organization_id = CAST(:org AS uuid) AND slug = ANY(:slugs)"
            ),
            {"org": org_id, "slugs": list(slugs)},
        )
    ).mappings().all()

    found = {r["slug"]: r for r in rows}
    missing = [s for s in slugs if s not in found]
    if missing:
        raise HTTPException(status_code=400, detail=f"Unknown role(s): {missing}.")

    blocked = [s for s in slugs if s in NON_ASSIGNABLE_ROLES]
    if blocked:
        raise HTTPException(
            status_code=400,
            detail=f"Role(s) {blocked} are internal and cannot be assigned to people.",
        )

    my_rank = await caller_rank(db, org_id, admin)
    too_high = [s for s in slugs if int(found[s]["rank"]) < my_rank]
    if too_high:
        raise HTTPException(
            status_code=403,
            detail=f"You cannot assign role(s) {too_high} — they outrank you.",
        )
    return [(found[s]["id"], s) for s in slugs]


async def set_roles(
    db: Any, user_id: str, role_ids: list[tuple[str, str]], assigned_by: str | None
) -> None:
    """Replace a member's role assignments wholesale."""
    await db.execute(
        text("DELETE FROM user_role WHERE user_id = CAST(:uid AS uuid)"),
        {"uid": user_id},
    )
    for role_id, _slug in role_ids:
        await db.execute(
            text(
                "INSERT INTO user_role (user_id, role_id, assigned_by) "
                "VALUES (CAST(:uid AS uuid), CAST(:rid AS uuid), :by) "
                "ON CONFLICT DO NOTHING"
            ),
            {"uid": user_id, "rid": role_id, "by": assigned_by},
        )


#: The one provisioning statement, held as a module constant so the fence can
#: read it. ``tests/unit/test_signin_requests.py`` asserts against THIS STRING —
#: the fake DB in that file re-implements the ``ON CONFLICT`` arms in Python and
#: a mirror can only ever agree with itself, so a behavioural test alone cannot
#: notice the guard being widened. The structural assertion is the fence.
#:
#: **The guard names the statuses it rewrites; it never names the ones it does
#: not.** A `<>`/`NOT IN` comparison against ``app_user.status`` would mean
#: "every status except…", which is how a row nobody meant to touch gets
#: rewritten — `app_user.status <> 'active'` is exactly the mutation that turns
#: approve into a way to reinstate a REMOVED member.
#:
#: The two arms, and why each is where it is:
#:
#: * ``invited`` → the caller's ``status``, unconditionally. This is the only
#:   route to `active`, and it is what makes approve one action rather than
#:   §2's two clicks (§6 done-when 7).
#: * ``removed`` → the caller's ``status``, but **never `active`**. Bringing an
#:   off-boarded person back is a `removed → active` transition, which on
#:   ``PATCH /admin/members/{email}`` requires ``admin:members:manage``; approve
#:   holds only the weaker ``admin:members:invite``. Invite (``'invited'``)
#:   passes the clause and keeps its pre-extraction behaviour byte-for-byte.
#:
#: `active` and `suspended` rows are never rewritten by either caller.
_PROVISION_MEMBER_SQL = """
    INSERT INTO app_user (email, display_name, organization_id,
                          status, invited_by, invited_at, joined_at)
    VALUES (:email, :name, CAST(:org AS uuid), :status, :by, now(),
            CASE WHEN :status = 'active' THEN now() END)
    ON CONFLICT (email) DO UPDATE
       SET organization_id = EXCLUDED.organization_id,
           display_name    = COALESCE(NULLIF(EXCLUDED.display_name, ''),
                                      app_user.display_name),
           status          = CASE
                               WHEN app_user.status = 'invited'
                                    THEN :status
                               WHEN app_user.status = 'removed'
                                    AND :status <> 'active'
                                    THEN :status
                               ELSE app_user.status
                             END,
           joined_at       = CASE
                               WHEN app_user.status = 'invited'
                                    AND :status = 'active'
                                    THEN COALESCE(app_user.joined_at, now())
                               ELSE app_user.joined_at
                             END,
           updated_at      = now()
"""


async def provision_member(
    db: Any,
    org_id: str,
    *,
    email: str,
    display_name: str,
    roles: list[str],
    admin: UserContext,
    status: str,
) -> tuple[dict[str, Any], list[str]]:
    """Create-or-update the ``app_user`` row and set its roles. THE one path.

    Extracted from ``members.invite_member`` so that approving a sign-in
    request (``access_requests.approve_access_request``) provisions through
    exactly the same code — including invariants 1 and 2, which a second
    hand-rolled INSERT would quietly skip. Spec ``colleague_onboarding.md`` §6
    done-when 8.

    Deliberately left to the CALLER: ``db.commit()`` (so an approval can mark
    its request decided in the same transaction), ``invalidate_for``,
    ``record_admin_change`` (the audit action differs — `org.member_invited`
    vs `org.access_request_approved`) and the response model.

    ``status`` is what a NEW row gets; on an existing row it is applied only by
    the arms `_PROVISION_MEMBER_SQL` names, which is where that rule is
    documented. The short version: **neither caller can activate a row that is
    not `invited`**, so approve — on the weaker ``admin:members:invite`` — can
    reverse neither a suspension nor an off-boarding, both of which are
    ``admin:members:manage`` decisions.

    Invariant 1 is enforced here rather than only in ``members.py`` because
    ``set_roles`` below **replaces** a member's assignments wholesale: inviting
    or approving the last `owner` with the default `member` role would delete
    the org's only owner grant, and the only way back is SQL on the box.
    """
    email = (email or "").strip().lower()
    if "@" not in email or len(email) > 254:
        raise HTTPException(status_code=400, detail="A valid email is required.")

    role_ids = await resolve_assignable_roles(db, org_id, roles or ["member"], admin)

    # Refuse BEFORE the upsert, like every sibling write does (`members.py`
    # `update_member` / `remove_member` / `set_member_roles`): an existing row
    # whose roles are about to be replaced by a set without `owner` is the same
    # lockout as demoting them on the roles screen. Narrower than the roles
    # route on purpose — it only asks when the grant is actually about to be
    # taken away, so provisioning is not blocked in an org that has no owner
    # yet (the bootstrap state, where nothing is being lost).
    existing = await find_member(db, email)
    if (
        existing is not None
        and "owner" not in {slug for _rid, slug in role_ids}
        # Short-circuits, so provisioning a NEW address still costs no extra
        # query — the check only asks when there is a grant to lose.
        and "owner" in await roles_for_user(db, existing["id"])
    ):
        await assert_owner_survives(db, org_id, excluding_user_id=existing["id"])

    await db.execute(
        text(_PROVISION_MEMBER_SQL),
        {"email": email, "name": display_name or "", "org": org_id,
         "by": admin.email, "status": status},
    )
    member = await get_member(db, email)
    await set_roles(db, member["id"], role_ids, admin.email)
    return member, [slug for _rid, slug in role_ids]


def invalidate_for(*emails: str | None) -> None:
    """Drop cached access so an admin change lands immediately, not in 60s."""
    for email in emails:
        if email:
            invalidate_access(email)


def record_admin_change(
    actor: str | None, action: str, target: str, **payload: Any
) -> None:
    """Append an access change to the audit log.

    Every write in this package goes through here. "Who could see what, and
    who changed it" is the first question asked after an incident and the
    first thing an access review needs; structlog alone does not survive as a
    queryable record.

    Best-effort by contract (``acb_audit.record`` logs always, DB-writes if it
    can) — an audit backend that is down must not block an admin from
    revoking someone's access.
    """
    try:
        from acb_audit import AuditEvent, record  # noqa: PLC0415

        record(AuditEvent(
            actor=f"user:{actor}" if actor else "system:internal",
            action=action,
            target=target,
            payload=payload,
        ))
    except Exception as exc:  # noqa: BLE001
        _log.warning("admin_audit_failed", action=action, error=str(exc))
