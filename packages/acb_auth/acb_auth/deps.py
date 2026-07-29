"""FastAPI dependency helpers for RBAC (WBS 1.7).

Usage in routes
---------------
    from acb_auth import get_current_user, require_permission, require_role, UserRole

    # Any authenticated user:
    @app.post("/pull")
    async def pull(req: PullRequest, user=Depends(get_current_user)):
        ...

    # Permission-gated (preferred for new routes):
    @app.get("/whatsapp/chats", dependencies=[require_permission("feature:whatsapp")])
    async def list_chats():
        ...

    # Executive-only (legacy coarse role — still honoured, see roles.py):
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
from collections.abc import Collection
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request

from acb_auth.access import SERVICE_ACCESS, resolve_access, resolve_identity
from acb_auth.permissions import NO_ACCESS
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


def _trust_unverified_sso_headers() -> bool:
    """Escape hatch: when true, X-User-Email is trusted even without a valid
    internal Bearer token (the pre-2026-07 behaviour).

    Default is FALSE. A bare X-User-Email (no Bearer) is spoofable by anyone who
    can reach the gateway directly, so trusting it was a cross-account auth
    bypass. Flip this to 1/true ONLY as a temporary rollback if a token MISMATCH
    between the Next.js proxy and the gateway is turning legitimate proxied
    traffic anonymous — the real fix is to align the two tokens.
    """
    return os.getenv(
        "GATEWAY_TRUST_UNVERIFIED_SSO_HEADERS", ""
    ).strip().lower() in {"1", "true", "yes", "on"}



async def _with_resolved_access(user: UserContext) -> UserContext:
    """Attach the member's DB-resolved permission set to a UserContext.

    Best-effort by construction: :func:`acb_auth.access.resolve_access` never
    raises, degrading to the legacy executive/employee mapping when the access
    tables are absent and to no-access when the member is unknown. Results are
    cached for 60s, so this costs one indexed query per member per minute
    rather than one per request.
    """
    if not user.email:
        return user
    access = await resolve_access(user.email, legacy_role=user.role.value)
    user_id, organization_id = await resolve_identity(user.email)
    enriched = user.with_access(
        access, user_id=user_id, organization_id=organization_id
    )

    # Keep the legacy coarse role consistent with the org model, so a member
    # promoted to `admin` in the members UI immediately passes the
    # require_role(EXECUTIVE) routes that have not migrated to permissions yet.
    #
    # Upgrade-only, deliberately: the Next.js proxy still derives X-User-Role
    # from EXECUTIVE_EMAILS, and an admin listed there who has never signed in
    # has no app_user row to resolve. Letting the DB *downgrade* the header
    # would lock exactly that person out during rollout.
    if enriched.role is not UserRole.EXECUTIVE and access.has("admin:settings:manage"):
        return UserContext(
            email=enriched.email,
            role=UserRole.EXECUTIVE,
            user_id=enriched.user_id,
            organization_id=enriched.organization_id,
            access=access,
        )
    return enriched


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

    Every branch also resolves the caller's effective access (org roles +
    per-user overrides) onto the context, so routes can call
    ``user.has_permission(...)`` without a second lookup.

    Never raises — missing/wrong headers resolve to the lowest-privilege role
    and an empty permission set. Enforcement is done by require_role() /
    require_permission().
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
        return await _with_resolved_access(
            UserContext(
                email=email or x_user_email,  # still trust Next.js but flag domain mismatch
                role=_coerce_role(x_user_role),
            )
        )

    # 1b. Bearer-matched call WITHOUT user headers → internal service call.
    #     Used by cron jobs, CI pipelines, and legacy LangGraph batch mode
    #     that predates the identity-forwarding fix.
    #
    #     Granted everything: whoever holds the internal token can already
    #     assert any X-User-Email, so a narrower set would be theatre.
    if bearer_ok:
        return UserContext(
            email="system:internal",
            role=UserRole.AGENT,
            access=SERVICE_ACCESS,
        )

    # 2. SSO headers WITHOUT a valid Bearer token.
    #    X-User-Email is only trustworthy when it arrives WITH the internal Bearer
    #    token (branch 1a) — that proves it came from the Next.js proxy, which
    #    authenticated the Google/NextAuth session. A bare X-User-Email is
    #    spoofable by anyone who can reach the gateway directly (it is exposed via
    #    Caddy), so trusting it was a full cross-account auth bypass. When an
    #    internal token IS configured we refuse to authenticate such a caller.
    #    When none is configured we preserve the old trust to avoid bricking an
    #    unprovisioned/dev gateway (mirroring require_internal_auth's fail-open
    #    contract); the escape hatch forces trust for a token-mismatch rollback.
    if (
        x_user_email
        and _get_internal_token()
        and not _trust_unverified_sso_headers()
    ):
        return UserContext(email=None, role=UserRole.EMPLOYEE, access=NO_ACCESS)

    email = x_user_email
    if email:
        # Domain enforcement (defence in depth) for the fail-open / escape-hatch
        # paths that still trust the header.
        allowed_domain = os.getenv("ALLOWED_EMAIL_DOMAIN", "fracktal.in").lower().lstrip("@")
        if not email.lower().endswith("@" + allowed_domain):
            # Treat as anonymous rather than raising — callers use require_role() to enforce.
            email = None

    return await _with_resolved_access(
        UserContext(email=email, role=_coerce_role(x_user_role))
    )


async def require_internal_auth(
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> None:
    """Reject callers that do not present a valid internal Bearer token.

    Unlike :func:`get_current_user` (which never rejects — it only *labels* the
    caller), this dependency 401s anyone without the internal service token. Use
    it on server-to-server endpoints that must not be world-reachable — notably
    the OpenAI-compatible ``/v1/chat/completions`` proxy, which otherwise bills
    the server's stored provider keys for any anonymous caller.

    SSO ``X-User-*`` headers are deliberately NOT accepted here: they are
    spoofable without the Next.js proxy, and every legitimate caller of these
    endpoints (MAF agents, Copilot BYOK, mem0/graphiti, the Next.js server
    routes) already forwards ``Authorization: Bearer <internal token>``.

    If no internal token is configured (``_get_internal_token()`` returns ""),
    Bearer auth is disabled and the call is allowed — matching that function's
    documented contract. This means a mis-provisioned deployment fails OPEN
    rather than bricking; since the endpoint was fully open before this guard,
    that is strictly no worse, while any real deployment (which always sets
    ``LITELLM_MASTER_KEY``) is now closed.
    """
    expected = _get_internal_token()
    if not expected:
        return  # Bearer auth disabled (unconfigured) — preserve prior behaviour.
    if authorization and authorization.startswith("Bearer "):
        submitted = authorization.removeprefix("Bearer ").strip()
        if submitted and submitted == expected:
            return
    raise HTTPException(status_code=401, detail="Unauthorized")


def require_role(*allowed: UserRole) -> Depends:
    """Return a FastAPI Depends that 403s if the caller role is not in allowed.

    Unchanged from the pre-org-access-control behaviour on purpose: every route
    written against the coarse executive/employee split keeps working exactly
    as before. New routes should prefer :func:`require_permission`.
    """
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


def require_permission(*permissions: str) -> Depends:
    """Return a FastAPI Depends that 403s unless the caller holds **all** of them.

    Anonymous callers get 401 rather than 403 — "you are not signed in" and
    "you are signed in but not allowed" are different problems and the
    frontend routes them differently (sign-in redirect vs. access-denied page).

    The 403 body names the missing permission. That is a deliberate trade:
    a signed-in member learning the *name* of a permission they lack leaks
    nothing an admin screen wouldn't tell them, and without it every access
    bug becomes a support ticket.

        @router.get("/chats", dependencies=[require_permission("feature:whatsapp")])
    """
    required = tuple(permissions)

    async def _check(user: Annotated[UserContext, Depends(get_current_user)]) -> UserContext:
        if not user.email:
            raise HTTPException(status_code=401, detail="Authentication required")
        missing = [p for p in required if not user.has_permission(p)]
        if missing:
            raise HTTPException(
                status_code=403,
                detail=f"Forbidden: missing permission(s) {sorted(missing)}.",
            )
        return user

    return Depends(_check)


def require_feature(slug: str) -> Depends:
    """Sugar for ``require_permission(f"feature:{slug}")``."""
    return require_permission(f"feature:{slug}")


def require_feature_router(
    slug: str, *, exempt: Collection[str] = ()
) -> Depends:
    """Gate a whole feature surface at the router, with declared exemptions.

    Attach to an ``APIRouter(dependencies=[...])`` so every route under a
    prefix is covered by construction. A new endpoint added to that router is
    then gated by default, which is the property that matters: the failure
    mode of per-route gating is the route someone forgets.

    ``exempt`` holds **route path templates** (e.g.
    ``"/email/oauth/{provider}/callback"``) that must stay reachable without a
    member. These are not oversights — a provider webhook and an OAuth
    redirect arrive with no session and no internal token, so gating them
    would break message ingestion and account linking rather than merely
    restrict them. Listing them explicitly keeps the set greppable and small;
    matching on the *template* rather than the concrete URL means a path
    parameter can never be used to slip past the gate.

        router = APIRouter(
            prefix="/whatsapp",
            dependencies=[require_feature_router("whatsapp",
                                                 exempt=["/whatsapp/webhook"])],
        )

    Exempting a path here removes the *feature* check only; whatever
    authentication that endpoint already does for itself (signature
    verification, HMAC-signed OAuth state) is untouched.
    """
    permission = f"feature:{slug}"
    exempt_paths = frozenset(exempt)

    async def _check(
        request: Request,
        user: Annotated[UserContext, Depends(get_current_user)],
    ) -> UserContext:
        route = request.scope.get("route")
        template = getattr(route, "path", None) or request.url.path
        if template in exempt_paths:
            return user
        if not user.email:
            raise HTTPException(status_code=401, detail="Authentication required")
        if not user.has_permission(permission):
            raise HTTPException(
                status_code=403,
                detail=f"Forbidden: missing permission '{permission}'.",
            )
        return user

    return Depends(_check)


def require_any_permission(*permissions: str) -> Depends:
    """Like :func:`require_permission` but any single match suffices.

    For endpoints that legitimately serve two audiences — e.g. an approvals
    feed readable by both the Approvals pane and platform admins.
    """
    required = tuple(permissions)

    async def _check(user: Annotated[UserContext, Depends(get_current_user)]) -> UserContext:
        if not user.email:
            raise HTTPException(status_code=401, detail="Authentication required")
        if not any(user.has_permission(p) for p in required):
            raise HTTPException(
                status_code=403,
                detail=f"Forbidden: requires one of {sorted(required)}.",
            )
        return user

    return Depends(_check)


def assert_can_run_agent(user: UserContext, agent_name: str) -> None:
    """Raise 403 unless ``user`` may run ``agent_name``.

    A function rather than a dependency because the agent name arrives in the
    request body, not the path — the run endpoints call this after parsing.
    Seam 2 of the spec's enforcement table.
    """
    if user.role is UserRole.AGENT and user.has_permission("*"):
        return  # internal service principal
    if not user.can_run_agent(agent_name):
        raise HTTPException(
            status_code=403,
            detail=f"Forbidden: no access to agent '{agent_name}'.",
        )