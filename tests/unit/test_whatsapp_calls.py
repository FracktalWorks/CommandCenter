"""Unit tests for WhatsApp voice calls (transport/calls.py).

Covers the parts that hold real risk: account ownership (the bridge only checks
a shared secret, so the gateway is the only thing stopping one user driving
another's paired phone), the bridge-unreachable path, and the shared-secret gate
on the inbound call-event seam.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

import gateway.routes.whatsapp.transport.calls as calls


# ── fakes ─────────────────────────────────────────────────────────────────────

class _Row:
    def __init__(self, sync_status: str):
        self.sync_status = sync_status


class _Result:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


class _FakeDB:
    """Minimal async DB stub: every execute returns the same canned row."""

    def __init__(self, row):
        self._row = row
        self.closed = False

    async def execute(self, *_a, **_kw):
        return _Result(self._row)

    async def close(self):
        self.closed = True


class _User:
    def __init__(self, email: str = "someone@example.com"):
        self.email = email


def _patch_db(monkeypatch, row) -> _FakeDB:
    db = _FakeDB(row)

    async def _get_db():
        return db

    monkeypatch.setattr(calls, "_get_db", _get_db)
    return db


def _patch_bridge(monkeypatch, status: int, body):
    """Replace the bridge transport, recording what it was called with."""
    seen: dict = {}

    async def _bridge(method, path, timeout, **kw):
        seen["method"], seen["path"], seen["timeout"] = method, path, timeout
        seen.update(kw)
        return status, body

    monkeypatch.setattr(calls, "_bridge", _bridge)
    return seen


# ── ownership guard ───────────────────────────────────────────────────────────

async def test_unknown_account_is_404(monkeypatch) -> None:
    _patch_db(monkeypatch, None)
    with pytest.raises(HTTPException) as exc:
        await calls._assert_owns_account("someone-elses-id", _User())
    assert exc.value.status_code == 404


async def test_account_still_pairing_is_409(monkeypatch) -> None:
    _patch_db(monkeypatch, _Row("pairing"))
    with pytest.raises(HTTPException) as exc:
        await calls._assert_owns_account("acct", _User())
    assert exc.value.status_code == 409
    assert "pairing" in exc.value.detail.lower()


async def test_live_account_passes_and_closes_db(monkeypatch) -> None:
    db = _patch_db(monkeypatch, _Row("live"))
    await calls._assert_owns_account("acct", _User())
    assert db.closed is True


async def test_missing_account_id_is_400(monkeypatch) -> None:
    _patch_db(monkeypatch, _Row("live"))
    with pytest.raises(HTTPException) as exc:
        await calls._assert_owns_account("", _User())
    assert exc.value.status_code == 400


# ── placing a call ────────────────────────────────────────────────────────────

async def test_place_direct_call_forwards_to_bridge(monkeypatch) -> None:
    _patch_db(monkeypatch, _Row("live"))
    seen = _patch_bridge(monkeypatch, 200, {
        "call_id": "ABC123", "account_id": "acct", "peer": "+919876543210",
        "direction": "outgoing", "kind": "direct", "phase": "calling",
    })
    out = await calls.place_call(
        calls.PlaceCallRequest(account_id="acct", to="+919876543210"), _User())

    assert (seen["method"], seen["path"]) == ("POST", "/call")
    assert seen["json"]["session"] == "acct"
    assert seen["json"]["to"] == "+919876543210"
    assert out.call_id == "ABC123"
    assert out.phase == "calling"


async def test_place_group_call_by_group_id(monkeypatch) -> None:
    _patch_db(monkeypatch, _Row("live"))
    seen = _patch_bridge(monkeypatch, 200, {"call_id": "G1", "kind": "group"})
    out = await calls.place_call(
        calls.PlaceCallRequest(account_id="acct", group_id="12036300@g.us"), _User())

    assert seen["json"]["group_id"] == "12036300@g.us"
    assert out.kind == "group"


async def test_place_call_with_no_target_is_400(monkeypatch) -> None:
    _patch_db(monkeypatch, _Row("live"))
    _patch_bridge(monkeypatch, 200, {})
    with pytest.raises(HTTPException) as exc:
        await calls.place_call(calls.PlaceCallRequest(account_id="acct"), _User())
    assert exc.value.status_code == 400


async def test_single_target_is_not_a_group_call(monkeypatch) -> None:
    """One target can't form a group call — reject rather than silently
    turning it into a 1:1 to whoever happens to be first."""
    _patch_db(monkeypatch, _Row("live"))
    _patch_bridge(monkeypatch, 200, {})
    with pytest.raises(HTTPException) as exc:
        await calls.place_call(
            calls.PlaceCallRequest(account_id="acct", targets=["+911111111111"]), _User())
    assert exc.value.status_code == 400


async def test_unreachable_bridge_is_503_not_500(monkeypatch) -> None:
    _patch_db(monkeypatch, _Row("live"))
    _patch_bridge(monkeypatch, calls._BRIDGE_DOWN, {"detail": "not reachable"})
    with pytest.raises(HTTPException) as exc:
        await calls.place_call(
            calls.PlaceCallRequest(account_id="acct", to="+91999"), _User())
    assert exc.value.status_code == 503


async def test_bridge_timeout_is_504_not_a_proxy_abort(monkeypatch) -> None:
    """A wedged bridge must produce our own 504 with a diagnosis. If we let it
    run to the workbench proxy's 30s abort instead, the user only ever sees
    'gateway unreachable', which points at the wrong service entirely."""
    _patch_db(monkeypatch, _Row("live"))
    _patch_bridge(monkeypatch, calls._BRIDGE_TIMEOUT, {"detail": "didn't answer within 20s"})
    with pytest.raises(HTTPException) as exc:
        await calls.place_call(
            calls.PlaceCallRequest(account_id="acct", to="+91999"), _User())
    assert exc.value.status_code == 504
    assert "answer" in exc.value.detail


async def test_place_budget_stays_under_the_proxy_abort(monkeypatch) -> None:
    """The whole point of the budget: every bridge hop must finish before the
    workbench proxy gives up at 30s, or its generic error masks ours."""
    assert calls._PLACE_TIMEOUT_SECS < 30.0
    assert calls._READ_TIMEOUT_SECS < calls._PLACE_TIMEOUT_SECS

    _patch_db(monkeypatch, _Row("live"))
    seen = _patch_bridge(monkeypatch, 200, {"call_id": "A"})
    await calls.place_call(
        calls.PlaceCallRequest(account_id="acct", to="+91999"), _User())
    assert seen["timeout"] == calls._PLACE_TIMEOUT_SECS


async def test_bridge_error_status_is_propagated(monkeypatch) -> None:
    _patch_db(monkeypatch, _Row("live"))
    _patch_bridge(monkeypatch, 409, {"detail": "account not connected"})
    with pytest.raises(HTTPException) as exc:
        await calls.place_call(
            calls.PlaceCallRequest(account_id="acct", to="+91999"), _User())
    assert exc.value.status_code == 409
    assert "not connected" in exc.value.detail


# ── call actions ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("fn", "action"),
    [(calls.hangup_call, "hangup"),
     (calls.answer_call, "answer"),
     (calls.reject_call, "reject")],
)
async def test_actions_hit_their_bridge_path(monkeypatch, fn, action) -> None:
    _patch_db(monkeypatch, _Row("live"))
    seen = _patch_bridge(monkeypatch, 200, {"call_id": "X", "phase": "ended"})
    out = await fn(calls.CallActionRequest(account_id="acct", call_id="X"), _User())

    assert seen["path"] == f"/call/{action}"
    assert seen["json"]["call_id"] == "X"
    assert out.phase == "ended"


async def test_action_on_unknown_call_is_404(monkeypatch) -> None:
    _patch_db(monkeypatch, _Row("live"))
    _patch_bridge(monkeypatch, 404, {"detail": "call not found"})
    with pytest.raises(HTTPException) as exc:
        await calls.hangup_call(
            calls.CallActionRequest(account_id="acct", call_id="nope"), _User())
    assert exc.value.status_code == 404


# ── listing ───────────────────────────────────────────────────────────────────

async def test_list_calls_maps_bridge_rows(monkeypatch) -> None:
    _patch_db(monkeypatch, _Row("live"))
    _patch_bridge(monkeypatch, 200, {"calls": [
        {"call_id": "A", "phase": "active", "kind": "direct"},
        {"call_id": "B", "phase": "ended", "kind": "group"},
    ]})
    out = await calls.list_calls("acct", _User())
    assert [c.call_id for c in out.calls] == ["A", "B"]
    assert out.bridge_reachable is True


@pytest.mark.parametrize("status", [calls._BRIDGE_DOWN, calls._BRIDGE_TIMEOUT])
async def test_list_calls_survives_a_broken_bridge(monkeypatch, status) -> None:
    """A dead or wedged bridge must render as the dialer's offline state, not a
    500 and not an innocent-looking empty list."""
    _patch_db(monkeypatch, _Row("live"))
    _patch_bridge(monkeypatch, status, {})
    out = await calls.list_calls("acct", _User())
    assert out.calls == []
    assert out.bridge_reachable is False


async def test_list_calls_ignores_malformed_rows(monkeypatch) -> None:
    _patch_db(monkeypatch, _Row("live"))
    _patch_bridge(monkeypatch, 200, {"calls": [{"call_id": "A"}, "junk", None]})
    out = await calls.list_calls("acct", _User())
    assert [c.call_id for c in out.calls] == ["A"]


# ── recordings ────────────────────────────────────────────────────────────────

async def test_audio_seconds_flows_through(monkeypatch) -> None:
    """A connected call that captured zero audio is the failure that looks like
    success, so the count has to survive the hop to the UI."""
    _patch_db(monkeypatch, _Row("live"))
    _patch_bridge(monkeypatch, 200, {"calls": [
        {"call_id": "A", "phase": "ended", "recording": "/x/A.wav", "audio_seconds": 12.5},
        {"call_id": "B", "phase": "ended", "recording": "/x/B.wav", "audio_seconds": 0.0},
    ]})
    out = await calls.list_calls("acct", _User())
    assert out.calls[0].audio_seconds == 12.5
    assert out.calls[1].audio_seconds == 0.0


async def test_recording_enforces_account_ownership(monkeypatch) -> None:
    """The bridge only checks a shared secret, so audio of someone else's call
    must be refused here or not at all."""
    _patch_db(monkeypatch, None)
    with pytest.raises(HTTPException) as exc:
        await calls.call_recording("SOMECALL", "someone-elses", _User())
    assert exc.value.status_code == 404


# ── event timeline ────────────────────────────────────────────────────────────

async def test_timeline_returns_events_in_order(monkeypatch) -> None:
    _patch_db(monkeypatch, _Row("live"))
    _patch_bridge(monkeypatch, 200, {
        "call": {"call_id": "A", "phase": "ended", "audio_seconds": 4.2},
        "events": [
            {"at": "2026-08-02T20:00:00.000Z", "kind": "signal", "detail": "dialled"},
            {"at": "2026-08-02T20:00:01.000Z", "kind": "audio",
             "detail": "uplink closed: status=1006"},
        ],
    })
    out = await calls.call_events("A", "acct", _User())
    assert [e.kind for e in out.events] == ["signal", "audio"]
    assert "1006" in out.events[1].detail
    assert out.call.audio_seconds == 4.2


async def test_timeline_survives_a_down_bridge(monkeypatch) -> None:
    """The timeline is what you reach for when things are broken; it must not
    be the thing that breaks."""
    _patch_db(monkeypatch, _Row("live"))
    _patch_bridge(monkeypatch, calls._BRIDGE_DOWN, {})
    out = await calls.call_events("A", "acct", _User())
    assert out.bridge_reachable is False
    assert out.events == []


async def test_timeline_ignores_malformed_events(monkeypatch) -> None:
    _patch_db(monkeypatch, _Row("live"))
    _patch_bridge(monkeypatch, 200, {
        "call": {"call_id": "A"},
        "events": [{"at": "t", "kind": "k", "detail": "d"}, "junk", None],
    })
    out = await calls.call_events("A", "acct", _User())
    assert len(out.events) == 1


async def test_timeline_enforces_account_ownership(monkeypatch) -> None:
    _patch_db(monkeypatch, None)
    _patch_bridge(monkeypatch, 200, {})
    with pytest.raises(HTTPException) as exc:
        await calls.call_events("A", "someone-elses", _User())
    assert exc.value.status_code == 404


# ── diagnostics ───────────────────────────────────────────────────────────────

async def test_diagnostics_reports_bridge_verdict(monkeypatch) -> None:
    _patch_db(monkeypatch, _Row("live"))
    _patch_bridge(monkeypatch, 200, {
        "account_id": "acct", "session_exists": True, "logged_in": True,
        "connected": True, "caller_ready": True,
        "own_jid": "919876543210:1@s.whatsapp.net", "push_name": "Vijay",
        "active_calls": 0, "recording_dir": "/data/call-recordings",
        "verdict": "Ready to place calls.",
    })
    out = await calls.call_diagnostics("acct", _User())
    assert out.connected is True
    assert out.caller_ready is True
    assert out.verdict == "Ready to place calls."
    assert out.bridge_reachable is True


async def test_diagnostics_survives_a_down_bridge(monkeypatch) -> None:
    """Diagnostics is what you reach for when things are broken — it must not
    be the thing that breaks."""
    _patch_db(monkeypatch, _Row("live"))
    _patch_bridge(monkeypatch, calls._BRIDGE_DOWN, {"detail": "not reachable"})
    out = await calls.call_diagnostics("acct", _User())
    assert out.bridge_reachable is False
    assert "reachable" in out.verdict.lower()


async def test_diagnostics_enforces_account_ownership(monkeypatch) -> None:
    _patch_db(monkeypatch, None)
    _patch_bridge(monkeypatch, 200, {})
    with pytest.raises(HTTPException) as exc:
        await calls.call_diagnostics("someone-elses", _User())
    assert exc.value.status_code == 404


# ── inbound call-event seam ───────────────────────────────────────────────────

class _Req:
    def __init__(self, payload, secret="s3cret"):
        self._payload = payload
        self.headers = {"X-Bridge-Secret": secret} if secret else {}

    async def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


async def test_call_event_rejects_a_bad_secret(monkeypatch) -> None:
    monkeypatch.setattr(calls, "bridge_secret_ok", lambda _h: False)
    resp = await calls.bridge_call_event(_Req({"call_id": "A"}, secret="wrong"))
    assert resp.status_code == 403


async def test_call_event_accepts_a_good_secret(monkeypatch) -> None:
    monkeypatch.setattr(calls, "bridge_secret_ok", lambda _h: True)
    resp = await calls.bridge_call_event(_Req({
        "call_id": "A", "account_id": "acct", "phase": "active",
        "direction": "outgoing", "kind": "direct", "recording": "/x/A.wav",
    }))
    assert resp.status_code == 200


async def test_call_event_rejects_invalid_json(monkeypatch) -> None:
    monkeypatch.setattr(calls, "bridge_secret_ok", lambda _h: True)
    resp = await calls.bridge_call_event(_Req(ValueError("not json")))
    assert resp.status_code == 400


async def test_call_event_rejects_a_non_object_payload(monkeypatch) -> None:
    monkeypatch.setattr(calls, "bridge_secret_ok", lambda _h: True)
    resp = await calls.bridge_call_event(_Req(["not", "an", "object"]))
    assert resp.status_code == 400
