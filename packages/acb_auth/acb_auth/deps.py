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

Two secrets, deliberately distinct (BO-2 residual #4):

    GATEWAY_INTERNAL_TOKEN  -- SERVICE IDENTITY. Proves the caller *is* the
        platform (Next.js proxy, cron, CI) and grants SERVICE_ACCESS, i.e.
        everything. Never handed to agent code. Checked by
        require_internal_auth() and get_current_user()'s Bearer branch.

    LITELLM_MASTER_KEY      -- the /v1 API key. Handed to every agent's BYOK
        client so completions route through the gateway. Checked ONLY by
        require_llm_api_auth(). Treat as semi-public within the deployment.

They used to be one value: the identity token fell back to the LLM key, and
the orchestrator handed agents whichever it resolved to. Every agent therefore
held the identity token and could call /admin/* to grant itself anything.

Empty string disables Bearer auth (never accept all callers — use SSO headers
instead).
"""
from __future__ import annotations

import os
import secrets
from collections.abc import Collection
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request

from acb_common import get_logger

from acb_auth.access import SERVICE_ACCESS, resolve_access, resolve_identity
from acb_auth.permissions import NO_ACCESS
from acb_auth.roles import UserContext, UserRole, _coerce_role

_log = get_logger("acb_auth.deps")

# ---------------------------------------------------------------------------
# Internal service token (server → gateway calls, e.g. Next.js proxy route)
# ---------------------------------------------------------------------------

def _get_llm_api_token() -> str:
    """The API key for the gateway's OpenAI-compatible ``/v1`` endpoint.

    This one is handed OUT — every agent's BYOK client presents it to route
    completions through the gateway. Treat it as semi-public within the
    deployment: anything it authenticates, an agent can do.
    """
    tok = os.getenv("LITELLM_MASTER_KEY", "").strip()
    if not tok:
        try:
            from acb_common import get_settings  # noqa: PLC0415
            tok = (get_settings().litellm_master_key or "").strip()
        except Exception:  # noqa: BLE001
            pass
    return tok


def _get_internal_token() -> str:
    """The SERVICE IDENTITY token: proof that a caller *is* the platform.

    Grants ``SERVICE_ACCESS`` (everything), so it must never be given to code
    that runs untrusted input — which is exactly why it is now separate from
    the ``/v1`` API key. Previously this fell back to ``LITELLM_MASTER_KEY``,
    and the orchestrator handed agents whichever value this resolved to, so
    every agent held the identity token and could call ``/admin/*`` to grant
    itself anything. That is BO-2 residual #4.

    Precedence: ``GATEWAY_INTERNAL_TOKEN`` → (unprovisioned only)
    ``LITELLM_MASTER_KEY`` with a warning → ``""``, which disables Bearer
    auth entirely.

    The fallback is retained ONLY so a deployment that has not set
    ``GATEWAY_INTERNAL_TOKEN`` keeps working rather than 401ing every internal
    call on upgrade. While it is in effect the two secrets are the same value
    and the separation does not exist, so it warns on every resolution — a
    silent fallback here would be the vulnerability wearing a fix's clothes.
    """
    tok = os.getenv("GATEWAY_INTERNAL_TOKEN", "").strip()
    if not tok:
        try:
            from acb_common import get_settings  # noqa: PLC0415
            tok = (get_settings().gateway_internal_token or "").strip()
        except Exception:  # noqa: BLE001
            pass
    if tok:
        return tok

    llm_key = _get_llm_api_token()
    if llm_key:
        _log.warning(
            "gateway_internal_token_unset",
            detail=(
                "Falling back to LITELLM_MASTER_KEY for service identity. That "
                "key is handed to every agent, so any agent can currently "
                "authenticate as the platform. Set GATEWAY_INTERNAL_TOKEN to a "
                "distinct secret."
            ),
        )
    return llm_key


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
        if expected and secrets.compare_digest(submitted, expected):
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
        if submitted and secrets.compare_digest(submitted, expected):
            return
    raise HTTPException(status_code=401, detail="Unauthorized")


async def require_llm_api_auth(
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> None:
    """Guard the OpenAI-compatible ``/v1`` endpoint.

    Accepts **either** the ``/v1`` API key (``LITELLM_MASTER_KEY``, which every
    agent's BYOK client holds) **or** the service identity token (the Next.js
    server and internal jobs route completions too).

    This is deliberately weaker than :func:`require_internal_auth` and must
    stay that way. ``/v1`` bills the server's stored provider keys, so it needs
    authentication — but it is the one endpoint agents are *supposed* to reach,
    so gating it on the identity token is what forced agents to hold that token
    in the first place. Separating the two is the fix.
    """
    submitted = ""
    if authorization and authorization.startswith("Bearer "):
        submitted = authorization.removeprefix("Bearer ").strip()

    accepted = [t for t in (_get_llm_api_token(), _get_internal_token()) if t]
    if not accepted:
        return  # Unconfigured deployment — same fail-open contract as below.
    if submitted and any(secrets.compare_digest(submitted, t) for t in accepted):
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


def _route_template(request: Request) -> str:
    """The matched route's path template, e.g. ``/email/oauth/{provider}/callback``.

    Always the template, never the concrete URL: matching on the URL would let
    a path parameter be crafted to spell an exempt path.
    """
    route = request.scope.get("route")
    return getattr(route, "path", None) or request.url.path


def require_authenticated(public: Collection[str] = ()) -> Depends:
    """App-wide default-deny: 401 unless the caller proved who they are.

    BO-2 residual #1. ``get_current_user`` never rejects — it *labels*, which
    means every route was open unless it remembered to opt in to a guard. The
    failure mode of opt-in security is the route nobody opted in, and that is
    exactly what happened: ``/agent/workspace/{id}/history`` and
    ``/promote`` were reading and writing agent workspaces anonymously.

    Attach once at ``FastAPI(dependencies=[...])`` so a route added tomorrow is
    covered without anyone remembering anything.

    "Authenticated" means either a valid internal bearer token or a
    domain-verified ``X-User-Email`` that arrived with one — i.e. anything
    ``get_current_user`` resolved to a non-empty email. It says nothing about
    *authorization*; ``require_permission`` and friends still do that.

    ``public`` holds route templates that must stay reachable anonymously.
    Each one authenticates itself by another means (provider signature, HMAC
    state, shared secret) or is a liveness probe. Gating them would not
    restrict access, it would break ingestion and sign-in.
    """
    public_paths = frozenset(public)

    async def _check(
        request: Request,
        user: Annotated[UserContext, Depends(get_current_user)],
    ) -> UserContext:
        if _route_template(request) in public_paths:
            return user
        if not user.email:
            raise HTTPException(status_code=401, detail="Authentication required")
        return user

    return Depends(_check)


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
        if _route_template(request) in exempt_paths:
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


async def assert_can_run_agent_in_session(
    user: UserContext, agent_name: str, session_id: str | None,
) -> None:
    """:func:`assert_can_run_agent`, then the shared-session authority rule.

    A shared run acts with the intersection of every participant's access
    (``groups_sessions_authority.md`` §3), so the agent must be runnable by
    the ROOM, not only by the typer — otherwise its output lands in a
    transcript read by members who may not run it. The fold engages only
    when a second member exists; a solo or pre-133 session is exactly the
    plain gate. The refusal names the rule so the cap is never a mystery.
    """
    assert_can_run_agent(user, agent_name)
    if user.role is UserRole.AGENT and user.has_permission("*"):
        return  # internal service principal — no room to intersect
    if not session_id:
        return
    from acb_auth.access import resolve_session_access

    folded, members = await resolve_session_access(session_id, user.email)
    if len(members) > 1 and not folded.can_run_agent(agent_name):
        raise HTTPException(
            status_code=403,
            detail=(
                f"Forbidden: agent '{agent_name}' is not runnable by every "
                f"participant of this shared session — a shared run acts at "
                f"the intersection of all participants' access."
            ),
        )