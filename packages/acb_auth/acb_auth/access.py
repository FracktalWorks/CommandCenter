"""DB-backed resolution of a member's effective access.

Reads the org/role/override tables from ``infra/postgres/128_org_access_control.sql``
and turns an email into an :class:`~acb_auth.permissions.EffectiveAccess`.
Pure matching logic lives in :mod:`acb_auth.permissions`; this module is the
I/O half.

Spec: ``ai-company-brain/specs/org_access_control.md`` §5.

Why resolve per request instead of stuffing permissions in the session JWT: a
JWT outlives an access change. "I revoked WhatsApp an hour ago and they still
have it" is the failure that makes people stop trusting the whole model, so
the session carries identity only and access is resolved server-side behind a
short TTL cache.
"""
from __future__ import annotations

import os
import time
from typing import Any

from acb_common import get_logger

from acb_auth.permissions import (
    LEGACY_ROLE_MAP,
    EffectiveAccess,
    build_access,
)

_log = get_logger("acb_auth.access")

#: Short enough that a revocation lands within a minute, long enough that a
#: chatty page does not issue one query per API call.
CACHE_TTL_SECONDS = 60.0

#: Possession of the internal bearer token is already total authority (it can
#: assert any X-User-Email), so the service principal is granted everything
#: rather than pretending to a narrower set it could trivially escape.
SERVICE_ACCESS = EffectiveAccess(
    roles=frozenset({"agent_service"}),
    role_granted=frozenset({"*"}),
)

_cache: dict[str, tuple[float, EffectiveAccess]] = {}
_ENGINE: Any = None
_SESSION_FACTORY: Any = None
#: Set once the access tables are confirmed missing, so we degrade to the
#: legacy mapping without re-querying a failing table on every request.
_tables_missing = False


# ── Engine (same recipe as gateway routes/apps/_common.py) ──────────────────

def _get_session_factory() -> Any:
    global _ENGINE, _SESSION_FACTORY
    if _SESSION_FACTORY is None:
        from sqlalchemy.ext.asyncio import (  # noqa: PLC0415
            async_sessionmaker,
            create_async_engine,
        )
        from acb_common import get_settings  # noqa: PLC0415

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


# ── Cache ───────────────────────────────────────────────────────────────────

def invalidate(email: str | None = None) -> None:
    """Drop cached access for one member, or everyone when email is None.

    Every admin write path calls this. Without it the 60s TTL becomes the
    latency of a permission change, which is fine for revocation-by-timeout
    but infuriating for an admin watching a toggle appear to do nothing.
    """
    if email:
        _cache.pop(email.lower().strip(), None)
    else:
        _cache.clear()


def _cache_get(email: str) -> EffectiveAccess | None:
    hit = _cache.get(email)
    if hit is None:
        return None
    expires_at, access = hit
    if expires_at < time.monotonic():
        _cache.pop(email, None)
        return None
    return access


def _cache_put(email: str, access: EffectiveAccess) -> None:
    _cache[email] = (time.monotonic() + CACHE_TTL_SECONDS, access)


# ── Legacy fallback ─────────────────────────────────────────────────────────

def legacy_fallback_enabled() -> bool:
    """Whether a missing access table degrades to the legacy role mapping.

    **Off by default** since BO-2 residual #1 landed. Before authentication was
    enforced app-wide, refusing everyone when the tables were absent would have
    been an outage with no way back in, so the fallback was automatic. Now that
    an unauthenticated caller is rejected outright, the remaining case is an
    authenticated member on a deployment whose migration has not run — and
    quietly granting them an *approximation* of access is worse than refusing:
    it is the access model silently not being the access model.

    Deploy order makes this safe: ``.github/workflows/deploy.yml`` runs
    ``apply_migrations.sh`` before restarting the gateway, so by the time this
    code serves traffic the tables exist.

    ``ACCESS_LEGACY_FALLBACK=1`` re-enables it. That is the recovery hatch for
    a failed migration — turn it on, fix the migration, turn it off.
    """
    return os.getenv("ACCESS_LEGACY_FALLBACK", "").strip().lower() in {
        "1", "true", "yes", "on",
    }


def legacy_access(role: str | None) -> EffectiveAccess:
    """Approximate the pre-128 world from the legacy ``executive``/``employee``.

    Reached only when the access tables are absent AND
    :func:`legacy_fallback_enabled` is on — see spec §7. A member whose row
    *does* exist never lands here; an unknown user resolves to nothing.
    """
    slug = LEGACY_ROLE_MAP.get((role or "employee").lower(), "member")
    if slug in ("admin", "agent_service"):
        return build_access(
            ["feature:*", "agents:run:*", "agents:manage", "apps:use:*",
             "apps:create", "apps:publish", "admin:members:read",
             "admin:members:invite", "admin:members:manage",
             "admin:roles:manage", "admin:access:manage",
             "admin:settings:manage", "admin:audit:read",
             "integrations:manage", "data:org:read"],
            roles=[slug],
        )
    return build_access(
        ["feature:chat", "feature:email", "feature:tasks", "feature:notes",
         "feature:memory", "feature:dashboard", "feature:artifacts",
         "agents:run:*", "apps:use:*"],
        roles=[slug],
    )


def _degraded(legacy_role: str | None) -> EffectiveAccess:
    """What a failed/absent access lookup resolves to.

    Fail CLOSED unless the operator opted into the legacy mapping. See
    :func:`legacy_fallback_enabled` for why the default flipped.
    """
    if legacy_fallback_enabled():
        return legacy_access(legacy_role)
    return EffectiveAccess(is_active=False)


# ── Resolution ──────────────────────────────────────────────────────────────

_ACCESS_SQL = """
    SELECT u.id::text                       AS user_id,
           u.organization_id::text          AS organization_id,
           u.status                         AS status,
           u.role                           AS legacy_role,
           COALESCE(
               (SELECT array_agg(DISTINCT r.slug)
                  FROM user_role ur
                  JOIN org_role r ON r.id = ur.role_id
                 WHERE ur.user_id = u.id),
               ARRAY[]::text[]
           )                                AS roles,
           COALESCE(
               (SELECT array_agg(DISTINCT rp.permission)
                  FROM user_role ur
                  JOIN org_role_permission rp ON rp.role_id = ur.role_id
                 WHERE ur.user_id = u.id),
               ARRAY[]::text[]
           )                                AS role_permissions,
           COALESCE(
               (SELECT array_agg(o.permission || '=' || o.effect)
                  FROM user_permission_override o
                 WHERE o.user_id = u.id),
               ARRAY[]::text[]
           )                                AS overrides
      FROM app_user u
     WHERE lower(u.email) = :email
     LIMIT 1
"""


async def resolve_access(
    email: str | None,
    *,
    legacy_role: str | None = None,
    use_cache: bool = True,
) -> EffectiveAccess:
    """Resolve a member's effective access by email.

    An unknown email resolves to no access. A suspended or removed member
    resolves to no access regardless of the roles still on their row — the
    status check is not a filter on the query but a property of the result, so
    a stale cache entry can never outlive a suspension by more than the TTL.
    """
    global _tables_missing

    if not email:
        return EffectiveAccess(is_active=False)
    key = email.lower().strip()

    if use_cache:
        cached = _cache_get(key)
        if cached is not None:
            return cached

    if _tables_missing:
        return _degraded(legacy_role)

    try:
        from sqlalchemy import text  # noqa: PLC0415

        factory = _get_session_factory()
        async with factory() as session:
            row = (
                await session.execute(text(_ACCESS_SQL), {"email": key})
            ).mappings().first()
    except Exception as exc:  # noqa: BLE001
        # Distinguish "migration hasn't run" (degrade to legacy, permanently)
        # from a transient DB blip (degrade for this request only).
        message = str(exc).lower()
        if "does not exist" in message or "undefinedtable" in message:
            _tables_missing = True
            _log.error(
                "access_tables_missing",
                detail=(
                    "apply infra/postgres/128_org_access_control.sql. Members "
                    "resolve to NO ACCESS until it runs; set "
                    "ACCESS_LEGACY_FALLBACK=1 to degrade to the legacy "
                    "executive/employee mapping instead."
                ),
            )
        else:
            _log.warning("access_resolve_failed", error=str(exc))
        return _degraded(legacy_role)

    if row is None:
        # Authenticated by the IdP but not provisioned here. No access, and
        # deliberately not auto-provisioned: an admin invites people.
        return EffectiveAccess(is_active=False)

    overrides: list[tuple[str, str]] = []
    for entry in row["overrides"] or []:
        perm, _, effect = str(entry).rpartition("=")
        if perm and effect in ("allow", "deny"):
            overrides.append((perm, effect))

    access = build_access(
        row["role_permissions"] or [],
        overrides,
        roles=row["roles"] or [],
        is_active=row["status"] == "active",
    )

    if use_cache:
        _cache_put(key, access)
    return access


async def resolve_identity(email: str | None) -> tuple[str | None, str | None]:
    """Return ``(user_id, organization_id)`` for an email, or ``(None, None)``."""
    if not email:
        return None, None
    try:
        from sqlalchemy import text  # noqa: PLC0415

        factory = _get_session_factory()
        async with factory() as session:
            row = (
                await session.execute(
                    text(
                        "SELECT id::text AS id, organization_id::text AS org "
                        "FROM app_user WHERE lower(email) = :email LIMIT 1"
                    ),
                    {"email": email.lower().strip()},
                )
            ).mappings().first()
    except Exception:  # noqa: BLE001
        return None, None
    if row is None:
        return None, None
    return row["id"], row["org"]
