"""Unit tests for the Microsoft Graph push-notification endpoint.

Covers the two responsibilities of `/email/webhook/microsoft`:
  1. the validation handshake (echo the validationToken),
  2. notification routing (validate clientState → queue a background sync).

The DB session is mocked, so no DB or mailbox is required.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import BackgroundTasks

from gateway.routes import email as m


class _Req:
    """Minimal stand-in for starlette Request (query_params + json())."""

    def __init__(self, query: dict | None = None, body: dict | None = None):
        self.query_params = query or {}
        self._body = body

    async def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


def _mock_db(fetchone_row):
    db = AsyncMock()
    result = MagicMock()
    result.fetchone.return_value = fetchone_row
    db.execute.return_value = result
    return db


async def test_validation_handshake_echoes_token() -> None:
    req = _Req(query={"validationToken": "tok-abc-123"})
    bg = BackgroundTasks()
    resp = await m.microsoft_webhook(req, bg)
    assert resp.status_code == 200
    assert resp.body == b"tok-abc-123"
    assert len(bg.tasks) == 0  # validation must not trigger a sync


async def test_unknown_subscription_queues_nothing() -> None:
    req = _Req(body={"value": [{"subscriptionId": "sub-x", "clientState": "cs"}]})
    bg = BackgroundTasks()
    with patch.object(m, "_get_db", AsyncMock(return_value=_mock_db(None))):
        resp = await m.microsoft_webhook(req, bg)
    assert resp.status_code == 202
    assert len(bg.tasks) == 0


async def test_known_subscription_queues_one_sync() -> None:
    req = _Req(body={"value": [
        {"subscriptionId": "sub-x", "clientState": "cs-match"}
    ]})
    bg = BackgroundTasks()
    row = SimpleNamespace(id="acc-1", webhook_client_state="cs-match")
    with patch.object(m, "_get_db", AsyncMock(return_value=_mock_db(row))):
        resp = await m.microsoft_webhook(req, bg)
    assert resp.status_code == 202
    assert len(bg.tasks) == 1
    assert bg.tasks[0].func is m._webhook_sync
    assert bg.tasks[0].args == ("acc-1",)


async def test_client_state_mismatch_is_ignored() -> None:
    req = _Req(body={"value": [
        {"subscriptionId": "sub-x", "clientState": "FORGED"}
    ]})
    bg = BackgroundTasks()
    row = SimpleNamespace(id="acc-1", webhook_client_state="cs-correct")
    with patch.object(m, "_get_db", AsyncMock(return_value=_mock_db(row))):
        resp = await m.microsoft_webhook(req, bg)
    assert resp.status_code == 202
    assert len(bg.tasks) == 0  # spoofed clientState rejected


async def test_malformed_body_returns_202_without_crashing() -> None:
    req = _Req(body=None)  # .json() raises
    bg = BackgroundTasks()
    resp = await m.microsoft_webhook(req, bg)
    assert resp.status_code == 202
    assert len(bg.tasks) == 0
