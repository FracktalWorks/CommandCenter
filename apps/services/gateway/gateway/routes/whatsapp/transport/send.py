"""Transport · send — outbound messages, window-aware.

The raw send transport. Inside the 24h customer-service window a free-form text
send is allowed; outside it, only an approved template. This module enforces that
regime and records the outbound row.

HITL note: the plan gates outward sends behind the Action Broker approval flow
(W1). This endpoint is the transport the approval flow will call; until then it
is intended for the founder's own explicit "Send" tap in the dashboard, which is
itself the human in the loop.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.whatsapp.core import _get_db, _provider_for_account, router
from pydantic import BaseModel
from sqlalchemy import text


class SendRequest(BaseModel):
    # Provide EITHER text (session send, window must be open) OR a template.
    text: str | None = None
    template_name: str | None = None
    template_language: str = "en"
    reply_to_wa_message_id: str | None = None


def window_is_open(expires_at: datetime | None, now: datetime | None = None) -> bool:
    """Pure: is the 24h service window still open at ``now``? (unit-testable)."""
    if expires_at is None:
        return False
    now = now or datetime.now(UTC)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    return expires_at > now


def choose_regime(req: SendRequest, window_open: bool) -> str:
    """Decide the send regime or raise a 4xx describing why the send is blocked.

    - text + open window  → 'session'
    - template            → 'template' (always allowed)
    - text + closed window → blocked (must use a template)
    """
    if req.template_name:
        return "template"
    if req.text:
        if not window_open:
            raise HTTPException(
                status_code=409,
                detail="24h window closed — send an approved template instead",
            )
        return "session"
    raise HTTPException(status_code=400, detail="text or template_name required")


@router.post("/chats/{chat_id}/send", response_model=dict)
async def send_message(
    chat_id: str,
    req: SendRequest,
    user: UserContext = Depends(get_current_user),
):
    """Send a message to a chat, respecting the 24h window, and store the row."""
    db = await _get_db()
    try:
        chat = (await db.execute(
            text("""SELECT c.id, c.account_id, c.wa_chat_id,
                           c.service_window_expires_at
                    FROM wa_chats c
                    JOIN wa_accounts a ON a.id = c.account_id
                    WHERE c.id = :cid AND a.user_id = :uid"""),
            {"cid": chat_id, "uid": user.email or "anonymous"},
        )).fetchone()
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found")

        regime = choose_regime(req, window_is_open(chat.service_window_expires_at))

        provider, _store, _acc = await _provider_for_account(db, str(chat.account_id))
        if regime == "template":
            wamid = await provider.send_template(
                chat.wa_chat_id, req.template_name, req.template_language,
            )
            body = f"[template: {req.template_name}]"
            template_name: str | None = req.template_name
        else:
            wamid = await provider.send_text(
                chat.wa_chat_id, req.text or "",
                reply_to_wa_message_id=req.reply_to_wa_message_id,
            )
            body = req.text or ""
            template_name = None

        now = datetime.now(UTC)
        await db.execute(
            text("""INSERT INTO wa_messages
                      (id, account_id, chat_id, wa_message_id, direction, sender,
                       kind, body_text, send_regime, template_name, sent_at)
                    VALUES
                      (:id, :aid, :cid, :wamid, 'out', '{}'::jsonb,
                       'text', :body, :regime, :template, :sent_at)
                    ON CONFLICT (account_id, wa_message_id) DO NOTHING"""),
            {"id": str(uuid4()), "aid": str(chat.account_id), "cid": chat_id,
             "wamid": wamid, "body": body, "regime": regime,
             "template": template_name, "sent_at": now},
        )
        await db.execute(
            text("""UPDATE wa_chats SET last_message_at = :now, updated_at = now()
                    WHERE id = :cid"""),
            {"now": now, "cid": chat_id},
        )
        await db.commit()
        return {"wa_message_id": wamid, "send_regime": regime}
    finally:
        await db.close()
