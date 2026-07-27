"""Transport · bridge — the whatsmeow (QR/personal) inbound + pairing seam (W15).

The unofficial personal-number counterpart to ``webhook.py``. A local whatsmeow
bridge service (apps/services/whatsapp_bridge) pairs a personal number by QR,
holds the session, and streams NORMALIZED messages here. This module:

* ``POST /whatsapp/bridge/ingest`` — the bridge posts a batch of normalized
  messages (shared-secret auth); we parse → ``persist_sync_result`` → the SAME
  post-sync hooks the webhook fires. So every message a personal number receives
  flows through the identical triage + AI brain as a Cloud API number.
* ``POST /whatsapp/bridge/paired`` — the bridge tells us a device finished
  pairing; we fill in the number/name and flip the account to 'live'.
* ``POST /whatsapp/bridge/connect`` — the app asks to pair: create a 'pairing'
  account and ask the bridge for a QR to show.
* ``GET  /whatsapp/bridge/status`` — the app polls pairing status + QR.

The gateway holds NO WhatsApp session — it only talks HTTP to the bridge. The
``parse_bridge_payload`` mapper is pure/testable; it produces the exact
``SyncResult`` the shared persist path already consumes.
"""

from __future__ import annotations

import hmac
import json
import os
from datetime import datetime
from typing import Any
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from acb_common import get_logger
from fastapi import Depends, Request, Response
from gateway.routes.whatsapp.core import _get_db, fire_post_sync_hooks, router
from pydantic import BaseModel
from sqlalchemy import text
from whatsapp_ingestion.providers.base import (
    SyncResult,
    WhatsAppContact,
    WhatsAppMedia,
    WhatsAppMessage,
)

_log = get_logger("gateway.whatsapp.bridge")

_BRIDGE_SECRET_ENV = "WHATSAPP_BRIDGE_SECRET"
_BRIDGE_URL_ENV = "WHATSAPP_BRIDGE_URL"
_DEFAULT_BRIDGE_URL = "http://localhost:8790"


# ── pure parser ───────────────────────────────────────────────────────────────

def _parse_ts(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def parse_bridge_payload(payload: dict[str, Any]) -> SyncResult:
    """Map the bridge's normalized JSON batch to a ``SyncResult``. Pure.

    The bridge is our own service, so the JSON is our contract: a ``messages``
    list (+ optional ``contacts``) shaped like the ``WhatsAppMessage`` dataclass.
    Messages missing an id or chat id are skipped (never a partial row)."""
    result = SyncResult()
    for c in payload.get("contacts") or []:
        if not isinstance(c, dict):
            continue
        result.contacts.append(WhatsAppContact(
            wa_id=str(c.get("wa_id") or ""),
            phone_number=str(c.get("phone_number") or ""),
            name=str(c.get("name") or ""),
        ))
    for m in payload.get("messages") or []:
        if not isinstance(m, dict) or not m.get("wa_message_id") or not m.get("chat_id"):
            continue
        media = None
        md = m.get("media")
        if isinstance(md, dict) and md.get("wa_media_id"):
            media = WhatsAppMedia(
                wa_media_id=str(md["wa_media_id"]),
                mime_type=str(md.get("mime_type") or "application/octet-stream"),
                filename=md.get("filename"),
                size_bytes=md.get("size_bytes"),
                sha256=md.get("sha256"),
            )
        result.messages.append(WhatsAppMessage(
            wa_message_id=str(m["wa_message_id"]),
            wa_chat_id=str(m["chat_id"]),
            direction="out" if m.get("direction") == "out" else "in",
            kind=str(m.get("kind") or "text"),
            sender_wa_id=str(m.get("sender_wa_id") or ""),
            sender_name=str(m.get("sender_name") or ""),
            body_text=str(m.get("body_text") or ""),
            quoted_wa_message_id=m.get("quoted_wa_message_id"),
            mentions=[str(x) for x in (m.get("mentions") or [])],
            media=media,
            group_subject=m.get("group_subject"),
            chat_kind="group" if m.get("chat_kind") == "group" else "dm",
            sent_at=_parse_ts(m.get("sent_at")),
            raw=m,
        ))
    return result


def parse_labels_payload(
    payload: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Map the bridge's ``/bridge/labels`` body to normalized (labels, assocs).

    Pure. Labels missing a ``wa_label_id`` are skipped (nothing to key on);
    associations missing an id or chat JID are skipped. Both arrays are optional
    — a single LabelEdit sends one label, a LabelAssociationChat one assoc."""
    labels: list[dict[str, Any]] = []
    for lbl in payload.get("labels") or []:
        if not isinstance(lbl, dict):
            continue
        wid = str(lbl.get("wa_label_id") or "").strip()
        if not wid:
            continue
        labels.append({
            "wa_label_id": wid,
            "name": str(lbl.get("name") or "").strip() or wid,
            "color": (str(lbl.get("color")).strip() or None) if lbl.get("color") else None,
            "color_index": _as_int(lbl.get("color_index")),
            "list_type": (str(lbl.get("list_type")).strip() or None) if lbl.get("list_type") else None,
            "predefined_id": _as_int(lbl.get("predefined_id")),
            "sort_order": _as_int(lbl.get("sort_order")) or 100,
            "active": bool(lbl.get("active", True)),
            "deleted": bool(lbl.get("deleted", False)),
        })
    assocs: list[dict[str, Any]] = []
    for a in payload.get("associations") or []:
        if not isinstance(a, dict):
            continue
        wid = str(a.get("wa_label_id") or "").strip()
        chat = str(a.get("wa_chat_id") or "").strip()
        if not wid or not chat:
            continue
        assocs.append({
            "wa_label_id": wid,
            "wa_chat_id": chat,
            "labeled": bool(a.get("labeled", True)),
        })
    return labels, assocs


def _as_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


async def persist_labels(
    db: Any,
    account_id: str,
    labels: list[dict[str, Any]],
    assocs: list[dict[str, Any]],
) -> dict[str, int]:
    """Upsert synced labels + chat associations for an account. A deleted label
    also drops its associations; an un-labeling removes the association row."""
    for lbl in labels:
        await db.execute(
            text("""
                INSERT INTO wa_labels (account_id, wa_label_id, name, color,
                    color_index, list_type, predefined_id, sort_order,
                    active, deleted, sync_state, updated_at)
                VALUES (:aid, :wid, :name, :color, :cidx, :ltype, :pid, :sort,
                        :active, :deleted, 'synced', now())
                ON CONFLICT (account_id, wa_label_id) WHERE wa_label_id IS NOT NULL
                DO UPDATE SET name = excluded.name, color = excluded.color,
                    color_index = excluded.color_index, list_type = excluded.list_type,
                    predefined_id = excluded.predefined_id, sort_order = excluded.sort_order,
                    active = excluded.active, deleted = excluded.deleted,
                    sync_state = 'synced', updated_at = now()
            """),
            {"aid": account_id, "wid": lbl["wa_label_id"], "name": lbl["name"],
             "color": lbl["color"], "cidx": lbl["color_index"],
             "ltype": lbl["list_type"], "pid": lbl["predefined_id"],
             "sort": lbl["sort_order"], "active": lbl["active"],
             "deleted": lbl["deleted"]},
        )
        if lbl["deleted"]:
            await db.execute(
                text("""DELETE FROM wa_chat_labels
                        WHERE account_id = :aid AND wa_label_id = :wid"""),
                {"aid": account_id, "wid": lbl["wa_label_id"]},
            )
    for a in assocs:
        if a["labeled"]:
            await db.execute(
                text("""
                    INSERT INTO wa_chat_labels (account_id, wa_chat_id, wa_label_id)
                    VALUES (:aid, :chat, :wid)
                    ON CONFLICT (account_id, wa_chat_id, wa_label_id) DO NOTHING
                """),
                {"aid": account_id, "chat": a["wa_chat_id"], "wid": a["wa_label_id"]},
            )
        else:
            await db.execute(
                text("""DELETE FROM wa_chat_labels
                        WHERE account_id = :aid AND wa_chat_id = :chat
                          AND wa_label_id = :wid"""),
                {"aid": account_id, "chat": a["wa_chat_id"], "wid": a["wa_label_id"]},
            )
    return {"labels": len(labels), "associations": len(assocs)}


# ── shared-secret auth (bridge ↔ gateway is server-to-server) ──────────────────

def bridge_secret_ok(header: str | None) -> bool:
    """Constant-time check of the bridge's shared secret. When no secret is
    configured we allow it and log (local dev); production MUST set it. Pure."""
    expected = os.environ.get(_BRIDGE_SECRET_ENV, "").strip()
    if not expected:
        _log.warning("whatsapp.bridge.no_secret_set")
        return True
    return bool(header) and hmac.compare_digest(header, expected)


def _bridge_url() -> str:
    return os.environ.get(_BRIDGE_URL_ENV, _DEFAULT_BRIDGE_URL).rstrip("/")


def _bridge_headers() -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    secret = os.environ.get(_BRIDGE_SECRET_ENV, "").strip()
    if secret:
        h["X-Bridge-Secret"] = secret
    return h


# ── inbound: the bridge posts messages + pairing events ────────────────────────

@router.post("/bridge/ingest")
async def bridge_ingest(request: Request):
    """The whatsmeow bridge posts a normalized message batch for a paired
    number. Verify → parse → persist → the same post-sync hooks as the webhook."""
    if not bridge_secret_ok(request.headers.get("X-Bridge-Secret")):
        return Response(status_code=403, content="bad secret")
    try:
        payload = await request.json()
    except Exception:
        return Response(status_code=400, content="invalid json")
    account_id = str(payload.get("account_id") or "").strip()
    if not account_id:
        return Response(status_code=200, content="ok")  # nothing to route

    db = await _get_db()
    try:
        owned = (await db.execute(
            text("""SELECT 1 FROM wa_accounts
                    WHERE id = :aid AND provider = 'whatsmeow'"""),
            {"aid": account_id},
        )).fetchone()
        if not owned:
            _log.warning("whatsapp.bridge.unknown_account", account_id=account_id)
            return Response(status_code=200, content="ok")

        from whatsapp_ingestion.persist import persist_sync_result
        result = parse_bridge_payload(payload)
        counts = await persist_sync_result(db, account_id, result)
        await db.commit()

        if payload.get("backfill"):
            # History-sync batch: persist only. Skip the post-sync hooks so
            # auto-reply rules never fire on months-old messages — the bridge
            # calls /bridge/reclassify once the backfill settles.
            return {"ok": True, "messages": counts["messages"], "backfill": True}

        # Same shared post-sync pipeline the Cloud API webhook fires.
        await fire_post_sync_hooks(account_id, counts)
        return {"ok": True, "messages": counts["messages"]}
    finally:
        await db.close()


@router.post("/bridge/reclassify")
async def bridge_reclassify(request: Request):
    """The bridge signals that a history backfill has settled: run the chat-status
    classifier once over the account so imported chats get their reply state. We
    deliberately run ONLY classify_chats here (never on_new_messages) — a backfill
    must not trigger auto-replies to old messages."""
    if not bridge_secret_ok(request.headers.get("X-Bridge-Secret")):
        return Response(status_code=403, content="bad secret")
    try:
        payload = await request.json()
    except Exception:
        return Response(status_code=400, content="invalid json")
    account_id = str(payload.get("account_id") or "").strip()
    if not account_id:
        return Response(status_code=400, content="account_id required")

    db = await _get_db()
    try:
        owned = (await db.execute(
            text("""SELECT 1 FROM wa_accounts
                    WHERE id = :aid AND provider = 'whatsmeow'"""),
            {"aid": account_id},
        )).fetchone()
    finally:
        await db.close()
    if not owned:
        return Response(status_code=200, content="ok")

    try:
        from whatsapp_ingestion.post_sync import hooks, run_hook
        await run_hook(hooks.classify_chats, account_id)
    except Exception as exc:
        _log.warning("whatsapp.bridge.reclassify_failed",
                     account_id=account_id, error=str(exc)[:200])
    return {"ok": True}


@router.post("/bridge/labels")
async def bridge_labels(request: Request):
    """The whatsmeow bridge posts native WhatsApp labels + chat associations for a
    paired number (from app-state sync). Verify → parse → upsert into wa_labels +
    wa_chat_labels, so the founder's own WhatsApp labels mirror into the inbox."""
    if not bridge_secret_ok(request.headers.get("X-Bridge-Secret")):
        return Response(status_code=403, content="bad secret")
    try:
        payload = await request.json()
    except Exception:
        return Response(status_code=400, content="invalid json")
    account_id = str(payload.get("account_id") or "").strip()
    if not account_id:
        return Response(status_code=200, content="ok")

    db = await _get_db()
    try:
        owned = (await db.execute(
            text("""SELECT 1 FROM wa_accounts
                    WHERE id = :aid AND provider = 'whatsmeow'"""),
            {"aid": account_id},
        )).fetchone()
        if not owned:
            _log.warning("whatsapp.bridge.labels_unknown_account", account_id=account_id)
            return Response(status_code=200, content="ok")

        labels, assocs = parse_labels_payload(payload)
        counts = await persist_labels(db, account_id, labels, assocs)
        await db.commit()
        return {"ok": True, **counts}
    finally:
        await db.close()


@router.post("/bridge/paired")
async def bridge_paired(request: Request):
    """The bridge reports a completed QR pairing: fill in the number's identity
    and flip it to 'live'."""
    if not bridge_secret_ok(request.headers.get("X-Bridge-Secret")):
        return Response(status_code=403, content="bad secret")
    try:
        payload = await request.json()
    except Exception:
        return Response(status_code=400, content="invalid json")
    account_id = str(payload.get("session") or payload.get("account_id") or "").strip()
    if not account_id:
        return Response(status_code=400, content="session required")
    db = await _get_db()
    try:
        await db.execute(
            text("""UPDATE wa_accounts SET
                      phone_number = COALESCE(NULLIF(:phone, ''), phone_number),
                      display_name = COALESCE(NULLIF(:name, ''), display_name),
                      phone_number_id = COALESCE(NULLIF(:jid, ''), phone_number_id),
                      sync_status = 'live', updated_at = now()
                    WHERE id = :aid AND provider = 'whatsmeow'"""),
            {"phone": str(payload.get("phone_number") or ""),
             "name": str(payload.get("display_name") or ""),
             "jid": str(payload.get("jid") or ""), "aid": account_id},
        )
        await db.commit()
        return {"ok": True}
    finally:
        await db.close()


# ── pairing: the app starts a session + polls status ───────────────────────────

class BridgeConnectModel(BaseModel):
    account_id: str
    qr: str | None = None            # QR string/data-uri to render, if the bridge gave one
    status: str = "pairing"
    bridge_reachable: bool = True


@router.post("/bridge/connect", response_model=BridgeConnectModel)
async def bridge_connect(user: UserContext = Depends(get_current_user)):
    """Begin QR pairing for a personal number: create a 'pairing' account and ask
    the bridge to start a whatsmeow session, returning a QR to scan."""
    account_id = str(uuid4())
    uid = user.email or "anonymous"
    creds = {"session": account_id, "bridge": True}

    from acb_llm.key_store import get_key_store
    encrypted = get_key_store().encrypt(json.dumps(creds))

    db = await _get_db()
    try:
        is_first = (await db.execute(
            text("SELECT COUNT(*) FROM wa_accounts WHERE user_id = :uid"),
            {"uid": uid},
        )).scalar() == 0
        await db.execute(
            text("""INSERT INTO wa_accounts
                      (id, user_id, phone_number, phone_number_id, display_name,
                       credentials_encrypted, sync_status, provider, is_default)
                    VALUES (:id, :uid, '', :pnid, 'Personal WhatsApp (pairing)',
                            :creds, 'pairing', 'whatsmeow', :is_default)"""),
            {"id": account_id, "uid": uid, "pnid": f"bridge-{account_id}",
             "creds": encrypted, "is_default": is_first},
        )
        await db.commit()
    finally:
        await db.close()

    qr, reachable = await _bridge_start_session(account_id)
    return BridgeConnectModel(
        account_id=account_id, qr=qr, status="pairing", bridge_reachable=reachable)


@router.get("/bridge/status", response_model=BridgeConnectModel)
async def bridge_status(
    account_id: str, user: UserContext = Depends(get_current_user),
):
    """Poll pairing status + the current QR for a pairing account."""
    db = await _get_db()
    try:
        row = (await db.execute(
            text("""SELECT sync_status FROM wa_accounts
                    WHERE id = :aid AND user_id = :uid
                      AND provider = 'whatsmeow'"""),
            {"aid": account_id, "uid": user.email or "anonymous"},
        )).fetchone()
    finally:
        await db.close()
    if not row:
        return BridgeConnectModel(account_id=account_id, status="unknown")
    if row.sync_status == "live":
        return BridgeConnectModel(account_id=account_id, status="live")
    qr, reachable = await _bridge_session_qr(account_id)
    return BridgeConnectModel(
        account_id=account_id, qr=qr, status=row.sync_status or "pairing",
        bridge_reachable=reachable)


async def _bridge_start_session(account_id: str) -> tuple[str | None, bool]:
    """Ask the bridge to start a whatsmeow session; return ``(qr, reachable)``."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(20.0)) as client:
            resp = await client.post(
                f"{_bridge_url()}/session", headers=_bridge_headers(),
                json={"session": account_id})
            resp.raise_for_status()
            data = resp.json()
        return (data.get("qr") if isinstance(data, dict) else None), True
    except Exception as exc:
        _log.warning("whatsapp.bridge.start_failed", error=str(exc)[:200])
        return None, False


async def _bridge_session_qr(account_id: str) -> tuple[str | None, bool]:
    """Fetch the current QR/status for a session from the bridge."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(20.0)) as client:
            resp = await client.get(
                f"{_bridge_url()}/session/{account_id}", headers=_bridge_headers())
            resp.raise_for_status()
            data = resp.json()
        return (data.get("qr") if isinstance(data, dict) else None), True
    except Exception as exc:
        _log.warning("whatsapp.bridge.qr_failed", error=str(exc)[:200])
        return None, False
