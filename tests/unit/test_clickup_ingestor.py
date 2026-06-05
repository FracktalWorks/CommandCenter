"""Unit tests for WBS 0.3 — ClickUp ingestor (offline, no Redis, no HTTP).

Tests:
  - HMAC signature verification
  - Webhook endpoint: valid sig returns 200 with {"status":"accepted"}
  - Webhook endpoint: invalid sig returns 401
  - Webhook: task event triggers background normalisation task
  - Redis queue helpers: enqueue / enqueue_dlq (mock Redis)
  - client.get_task: present in client module
"""
from __future__ import annotations

import hashlib
import hmac
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from ingestion.sources.clickup.webhook import _TASK_EVENTS, _verify, router


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_sig(body: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


# ---------------------------------------------------------------------------
# _verify()
# ---------------------------------------------------------------------------

def test_verify_valid_signature(monkeypatch):
    secret = "test-secret"
    monkeypatch.setattr(
        "ingestion.sources.clickup.webhook.get_settings",
        lambda: MagicMock(clickup_webhook_secret=secret),
    )
    body = b'{"event":"taskUpdated"}'
    sig = _make_sig(body, secret)
    assert _verify(body, sig) is True


def test_verify_invalid_signature(monkeypatch):
    secret = "test-secret"
    monkeypatch.setattr(
        "ingestion.sources.clickup.webhook.get_settings",
        lambda: MagicMock(clickup_webhook_secret=secret),
    )
    body = b'{"event":"taskUpdated"}'
    assert _verify(body, "wrong-sig") is False


def test_verify_no_secret_returns_false(monkeypatch):
    monkeypatch.setattr(
        "ingestion.sources.clickup.webhook.get_settings",
        lambda: MagicMock(clickup_webhook_secret=""),
    )
    assert _verify(b"body", "any-sig") is False


# ---------------------------------------------------------------------------
# Webhook endpoint
# ---------------------------------------------------------------------------

def _test_client() -> TestClient:
    from fastapi import FastAPI  # noqa: PLC0415
    app = FastAPI()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


def test_webhook_rejects_invalid_signature(monkeypatch):
    monkeypatch.setattr(
        "ingestion.sources.clickup.webhook.get_settings",
        lambda: MagicMock(clickup_webhook_secret="secret"),
    )
    client = _test_client()
    resp = client.post(
        "/webhooks/clickup",
        content=b'{"event":"taskUpdated","task_id":"abc"}',
        headers={"X-Signature": "bad-sig"},
    )
    assert resp.status_code == 401


def test_webhook_accepts_valid_signature(monkeypatch):
    secret = "test-secret"
    monkeypatch.setattr(
        "ingestion.sources.clickup.webhook.get_settings",
        lambda: MagicMock(clickup_webhook_secret=secret),
    )
    # Stub out enqueue so no Redis is needed
    monkeypatch.setattr("ingestion.sources.clickup.webhook.enqueue", MagicMock())
    # Stub out background normalisation so no ClickUp API / DB calls happen
    monkeypatch.setattr("ingestion.sources.clickup.webhook._normalise_task", AsyncMock())
    body = b'{"event":"taskUpdated","task_id":"abc123"}'
    sig = _make_sig(body, secret)
    client = _test_client()
    resp = client.post(
        "/webhooks/clickup",
        content=body,
        headers={"X-Signature": sig},
    )
    assert resp.status_code == 200
    assert resp.json() == {"status": "accepted"}


def test_webhook_enqueues_event(monkeypatch):
    secret = "sec"
    monkeypatch.setattr(
        "ingestion.sources.clickup.webhook.get_settings",
        lambda: MagicMock(clickup_webhook_secret=secret),
    )
    enqueue_mock = MagicMock(return_value="1234-0")
    monkeypatch.setattr("ingestion.sources.clickup.webhook.enqueue", enqueue_mock)
    # Prevent background task from making real API/DB calls
    monkeypatch.setattr("ingestion.sources.clickup.webhook._normalise_task", AsyncMock())

    body = json.dumps({"event": "taskCreated", "task_id": "t1"}).encode()
    sig = _make_sig(body, secret)
    client = _test_client()
    client.post("/webhooks/clickup", content=body, headers={"X-Signature": sig})

    enqueue_mock.assert_called_once()
    call_args = enqueue_mock.call_args[0]
    assert call_args[1] == "taskCreated"


# ---------------------------------------------------------------------------
# Task event set
# ---------------------------------------------------------------------------

def test_task_events_set_contains_expected():
    assert "taskCreated" in _TASK_EVENTS
    assert "taskUpdated" in _TASK_EVENTS
    assert "taskDeleted" in _TASK_EVENTS


# ---------------------------------------------------------------------------
# client.get_task exists
# ---------------------------------------------------------------------------

def test_client_has_get_task():
    from ingestion.sources.clickup import client  # noqa: PLC0415
    assert hasattr(client, "get_task"), "client.get_task must exist (WBS 0.3)"
    import inspect  # noqa: PLC0415
    assert inspect.iscoroutinefunction(client.get_task)


# ---------------------------------------------------------------------------
# queue helpers (mock Redis)
# ---------------------------------------------------------------------------

def test_enqueue_calls_xadd(monkeypatch):
    from ingestion import queue  # noqa: PLC0415

    mock_redis = MagicMock()
    mock_redis.xadd = MagicMock(return_value="1234-0")
    monkeypatch.setattr(queue, "_client", lambda: mock_redis)

    entry_id = queue.enqueue(queue.STREAM_CLICKUP, "taskUpdated", {"task_id": "t1"})
    assert entry_id == "1234-0"
    mock_redis.xadd.assert_called_once()


def test_enqueue_dlq_calls_xadd(monkeypatch):
    from ingestion import queue  # noqa: PLC0415

    mock_redis = MagicMock()
    mock_redis.xadd = MagicMock(return_value="9999-0")
    monkeypatch.setattr(queue, "_client", lambda: mock_redis)

    entry_id = queue.enqueue_dlq(queue.STREAM_CLICKUP, "taskUpdated", {}, error="boom")
    assert entry_id == "9999-0"
    call_fields = mock_redis.xadd.call_args[0][1]
    assert call_fields["error"] == "boom"
    assert call_fields["origin_stream"] == queue.STREAM_CLICKUP