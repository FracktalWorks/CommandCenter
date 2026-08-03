"""Org access control — permission model and guard behaviour.

Spec: ai-company-brain/specs/org_access_control.md

These cover the pure resolution layer (acb_auth.permissions) and the FastAPI
guards, which is where a mistake is silent: a permission that matches nothing
is invisible rather than loud, and a wildcard that matches too much looks
identical to one that matches correctly until someone reaches data they
shouldn't.
"""
from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from acb_auth import (
    ASSIGNABLE_SYSTEM_ROLES,
    CAPABILITIES,
    FEATURES,
    SYSTEM_ROLES,
    EffectiveAccess,
    InvalidPermission,
    UserContext,
    UserRole,
    agent_run_permission,
    assert_can_run_agent,
    build_access,
    feature_permission,
    get_current_user,
    permission_matches,
    require_any_permission,
    require_permission,
    validate_permission,
)
from acb_auth.access import SERVICE_ACCESS, legacy_access


# ── Matching ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("pattern", "required", "expected"),
    [
        ("feature:whatsapp", "feature:whatsapp", True),
        ("feature:whatsapp", "feature:email", False),
        ("*", "anything:at:all", True),
        ("feature:*", "feature:whatsapp", True),
        ("feature:*", "feature:build.apps", True),
        ("feature:*", "agents:run:x", False),
        ("agents:run:*", "agents:run:agent-sales", True),
        ("agents:*", "agents:run:agent-sales", True),
        ("agents:run:*", "agents:manage", False),
        # A prefix wildcard must not match the bare prefix itself: holding
        # "feature:*" is not holding a permission literally named "feature:".
        ("feature:*", "feature:", False),
        # Prefix must land on a segment boundary, or "feature:*" would cover an
        # unrelated "featureflags:x".
        ("feature:*", "featureflags:x", False),
    ],
)
def test_permission_matches(pattern: str, required: str, expected: bool) -> None:
    assert permission_matches(pattern, required) is expected


# ── Validation ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "raw",
    ["feature:whatsapp", "*", "agents:run:*", "AGENTS:RUN:X", " feature:chat "],
)
def test_validate_accepts(raw: str) -> None:
    assert validate_permission(raw) == raw.strip().lower()


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "feature:*:read",        # inward wildcard — unauditable, refused
        "*:read",
        "feature:what sapp",     # whitespace inside a segment
        "feature:" + "x" * 200,  # over the length ceiling
    ],
)
def test_validate_rejects(raw: str) -> None:
    with pytest.raises(InvalidPermission):
        validate_permission(raw)


# ── Resolution ──────────────────────────────────────────────────────────────

def test_default_is_deny() -> None:
    access = build_access(["feature:chat"])
    assert access.has("feature:chat")
    assert not access.has("feature:whatsapp")
    assert not access.has("admin:members:read")


def test_deny_override_beats_a_wildcard_role_grant() -> None:
    """The headline case: `admin`-style blanket access, minus two things."""
    access = build_access(
        ["feature:*", "agents:run:*"],
        [("feature:whatsapp", "deny"), ("feature:build.apps", "deny")],
        roles=["admin"],
    )
    assert access.can_use_feature("email")
    assert not access.can_use_feature("whatsapp")
    assert not access.can_use_feature("build.apps")
    assert access.can_run_agent("agent-sales")


def test_allow_override_adds_a_single_agent_on_top_of_a_denied_wildcard() -> None:
    """"No agents except this one" — deny the blanket, allow one by name."""
    access = build_access(
        ["feature:chat", "agents:run:*"],
        [
            ("agents:run:*", "deny"),
            ("agents:run:email-assistant", "allow"),
        ],
        roles=["member"],
    )
    assert access.can_run_agent("email-assistant")
    assert not access.can_run_agent("whatsapp-assistant")
    assert not access.can_run_agent("app-builder")


def test_deny_wins_when_two_overrides_are_equally_specific() -> None:
    access = build_access(
        ["feature:whatsapp"],
        [("feature:whatsapp", "allow"), ("feature:whatsapp", "deny")],
    )
    assert not access.can_use_feature("whatsapp")


def test_a_wildcard_deny_override_beats_an_exact_role_grant() -> None:
    """Specificity orders overrides against each other — never against roles.

    If a role's exact `feature:chat` could out-specify an admin's explicit
    `feature:*` deny, "switch everything off for this person" would silently
    leave holes.
    """
    access = build_access(
        ["feature:chat", "feature:email"],
        [("feature:*", "deny")],
        roles=["member"],
    )
    assert not access.can_use_feature("chat")
    assert not access.can_use_feature("email")
    assert access.allowed_features() == ()


def test_more_specific_deny_beats_a_broader_allow_override() -> None:
    access = build_access(
        [],
        [("agents:run:*", "allow"), ("agents:run:app-builder", "deny")],
    )
    assert access.can_run_agent("email-assistant")
    assert not access.can_run_agent("app-builder")


def test_bare_star_is_the_least_specific_pattern() -> None:
    access = build_access([], [("*", "deny"), ("feature:chat", "allow")])
    assert access.can_use_feature("chat")
    assert not access.can_use_feature("email")


def test_granted_exposes_roles_and_allow_overrides_together() -> None:
    """`granted` is for display/export; the decision uses the layers."""
    access = build_access(["feature:chat"], [("feature:email", "allow")])
    assert access.granted == frozenset({"feature:chat", "feature:email"})
    assert access.role_granted == frozenset({"feature:chat"})
    assert access.allowed == frozenset({"feature:email"})


def test_suspended_member_resolves_to_nothing() -> None:
    access = build_access(["*"], roles=["owner"], is_active=False)
    assert not access.has("feature:chat")
    assert not access.has("admin:members:read")
    assert access.allowed_features() == ()


def test_malformed_stored_permissions_are_skipped_not_fatal() -> None:
    """A bad row written before validation existed must not lock anyone out."""
    access = build_access(["feature:chat", "feature:*:read", ""])
    assert access.can_use_feature("chat")


def test_decision_explains_its_provenance() -> None:
    access = build_access(
        ["feature:*"], [("feature:whatsapp", "deny")], roles=["admin"]
    )
    granted = access.decide("feature:email")
    assert granted.allowed and granted.source == "role"
    assert granted.pattern == "feature:*"

    denied = access.decide("feature:whatsapp")
    assert not denied.allowed and denied.source == "deny-override"
    assert denied.pattern == "feature:whatsapp"

    missing = access.decide("admin:roles:manage")
    assert not missing.allowed and missing.source == "default-deny"


def test_allowed_features_follows_catalog_order() -> None:
    access = build_access(["feature:*"])
    assert access.allowed_features() == FEATURES


# ── Agent inheritance ───────────────────────────────────────────────────────

def test_intersect_never_widens_access() -> None:
    """An agent run inherits the caller's set; it can only narrow."""
    caller = build_access(["feature:chat", "agents:run:email-assistant"])
    agent = build_access(["*"])
    combined = agent.intersect(caller)
    assert combined.can_run_agent("email-assistant")
    assert not combined.can_run_agent("app-builder")
    assert not combined.has("admin:members:read")


def test_intersect_unions_denials() -> None:
    a = build_access(["feature:*"], [("feature:whatsapp", "deny")])
    b = build_access(["feature:*"], [("feature:email", "deny")])
    combined = a.intersect(b)
    assert not combined.can_use_feature("whatsapp")
    assert not combined.can_use_feature("email")
    assert combined.can_use_feature("chat")


# ── Vocabulary invariants ───────────────────────────────────────────────────

def test_every_declared_permission_is_valid() -> None:
    for slug in FEATURES:
        validate_permission(feature_permission(slug))
    for cap in CAPABILITIES:
        validate_permission(cap)


def test_every_center_has_a_feature_slug() -> None:
    """A Center seeded in SQL but missing from FEATURES is unreachable.

    ``allowed_features()`` iterates FEATURES, not ``feature_catalog``, and
    ``/auth/me`` returns exactly that list — so a slug absent here is invisible
    to the nav and to AccessGate for EVERY principal, including an owner
    holding ``*`` (the wildcard is only matched against these literals). That
    was the live defect: migration 140 seeded six ``center.*`` catalog rows and
    ``routes/admin/groups.py`` has been writing ``allow feature:center.<slug>``
    overrides the product could never display.

    The expectation is derived from the group slugs rather than retyped, so the
    1:1 group↔Center pairing (department_centers.md §1) cannot drift.
    """
    from gateway.routes.admin.groups import CENTER_GROUP_SLUGS

    missing = [
        feature_permission(f"center.{slug}")
        for slug in CENTER_GROUP_SLUGS
        if f"center.{slug}" not in FEATURES
    ]
    assert not missing, (
        f"Center features seeded/granted but absent from FEATURES: {missing}. "
        "They would be unreachable for every member, owners included."
    )


def test_agent_service_is_not_assignable_to_people() -> None:
    assert "agent_service" in SYSTEM_ROLES
    assert "agent_service" not in ASSIGNABLE_SYSTEM_ROLES


def test_legacy_roles_map_onto_the_new_model() -> None:
    """Deploying the migration must not change anyone's access."""
    exec_access = legacy_access("executive")
    assert exec_access.can_use_feature("whatsapp")
    assert exec_access.has("admin:members:manage")

    employee = legacy_access("employee")
    assert employee.can_use_feature("chat")
    assert not employee.has("admin:members:manage")
    # The seeded `member` role deliberately withholds these.
    assert not employee.can_use_feature("whatsapp")
    assert not employee.can_use_feature("build.apps")


def test_unknown_legacy_role_falls_back_to_member() -> None:
    assert legacy_access("nonsense").roles == frozenset({"member"})


# ── UserContext ─────────────────────────────────────────────────────────────

def test_user_context_defaults_to_no_access() -> None:
    """Any construction path that skips resolution must not grant anything."""
    user = UserContext(email="a@fracktal.in", role=UserRole.EXECUTIVE)
    assert not user.has_permission("feature:chat")
    assert user.permissions == frozenset()
    assert user.roles == frozenset()


def test_with_access_preserves_identity() -> None:
    user = UserContext(email="a@fracktal.in", role=UserRole.EMPLOYEE)
    enriched = user.with_access(
        build_access(["feature:chat"], roles=["member"]),
        user_id="u-1",
        organization_id="o-1",
    )
    assert enriched.email == "a@fracktal.in"
    assert enriched.user_id == "u-1"
    assert enriched.organization_id == "o-1"
    assert enriched.can_use_feature("chat")
    # Frozen dataclass: the original is untouched.
    assert not user.can_use_feature("chat")


# ── Guards ──────────────────────────────────────────────────────────────────

def _client(access: EffectiveAccess, *, email: str | None = "a@fracktal.in") -> TestClient:
    app = FastAPI()

    async def _fake_user() -> UserContext:
        return UserContext(email=email, role=UserRole.EMPLOYEE, access=access)

    @app.get("/whatsapp", dependencies=[require_permission("feature:whatsapp")])
    async def _whatsapp() -> dict[str, bool]:
        return {"ok": True}

    @app.get(
        "/either",
        dependencies=[require_any_permission("feature:whatsapp", "admin:members:read")],
    )
    async def _either() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/run/{name}")
    async def _run(name: str, user: UserContext = Depends(_fake_user)) -> dict[str, bool]:
        assert_can_run_agent(user, name)
        return {"ok": True}

    app.dependency_overrides[get_current_user] = _fake_user
    return TestClient(app)


def test_require_permission_allows_the_holder() -> None:
    client = _client(build_access(["feature:whatsapp"]))
    assert client.get("/whatsapp").status_code == 200


def test_require_permission_403s_without_it() -> None:
    client = _client(build_access(["feature:chat"]))
    res = client.get("/whatsapp")
    assert res.status_code == 403
    # The body names what is missing so an access bug is self-diagnosing.
    assert "feature:whatsapp" in res.json()["detail"]


def test_require_permission_401s_when_anonymous() -> None:
    """401 and 403 are different problems: sign in vs. ask an admin."""
    client = _client(build_access(["feature:whatsapp"]), email=None)
    assert client.get("/whatsapp").status_code == 401


def test_require_any_permission_needs_only_one() -> None:
    client = _client(build_access(["admin:members:read"]))
    assert client.get("/either").status_code == 200
    assert client.get("/whatsapp").status_code == 403


def test_agent_run_gate() -> None:
    client = _client(
        build_access(
            ["agents:run:*"], [("agents:run:app-builder", "deny")]
        )
    )
    assert client.get("/run/email-assistant").status_code == 200
    res = client.get("/run/app-builder")
    assert res.status_code == 403
    assert "app-builder" in res.json()["detail"]


def test_service_principal_runs_any_agent() -> None:
    """Internal-token callers already hold total authority; no theatre."""
    user = UserContext(
        email="system:internal", role=UserRole.AGENT, access=SERVICE_ACCESS
    )
    assert_can_run_agent(user, "anything")  # must not raise
    assert user.has_permission(agent_run_permission("anything"))
