"""Observability access + durable history (fix for "observability doesn't work").

The live observability views were EXECUTIVE-gated, but the SSO proxy sends
role=employee unless the operator's email is in EXECUTIVE_EMAILS (empty by
default) — so the operator's own dashboard silently 403'd → blank page. These
assert the relaxed gate (any authenticated caller) and that /runs degrades to an
empty list rather than 500 when the DB is unavailable.
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient
from gateway.routes import observability as obs


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(obs.router)
    return TestClient(app)


def test_runs_is_open_to_employee_role():
    # EMPLOYEE is the default role the SSO proxy forwards. Previously → 403.
    c = _client()
    r = c.get("/observability/runs?limit=5", headers={"X-User-Role": "employee"})
    assert r.status_code == 200
    body = r.json()
    assert "runs" in body and isinstance(body["runs"], list)


def test_cost_is_open_to_employee_role():
    c = _client()
    r = c.get("/observability/cost?days=3", headers={"X-User-Role": "employee"})
    assert r.status_code == 200
    assert "totals" in r.json()


def test_runs_degrades_to_empty_without_db(monkeypatch):
    # No Postgres in the unit env → the endpoint must return [] (200), never 500.
    c = _client()
    r = c.get("/observability/runs", headers={"X-User-Role": "employee"})
    assert r.status_code == 200
    assert r.json()["runs"] == []


def test_runs_rejects_bad_status_filter_silently():
    # An unknown status is ignored (not applied), not an error.
    c = _client()
    r = c.get("/observability/runs?status=bogus", headers={"X-User-Role": "employee"})
    assert r.status_code == 200
