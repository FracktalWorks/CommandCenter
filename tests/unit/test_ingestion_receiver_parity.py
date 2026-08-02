"""BO-20f — the Gmail and Zoho receivers reach ClickUp's enqueue + emit parity.

Offline: no Redis, no DB, no network.

What is faked, and what deliberately is NOT:
  - **Redis** is faked at ``queue._client`` (the ``test_clickup_ingestor.py:158-181``
    pattern), so the real ``queue.enqueue`` runs and we assert on the actual
    ``xadd`` the receiver produces — this works regardless of how the receiver
    imports ``enqueue``.
  - **The event-sink registry is REAL.** ``emit_event`` is never monkeypatched:
    faking it would make the sink assertion vacuous, and the receivers import it
    inside the function body so patching the module attribute would not take
    effect anyway. A recording sink is registered via ``register_event_sink``,
    and ``clear_event_sinks()`` runs in setup — if anything in the session
    imported ``gateway.main``, ``_SINKS`` already holds the real
    ``dispatch_event`` and "invoked exactly once" would otherwise be
    conditional. Teardown **restores** the snapshot rather than clearing, so
    this file cannot leave a later test looking at an empty registry.
  - **``acb_audit.record``** is faked. Both receivers audit-log every accepted
    push, and ``record`` opens a real ``acb_graph`` session (best-effort, its
    failure is swallowed) — without this stub these unit tests would reach for
    the configured Postgres. It carries none of the assertions below.
"""
from __future__ import annotations

import asyncio
import base64
import json
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, FastAPI
from fastapi.testclient import TestClient
from ingestion import event_hooks, queue
from ingestion.event_hooks import clear_event_sinks, emit_event, register_event_sink
from ingestion.sources.gmail import webhook as gmail_webhook
from ingestion.sources.zoho import webhook as zoho_webhook

GMAIL_TOKEN = "gmail-pubsub-token"
ZOHO_SECRET = "zoho-shared-secret"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def sink_calls():
    """Record every ``(source, event_type, payload)`` the REAL registry fans out.

    ``_SINKS`` is process-global, so teardown **restores** the snapshot rather
    than clearing: a later test in the same session that asserts "webhook →
    workflow run" must not silently see an empty registry because this file
    happened to run first.
    """
    saved = list(event_hooks._SINKS)
    clear_event_sinks()
    calls: list[tuple[str, str, dict[str, Any]]] = []

    async def _recording_sink(source: str, event_type: str, payload: dict[str, Any]) -> None:
        calls.append((source, event_type, payload))

    register_event_sink(_recording_sink)
    try:
        yield calls
    finally:
        clear_event_sinks()
        event_hooks._SINKS.extend(saved)


@pytest.fixture
def mock_redis(monkeypatch):
    """Fake Redis behind the real ``queue.enqueue``."""
    client = MagicMock()
    client.xadd = MagicMock(return_value="1719123456789-0")
    monkeypatch.setattr(queue, "_client", lambda: client)
    return client


@pytest.fixture(autouse=True)
def _no_audit_db(monkeypatch):
    """Keep the audit write off the DB (see module docstring)."""
    monkeypatch.setattr(gmail_webhook, "record", MagicMock())
    monkeypatch.setattr(zoho_webhook, "record", MagicMock())


@pytest.fixture
def gmail_settings(monkeypatch) -> None:
    monkeypatch.setattr(
        "ingestion.sources.gmail.webhook.get_settings",
        lambda: MagicMock(gmail_pubsub_token=GMAIL_TOKEN),
    )


@pytest.fixture
def zoho_settings(monkeypatch) -> None:
    monkeypatch.setattr(
        "ingestion.sources.zoho.webhook.get_settings",
        lambda: MagicMock(zoho_webhook_secret=ZOHO_SECRET),
    )


@pytest.fixture
def gmail_client(gmail_settings) -> TestClient:
    app = FastAPI()
    app.include_router(gmail_webhook.router)
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def zoho_client(zoho_settings) -> TestClient:
    app = FastAPI()
    app.include_router(zoho_webhook.router)
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

GMAIL_NOTIFICATION: dict[str, Any] = {"emailAddress": "ops@fracktal.in", "historyId": 9182734}
ZOHO_PAYLOAD: dict[str, Any] = {
    "event": "Deals.update",
    "module": "Deals",
    "data": [{"id": "555", "module": "Deals"}],
}


def _pubsub_envelope(notification: dict[str, Any]) -> dict[str, Any]:
    data = base64.b64encode(json.dumps(notification).encode()).decode()
    return {"message": {"data": data, "messageId": "1"}, "subscription": "projects/x/subscriptions/y"}


def _post_gmail(client: TestClient, body: dict[str, Any], token: str = GMAIL_TOKEN):
    return client.post("/webhooks/gmail", json=body, headers={"Authorization": f"Bearer {token}"})


def _post_zoho(client: TestClient, body: dict[str, Any], token: str = ZOHO_SECRET):
    return client.post("/webhooks/zoho", json=body, headers={"X-Zoho-Token": token})


def _xadd_call(mock_redis: MagicMock) -> tuple[str, dict[str, str]]:
    """The single ``xadd`` the receiver produced → (stream, fields)."""
    assert mock_redis.xadd.call_count == 1, (
        f"expected exactly one xadd, got {mock_redis.xadd.call_count}"
    )
    args = mock_redis.xadd.call_args[0]
    return args[0], args[1]


# ---------------------------------------------------------------------------
# (i) exactly one xadd, to the right stream, carrying the prescribed event type
# ---------------------------------------------------------------------------

def test_gmail_enqueues_decoded_notification(gmail_client, mock_redis, sink_calls):
    resp = _post_gmail(gmail_client, _pubsub_envelope(GMAIL_NOTIFICATION))
    assert resp.status_code == 200
    assert resp.json() == {"status": "accepted"}

    stream, fields = _xadd_call(mock_redis)
    assert stream == queue.STREAM_GMAIL
    assert fields["event_type"] == "historyUpdated"
    # The DECODED notification is what goes on the bus — never the base64 envelope.
    assert json.loads(fields["data"]) == GMAIL_NOTIFICATION


def test_zoho_enqueues_parsed_body(zoho_client, mock_redis, sink_calls):
    resp = _post_zoho(zoho_client, ZOHO_PAYLOAD)
    assert resp.status_code == 200
    assert resp.json() == {"status": "accepted"}

    stream, fields = _xadd_call(mock_redis)
    assert stream == queue.STREAM_ZOHO
    # The event type is the value the receiver already computes from the body.
    assert fields["event_type"] == "Deals.update"
    assert json.loads(fields["data"]) == ZOHO_PAYLOAD


def test_zoho_event_type_falls_back_to_unknown(zoho_client, mock_redis, sink_calls):
    """No ``event``/``operation`` key → the receiver's existing "unknown"."""
    body = {"module": "Contacts"}
    assert _post_zoho(zoho_client, body).status_code == 200
    _, fields = _xadd_call(mock_redis)
    assert fields["event_type"] == "unknown"
    assert sink_calls == [("zoho", "unknown", body)]


# ---------------------------------------------------------------------------
# (ii) the real sink registry is invoked exactly once with the prescribed tuple
# ---------------------------------------------------------------------------

def test_gmail_emits_event_once(gmail_client, mock_redis, sink_calls):
    _post_gmail(gmail_client, _pubsub_envelope(GMAIL_NOTIFICATION))
    # TestClient runs BackgroundTasks before returning — no sleep needed.
    assert sink_calls == [("gmail", "historyUpdated", GMAIL_NOTIFICATION)]


def test_zoho_emits_event_once(zoho_client, mock_redis, sink_calls):
    _post_zoho(zoho_client, ZOHO_PAYLOAD)
    assert sink_calls == [("zoho", "Deals.update", ZOHO_PAYLOAD)]


# ---------------------------------------------------------------------------
# (iii) Redis down: still 200, still emitted
# ---------------------------------------------------------------------------

def test_gmail_survives_redis_failure(gmail_client, mock_redis, sink_calls):
    mock_redis.xadd.side_effect = RuntimeError("redis down")
    resp = _post_gmail(gmail_client, _pubsub_envelope(GMAIL_NOTIFICATION))
    assert resp.status_code == 200
    assert resp.json() == {"status": "accepted"}
    assert sink_calls == [("gmail", "historyUpdated", GMAIL_NOTIFICATION)]


def test_zoho_survives_redis_failure(zoho_client, mock_redis, sink_calls):
    mock_redis.xadd.side_effect = RuntimeError("redis down")
    resp = _post_zoho(zoho_client, ZOHO_PAYLOAD)
    assert resp.status_code == 200
    assert resp.json() == {"status": "accepted"}
    assert sink_calls == [("zoho", "Deals.update", ZOHO_PAYLOAD)]


# ---------------------------------------------------------------------------
# (iv) auth is unchanged — an invalid credential still 401s and side-effects nothing
# ---------------------------------------------------------------------------

def test_gmail_rejects_invalid_bearer(gmail_client, mock_redis, sink_calls):
    resp = _post_gmail(gmail_client, _pubsub_envelope(GMAIL_NOTIFICATION), token="wrong")
    assert resp.status_code == 401
    assert mock_redis.xadd.call_count == 0
    assert sink_calls == []


def test_zoho_rejects_invalid_token(zoho_client, mock_redis, sink_calls):
    resp = _post_zoho(zoho_client, ZOHO_PAYLOAD, token="wrong")
    assert resp.status_code == 401
    assert mock_redis.xadd.call_count == 0
    assert sink_calls == []


def test_non_ascii_credentials_401_not_500(gmail_client, zoho_client, mock_redis, sink_calls):
    """A non-ASCII credential is a rejection, not a crash.

    ``hmac.compare_digest`` raises ``TypeError`` when handed a ``str``
    containing non-ASCII, so comparing the raw strings turned
    ``?token=%C3%A9`` into a 500 on an endpoint that is in ``PUBLIC_ROUTES``.
    It failed closed, but a 500 is free noise for an unauthenticated caller.
    """
    zoho_resp = zoho_client.post("/webhooks/zoho?token=%C3%A9", json=ZOHO_PAYLOAD)
    assert zoho_resp.status_code == 401, zoho_resp.text

    # Header values go on the wire as bytes and Starlette latin-1-decodes them,
    # so a non-ASCII bearer is reachable — httpx just refuses to encode it from
    # a `str`, hence the explicit bytes here.
    gmail_resp = gmail_client.post(
        "/webhooks/gmail",
        json=_pubsub_envelope(GMAIL_NOTIFICATION),
        headers={"Authorization": "Bearer é".encode("latin-1")},
    )
    assert gmail_resp.status_code == 401, gmail_resp.text

    assert mock_redis.xadd.call_count == 0
    assert sink_calls == []


# ---------------------------------------------------------------------------
# (v) payload shapes the providers are not obliged to avoid
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("raw", ["[1,2]", "null", '"hi"', "3"])
def test_gmail_non_object_push_is_acked_not_500(raw, gmail_client, mock_redis, sink_calls):
    """A push whose data decodes to valid JSON that is not an object.

    The receiver reads ``emailAddress``/``historyId`` off the decode, so a list
    or ``None`` raised ``AttributeError`` → 500 → Pub/Sub retries the same
    undecodable push forever. Same reasoning as the empty-decode case below.
    """
    data = base64.b64encode(raw.encode()).decode()
    resp = _post_gmail(gmail_client, {"message": {"data": data, "messageId": "1"}})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"status": "accepted"}
    assert mock_redis.xadd.call_count == 0
    assert sink_calls == []


@pytest.mark.parametrize("raw", ["[1,2]", "null", '"hi"', "3"])
def test_gmail_decode_envelope_always_returns_a_dict(raw):
    data = base64.b64encode(raw.encode()).decode()
    assert gmail_webhook._decode_envelope({"message": {"data": data}}) == {}


def test_zoho_non_string_event_becomes_a_string(zoho_client, mock_redis, sink_calls):
    """``event`` is a wire token: it must reach ``xadd`` as a string.

    Redis rejects a non-scalar stream field (``DataError: Invalid input of
    type: 'dict'``), and the receiver's ``except`` would log that as
    ``zoho.queue.unavailable`` — blaming Redis for a payload-shape problem —
    while the sink fan-out still started a run.
    """
    body = {"event": {"type": "Deals.update"}, "module": "Deals"}
    assert _post_zoho(zoho_client, body).status_code == 200
    _, fields = _xadd_call(mock_redis)
    assert isinstance(fields["event_type"], str)
    assert fields["event_type"] == "{'type': 'Deals.update'}"
    assert sink_calls == [("zoho", "{'type': 'Deals.update'}", body)]


# ---------------------------------------------------------------------------
# (vi) the emit is DEFERRED to BackgroundTasks, never awaited inline
# ---------------------------------------------------------------------------
# Not cosmetic: an inline `await emit_event(...)` puts a DB round-trip plus one
# INSERT INTO workflow_runs per matching trigger inside the provider's ack
# deadline (Pub/Sub's default is 10s), so a slow DB becomes provider retries and
# therefore duplicate runs — exactly what BackgroundTasks prevents. TestClient
# runs the tasks before returning, so it cannot tell the two apart; call the
# endpoint coroutine directly with a hand-built BackgroundTasks instead.

class _FakeRequest:
    def __init__(self, body: dict[str, Any]) -> None:
        self._body = body

    async def json(self) -> dict[str, Any]:
        return self._body


def _scheduled(bt: BackgroundTasks) -> list[tuple[Any, tuple[Any, ...]]]:
    return [(t.func, t.args) for t in bt.tasks]


def test_zoho_defers_emit_to_background_tasks(zoho_settings, mock_redis, sink_calls):
    bt = BackgroundTasks()
    resp = asyncio.run(
        zoho_webhook.receive(_FakeRequest(ZOHO_PAYLOAD), bt, token=ZOHO_SECRET)
    )
    assert resp == {"status": "accepted"}
    # The endpoint has returned and the sink has NOT run — the emit is deferred.
    assert sink_calls == []
    assert _scheduled(bt) == [(emit_event, ("zoho", "Deals.update", ZOHO_PAYLOAD))]


def test_gmail_defers_emit_to_background_tasks(gmail_settings, mock_redis, sink_calls):
    bt = BackgroundTasks()
    envelope = _pubsub_envelope(GMAIL_NOTIFICATION)
    resp = asyncio.run(
        gmail_webhook.receive(
            _FakeRequest(envelope), bt, authorization=f"Bearer {GMAIL_TOKEN}"
        )
    )
    assert resp == {"status": "accepted"}
    assert sink_calls == []
    assert _scheduled(bt) == [
        (emit_event, ("gmail", "historyUpdated", GMAIL_NOTIFICATION))
    ]


# ---------------------------------------------------------------------------
# Empty-decode: the case the spec leaves open, settled and pinned here
# ---------------------------------------------------------------------------

def test_gmail_undecodable_push_is_acked_but_not_dispatched(gmail_client, mock_redis, sink_calls):
    """A dataless / malformed Pub/Sub push decodes to {} — ack it, dispatch nothing.

    Decision (BO-20f left this open): an empty decode carries neither mailbox nor
    historyId, so enqueueing it would replay nothing and emitting it would fire
    user-visible workflow triggers with a payload no run can act on. We still
    return 200 so Pub/Sub does not retry a push that can never decode.
    """
    for envelope in ({"message": {"messageId": "1"}}, {"message": {"data": "!!not-base64!!"}}):
        mock_redis.xadd.reset_mock()
        resp = _post_gmail(gmail_client, envelope)
        assert resp.status_code == 200
        assert resp.json() == {"status": "accepted"}
        assert mock_redis.xadd.call_count == 0
        assert sink_calls == []
