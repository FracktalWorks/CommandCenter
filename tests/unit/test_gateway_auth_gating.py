"""Auth gating on dangerous gateway endpoints (audit C2/C6, BO-2).

get_current_user never rejects — it only labels — so several state-changing
endpoints were anonymously reachable. These assert that the internal-Bearer
gate now 401s an unauthenticated caller BEFORE any handler work runs.
"""
from __future__ import annotations

from fastapi.testclient import TestClient


def _client(monkeypatch) -> TestClient:
    # Enable Bearer auth with a known token; tests below deliberately omit it.
    monkeypatch.setenv("GATEWAY_INTERNAL_TOKEN", "test-internal-token")
    from gateway.main import app

    return TestClient(app, raise_server_exceptions=False)


def test_mutation_approve_rejects_anonymous(monkeypatch) -> None:
    # C2: approving a mutation runs `git push` — must never be anonymous.
    client = _client(monkeypatch)
    r = client.post("/agent/mutations/pending/deadbeef/approve")
    assert r.status_code == 401


def test_mutation_reject_and_remutate_reject_anonymous(monkeypatch) -> None:
    client = _client(monkeypatch)
    assert client.post(
        "/agent/mutations/pending/deadbeef/reject"
    ).status_code == 401
    assert client.post(
        "/agent/mutations/pending/deadbeef/remutate"
    ).status_code == 401
    assert client.delete(
        "/agent/mutations/pending/deadbeef"
    ).status_code == 401


def test_memory_endpoints_reject_anonymous(monkeypatch) -> None:
    # C6: /memory/{user_id}/* is an IDOR without auth (read/delete any user).
    client = _client(monkeypatch)
    assert client.get("/memory/someone@example.com").status_code == 401
    assert client.post(
        "/memory/someone@example.com/search",
        json={"query": "x", "limit": 1},
    ).status_code == 401


def test_mutation_approve_allows_internal_token(monkeypatch) -> None:
    # With the internal Bearer token the auth gate passes (the handler may then
    # 404 the bogus commit id — the point is auth no longer blocks it at 401).
    client = _client(monkeypatch)
    r = client.post(
        "/agent/mutations/pending/deadbeef/approve",
        headers={"Authorization": "Bearer test-internal-token"},
    )
    assert r.status_code != 401
