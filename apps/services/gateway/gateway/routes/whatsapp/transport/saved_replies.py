"""Transport · saved replies — founder-defined canned snippets (W8).

The answers a founder types ten times a day (price list, address, GST number,
catalogue link). DISTINCT from templates: a saved reply is a plain free-form
snippet dropped into the composer inside the 24h window, with an optional
``/shortcut`` for recall. Plain CRUD scoped to the account, mirroring the
categories/templates routes; ``normalize_shortcut`` is pure/testable.
"""

from __future__ import annotations

import re
from typing import Any
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.whatsapp.core import _get_db, router
from pydantic import BaseModel
from sqlalchemy import text

_MAX_TITLE = 80
_MAX_BODY = 4096
_MAX_SHORTCUT = 32
_SHORTCUT_CHARS = re.compile(r"[^a-z0-9_]")


def normalize_shortcut(raw: str | None) -> str | None:
    """Canonicalize a recall shortcut, or None when absent. Pure.

    Lowercased, a single leading ``/``, and restricted to ``[a-z0-9_]`` so it is
    unambiguous to type. An empty/only-punctuation value normalizes to None
    (the reply simply has no shortcut).
    """
    if not raw:
        return None
    slug = _SHORTCUT_CHARS.sub("", raw.strip().lower().lstrip("/"))
    if not slug:
        return None
    return f"/{slug[:_MAX_SHORTCUT]}"


class SavedReplyModel(BaseModel):
    id: str
    title: str
    body: str
    shortcut: str | None = None
    sort_order: int = 100


class SavedReplyCreate(BaseModel):
    account_id: str
    title: str
    body: str
    shortcut: str | None = None
    sort_order: int = 100


class SavedReplyUpdate(BaseModel):
    title: str | None = None
    body: str | None = None
    shortcut: str | None = None
    sort_order: int | None = None


def _model(row: Any) -> SavedReplyModel:
    return SavedReplyModel(
        id=str(row.id), title=row.title, body=row.body,
        shortcut=row.shortcut, sort_order=row.sort_order,
    )


_SELECT = "SELECT id, title, body, shortcut, sort_order FROM wa_saved_replies"


async def _assert_account_owned(db: Any, account_id: str, user_email: str) -> None:
    owned = (await db.execute(
        text("SELECT 1 FROM wa_accounts WHERE id = :id AND user_id = :uid"),
        {"id": account_id, "uid": user_email},
    )).fetchone()
    if not owned:
        raise HTTPException(status_code=404, detail="Account not found")


async def _owned_reply_account(db: Any, reply_id: str, user_email: str) -> str:
    row = (await db.execute(
        text("""SELECT r.account_id FROM wa_saved_replies r
                JOIN wa_accounts a ON a.id = r.account_id
                WHERE r.id = :rid AND a.user_id = :uid"""),
        {"rid": reply_id, "uid": user_email},
    )).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Saved reply not found")
    return str(row.account_id)


@router.get("/saved-replies", response_model=list[SavedReplyModel])
async def list_saved_replies(
    account_id: str, user: UserContext = Depends(get_current_user),
):
    """List an account's saved replies, in the founder's chosen order."""
    db = await _get_db()
    try:
        await _assert_account_owned(db, account_id, user.email or "anonymous")
        rows = (await db.execute(
            text(_SELECT + " WHERE account_id = :aid ORDER BY sort_order, title"),
            {"aid": account_id},
        )).fetchall()
        return [_model(r) for r in rows]
    finally:
        await db.close()


@router.post("/saved-replies", response_model=SavedReplyModel, status_code=201)
async def create_saved_reply(
    req: SavedReplyCreate, user: UserContext = Depends(get_current_user),
):
    """Add a saved reply."""
    title = (req.title or "").strip()[:_MAX_TITLE]
    body = (req.body or "").strip()[:_MAX_BODY]
    if not title or not body:
        raise HTTPException(status_code=422, detail="title and body are required")
    shortcut = normalize_shortcut(req.shortcut)
    db = await _get_db()
    try:
        await _assert_account_owned(db, req.account_id, user.email or "anonymous")
        try:
            row = (await db.execute(
                text("""INSERT INTO wa_saved_replies
                          (id, account_id, title, body, shortcut, sort_order)
                        VALUES (:id, :aid, :title, :body, :shortcut, :sort)
                        RETURNING id, title, body, shortcut, sort_order"""),
                {"id": str(uuid4()), "aid": req.account_id, "title": title,
                 "body": body, "shortcut": shortcut, "sort": req.sort_order},
            )).fetchone()
        except Exception as exc:  # unique-shortcut collision, etc.
            await db.rollback()
            if "uq_wa_saved_replies_shortcut" in str(exc):
                raise HTTPException(
                    status_code=409,
                    detail=f"shortcut {shortcut} is already in use") from exc
            raise
        await db.commit()
        return _model(row)
    finally:
        await db.close()


@router.patch("/saved-replies/{reply_id}", response_model=SavedReplyModel)
async def update_saved_reply(
    reply_id: str, req: SavedReplyUpdate,
    user: UserContext = Depends(get_current_user),
):
    """Edit a saved reply (title / body / shortcut / order)."""
    db = await _get_db()
    try:
        await _owned_reply_account(db, reply_id, user.email or "anonymous")
        fields: dict[str, Any] = {}
        if req.title is not None:
            t = req.title.strip()[:_MAX_TITLE]
            if not t:
                raise HTTPException(status_code=422, detail="title cannot be empty")
            fields["title"] = t
        if req.body is not None:
            b = req.body.strip()[:_MAX_BODY]
            if not b:
                raise HTTPException(status_code=422, detail="body cannot be empty")
            fields["body"] = b
        if req.shortcut is not None:
            fields["shortcut"] = normalize_shortcut(req.shortcut)
        if req.sort_order is not None:
            fields["sort_order"] = req.sort_order

        if fields:
            sets = ", ".join(f"{k} = :{k}" for k in fields)
            params = {**fields, "rid": reply_id}
            try:
                await db.execute(
                    text(f"UPDATE wa_saved_replies SET {sets}, updated_at = now() "
                         f"WHERE id = :rid"),
                    params,
                )
            except Exception as exc:
                await db.rollback()
                if "uq_wa_saved_replies_shortcut" in str(exc):
                    raise HTTPException(
                        status_code=409,
                        detail="that shortcut is already in use") from exc
                raise
            await db.commit()
        updated = (await db.execute(
            text(_SELECT + " WHERE id = :rid"), {"rid": reply_id},
        )).fetchone()
        return _model(updated)
    finally:
        await db.close()


@router.delete("/saved-replies/{reply_id}", status_code=204)
async def delete_saved_reply(
    reply_id: str, user: UserContext = Depends(get_current_user),
):
    """Delete a saved reply."""
    db = await _get_db()
    try:
        await _owned_reply_account(db, reply_id, user.email or "anonymous")
        await db.execute(
            text("DELETE FROM wa_saved_replies WHERE id = :rid"), {"rid": reply_id},
        )
        await db.commit()
    finally:
        await db.close()
