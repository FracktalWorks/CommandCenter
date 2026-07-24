"""Transport · accounts — connected WhatsApp Business numbers (list/create/delete).

Creation is the tail of the Meta Embedded Signup flow: the frontend completes the
coexistence handshake with Meta and posts the resulting identifiers + system-user
token here, which we encrypt and store. There is no polling scheduler — Meta
pushes events to the webhook — so an account is "live" as soon as its webhook is
subscribed.
"""

from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.whatsapp.core import (
    WhatsAppAccountModel,
    _get_db,
    router,
)
from pydantic import BaseModel
from sqlalchemy import text


class CreateAccountRequest(BaseModel):
    """The identifiers Embedded Signup returns, plus the system-user token."""
    phone_number: str
    phone_number_id: str
    waba_id: str | None = None
    display_name: str = ""
    webhook_verify_token: str | None = None
    credentials: dict[str, Any]     # {access_token, graph_version?}


def _account_model(row: Any) -> WhatsAppAccountModel:
    return WhatsAppAccountModel(
        id=str(row.id),
        phone_number=row.phone_number,
        phone_number_id=row.phone_number_id,
        waba_id=row.waba_id,
        display_name=row.display_name or "",
        avatar_color=row.avatar_color or "#25D366",
        sync_status=row.sync_status or "idle",
        sync_error=row.sync_error,
        history_import_phase=row.history_import_phase or 0,
        quality_rating=row.quality_rating,
        last_synced_at=row.last_synced_at.isoformat() if row.last_synced_at else None,
        is_default=bool(row.is_default),
    )


@router.get("/accounts", response_model=list[WhatsAppAccountModel])
async def list_accounts(user: UserContext = Depends(get_current_user)):
    """List the WhatsApp Business numbers connected by the current user."""
    db = await _get_db()
    try:
        rows = (await db.execute(
            text("""SELECT id, phone_number, phone_number_id, waba_id,
                           display_name, avatar_color, sync_status, sync_error,
                           history_import_phase, quality_rating, last_synced_at,
                           is_default
                    FROM wa_accounts WHERE user_id = :uid
                    ORDER BY is_default DESC, created_at"""),
            {"uid": user.email or "anonymous"},
        )).fetchall()
        return [_account_model(r) for r in rows]
    finally:
        await db.close()


@router.post("/accounts", response_model=WhatsAppAccountModel, status_code=201)
async def create_account(
    req: CreateAccountRequest, user: UserContext = Depends(get_current_user),
):
    """Register a WhatsApp Business number after Embedded Signup completes."""
    if not req.credentials.get("access_token"):
        raise HTTPException(status_code=400, detail="credentials.access_token required")

    # The provider needs phone_number_id in its creds; fold it in so the stored
    # blob is self-contained (the Cloud API provider reads it from there).
    creds = dict(req.credentials)
    creds.setdefault("phone_number_id", req.phone_number_id)
    creds.setdefault("waba_id", req.waba_id)

    from acb_llm.key_store import get_key_store
    store = get_key_store()
    encrypted = store.encrypt(json.dumps(creds))

    db = await _get_db()
    try:
        existing = (await db.execute(
            text("""SELECT id FROM wa_accounts
                    WHERE user_id = :uid AND phone_number_id = :pnid"""),
            {"uid": user.email or "anonymous", "pnid": req.phone_number_id},
        )).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="Number already connected")

        # First account for this user becomes the default.
        is_first = (await db.execute(
            text("SELECT COUNT(*) FROM wa_accounts WHERE user_id = :uid"),
            {"uid": user.email or "anonymous"},
        )).scalar() == 0

        row = (await db.execute(
            text("""INSERT INTO wa_accounts
                      (id, user_id, phone_number, phone_number_id, waba_id,
                       display_name, credentials_encrypted, webhook_verify_token,
                       sync_status, is_default)
                    VALUES
                      (:id, :uid, :phone, :pnid, :waba, :name, :creds, :verify,
                       'importing', :is_default)
                    RETURNING id, phone_number, phone_number_id, waba_id,
                              display_name, avatar_color, sync_status, sync_error,
                              history_import_phase, quality_rating, last_synced_at,
                              is_default"""),
            {"id": str(uuid4()), "uid": user.email or "anonymous",
             "phone": req.phone_number, "pnid": req.phone_number_id,
             "waba": req.waba_id, "name": req.display_name, "creds": encrypted,
             "verify": req.webhook_verify_token, "is_default": is_first},
        )).fetchone()
        await db.commit()
        return _account_model(row)
    finally:
        await db.close()


@router.delete("/accounts/{account_id}", status_code=204)
async def delete_account(
    account_id: str, user: UserContext = Depends(get_current_user),
):
    """Disconnect a number. The message archive is kept (rows cascade only if the
    account row is removed) — we remove the account, which cascades its data; the
    UI copy makes that explicit."""
    db = await _get_db()
    try:
        result = await db.execute(
            text("DELETE FROM wa_accounts WHERE id = :id AND user_id = :uid"),
            {"id": account_id, "uid": user.email or "anonymous"},
        )
        await db.commit()
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Account not found")
    finally:
        await db.close()
