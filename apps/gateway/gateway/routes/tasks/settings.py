"""Tasks · settings — per-user AI tiers + behaviour toggles.

Parity with the email app's model roles (email_assistant_settings): each AI
function of the task manager runs on a user-chosen tier/model instead of a
hardcoded one:

  chat_model           the assistant rail (strong tool-caller recommended)
  clarify_model        clarify cognition when the agent takes it over
  atomize_model        mind-dump splitting + duplicate judgment (high volume,
                       fast tier recommended)
  email_capture_model  email→task capture drafting

Plus toggles: ``capture_dedup`` (background duplicate check on quick
capture) and ``auto_sync_on_open`` (incremental provider pull on app open).

GTD settings are per USER (a GTD system is personal), unlike email settings
which are per mailbox. ``gtd_models()`` is the helper the
other tasks modules consume — every value falls back to its per-function
default so the app works before the user ever opens Settings.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends
from gateway.routes.tasks.core import _get_db, _log, _uid, router
from pydantic import BaseModel
from sqlalchemy import text

# Per-function default tiers (aliases resolved by acb_llm: tier-fast→tier1 …).
DEFAULT_GTD_MODELS = {
    "chat": "tier-powerful",       # assistant rail — strong tool-caller
    "clarify": "tier-balanced",    # clarify proposals (agent seam)
    "atomize": "tier-fast",        # high-volume splitting/dedup triage
    "email_capture": "tier-fast",  # one-email → one-capture drafting
}


class GtdSettingsModel(BaseModel):
    chat_model: str = DEFAULT_GTD_MODELS["chat"]
    clarify_model: str = DEFAULT_GTD_MODELS["clarify"]
    atomize_model: str = DEFAULT_GTD_MODELS["atomize"]
    email_capture_model: str = DEFAULT_GTD_MODELS["email_capture"]
    capture_dedup: bool = True
    auto_sync_on_open: bool = True


class GtdSettingsPatch(BaseModel):
    chat_model: str | None = None
    clarify_model: str | None = None
    atomize_model: str | None = None
    email_capture_model: str | None = None
    capture_dedup: bool | None = None
    auto_sync_on_open: bool | None = None


async def gtd_models(db: Any, user_id: str) -> dict[str, str]:
    """The user's per-function models with per-function defaults filled in.
    Never raises — a failed lookup returns the defaults so AI features work
    before settings exist."""
    out = dict(DEFAULT_GTD_MODELS)
    try:
        row = (await db.execute(text(
            """SELECT chat_model, clarify_model, atomize_model,
                      email_capture_model
               FROM gtd_settings WHERE user_id = :uid"""),
            {"uid": user_id})).fetchone()
        if row:
            out["chat"] = row.chat_model or out["chat"]
            out["clarify"] = row.clarify_model or out["clarify"]
            out["atomize"] = row.atomize_model or out["atomize"]
            out["email_capture"] = (row.email_capture_model
                                    or out["email_capture"])
    except Exception as exc:
        _log.warning("tasks.settings.models_failed", error=str(exc)[:160])
    return out


async def _load(db: Any, user_id: str) -> GtdSettingsModel:
    row = (await db.execute(text(
        "SELECT * FROM gtd_settings WHERE user_id = :uid"),
        {"uid": user_id})).fetchone()
    if not row:
        return GtdSettingsModel()
    return GtdSettingsModel(
        chat_model=row.chat_model or DEFAULT_GTD_MODELS["chat"],
        clarify_model=row.clarify_model or DEFAULT_GTD_MODELS["clarify"],
        atomize_model=row.atomize_model or DEFAULT_GTD_MODELS["atomize"],
        email_capture_model=(row.email_capture_model
                             or DEFAULT_GTD_MODELS["email_capture"]),
        capture_dedup=bool(row.capture_dedup),
        auto_sync_on_open=bool(row.auto_sync_on_open),
    )


@router.get("/settings", response_model=GtdSettingsModel)
async def get_gtd_settings(user: UserContext = Depends(get_current_user)):
    db = await _get_db()
    try:
        return await _load(db, _uid(user))
    finally:
        await db.close()


@router.put("/settings", response_model=GtdSettingsModel)
async def put_gtd_settings(
    patch: GtdSettingsPatch,
    user: UserContext = Depends(get_current_user),
):
    """Partial update — only the provided fields change (upsert)."""
    uid = _uid(user)
    fields = {k: v for k, v in patch.model_dump().items() if v is not None}
    db = await _get_db()
    try:
        if fields:
            cols = ", ".join(fields)
            vals = ", ".join(f":{k}" for k in fields)
            sets = ", ".join(f"{k} = EXCLUDED.{k}" for k in fields)
            await db.execute(text(
                f"""INSERT INTO gtd_settings (user_id, {cols})
                    VALUES (:uid, {vals})
                    ON CONFLICT (user_id)
                    DO UPDATE SET {sets}, updated_at = now()"""),
                {"uid": uid, **fields})
            await db.commit()
        return await _load(db, uid)
    finally:
        await db.close()
