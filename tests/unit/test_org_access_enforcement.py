"""Org access control — enforcement at the gateway route layer.

Spec: ``ai-company-brain/specs/org_access_control.md`` §5, seam 1.

``test_org_access_control.py`` covers the permission *model*. This file covers
the thing the model is for: that a member denied a feature is actually refused
by the API, and — equally important — that the machine entrypoints which carry
their own authentication are NOT caught by the feature gate.

That second half is not defensive padding. A provider webhook or an OAuth
redirect arrives with no session and no internal token; gating one silently
stops message ingestion or account linking rather than restricting access, and
the failure is invisible until someone notices missing data.
"""
from __future__ import annotations

import importlib
import inspect

import pytest
from acb_auth import (
    UserContext,
    UserRole,
    build_access,
    get_current_user,
    require_feature_router,
)
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

# ── The gate itself ─────────────────────────────────────────────────────────

def _app(access, *, email: str | None = "a@fracktal.in") -> TestClient:
    router = APIRouter(
        prefix="/thing",
        dependencies=[require_feature_router("whatsapp", exempt=["/thing/webhook"])],
    )

    @router.get("/list")
    async def _list() -> dict[str, bool]:
        return {"ok": True}

    @router.post("/webhook")
    async def _webhook() -> dict[str, bool]:
        return {"ok": True}

    @router.get("/items/{item_id}")
    async def _item(item_id: str) -> dict[str, str]:
        return {"id": item_id}

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: UserContext(
        email=email, role=UserRole.EMPLOYEE, access=access
    )
    return TestClient(app)


def test_router_gate_allows_the_holder() -> None:
    client = _app(build_access(["feature:whatsapp"]))
    assert client.get("/thing/list").status_code == 200


def test_router_gate_refuses_a_denied_member() -> None:
    client = _app(
        build_access(["feature:*"], [("feature:whatsapp", "deny")])
    )
    res = client.get("/thing/list")
    assert res.status_code == 403
    assert "feature:whatsapp" in res.json()["detail"]


def test_router_gate_covers_every_route_under_the_prefix() -> None:
    """The point of gating at the router: a new endpoint is covered by default."""
    client = _app(build_access(["feature:chat"]))
    assert client.get("/thing/list").status_code == 403
    assert client.get("/thing/items/abc").status_code == 403


def test_exempt_route_stays_open_to_an_unauthenticated_caller() -> None:
    """The webhook case: no session, no token, must still reach the endpoint."""
    client = _app(build_access([]), email=None)
    assert client.post("/thing/webhook").status_code == 200
    # ...while everything else on the same router is still refused.
    assert client.get("/thing/list").status_code == 401


def test_gate_401s_anonymous_and_403s_a_signed_in_member() -> None:
    assert _app(build_access([]), email=None).get("/thing/list").status_code == 401
    assert _app(build_access(["feature:chat"])).get("/thing/list").status_code == 403


def test_path_parameters_cannot_impersonate_an_exempt_route() -> None:
    """Matching is on the route TEMPLATE, not the concrete URL.

    A member without the feature must not reach a gated route by crafting a
    path parameter that happens to spell an exempt path.
    """
    client = _app(build_access(["feature:chat"]))
    assert client.get("/thing/items/webhook").status_code == 403


def test_service_principal_passes_the_gate() -> None:
    from acb_auth.access import SERVICE_ACCESS

    client = _app(SERVICE_ACCESS, email="system:internal")
    assert client.get("/thing/list").status_code == 200


# ── The real routers ────────────────────────────────────────────────────────

GATED_ROUTERS: dict[str, set[str]] = {
    # module → route templates deliberately exempt from the feature gate.
    "gateway.routes.whatsapp": {
        "/whatsapp/webhook",
        "/whatsapp/bridge/ingest",
        "/whatsapp/bridge/reclassify",
        "/whatsapp/bridge/labels",
        "/whatsapp/bridge/avatars",
        "/whatsapp/bridge/paired",
        # The bridge posts freshly-fetched profile-picture URLs (W17). Same
        # X-Bridge-Secret scheme as its siblings; gating it would silently
        # stop avatar sync, not restrict any member.
        # The bridge reports voice-call state transitions. Same secret scheme;
        # it arrives from the Go service with no user session, so gating it
        # would drop call events rather than restrict anyone.
        "/whatsapp/bridge/call-event",
        # The browser's call-audio WebSocket. It can't carry the internal
        # bearer, so it authenticates with a short-lived signed token instead;
        # gating it would drop audio rather than restrict anyone.
        "/whatsapp/calls/audio",
    },
    "gateway.routes.email": {
        "/email/oauth/{provider}/callback",
        "/email/webhook/microsoft",
    },
    "gateway.routes.notes": {
        "/notes/meetings/{meeting_id}/live/segment",
        "/notes/stt/bot-live-token",
        # The meeting-bot worker polls this to decide whether to keep paying for
        # streaming ASR. Same bot-token auth as the two above — it runs in its
        # own container and has no user session.
        "/notes/meetings/{meeting_id}/live/wanted",
    },
    "gateway.routes.tasks": set(),
    "gateway.routes.chat": set(),
    "gateway.routes.actions": set(),
    "gateway.routes.integrations": set(),
    "gateway.routes.workflows": {
        "/workflows/hooks/{hook_token}",
    },
}


def _routes(module: str):
    return importlib.import_module(module).router.routes


@pytest.mark.parametrize("module", sorted(GATED_ROUTERS))
def test_every_gated_router_actually_carries_a_gate(module: str) -> None:
    """Guards the wiring: a router that lost its dependency fails here."""
    for route in _routes(module):
        deps = getattr(route, "dependencies", [])
        names = [getattr(d, "dependency", None) for d in deps]
        assert any(
            getattr(n, "__qualname__", "").startswith("require_feature_router")
            for n in names
        ), f"{module} {route.path} is not behind require_feature_router"


@pytest.mark.parametrize("module,exempt", sorted(GATED_ROUTERS.items()))
def test_no_unexempted_machine_entrypoint(module: str, exempt: set[str]) -> None:
    """Every route with no user context is either exempt or a plain UI read.

    A route that takes no ``UserContext`` is a candidate machine entrypoint.
    If a new one is added without an exemption, this fails loudly instead of
    silently breaking ingestion in production.
    """
    known_userless_ui_reads = {"/tasks/providers"}
    for route in _routes(module):
        endpoint = getattr(route, "endpoint", None)
        if endpoint is None:
            continue
        try:
            params = inspect.signature(endpoint).parameters.values()
        except (TypeError, ValueError):
            continue
        has_user = any(
            "UserContext" in str(p.annotation) or p.name in ("user", "_user", "admin")
            for p in params
        )
        if has_user:
            continue
        assert route.path in exempt or route.path in known_userless_ui_reads, (
            f"{route.path} takes no user context and is not exempt — if it is a "
            f"machine entrypoint the gate will break it; if it is a UI read, "
            f"add it to known_userless_ui_reads."
        )


@pytest.mark.parametrize("module,exempt", sorted(GATED_ROUTERS.items()))
def test_exemptions_match_real_routes(module: str, exempt: set[str]) -> None:
    """A typo'd exemption is dead text that silently gates a machine callback."""
    live = {r.path for r in _routes(module)}
    assert exempt <= live, f"{module}: exemptions not matching any route: {exempt - live}"
