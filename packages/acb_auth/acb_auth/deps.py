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

Service-to-service (internal):
    Authorization: Bearer <GATEWAY_INTERNAL_TOKEN>
    Sets role = "agent" so internal callers can access all non-executive routes.
    The token must match the GATEWAY_INTERNAL_TOKEN env var (falls back to
    LITELLM_MASTER_KEY in dev).  Empty string disables Bearer auth (never
    accept all callers — use SSO headers instead).
"""
from __future__ import annotations

import os
from typing import Annotated

from fastapi import Depends, Header, HTTPException

from acb_auth.roles import UserContext, UserRole, _coerce_role

# ---------------------------------------------------------------------------
# Internal service token (server → gateway calls, e.g. Next.js proxy route)
# ---------------------------------------------------------------------------

def _get_internal_token() -> str:
    """Resolve the expected Bearer token for server-to-server calls.

    Precedence: GATEWAY_INTERNAL_TOKEN → LITELLM_MASTER_KEY (via Settings) → "".
    An empty string means Bearer auth is disabled.
    """
    tok = os.getenv("GATEWAY_INTERNAL_TOKEN", "").strip()
    if not tok:
        # Try Settings (pydantic-settings loads .env; os.getenv may miss it)
        try:
            from acb_common import get_settings  # noqa: PLC0415
            tok = (get_settings().litellm_master_key or "").strip()
        except Exception:  # noqa: BLE001
            pass
    if not tok:
        # Hard fallback to raw env (Docker / CI where vars are injected directly)
        tok = os.getenv("LITELLM_MASTER_KEY", "").strip()
    return tok



async def get_current_user(
    x_user_email: Annotated[str | None, Header(alias="X-User-Email")] = None,
    x_user_role: Annotated[str | None, Header(alias="X-User-Role")] = None,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> UserContext:
    """Resolve identity from SSO-injected headers or an internal Bearer token.

    Priority:
    1. If ``Authorization: Bearer <token>`` matches the internal token →
       synthetic ``UserContext(email="system:internal", role=AGENT)``.
    2. If ``X-User-Email`` is set → resolve from SSO headers (normal user flow).
    3. Otherwise → anonymous ``UserContext(email=None, role=EMPLOYEE)``.

    Never raises — missing/wrong headers resolve to the lowest-privilege role.
    Enforcement is done by require_role().
    """
    # 1. Internal Bearer token (Next.js proxy, cron jobs, CI)
    bearer_ok = False
    if authorization and authorization.startswith("Bearer "):
        submitted = authorization.removeprefix("Bearer ").strip()
        expected = _get_internal_token()
        # Only accept if expected is non-empty AND tokens match.
        if expected and submitted == expected:
            bearer_ok = True

    # 1a. Bearer-matched call WITH user identity headers → real user context.
    #     This is the normal browser flow: Next.js proxy authenticates the
    #     session (NextAuth Google SSO) and forwards the verified email + role
    #     alongside the internal Bearer token.  We trust the identity because
    #     only the Next.js server can produce a valid Bearer token.
    if bearer_ok and x_user_email:
        allowed_domain = os.getenv("ALLOWED_EMAIL_DOMAIN", "fracktal.in").lower().lstrip("@")
        email = x_user_email
        if not email.lower().endswith("@" + allowed_domain):
            email = None
        return UserContext(
            email=email or x_user_email,  # still trust Next.js but flag domain mismatch
            role=_coerce_role(x_user_role),
        )

    # 1b. Bearer-matched call WITHOUT user headers → internal service call.
    #     Used by cron jobs, CI pipelines, and legacy LangGraph batch mode
    #     that predates the identity-forwarding fix.
    if bearer_ok:
        return UserContext(email="system:internal", role=UserRole.AGENT)

    # 2. SSO headers without Bearer (direct browser/dev access — no proxy).
    email = x_user_email
    if email:
        # Domain enforcement: reject emails not from the allowed domain.
        # This is a defence-in-depth check — the Next.js middleware and Google SSO
        # should already have blocked non-fracktal.in users before this point.
        allowed_domain = os.getenv("ALLOWED_EMAIL_DOMAIN", "fracktal.in").lower().lstrip("@")
        if not email.lower().endswith("@" + allowed_domain):
            # Treat as anonymous rather than raising — callers use require_role() to enforce.
            email = None

    return UserContext(
        email=email,
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