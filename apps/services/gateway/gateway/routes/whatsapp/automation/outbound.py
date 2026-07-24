"""Automation · outbound — approval-gated sends via the Action Broker.

The founder's own explicit "Send" tap in a conversation is itself the human in
the loop, so it goes direct (transport/send.py). But a ONE-TO-MANY broadcast —
"send this monsoon-delay update to all 18 dealer groups" — is exactly the kind of
outward write the spec says must always pass through the Action Broker approval
queue. This module routes it there: a broadcast is proposed with SUGGEST
authority (which the broker maps to NEEDS_APPROVAL) and enqueued — nothing is
sent until a human approves, at which point the registered ``whatsapp.broadcast``
handler performs the sends.

The actual provider write lives ONLY in the registered handlers, so the broker
is the one component that can send WhatsApp on the system's behalf (root
AGENTS.md non-negotiable #4).
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from acb_common import get_logger
from fastapi import Depends, HTTPException
from gateway.routes.whatsapp.core import _get_db, _provider_for_account, router
from pydantic import BaseModel
from sqlalchemy import text

_log = get_logger("gateway.whatsapp.outbound")

WA_SEND = "whatsapp.send"
WA_BROADCAST = "whatsapp.broadcast"


# ── broker handlers (the ONLY place a real WhatsApp send happens) ─────────────

async def _record_outbound(
    db: Any, account_id: str, chat_id: str | None, wamid: str, body: str,
) -> None:
    if not chat_id:
        return
    await db.execute(
        text("""INSERT INTO wa_messages
                  (id, account_id, chat_id, wa_message_id, direction, sender,
                   kind, body_text, send_regime, sent_at)
                VALUES (:id, :aid, :cid, :wamid, 'out', '{}'::jsonb, 'text',
                        :body, 'session', now())
                ON CONFLICT (account_id, wa_message_id) DO NOTHING"""),
        {"id": str(uuid4()), "aid": account_id, "cid": chat_id,
         "wamid": wamid, "body": body},
    )


async def _wa_broadcast_handler(proposal: Any) -> dict[str, Any]:
    """Perform an approved broadcast: send the message to each target chat.

    Runs at approval time (or auto-apply, which broadcast never is). One failed
    recipient never aborts the rest — the result reports per-target outcomes.
    """
    payload = proposal.payload or {}
    account_id = payload["account_id"]
    text_body = payload["text"]
    targets = payload.get("targets", [])  # [{wa_chat_id, chat_id}]

    db = await _get_db()
    try:
        provider, _store, _row = await _provider_for_account(db, account_id)
        sent, failed = 0, 0
        for t in targets:
            try:
                wamid = await provider.send_text(t["wa_chat_id"], text_body)
                await _record_outbound(
                    db, account_id, t.get("chat_id"), wamid, text_body)
                sent += 1
            except Exception as exc:
                _log.warning("whatsapp.broadcast.target_failed",
                             target=t.get("wa_chat_id"), error=str(exc)[:120])
                failed += 1
        await db.commit()
        return {"sent": sent, "failed": failed, "total": len(targets)}
    finally:
        await db.close()


def register_whatsapp_handlers() -> None:
    """Register the WhatsApp write handlers with the Action Broker. Idempotent."""
    from action_broker.broker import register_action_handler
    register_action_handler(WA_BROADCAST, _wa_broadcast_handler)
    _log.info("whatsapp.broker_handlers_registered")


# ── broadcast composer route (always approval-gated) ──────────────────────────

class BroadcastRequest(BaseModel):
    account_id: str
    text: str
    # Target either an explicit set of chats, or every chat in a category.
    chat_ids: list[str] = []
    category: str | None = None


class BroadcastResponse(BaseModel):
    status: str                 # 'pending' — always, a broadcast never auto-sends
    action_id: str | None = None
    target_count: int = 0


@router.post("/broadcast", response_model=BroadcastResponse)
async def broadcast(
    req: BroadcastRequest, user: UserContext = Depends(get_current_user),
):
    """Stage a broadcast for approval — NEVER sends directly. Resolves the target
    chats, builds one Action Broker proposal (SUGGEST → NEEDS_APPROVAL), enqueues
    it, and returns the pending action id for the approvals inbox."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="broadcast text required")
    if not req.chat_ids and not req.category:
        raise HTTPException(status_code=400, detail="chat_ids or category required")

    db = await _get_db()
    try:
        # Resolve targets, owner-scoped.
        params: dict[str, Any] = {
            "uid": user.email or "anonymous", "aid": req.account_id,
        }
        where = ["c.account_id = :aid",
                 "c.account_id IN (SELECT id FROM wa_accounts WHERE user_id = :uid)"]
        if req.chat_ids:
            where.append("c.id = ANY(:ids)")
            params["ids"] = req.chat_ids
        if req.category:
            where.append("c.category = :cat")
            params["cat"] = req.category
        rows = (await db.execute(
            text(f"SELECT c.id, c.wa_chat_id FROM wa_chats c "
                 f"WHERE {' AND '.join(where)}"),
            params,
        )).fetchall()
        targets = [{"chat_id": str(r.id), "wa_chat_id": r.wa_chat_id} for r in rows]
        if not targets:
            raise HTTPException(status_code=404, detail="no matching chats")
    finally:
        await db.close()

    # Always propose with SUGGEST authority → the broker holds it for a human.
    from action_broker.broker import (
        ActionProposal,
        AuthorityTier,
        Disposition,
        submit,
    )
    proposal = ActionProposal(
        id=uuid4(),
        actor=f"user:{user.email or 'anonymous'}",
        action=WA_BROADCAST,
        target=f"account:{req.account_id}",
        payload={"account_id": req.account_id, "text": req.text,
                 "targets": targets},
        authority=AuthorityTier.SUGGEST,   # never auto-applies
        destructive=True,
    )
    result = await submit(proposal)
    # Safety invariant: a broadcast must never come back applied without a human.
    if result.get("disposition") != Disposition.NEEDS_APPROVAL.value:
        _log.error("whatsapp.broadcast.not_gated", result=result)
        raise HTTPException(status_code=500, detail="broadcast was not approval-gated")
    return BroadcastResponse(
        status="pending", action_id=result.get("action_id"),
        target_count=len(targets))
