"""``GET /auth/me`` — the caller's own identity and effective access.

Separate router (no ``/admin`` prefix, no admin permission) because every
signed-in member needs this: it is what the Control Plane filters the sidebar
and guards routes with. Asking for your own access is not an administrative
action.

It returns *resolved outcomes* — a list of allowed feature slugs and runnable
agents — rather than raw permission patterns for the client to evaluate. Two
implementations of the matching rule (one Python, one TypeScript) is one
implementation too many; the server decides and the client renders.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from acb_auth.permissions import CAPABILITIES
from fastapi import APIRouter, Depends

from gateway.routes.admin._common import get_db, get_org_id

me_router = APIRouter(prefix="/auth", tags=["auth"])


def _agent_names() -> list[str]:
    try:
        from gateway.routes.agent import (  # noqa: PLC0415
            _AGENT_REGISTRY,
            _load_dynamic_agents,
        )

        names = {a["name"] for a in _AGENT_REGISTRY}
        try:
            names |= {a["name"] for a in _load_dynamic_agents()}
        except Exception:  # noqa: BLE001
            pass
        return sorted(names)
    except Exception:  # noqa: BLE001
        return []


@me_router.get("/me", summary="Current user's identity and effective access")
async def get_me(user: UserContext = Depends(get_current_user)) -> dict[str, Any]:
    access = user.access

    organization: dict[str, str] = {}
    try:
        db = await get_db()
        async with db:
            org_id = await get_org_id(db)
            from sqlalchemy import text  # noqa: PLC0415

            row = (
                await db.execute(
                    text(
                        "SELECT slug, display_name FROM organization "
                        " WHERE id = CAST(:id AS uuid)"
                    ),
                    {"id": org_id},
                )
            ).mappings().first()
            if row:
                organization = {
                    "id": org_id,
                    "slug": row["slug"],
                    "display_name": row["display_name"],
                }
    except Exception:  # noqa: BLE001
        # An unprovisioned org must not stop a member from loading the app —
        # the access set is authoritative either way.
        organization = {}

    return {
        "email": user.email or "",
        "user_id": user.user_id or "",
        "authenticated": bool(user.email),
        "is_active": access.is_active,
        "organization": organization,
        "roles": sorted(access.roles),
        # Legacy coarse role, still consumed by pre-migration UI checks.
        "legacy_role": user.role.value,
        "features": list(access.allowed_features()),
        "agents": [n for n in _agent_names() if access.can_run_agent(n)],
        "permissions": sorted(access.granted),
        # Resolved yes/no for every concrete capability, so the browser never
        # re-implements the wildcard rule (an owner holds "*", not the literal
        # string). `permissions` above stays the raw grant patterns for the
        # admin screens that display them. Wildcard capabilities are omitted:
        # they are answered per-target ("agents" above), not as a flat yes.
        "capabilities": [
            c for c in CAPABILITIES if "*" not in c and access.has(c)
        ],
        "denied": sorted(access.denied),
        "is_admin": access.has("admin:members:read"),
    }
