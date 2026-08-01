"""Transport · calls — voice calls on a paired personal (whatsmeow) number.

The gateway holds no WhatsApp session, so this module is a thin, authenticated
proxy in front of the bridge's call API (apps/services/whatsapp_bridge/calls.go),
plus the inbound seam the bridge pushes call state to.

Why only personal numbers: Meta's Cloud API Calling product is 1:1-only and has
to be enabled per-number by Meta, and our WABA route has no media leg yet. The
whatsmeow bridge + meowcaller path works today and is the only one that can do
group calls at all. See ai-company-brain/specs/whatsapp_calls_note_taker.md.

    POST /whatsapp/calls          {account_id, to | group_id | targets}
    POST /whatsapp/calls/hangup   {account_id, call_id}
    POST /whatsapp/calls/answer   {account_id, call_id}
    POST /whatsapp/calls/reject   {account_id, call_id}
    GET  /whatsapp/calls?account_id=
    POST /whatsapp/bridge/call-event   (bridge → gateway, shared secret)

Calls placed from an unofficial client are outside WhatsApp's Terms of Service
and can get the number banned; the UI says so before the first call.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from acb_common import get_logger
from fastapi import Depends, HTTPException, Request, Response
from gateway.routes.whatsapp.core import _get_db, router
from gateway.routes.whatsapp.transport.bridge import (
    _bridge_headers,
    _bridge_url,
    bridge_secret_ok,
)
from pydantic import BaseModel
from sqlalchemy import text

_log = get_logger("gateway.whatsapp.calls")

# Our budget must stay strictly UNDER the Next proxy's 30s abort
# (workbench api/whatsapp/[...path]/route.ts). If they match, a slow bridge
# trips the proxy at the same moment we time out, and the user sees the
# proxy's generic "gateway unreachable" instead of what actually went wrong.
# Placing a call waits on WhatsApp's signalling round-trip, so it gets more
# room than a read; both stay well clear of 30s.
_PLACE_TIMEOUT_SECS = 20.0
_READ_TIMEOUT_SECS = 8.0


class PlaceCallRequest(BaseModel):
    account_id: str
    to: str = ""
    group_id: str = ""
    targets: list[str] = []


class CallActionRequest(BaseModel):
    account_id: str
    call_id: str


class CallModel(BaseModel):
    """One call as the bridge reports it. Mirrors callInfo in calls.go."""

    call_id: str = ""
    account_id: str = ""
    peer: str = ""
    direction: str = ""
    kind: str = ""
    phase: str = ""
    targets: list[str] = []
    started_at: str = ""
    ended_at: str = ""
    end_reason: str = ""
    recording: str = ""


class CallListModel(BaseModel):
    calls: list[CallModel] = []
    bridge_reachable: bool = True


async def _assert_owns_account(account_id: str, user: UserContext) -> None:
    """Confirm the account is this user's, and is a bridge (whatsmeow) number.

    Without this, any signed-in user could drive calls from anyone's paired
    phone — the bridge itself only checks the shared secret, so ownership has
    to be enforced here."""
    if not account_id:
        raise HTTPException(status_code=400, detail="account_id required")
    db = await _get_db()
    try:
        row = (await db.execute(
            text("""SELECT sync_status FROM wa_accounts
                    WHERE id = :aid AND user_id = :uid AND provider = 'whatsmeow'"""),
            {"aid": account_id, "uid": user.email or "anonymous"},
        )).fetchone()
    finally:
        await db.close()
    if not row:
        raise HTTPException(
            status_code=404,
            detail="No paired personal WhatsApp number with that id.")
    if row.sync_status != "live":
        raise HTTPException(
            status_code=409,
            detail="That number isn't paired yet — finish QR pairing first.")


#: Sentinel statuses for the two ways the bridge hop fails without an HTTP
#: reply. Kept distinct because they mean different things to the operator:
#: unreachable = the service is down or the URL is wrong; timeout = it accepted
#: the connection and then never answered (a wedged call, usually).
_BRIDGE_DOWN = 0
_BRIDGE_TIMEOUT = -1


async def _bridge(method: str, path: str, timeout: float, **kw: Any) -> tuple[int, Any]:
    """One request to the bridge. Returns ``(status, parsed_body)``.

    Never lets an httpx error escape as a 500 — the dialer needs to tell the
    user which half is broken, and an opaque 500 (or a proxy-level abort) tells
    them nothing."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            resp = await client.request(
                method, f"{_bridge_url()}{path}", headers=_bridge_headers(), **kw)
        try:
            body = resp.json()
        except ValueError:
            body = {"detail": resp.text[:300]}
        return resp.status_code, body
    except httpx.TimeoutException:
        _log.warning("whatsapp.calls.bridge_timeout", path=path, timeout=timeout)
        return _BRIDGE_TIMEOUT, {
            "detail": (
                f"The WhatsApp bridge accepted the request but didn't answer "
                f"within {timeout:g}s. Check it with "
                f"`journalctl -u acb-whatsapp-bridge -f` while you retry."
            )}
    except Exception as exc:
        _log.warning("whatsapp.calls.bridge_unreachable", error=str(exc)[:200])
        return _BRIDGE_DOWN, {
            "detail": (
                "The WhatsApp bridge isn't reachable. Check that the "
                "whatsapp_bridge service is running and WHATSAPP_BRIDGE_URL "
                "points at it."
            )}


def _raise_for_bridge(status: int, body: Any, action: str) -> None:
    """Translate a bridge failure into an HTTP error the dialer can show."""
    if status == _BRIDGE_DOWN:
        raise HTTPException(status_code=503, detail=_detail(body, "bridge unreachable"))
    if status == _BRIDGE_TIMEOUT:
        raise HTTPException(status_code=504, detail=_detail(body, "bridge timed out"))
    if status >= 300:
        raise HTTPException(status_code=status, detail=_detail(body, f"{action} failed"))


def _detail(body: Any, fallback: str) -> str:
    if isinstance(body, dict):
        return str(body.get("detail") or fallback)
    return str(body or fallback)[:300]


def _as_call(body: Any) -> CallModel:
    return CallModel(**body) if isinstance(body, dict) else CallModel()


@router.post("/calls", response_model=CallModel)
async def place_call(
    body: PlaceCallRequest, user: UserContext = Depends(get_current_user),
) -> CallModel:
    """Place a 1:1 call (``to``) or a group call (``group_id``, or two or more
    ``targets``) from a paired personal number."""
    await _assert_owns_account(body.account_id, user)
    if not body.to and not body.group_id and len(body.targets) < 2:
        raise HTTPException(
            status_code=400,
            detail="Give a number to call, a group id, or at least two targets.")

    status, data = await _bridge("POST", "/call", _PLACE_TIMEOUT_SECS, json={
        "session": body.account_id, "to": body.to,
        "group_id": body.group_id, "targets": body.targets,
    })
    _raise_for_bridge(status, data, "call")
    _log.info("whatsapp.calls.placed", account_id=body.account_id,
              kind="group" if (body.group_id or body.targets) else "direct")
    return _as_call(data)


async def _call_action(action: str, body: CallActionRequest, user: UserContext) -> CallModel:
    await _assert_owns_account(body.account_id, user)
    status, data = await _bridge("POST", f"/call/{action}", _READ_TIMEOUT_SECS, json={
        "session": body.account_id, "call_id": body.call_id,
    })
    _raise_for_bridge(status, data, action)
    return _as_call(data)


@router.post("/calls/hangup", response_model=CallModel)
async def hangup_call(
    body: CallActionRequest, user: UserContext = Depends(get_current_user),
) -> CallModel:
    """End a call this account placed or answered."""
    return await _call_action("hangup", body, user)


@router.post("/calls/answer", response_model=CallModel)
async def answer_call(
    body: CallActionRequest, user: UserContext = Depends(get_current_user),
) -> CallModel:
    """Answer a ringing inbound call. Inbound calls are never auto-answered."""
    return await _call_action("answer", body, user)


@router.post("/calls/reject", response_model=CallModel)
async def reject_call(
    body: CallActionRequest, user: UserContext = Depends(get_current_user),
) -> CallModel:
    """Decline a ringing inbound call."""
    return await _call_action("reject", body, user)


@router.get("/calls", response_model=CallListModel)
async def list_calls(
    account_id: str, user: UserContext = Depends(get_current_user),
) -> CallListModel:
    """Every call the bridge is tracking for this account, live and recently
    ended. An unreachable bridge is reported as an empty list plus a flag, not
    an error — the dialer should render its "bridge is down" state, not a crash."""
    await _assert_owns_account(account_id, user)
    status, data = await _bridge(
        "GET", "/calls", _READ_TIMEOUT_SECS, params={"session": account_id})
    if status <= 0 or status >= 300:
        # A timeout still means the bridge is answering the socket but wedged —
        # report it as unreachable so the dialer shows its offline state rather
        # than pretending there are simply no calls.
        return CallListModel(calls=[], bridge_reachable=status > 0)
    raw = data.get("calls") if isinstance(data, dict) else None
    return CallListModel(
        calls=[_as_call(c) for c in (raw or []) if isinstance(c, dict)],
        bridge_reachable=True,
    )


@router.post("/bridge/call-event")
async def bridge_call_event(request: Request) -> Response:
    """The bridge reports a call's state transition (ringing → active → ended).

    Logged rather than persisted for now: the dialer polls ``GET /calls`` for
    authoritative state, and a call row only earns a place in the database once
    it carries a transcript. This is the seam the note-taker pipeline hooks when
    that lands — an ``ended`` event with a recording path is its trigger."""
    if not bridge_secret_ok(request.headers.get("X-Bridge-Secret")):
        return Response(status_code=403, content="bad secret")
    try:
        payload = await request.json()
    except Exception:
        return Response(status_code=400, content="invalid json")
    if not isinstance(payload, dict):
        return Response(status_code=400, content="invalid payload")

    _log.info(
        "whatsapp.calls.event",
        call_id=str(payload.get("call_id") or "")[:64],
        account_id=str(payload.get("account_id") or "")[:64],
        phase=str(payload.get("phase") or "")[:32],
        direction=str(payload.get("direction") or "")[:16],
        kind=str(payload.get("kind") or "")[:16],
        has_recording=bool(payload.get("recording")),
    )
    return Response(status_code=200, content="ok")
