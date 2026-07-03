"""Unit tests for the /debug diagnostics API (E2 Phase 3).

Uses the real gateway app via TestClient against the local Postgres (the same
DB the integration stack uses). Seeds two agent_run rows (one errored, one ok)
and asserts: list filters, the lean-vs-full trace split, the retention policy is
honored through the API, the EXECUTIVE auth gate, and 404s.

Marked `integration` because it needs the acb-postgres container; skipped in the
default unit run (`-m 'not integration'`) and run explicitly in CI/on the VPS.
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.integration

_EXEC = {"X-User-Email": "vjv@fracktal.in", "X-User-Role": "executive"}
_EMP = {"X-User-Email": "emp@fracktal.in", "X-User-Role": "employee"}
_THREAD = "utest-debug-thread"


@pytest.fixture
def client_with_rows():
    from fastapi.testclient import TestClient
    from gateway import main
    from gateway.run_trace import _persist_row, build_run_trace_row

    _persist_row(build_run_trace_row(
        run_id="ut-err", thread_id=_THREAD, agent_name="utest-agent",
        user_id="vjv@fracktal.in", model="tier3",
        events=[{"type": "RUN_ERROR", "message": "kaboom"}],
        folded={"content": "partial", "tool_events": [{"name": "search",
                "status": "error"}], "reasoning": None, "custom_events": [],
                "timestamp": 500},
        started_ms=100, ended_ms=500,
    ))
    _persist_row(build_run_trace_row(
        run_id="ut-ok", thread_id=_THREAD, agent_name="utest-agent",
        user_id="vjv@fracktal.in", model="tier3",
        events=[{"type": "RUN_FINISHED"}],
        folded={"content": "done", "tool_events": [], "reasoning": None,
                "custom_events": [], "timestamp": 900},
        started_ms=800, ended_ms=900,
    ))
    client = TestClient(main.app)
    yield client
    # Cleanup.
    from acb_graph import get_session
    from sqlalchemy import text
    with get_session() as s:
        s.execute(text("DELETE FROM agent_run WHERE thread_id = :t"),
                  {"t": _THREAD})


def test_list_filters_by_agent_and_status(client_with_rows):
    r = client_with_rows.get(
        "/debug/runs?agent=utest-agent&status=error&limit=10", headers=_EXEC,
    )
    assert r.status_code == 200
    data = r.json()
    assert data["count"] == 1
    run = data["runs"][0]
    assert run["run_id"] == "ut-err"
    assert run["status"] == "error"
    assert run["error_message"] == "kaboom"
    # List rows are LEAN — no heavy trace blob.
    assert "trace" not in run


def test_list_filters_by_thread(client_with_rows):
    r = client_with_rows.get(
        f"/debug/runs?thread_id={_THREAD}&limit=10", headers=_EXEC,
    )
    assert r.status_code == 200
    assert r.json()["count"] == 2  # both seeded runs


def test_invalid_status_is_400(client_with_rows):
    r = client_with_rows.get("/debug/runs?status=bogus", headers=_EXEC)
    assert r.status_code == 400


def test_detail_errored_run_has_full_trace(client_with_rows):
    r = client_with_rows.get("/debug/runs/ut-err", headers=_EXEC)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "error"
    assert body["trace"] is not None  # retention: errored → trace kept
    assert body["trace"]["content"] == "partial"


def test_detail_successful_run_has_no_trace(client_with_rows):
    r = client_with_rows.get("/debug/runs/ut-ok", headers=_EXEC)
    assert r.status_code == 200
    # Retention policy honored end-to-end through the API.
    assert r.json()["trace"] is None


def test_detail_404(client_with_rows):
    r = client_with_rows.get("/debug/runs/does-not-exist", headers=_EXEC)
    assert r.status_code == 404


def test_flag_run_sets_flagged(client_with_rows):
    r = client_with_rows.post("/debug/runs/ut-ok/flag", headers=_EXEC)
    assert r.status_code == 200
    assert r.json()["flagged"] is True
    # Reflected on the next read.
    assert client_with_rows.get(
        "/debug/runs/ut-ok", headers=_EXEC,
    ).json()["flagged"] is True


def test_flag_404(client_with_rows):
    r = client_with_rows.post("/debug/runs/nope/flag", headers=_EXEC)
    assert r.status_code == 404


def test_employee_is_forbidden(client_with_rows):
    assert client_with_rows.get("/debug/runs", headers=_EMP).status_code == 403
    assert client_with_rows.get(
        "/debug/runs/ut-err", headers=_EMP,
    ).status_code == 403
