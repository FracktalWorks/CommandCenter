"""Transport · messages — list/read/update/delete a message, lazy full-body
hydration, and the full-body endpoint."""

from __future__ import annotations

import json
from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException, Query, status
from gateway.routes.email.core import (
    MAX_BODY_HTML_BYTES,
    MAX_BODY_TEXT_BYTES,
    EmailMessageModel,
    _fetch_attachments,
    _get_db,
    _log,
    _persist_rotated_creds,
    _provider_for_message,
    _row_to_message,
    _truncate_body,
    router,
)
from pydantic import BaseModel, Field
from sqlalchemy import text


class MessageUpdateModel(BaseModel):
    is_read: bool | None = None
    is_starred: bool | None = None
    is_flagged: bool | None = None
    folder: str | None = None
    add_labels: list[str] | None = None
    remove_labels: list[str] | None = None


class ListMessagesParams(BaseModel):
    account_id: str | None = None
    folder: str = "INBOX"
    query: str | None = None
    page: int = 1
    page_size: int = Field(default=50, ge=1, le=200)


@router.get("/messages")
async def list_messages(
    account_id: str | None = Query(None),
    folder: str = Query("INBOX"),
    label: str | None = Query(None),
    query: str | None = Query(None),
    thread_id: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    user: UserContext = Depends(get_current_user),
):
    """List/search emails across accounts.

    When ``thread_id`` is given the result is the whole conversation (across
    folders), oldest-first — used by the reading pane's conversation view.
    """
    db = await _get_db()
    try:
        where_clauses = [
            "ea.user_id = :user_id"
        ]
        params: dict[str, Any] = {
            "user_id": user.email or "anonymous",
            "limit": page_size,
            "offset": (page - 1) * page_size,
        }

        if account_id:
            where_clauses.append("em.account_id = :account_id")
            params["account_id"] = account_id
        if thread_id:
            # Conversation view: every message in the thread, ignore the folder
            # filter (a thread spans inbox/sent/etc.).
            where_clauses.append("em.thread_id = :thread_id")
            params["thread_id"] = thread_id
        elif folder:
            # "starred" is a flag, not a stored folder; everything else is matched
            # case-insensitively against the canonical folder key persisted by the
            # providers (inbox/sent/drafts/trash/archive/junk + user folders).
            if folder.lower() == "starred":
                where_clauses.append("em.is_starred = true")
            else:
                where_clauses.append("LOWER(em.folder) = LOWER(:folder)")
                params["folder"] = folder
        if label:
            # Match either a user label or an assigned category (both TEXT[]).
            where_clauses.append(
                "(:label = ANY(COALESCE(em.labels, '{}'))"
                " OR :label = ANY(em.categories))"
            )
            params["label"] = label
        if query:
            where_clauses.append(
                """to_tsvector('english',
                   coalesce(em.subject,'') || ' ' ||
                   coalesce(em.body_text,'') || ' ' ||
                   coalesce(em.from_address->>'name','') || ' ' ||
                   coalesce(em.from_address->>'email',''))
                   @@ plainto_tsquery('english', :query)"""
            )
            params["query"] = query

        where_sql = " AND ".join(where_clauses)

        # Count total
        count_result = await db.execute(
            text(
                f"""SELECT COUNT(*)
                    FROM email_messages em
                    JOIN email_accounts ea ON em.account_id = ea.id
                    WHERE {where_sql}"""
            ),
            params,
        )
        total = count_result.scalar() or 0

        # Fetch page
        result = await db.execute(
            text(
                f"""SELECT em.id, em.provider_message_id, em.thread_id,
                          em.account_id, em.folder, em.labels,
                          em.from_address, em.to_addresses,
                          em.cc_addresses, em.bcc_addresses,
                          em.subject, em.body_text, em.body_html,
                          em.snippet, em.has_attachments,
                          em.is_read, em.is_starred, em.is_flagged,
                          em.importance, em.categories,
                          em.received_at, em.synced_at
                   FROM email_messages em
                   JOIN email_accounts ea ON em.account_id = ea.id
                   WHERE {where_sql}
                   ORDER BY em.received_at {"ASC" if thread_id else "DESC"}
                   LIMIT :limit OFFSET :offset"""
            ),
            params,
        )
        rows = result.fetchall()

        messages = [_row_to_message(row) for row in rows]

        # Thread sizes — one extra grouped query so the list can flag which rows
        # are conversations (badge with the message count).
        thread_ids = list({m.thread_id for m in messages if m.thread_id})
        thread_counts: dict[str, int] = {}
        if thread_ids:
            cnt_params: dict[str, Any] = {"tids": thread_ids}
            cnt_sql = (
                "SELECT thread_id, COUNT(*) AS c FROM email_messages "
                "WHERE thread_id = ANY(:tids)"
            )
            if account_id:
                cnt_sql += " AND account_id = :account_id"
                cnt_params["account_id"] = account_id
            cnt_sql += " GROUP BY thread_id"
            cnt_res = await db.execute(text(cnt_sql), cnt_params)
            thread_counts = {r.thread_id: r.c for r in cnt_res.fetchall()}

        emails_out = []
        for m in messages:
            d = m.model_dump()
            d["thread_count"] = thread_counts.get(m.thread_id, 1)
            emails_out.append(d)

        return {
            "emails": emails_out,
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    finally:
        await db.close()


@router.get("/messages/{message_id}", response_model=EmailMessageModel)
async def get_message(
    message_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Get full email detail."""
    db = await _get_db()
    try:
        result = await db.execute(
            text(
                """SELECT em.id, em.provider_message_id, em.thread_id,
                          em.account_id, em.folder, em.labels,
                          em.from_address, em.to_addresses,
                          em.cc_addresses, em.bcc_addresses,
                          em.subject, em.body_text, em.body_html,
                          em.snippet, em.has_attachments,
                          em.is_read, em.is_starred, em.is_flagged,
                          em.importance, em.categories,
                          em.received_at, em.synced_at
                   FROM email_messages em
                   JOIN email_accounts ea ON em.account_id = ea.id
                   WHERE em.id = :message_id AND ea.user_id = :user_id"""
            ),
            {"message_id": message_id, "user_id": user.email or "anonymous"},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Message not found")

        # Mark as read
        await db.execute(
            text(
                """UPDATE email_messages SET is_read = true, updated_at = now()
                   WHERE id = :id AND is_read = false"""
            ),
            {"id": message_id},
        )
        await db.commit()

        msg = _row_to_message(row)

        # ── Lazy body hydration ──
        # Some providers (notably Outlook/Graph) sync message *headers* only, so
        # the stored body is empty.  When the user opens such a message, fetch the
        # full body from the provider once and persist it so subsequent opens are
        # instant.  Mark as read on the provider too (two-way sync).
        if not msg.body_text and not msg.body_html:
            try:
                provider, provider_msg_id, account_id, store = await _provider_for_message(
                    db, message_id, user.email or "anonymous"
                )
                if await provider.authenticate():
                    full = await provider.get_message(provider_msg_id)
                    body_text = _truncate_body(full.body_text or "", MAX_BODY_TEXT_BYTES)
                    body_html = (
                        _truncate_body(full.body_html, MAX_BODY_HTML_BYTES)
                        if full.body_html else None
                    )
                    await db.execute(
                        text(
                            """UPDATE email_messages
                               SET body_text = :bt, body_html = :bh,
                                   has_attachments = :ha, updated_at = now()
                               WHERE id = :id"""
                        ),
                        {
                            "id": message_id,
                            "bt": body_text,
                            "bh": body_html,
                            "ha": full.has_attachments,
                        },
                    )
                    # Persist attachment metadata fetched with the full message.
                    for att in full.attachments:
                        await db.execute(
                            text(
                                """INSERT INTO email_attachments
                                   (message_id, filename, mime_type, size_bytes,
                                    provider_attachment_id)
                                   VALUES (:mid, :filename, :mime_type, :size_bytes,
                                           :provider_attachment_id)
                                   ON CONFLICT DO NOTHING"""
                            ),
                            {
                                "mid": message_id,
                                "filename": att.filename,
                                "mime_type": att.mime_type,
                                "size_bytes": att.size_bytes,
                                "provider_attachment_id": att.provider_attachment_id,
                            },
                        )
                    await _persist_rotated_creds(db, store, account_id, provider)
                    await db.commit()
                    msg.body_text = body_text
                    msg.body_html = body_html
                    msg.has_attachments = full.has_attachments
            except HTTPException:
                raise
            except Exception as exc:  # noqa: BLE001
                _log.warning("get_message.hydrate_failed", message_id=message_id, error=str(exc)[:200])

        if msg.has_attachments:
            msg.attachments = await _fetch_attachments(db, message_id)
        return msg
    finally:
        await db.close()


@router.patch("/messages/{message_id}", response_model=EmailMessageModel)
async def update_message(
    message_id: str,
    updates: MessageUpdateModel,
    user: UserContext = Depends(get_current_user),
):
    """Update email properties (read, starred, flagged, folder, labels)."""
    db = await _get_db()
    try:
        # Verify ownership
        result = await db.execute(
            text(
                """SELECT em.id FROM email_messages em
                   JOIN email_accounts ea ON em.account_id = ea.id
                   WHERE em.id = :id AND ea.user_id = :user_id"""
            ),
            {"id": message_id, "user_id": user.email or "anonymous"},
        )
        if not result.fetchone():
            raise HTTPException(status_code=404, detail="Message not found")

        set_clauses = ["updated_at = now()"]
        params: dict[str, Any] = {"id": message_id}

        if updates.is_read is not None:
            set_clauses.append("is_read = :is_read")
            params["is_read"] = updates.is_read
        if updates.is_starred is not None:
            set_clauses.append("is_starred = :is_starred")
            params["is_starred"] = updates.is_starred
        if updates.is_flagged is not None:
            set_clauses.append("is_flagged = :is_flagged")
            params["is_flagged"] = updates.is_flagged
        if updates.folder is not None:
            set_clauses.append("folder = :folder")
            params["folder"] = updates.folder

        await db.execute(
            text(
                f"""UPDATE email_messages
                    SET {', '.join(set_clauses)}
                    WHERE id = :id"""
            ),
            params,
        )
        await db.commit()

        # Apply label add/remove locally — the categories column drives the
        # label chips shown in the UI.
        if updates.add_labels or updates.remove_labels:
            cat_res = await db.execute(
                text("SELECT categories FROM email_messages WHERE id = :id"),
                {"id": message_id},
            )
            crow = cat_res.fetchone()
            cats = list(crow.categories or []) if crow else []
            for name in updates.add_labels or []:
                if name not in cats:
                    cats.append(name)
            for name in updates.remove_labels or []:
                if name in cats:
                    cats.remove(name)
            await db.execute(
                text(
                    """UPDATE email_messages SET categories = :cats,
                       updated_at = now() WHERE id = :id"""
                ),
                {"id": message_id, "cats": cats},
            )
            await db.commit()

        # ── Two-way sync: push the change to the provider (best-effort) ──
        # The local DB is already updated; if the provider write fails we keep the
        # local state and log, rather than failing the user's action.
        try:
            provider, provider_msg_id, account_id, store = await _provider_for_message(
                db, message_id, user.email or "anonymous"
            )
            if await provider.authenticate():
                if (
                    updates.is_read is not None
                    or updates.is_starred is not None
                    or updates.is_flagged is not None
                ):
                    await provider.apply_flags(
                        provider_msg_id,
                        is_read=updates.is_read,
                        is_starred=updates.is_starred,
                        is_flagged=updates.is_flagged,
                    )
                if updates.folder is not None:
                    new_pid = await provider.move_to_folder(
                        provider_msg_id, updates.folder.lower()
                    )
                    # Outlook /move re-keys the message — persist the new id so
                    # later actions don't hit a stale (404) provider id, and use
                    # it for the set_labels call below.
                    if new_pid and new_pid != provider_msg_id:
                        await db.execute(
                            text(
                                """UPDATE email_messages
                                   SET provider_message_id = :pid, updated_at = now()
                                   WHERE id = :id"""
                            ),
                            {"pid": new_pid, "id": message_id},
                        )
                        await db.commit()
                        provider_msg_id = new_pid
                if updates.add_labels or updates.remove_labels:
                    await provider.set_labels(
                        provider_msg_id,
                        add=updates.add_labels or [],
                        remove=updates.remove_labels or [],
                    )
                await _persist_rotated_creds(db, store, account_id, provider)
                await db.commit()
        except Exception as exc:  # noqa: BLE001
            # Best-effort: the local change is already committed, so a provider
            # failure (incl. an HTTPException from the provider lookup/write) must
            # NOT fail the user's action — just log it.
            _log.warning(
                "update_message.provider_sync_failed",
                message_id=message_id, error=str(exc)[:200],
            )

        # Return updated message
        return await get_message(message_id, user)
    finally:
        await db.close()


@router.delete("/messages/{message_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_message(
    message_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Move email to trash (locally and on the provider)."""
    db = await _get_db()
    try:
        result = await db.execute(
            text(
                """UPDATE email_messages SET folder = 'trash', updated_at = now()
                   WHERE id = :id
                   AND account_id IN (
                       SELECT id FROM email_accounts WHERE user_id = :user_id
                   )"""
            ),
            {"id": message_id, "user_id": user.email or "anonymous"},
        )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Message not found")
        await db.commit()

        # ── Two-way sync: trash on the provider too (best-effort) ──
        try:
            provider, provider_msg_id, account_id, store = await _provider_for_message(
                db, message_id, user.email or "anonymous"
            )
            if await provider.authenticate():
                new_pid = await provider.trash_message(provider_msg_id)
                # Outlook trash = /move to Deleted Items, which re-keys the
                # message; persist the new id so it stays addressable.
                if new_pid and new_pid != provider_msg_id:
                    await db.execute(
                        text(
                            """UPDATE email_messages
                               SET provider_message_id = :pid, updated_at = now()
                               WHERE id = :id"""
                        ),
                        {"pid": new_pid, "id": message_id},
                    )
                await _persist_rotated_creds(db, store, account_id, provider)
                await db.commit()
        except Exception as exc:  # noqa: BLE001
            # Best-effort: local trash already committed; never fail the user's
            # action on a provider error (incl. provider-raised HTTPException).
            _log.warning(
                "delete_message.provider_sync_failed",
                message_id=message_id, error=str(exc)[:200],
            )
    finally:
        await db.close()


@router.get("/messages/{message_id}/full-body")
async def get_full_body(
    message_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Fetch the full, untruncated email body from the provider.

    Use this when body_truncated is true on a message — the stored body
    was capped to stay within storage limits.  This endpoint reaches out
    to Gmail/Microsoft/IMAP live to retrieve the complete message body.
    """
    db = await _get_db()
    try:
        result = await db.execute(
            text(
                """SELECT em.provider_message_id, p.provider,
                          p.credentials_encrypted
                   FROM email_messages em
                   JOIN email_accounts p ON em.account_id = p.id
                   WHERE em.id = :mid AND p.user_id = :user_id"""
            ),
            {"mid": message_id, "user_id": user.email or "anonymous"},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Message not found")

        # Decrypt credentials
        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))

        # Instantiate provider
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
                detail=f"Unknown provider: {row.provider}",
            )

        if not await provider.authenticate():
            raise HTTPException(
                status_code=401,
                detail="Email account authentication failed",
            )

        msg = await provider.get_message(row.provider_message_id)
        return {
            "message_id": message_id,
            "body_text": msg.body_text,
            "body_html": msg.body_html,
            "subject": msg.subject,
            "from": (
                f"{msg.from_address.name} <{msg.from_address.email}>"
                if msg.from_address else ""
            ),
        }
    except HTTPException:
        raise
    except Exception as exc:
        _log.error(
            "full_body.failed", message_id=message_id, error=str(exc)[:200]
        )
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch full body: {str(exc)}",
        )
    finally:
        await db.close()
