"""FastAPI dependency helpers for RBAC (WBS 1.7).

Usage in routes
---------------
    from acb_auth import get_current_user, require_role, UserRole

    # Any authenticated user:
    @app.post("/pull")
    async def pull(req: PullRequest, user=Depends(get_current_user)):
        ...

    # Executive-only:
    @app.post("/pull/sales", dependencies=[require_role(UserRole.EXECUTIVE)])
    async def pull_sales(req: PullRequest):
        ...

Headers (set by Next.js SSO proxy):
    X-User-Email   -- the Google-verified email (fracktal.in domain)
    X-User-Role    -- one of: executive | employee | agent
                     Falls back to "employee" if missing/unrecognised.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, HTTPException

from acb_auth.roles import UserContext, UserRole, _coerce_role


async def get_current_user(
    x_user_email: Annotated[str | None, Header(alias="X-User-Email")] = None,
    x_user_role: Annotated[str | None, Header(alias="X-User-Role")] = None,
) -> UserContext:
    """Resolve identity from SSO-injected headers.

    Never raises -- missing header produces UserContext(email=None, role=EMPLOYEE)
    so dev endpoints remain accessible. Enforcement is done by require_role().
    """
    return UserContext(
        email=x_user_email,
        role=_coerce_role(x_user_role),
    )


def require_role(*allowed: UserRole) -> Depends:
    """Return a FastAPI Depends that 403s if the caller role is not in allowed."""
    allowed_set = frozenset(allowed)

    async def _check(user: Annotated[UserContext, Depends(get_current_user)]) -> UserContext:
        if user.role not in allowed_set:
            raise HTTPException(
                status_code=403,
                detail=(
                    f"Forbidden: role '{user.role}' is not allowed. "
                    f"Required: {sorted(r.value for r in allowed_set)}."
                ),
            )
        return user

    return Depends(_check)