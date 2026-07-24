"""Automation · categories — labels upgraded into policy carriers (W2).

Each category answers four questions — how loudly does it notify, may the AI
auto-reply, is a draft prepared, when does silence escalate — so the triage queue
stays calm by policy rather than by the founder watching every chat. The default
set maps the WhatsApp Business app's stock labels plus ours (VIP, Family, Noise);
``Family`` is hands-off by default (draft_policy='never'), the trust line the
spec calls out.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.whatsapp.core import _get_db, router
from pydantic import BaseModel
from sqlalchemy import text

_NOTIFY = {"instant", "digest", "mention_only", "never"}
_AUTO_REPLY = {"never", "holding", "answer_from_system"}
_DRAFT = {"always", "on_intent", "never"}


class CategoryModel(BaseModel):
    id: str
    name: str
    icon: str | None = None
    wa_label_id: str | None = None
    notify_policy: str = "digest"
    auto_reply_policy: str = "never"
    draft_policy: str = "on_intent"
    escalate_after_mins: int | None = None
    sort_order: int = 100


class CategoryUpdate(BaseModel):
    icon: str | None = None
    notify_policy: str | None = None
    auto_reply_policy: str | None = None
    draft_policy: str | None = None
    escalate_after_mins: int | None = None
    sort_order: int | None = None


def default_categories() -> list[dict[str, Any]]:
    """The starter policy set. Pure/testable. Ordered as they appear in the nav.

    ``escalate_after_mins`` uses minutes (2h = 120, 4h = 240, 24h = 1440)."""
    return [
        {"name": "VIP", "icon": "star", "notify_policy": "instant",
         "auto_reply_policy": "never", "draft_policy": "always",
         "escalate_after_mins": 120, "sort_order": 10},
        {"name": "New customer", "icon": "tag", "notify_policy": "digest",
         "auto_reply_policy": "holding", "draft_policy": "on_intent",
         "escalate_after_mins": 1440, "sort_order": 20},
        {"name": "Pending payment", "icon": "tag", "notify_policy": "instant",
         "auto_reply_policy": "never", "draft_policy": "always",
         "escalate_after_mins": 240, "sort_order": 30},
        {"name": "Dealer groups", "icon": "group", "notify_policy": "mention_only",
         "auto_reply_policy": "never", "draft_policy": "on_intent",
         "escalate_after_mins": None, "sort_order": 40},
        {"name": "Family & personal", "icon": "person", "notify_policy": "instant",
         "auto_reply_policy": "never", "draft_policy": "never",
         "escalate_after_mins": None, "sort_order": 50},
        {"name": "Noise", "icon": "mute", "notify_policy": "never",
         "auto_reply_policy": "never", "draft_policy": "never",
         "escalate_after_mins": None, "sort_order": 90},
    ]


def _validate_policies(
    notify: str | None, auto_reply: str | None, draft: str | None,
) -> None:
    if notify is not None and notify not in _NOTIFY:
        raise HTTPException(status_code=400, detail=f"bad notify_policy {notify!r}")
    if auto_reply is not None and auto_reply not in _AUTO_REPLY:
        raise HTTPException(status_code=400, detail=f"bad auto_reply_policy {auto_reply!r}")
    if draft is not None and draft not in _DRAFT:
        raise HTTPException(status_code=400, detail=f"bad draft_policy {draft!r}")


def _model(row: Any) -> CategoryModel:
    return CategoryModel(
        id=str(row.id), name=row.name, icon=row.icon,
        wa_label_id=row.wa_label_id, notify_policy=row.notify_policy,
        auto_reply_policy=row.auto_reply_policy, draft_policy=row.draft_policy,
        escalate_after_mins=row.escalate_after_mins, sort_order=row.sort_order,
    )


async def _assert_account_owned(db: Any, account_id: str, user_email: str) -> None:
    owned = (await db.execute(
        text("SELECT 1 FROM wa_accounts WHERE id = :id AND user_id = :uid"),
        {"id": account_id, "uid": user_email},
    )).fetchone()
    if not owned:
        raise HTTPException(status_code=404, detail="Account not found")


_SELECT = """SELECT id, name, icon, wa_label_id, notify_policy,
                    auto_reply_policy, draft_policy, escalate_after_mins,
                    sort_order
             FROM wa_categories"""


@router.get("/categories", response_model=list[CategoryModel])
async def list_categories(
    account_id: str, user: UserContext = Depends(get_current_user),
):
    """List an account's categories with their policies, in nav order."""
    db = await _get_db()
    try:
        await _assert_account_owned(db, account_id, user.email or "anonymous")
        rows = (await db.execute(
            text(_SELECT + " WHERE account_id = :aid ORDER BY sort_order, name"),
            {"aid": account_id},
        )).fetchall()
        return [_model(r) for r in rows]
    finally:
        await db.close()


@router.post("/accounts/{account_id}/categories/bootstrap",
             response_model=list[CategoryModel])
async def bootstrap_categories(
    account_id: str, user: UserContext = Depends(get_current_user),
):
    """Seed the default category policy set (idempotent — existing names kept)."""
    db = await _get_db()
    try:
        await _assert_account_owned(db, account_id, user.email or "anonymous")
        for c in default_categories():
            await db.execute(
                text("""INSERT INTO wa_categories
                          (id, account_id, name, icon, notify_policy,
                           auto_reply_policy, draft_policy, escalate_after_mins,
                           sort_order)
                        VALUES
                          (:id, :aid, :name, :icon, :notify, :auto, :draft,
                           :esc, :sort)
                        ON CONFLICT (account_id, name) DO NOTHING"""),
                {"id": str(uuid4()), "aid": account_id, "name": c["name"],
                 "icon": c["icon"], "notify": c["notify_policy"],
                 "auto": c["auto_reply_policy"], "draft": c["draft_policy"],
                 "esc": c["escalate_after_mins"], "sort": c["sort_order"]},
            )
        await db.commit()
        rows = (await db.execute(
            text(_SELECT + " WHERE account_id = :aid ORDER BY sort_order, name"),
            {"aid": account_id},
        )).fetchall()
        return [_model(r) for r in rows]
    finally:
        await db.close()


@router.patch("/categories/{category_id}", response_model=CategoryModel)
async def update_category(
    category_id: str, req: CategoryUpdate,
    user: UserContext = Depends(get_current_user),
):
    """Change a category's policy (the founder tuning behaviour per category)."""
    _validate_policies(req.notify_policy, req.auto_reply_policy, req.draft_policy)
    db = await _get_db()
    try:
        row = (await db.execute(
            text("""SELECT c.id FROM wa_categories c
                    JOIN wa_accounts a ON a.id = c.account_id
                    WHERE c.id = :cid AND a.user_id = :uid"""),
            {"cid": category_id, "uid": user.email or "anonymous"},
        )).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Category not found")

        fields = req.model_dump(exclude_none=True)
        if fields:
            sets = ", ".join(f"{k} = :{k}" for k in fields)
            fields["cid"] = category_id
            await db.execute(
                text(f"UPDATE wa_categories SET {sets}, updated_at = now() "
                     f"WHERE id = :cid"),
                fields,
            )
            await db.commit()
        updated = (await db.execute(
            text(_SELECT + " WHERE id = :cid"), {"cid": category_id},
        )).fetchone()
        return _model(updated)
    finally:
        await db.close()
