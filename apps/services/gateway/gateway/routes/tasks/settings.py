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

# Default Kanban board stages for Next Actions (last stage = "done").
DEFAULT_WORKFLOW_STAGES: list[str] = ["TODO", "IN PROCESS", "WAITING FOR", "DONE"]

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
    # AI-clarify cognition (Phase 3): use the LLM pass, or the instant
    # heuristic only. background_sync: keep workspaces synced on a schedule.
    clarify_use_llm: bool = True
    background_sync: bool = True
    # Mirror already-completed provider tasks into the local board. Default OFF:
    # a connected workspace can carry hundreds of closed tasks that would
    # otherwise swamp the working views. Existing mirrored rows still flip to
    # DONE when closed upstream; this only governs importing NEW closed tasks.
    mirror_done_tasks: bool = False
    # The user's ordered Kanban board stages for Next Actions (Jira/ClickUp
    # style). The LAST stage is the "done" stage — dropping a card there marks
    # the task DONE. Configurable in settings.
    workflow_stages: list[str] = list(DEFAULT_WORKFLOW_STAGES)
    # Prioritization: hours from now within which a due task counts as URGENT
    # (also always urgent once overdue). Drives the matrix's ⏰ axis so urgency
    # never goes stale. Default 48h.
    urgent_window_hours: int = 48


class GtdSettingsPatch(BaseModel):
    chat_model: str | None = None
    clarify_model: str | None = None
    atomize_model: str | None = None
    email_capture_model: str | None = None
    capture_dedup: bool | None = None
    auto_sync_on_open: bool | None = None
    clarify_use_llm: bool | None = None
    background_sync: bool | None = None
    mirror_done_tasks: bool | None = None
    workflow_stages: list[str] | None = None
    urgent_window_hours: int | None = None


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


async def gtd_toggles(db: Any, user_id: str) -> dict[str, bool]:
    """The user's AI/behaviour toggles with safe defaults. Never raises — a
    missing row or a pre-migration DB (no such column) returns the defaults
    (features on), so callers degrade to current behaviour rather than break."""
    out = {"clarify_use_llm": True, "background_sync": True,
           "mirror_done_tasks": False}
    try:
        row = (await db.execute(text(
            """SELECT clarify_use_llm, background_sync, mirror_done_tasks
               FROM gtd_settings WHERE user_id = :uid"""),
            {"uid": user_id})).fetchone()
        if row:
            out["clarify_use_llm"] = bool(row.clarify_use_llm)
            out["background_sync"] = bool(row.background_sync)
            out["mirror_done_tasks"] = bool(row.mirror_done_tasks)
    except Exception as exc:
        _log.warning("tasks.settings.toggles_failed", error=str(exc)[:160])
    return out


async def gtd_workflow_stages(db: Any, user_id: str) -> list[str]:
    """The user's ordered board stages, defaults filled in. Never raises."""
    try:
        row = (await db.execute(text(
            "SELECT workflow_stages FROM gtd_settings WHERE user_id = :uid"),
            {"uid": user_id})).fetchone()
        if row:
            return _stages(row.workflow_stages)
    except Exception as exc:
        _log.warning("tasks.settings.stages_failed", error=str(exc)[:160])
    return list(DEFAULT_WORKFLOW_STAGES)


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
        # getattr defaults keep a pre-migration row (no such column) working.
        clarify_use_llm=bool(getattr(row, "clarify_use_llm", True)),
        background_sync=bool(getattr(row, "background_sync", True)),
        mirror_done_tasks=bool(getattr(row, "mirror_done_tasks", False)),
        workflow_stages=_stages(getattr(row, "workflow_stages", None)),
        urgent_window_hours=int(getattr(row, "urgent_window_hours", 48) or 48),
    )


def _stages(val: Any) -> list[str]:
    """Normalize the stored workflow_stages (JSONB list, or JSON string) into a
    clean list of non-empty stage names; fall back to the defaults."""
    import json
    if isinstance(val, str):
        try:
            val = json.loads(val)
        except ValueError:
            val = None
    if isinstance(val, list):
        cleaned = [str(s).strip() for s in val
                   if s is not None and str(s).strip()]
        if cleaned:
            return cleaned
    return list(DEFAULT_WORKFLOW_STAGES)


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
        if "workflow_stages" in fields:
            # Sanitize (trim, drop empties, cap) and JSON-encode for the JSONB
            # column. Guarantee a non-empty list with a "done" stage.
            import json
            stages = [str(s).strip() for s in fields["workflow_stages"]
                      if str(s).strip()][:24]
            if not stages:
                stages = list(DEFAULT_WORKFLOW_STAGES)
            fields["workflow_stages"] = json.dumps(stages)
        if fields:
            # JSONB columns need an explicit ::jsonb cast on the bind param.
            def _ph(k: str) -> str:
                return f":{k}::jsonb" if k == "workflow_stages" else f":{k}"
            cols = ", ".join(fields)
            vals = ", ".join(_ph(k) for k in fields)
            sets = ", ".join(f"{k} = EXCLUDED.{k}" for k in fields)
            await db.execute(text(
                f"""INSERT INTO gtd_settings (user_id, {cols})
                    VALUES (:uid, {vals})
                    ON CONFLICT (user_id)
                    DO UPDATE SET {sets}, updated_at = now()"""),
                {"uid": uid, **fields})
            await db.commit()

            # A background_sync toggle must (re)start or stop this user's
            # workspace loops at runtime — otherwise the change only takes
            # effect on the next gateway restart.
            if "background_sync" in fields:
                await _apply_background_sync_toggle(
                    db, uid, bool(fields["background_sync"]))
        return await _load(db, uid)
    finally:
        await db.close()


async def _apply_background_sync_toggle(
    db: Any, user_id: str, enabled: bool,
) -> None:
    """Start (enabled) or stop (disabled) the background loops for every
    sync-enabled workspace this user owns. Best-effort — a scheduler hiccup
    never fails the settings save."""
    try:
        from gateway.routes.tasks.scheduler import (
            refresh_account_sync,
            remove_account_sync,
        )
        rows = (await db.execute(text(
            """SELECT id FROM task_accounts
               WHERE user_id = :uid AND sync_enabled = true"""),
            {"uid": user_id})).fetchall()
        for r in rows:
            if enabled:
                await refresh_account_sync(str(r.id))
            else:
                await remove_account_sync(str(r.id))
    except Exception as exc:
        _log.warning("tasks.settings.bg_toggle_failed", error=str(exc)[:160])
