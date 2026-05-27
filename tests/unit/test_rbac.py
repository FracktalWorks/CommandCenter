"""Unit tests for acb_auth RBAC scaffold (WBS 1.7).

All tests are pure-Python -- no DB, no live FastAPI server required.
FastAPI route-level enforcement is covered by the async dependency tests
using httpx.AsyncClient with dependency_overrides.
"""
from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from acb_auth import UserContext, UserRole, get_current_user, require_role
from acb_auth.roles import _coerce_role


# ---- _coerce_role ----------------------------------------------------------

@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("executive", UserRole.EXECUTIVE),
        ("EXECUTIVE", UserRole.EXECUTIVE),
        ("Executive", UserRole.EXECUTIVE),
        ("employee", UserRole.EMPLOYEE),
        ("agent", UserRole.AGENT),
        ("unknown", UserRole.EMPLOYEE),
        ("admin", UserRole.EMPLOYEE),
        ("", UserRole.EMPLOYEE),
        (None, UserRole.EMPLOYEE),
    ],
)
def test_coerce_role(raw, expected):
    assert _coerce_role(raw) == expected


# ---- UserContext -----------------------------------------------------------

def test_user_context_executive_flag():
    u = UserContext(email="ceo@fracktal.in", role=UserRole.EXECUTIVE)
    assert u.is_executive
    assert not u.is_employee
    assert not u.is_agent


def test_user_context_employee_flag():
    u = UserContext(email="dev@fracktal.in", role=UserRole.EMPLOYEE)
    assert u.is_employee
    assert not u.is_executive


def test_user_context_no_email():
    u = UserContext(email=None, role=UserRole.EMPLOYEE)
    assert u.email is None


# ---- get_current_user (FastAPI dependency via TestClient) ------------------

def _make_app():
    app = FastAPI()

    @app.get("/whoami")
    async def whoami(user=Depends(get_current_user)):
        return {"email": user.email, "role": user.role.value}

    return app


def test_get_current_user_from_headers():
    client = TestClient(_make_app())
    r = client.get("/whoami", headers={"X-User-Email": "ceo@fracktal.in", "X-User-Role": "executive"})
    assert r.status_code == 200
    assert r.json() == {"email": "ceo@fracktal.in", "role": "executive"}


def test_get_current_user_no_headers_defaults_to_employee():
    client = TestClient(_make_app())
    r = client.get("/whoami")
    assert r.status_code == 200
    assert r.json()["role"] == "employee"


def test_get_current_user_unknown_role_falls_back():
    client = TestClient(_make_app())
    r = client.get("/whoami", headers={"X-User-Role": "superadmin"})
    assert r.status_code == 200
    assert r.json()["role"] == "employee"


# ---- require_role ----------------------------------------------------------

def _make_gated_app():
    app = FastAPI()

    @app.get("/open")
    async def open_route(user=Depends(get_current_user)):
        return {"role": user.role.value}

    @app.get("/exec-only", dependencies=[require_role(UserRole.EXECUTIVE)])
    async def exec_only():
        return {"ok": True}

    @app.get("/staff", dependencies=[require_role(UserRole.EXECUTIVE, UserRole.EMPLOYEE)])
    async def staff_only():
        return {"ok": True}

    return app


def test_require_role_executive_granted():
    client = TestClient(_make_gated_app())
    r = client.get("/exec-only", headers={"X-User-Role": "executive"})
    assert r.status_code == 200


def test_require_role_employee_denied_on_exec_route():
    client = TestClient(_make_gated_app())
    r = client.get("/exec-only", headers={"X-User-Role": "employee"})
    assert r.status_code == 403


def test_require_role_no_header_denied_on_exec_route():
    client = TestClient(_make_gated_app())
    r = client.get("/exec-only")
    assert r.status_code == 403


def test_require_role_multi_roles_employee_allowed():
    client = TestClient(_make_gated_app())
    r = client.get("/staff", headers={"X-User-Role": "employee"})
    assert r.status_code == 200


def test_require_role_multi_roles_executive_allowed():
    client = TestClient(_make_gated_app())
    r = client.get("/staff", headers={"X-User-Role": "executive"})
    assert r.status_code == 200


def test_require_role_agent_denied_on_staff_route():
    client = TestClient(_make_gated_app())
    r = client.get("/staff", headers={"X-User-Role": "agent"})
    assert r.status_code == 403


def test_require_role_403_body_contains_required_roles():
    client = TestClient(_make_gated_app())
    r = client.get("/exec-only", headers={"X-User-Role": "employee"})
    assert "executive" in r.json()["detail"]