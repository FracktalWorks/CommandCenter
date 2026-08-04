"""Org administration routes — shared kernel.

DB access, the org lookup, and the invariants every write path in this package
has to respect. Spec: ``ai-company-brain/specs/org_access_control.md``.

The three invariants, stated once here because they are the difference between
an access model and an outage:

1. **The org always has an owner.** Every path that could remove the last
   `owner` assignment refuses. A deployment with no owner is one where nobody
   can grant access back, and the only recovery is SQL on the production box.
2. **Nobody grants above themselves.** Role assignment is checked against the
   caller's own lowest rank, so an `admin` cannot mint an `owner`.
3. **System roles are immutable.** The five seeded roles are the floor the
   bootstrap path depends on; custom roles are where admins express local
   policy.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

from acb_auth import UserContext, get_current_user, invalidate_access
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

        settings = get_settings()
        db_url = os.environ.get("DATABASE_URL", settings.database_url)
        if "postgresql+psycopg" in db_url:
            db_url = db_url.replace("postgresql+psycopg", "postgresql+asyncpg")
        elif db_url.startswith("postgresql://"):
            db_url = db_url.replace("postgresql://", "postgresql+asyncpg://")
        _ENGINE = create_async_engine(
            db_url, echo=False, pool_pre_ping=True,
            pool_size=5, max_overflow=10, pool_recycle=1800,
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


async def get_member(db: Any, email: str) -> dict[str, Any]:
    """Fetch one member row by email, or 404."""
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
    if row is None:
        raise HTTPException(status_code=404, detail=f"No member '{email}'.")
    return dict(row)


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
    exactly the same code — including invariant 2, which a second hand-rolled
    INSERT would quietly skip. Spec ``colleague_onboarding.md`` §6 done-when 8.

    Deliberately left to the CALLER: ``db.commit()`` (so an approval can mark
    its request decided in the same transaction), ``invalidate_for``,
    ``record_admin_change`` (the audit action differs — `org.member_invited`
    vs `org.access_request_approved`) and the response model.

    ``status`` is what a NEW row gets. On an existing row it is applied only
    when that row is `removed` or `invited`; `active` and `suspended` are left
    exactly as they are. That arm is load-bearing in both directions:

    * invite (``status='invited'``) keeps today's behaviour byte-for-byte — a
      removed member comes back as invited, an active one is not downgraded;
    * approve (``status='active'``) lets an invited-but-never-activated row
      through in ONE action (§6 done-when 7, the fix for §2's two-click trap),
      while refusing to un-suspend anybody: approve is gated on
      ``admin:members:invite``, which is weaker than the
      ``admin:members:manage`` that suspended them.
    """
    email = (email or "").strip().lower()
    if "@" not in email or len(email) > 254:
        raise HTTPException(status_code=400, detail="A valid email is required.")

    role_ids = await resolve_assignable_roles(db, org_id, roles or ["member"], admin)

    await db.execute(
        text(
            "INSERT INTO app_user (email, display_name, organization_id, "
            "                      status, invited_by, invited_at, joined_at) "
            "VALUES (:email, :name, CAST(:org AS uuid), :status, :by, now(), "
            "        CASE WHEN :status = 'active' THEN now() END) "
            "ON CONFLICT (email) DO UPDATE "
            "   SET organization_id = EXCLUDED.organization_id, "
            "       display_name    = COALESCE(NULLIF(EXCLUDED.display_name, ''), "
            "                                  app_user.display_name), "
            "       status          = CASE WHEN app_user.status IN ('removed', 'invited') "
            "                              THEN :status ELSE app_user.status END, "
            "       joined_at       = CASE WHEN app_user.status IN ('removed', 'invited') "
            "                               AND :status = 'active' "
            "                              THEN COALESCE(app_user.joined_at, now()) "
            "                              ELSE app_user.joined_at END, "
            "       updated_at      = now()"
        ),
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
