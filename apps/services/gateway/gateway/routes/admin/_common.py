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
                "infra/postgres/128_org_access_control.sql."
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


def invalidate_for(*emails: str | None) -> None:
    """Drop cached access so an admin change lands immediately, not in 60s."""
    for email in emails:
        if email:
            invalidate_access(email)
