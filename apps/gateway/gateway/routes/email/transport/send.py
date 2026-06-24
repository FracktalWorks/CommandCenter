"""Transport · send — outbound send (and the learn-from-sent hook into the
automation layer via a deferred import)."""

from __future__ import annotations

import json

from acb_auth import UserContext, get_current_user
from fastapi import BackgroundTasks, Depends, HTTPException
from gateway.routes.email.core import _get_db, _persist_rotated_creds, router
from pydantic import BaseModel
from sqlalchemy import text


class SendAttachment(BaseModel):
    filename: str
    mime_type: str = "application/octet-stream"
    content_b64: str  # base64-encoded file content


class SendEmailRequest(BaseModel):
    account_id: str
    to: list[str]
    subject: str
    body_text: str
    body_html: str | None = None
    cc: list[str] | None = None
    bcc: list[str] | None = None
    reply_to_message_id: str | None = None
    attachments: list[SendAttachment] | None = None


@router.post("/send")
async def send_email(
    req: SendEmailRequest,
    background: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
):
    """Send a new email from a connected account."""
    db = await _get_db()
    try:
        # Verify account ownership
        result = await db.execute(
            text(
                """SELECT id, provider, credentials_encrypted
                   FROM email_accounts
                   WHERE id = :id AND user_id = :user_id"""
            ),
            {"id": req.account_id, "user_id": user.email or "anonymous"},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Account not found")

        # Decrypt credentials and instantiate provider
        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))

        if row.provider == "gmail":
            from email_ingestion.providers.gmail import GmailProvider
            provider = GmailProvider(creds)
        elif row.provider == "microsoft":
            from email_ingestion.providers.outlook import OutlookProvider
            provider = OutlookProvider(creds)
        elif row.provider == "imap":
            from email_ingestion.providers.imap import IMAPProvider
            provider = IMAPProvider(creds)
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Send not supported for provider: {row.provider}"
            )

        # Authenticate and send
        if not await provider.authenticate():
            raise HTTPException(status_code=401, detail="Email account auth failed")

        attachments = None
        if req.attachments:
            import base64 as _b64
            try:
                attachments = [
                    {
                        "filename": a.filename,
                        "mime_type": a.mime_type,
                        "content": _b64.b64decode(a.content_b64),
                    }
                    for a in req.attachments
                ]
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid attachment encoding: {exc}",
                ) from exc

        msg_id = await provider.send_message(
            to=req.to,
            subject=req.subject,
            body_text=req.body_text,
            body_html=req.body_html,
            cc=req.cc,
            bcc=req.bcc,
            reply_to_message_id=req.reply_to_message_id,
            attachments=attachments,
        )

        # Persist any refreshed/rotated OAuth token from authenticate().
        if provider.credentials_dirty():
            await _persist_rotated_creds(db, store, str(row.id), provider)
            await db.commit()

        # If this was a reply, learn from how the user edited the AI's draft.
        if req.reply_to_message_id and req.body_text:
            try:
                trow = (await db.execute(text(
                    "SELECT thread_id FROM email_messages "
                    "WHERE account_id = :aid AND provider_message_id = :pmid"
                ), {"aid": req.account_id,
                    "pmid": req.reply_to_message_id})).fetchone()
                if trow and trow.thread_id:
                    from gateway.routes.email.automation import (  # noqa: PLC0415
                        _cleanup_thread_drafts,
                        _learn_from_sent,
                        _mark_thread_replied,
                    )
                    background.add_task(
                        _learn_from_sent, req.account_id, trow.thread_id,
                        req.body_text)
                    # Move the thread out of "To Reply" → Awaiting Reply.
                    background.add_task(
                        _mark_thread_replied, req.account_id, trow.thread_id)
                    # Trash leftover drafts in the thread (AI draft / auto-save).
                    background.add_task(
                        _cleanup_thread_drafts, req.account_id, trow.thread_id)
            except Exception:  # noqa: BLE001
                pass

        return {"id": msg_id, "ok": True}
    finally:
        await db.close()
