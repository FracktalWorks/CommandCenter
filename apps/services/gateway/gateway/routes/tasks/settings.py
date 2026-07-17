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
from gateway.routes.tasks.core import _get_db, _log, _parse_jsonb, _uid, router
from pydantic import BaseModel
from sqlalchemy import text

# Default Kanban board stages for Next Actions (last stage = "done").
DEFAULT_WORKFLOW_STAGES: list[str] = ["TODO", "IN PROCESS", "WAITING FOR", "DONE"]

# Name heuristics for auto-seeding the ClickUp-status → Next-Actions-stage map.
# Each stage lists substrings that, when found in a (lower-cased) ClickUp status
# name, guess that stage. First match wins in STAGE order (so "in review" hits
# IN PROCESS, not WAITING); anything unmatched falls back to the first stage.
_STAGE_HEURISTICS: list[tuple[str, tuple[str, ...]]] = [
    ("DONE", ("done", "complete", "closed", "resolved", "shipped", "cancel")),
    ("WAITING FOR", ("waiting", "blocked", "on hold", "hold", "paused",
                     "pending", "stuck")),
    ("IN PROCESS", ("progress", "process", "doing", "review", "testing",
                    "qa", "active", "wip", "started")),
    ("TODO", ("todo", "to do", "to-do", "backlog", "open", "new", "icebox",
              "later", "someday", "planned", "queue")),
]


def guess_stage_for_status(status: str, stages: list[str]) -> str:
    """Auto-guess which of the user's `stages` a raw ClickUp status name belongs
    to, by substring heuristics. Falls back to the FIRST stage when nothing
    matches (so a task is always visible, never lost). Only guesses stages the
    user actually has — a heuristic for a stage not in `stages` is skipped."""
    low = (status or "").strip().lower()
    have = {s.strip().upper(): s for s in stages}
    for canonical, needles in _STAGE_HEURISTICS:
        if canonical in have and any(n in low for n in needles):
            return have[canonical]
    return stages[0] if stages else "TODO"


def seed_status_stage_map(
    statuses: list[str], stages: list[str],
    existing: dict[str, str] | None = None,
) -> dict[str, str]:
    """Build/extend the status→stage map: keep any EXISTING user choices, and
    auto-guess a stage for every status not yet mapped. Keyed by the normalized
    (trimmed, lower-cased) status name. Never overrides a user's explicit map."""
    out = dict(existing or {})
    for raw in statuses:
        key = (raw or "").strip().lower()
        if not key or key in out:
            continue
        out[key] = guess_stage_for_status(raw, stages)
    return out

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
    # ClickUp status → Next-Actions stage. {normalized_status: stage} — one entry
    # per unique upstream status name across every connected project. Governs how
    # a synced task groups on the Next-Actions board and (in reverse) which of a
    # task's own project statuses is written back on a drag. Empty = fall back to
    # the name heuristic; seeded by the auto-guess on first status-catalog read.
    status_stage_map: dict[str, str] = {}
    # Calendar/timeboxing prefs (migration 77). The plannable day window, a soft
    # daily focus budget (overcommit flag), inter-block buffer, and the user's
    # energy windows ([{start_hour,end_hour,energy}]). Grid + AI planner use them.
    day_start_hour: int = 7
    day_end_hour: int = 22
    daily_capacity_mins: int = 360
    buffer_mins: int = 0
    energy_windows: list[dict] = []


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
    status_stage_map: dict[str, str] | None = None
    day_start_hour: int | None = None
    day_end_hour: int | None = None
    daily_capacity_mins: int | None = None
    buffer_mins: int | None = None
    energy_windows: list[dict] | None = None


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


async def gtd_calendar_prefs(db: Any, user_id: str) -> dict[str, Any]:
    """Calendar/timeboxing prefs with safe defaults (never raises), for the grid
    + the AI day-planner. energy_windows = [{start_hour,end_hour,energy}]."""
    out: dict[str, Any] = {
        "day_start_hour": 7, "day_end_hour": 22,
        "daily_capacity_mins": 360, "buffer_mins": 0, "energy_windows": [],
    }
    try:
        s = await _load(db, user_id)
        out.update({
            "day_start_hour": s.day_start_hour,
            "day_end_hour": s.day_end_hour,
            "daily_capacity_mins": s.daily_capacity_mins,
            "buffer_mins": s.buffer_mins,
            "energy_windows": s.energy_windows,
        })
    except Exception as exc:
        _log.warning(
            "tasks.settings.calendar_prefs_failed", error=str(exc)[:160])
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
        # getattr defaults keep a pre-migration row (no such column) working.
        clarify_use_llm=bool(getattr(row, "clarify_use_llm", True)),
        background_sync=bool(getattr(row, "background_sync", True)),
        mirror_done_tasks=bool(getattr(row, "mirror_done_tasks", False)),
        workflow_stages=_stages(getattr(row, "workflow_stages", None)),
        urgent_window_hours=int(getattr(row, "urgent_window_hours", 48) or 48),
        status_stage_map=_status_map(getattr(row, "status_stage_map", None)),
        day_start_hour=int(getattr(row, "day_start_hour", 7) or 7),
        day_end_hour=int(getattr(row, "day_end_hour", 22) or 22),
        daily_capacity_mins=int(
            getattr(row, "daily_capacity_mins", 360) or 360),
        buffer_mins=int(getattr(row, "buffer_mins", 0) or 0),
        energy_windows=_energy_windows(getattr(row, "energy_windows", None)),
    )


def _energy_windows(val: Any) -> list[dict]:
    """Normalize stored energy_windows (JSONB list, or JSON string) → a clean
    list of {start_hour,end_hour,energy}. Drops anything malformed."""
    import json
    if isinstance(val, str):
        try:
            val = json.loads(val)
        except ValueError:
            return []
    if not isinstance(val, list):
        return []
    out: list[dict] = []
    for w in val:
        if not isinstance(w, dict):
            continue
        try:
            s, e = int(w.get("start_hour")), int(w.get("end_hour"))
        except (TypeError, ValueError):
            continue
        en = str(w.get("energy") or "").lower()
        if en in ("low", "medium", "high") and 0 <= s < e <= 24:
            out.append({"start_hour": s, "end_hour": e, "energy": en})
    return out


def _status_map(val: Any) -> dict[str, str]:
    """Normalize the stored status_stage_map (JSONB object, or JSON string) into
    a clean {normalized_status: stage} dict; empty dict on anything unparseable
    (pre-migration row, bad value) so callers fall back to the heuristic."""
    import json
    if isinstance(val, str):
        try:
            val = json.loads(val)
        except ValueError:
            val = None
    if isinstance(val, dict):
        return {str(k).strip().lower(): str(v).strip()
                for k, v in val.items()
                if str(k).strip() and str(v).strip()}
    return {}


async def gtd_status_stage_map(db: Any, user_id: str) -> dict[str, str]:
    """The user's ClickUp-status → stage map (normalized keys), defaults to {}.
    Never raises — a missing row / pre-migration DB returns {}."""
    try:
        row = (await db.execute(text(
            "SELECT status_stage_map FROM gtd_settings WHERE user_id = :uid"),
            {"uid": user_id})).fetchone()
        if row:
            return _status_map(row.status_stage_map)
    except Exception as exc:
        _log.warning("tasks.settings.status_map_failed", error=str(exc)[:160])
    return {}


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


class StatusCatalogEntry(BaseModel):
    status: str          # the ClickUp status name (a representative spelling)
    stage: str           # the mapped Next-Actions stage (auto-guessed if unset)
    mapped: bool         # False → this is an auto-guess, not a user choice yet


class StatusCatalogResponse(BaseModel):
    stages: list[str]                    # the user's 4 fixed stages (for the picker)
    entries: list[StatusCatalogEntry]    # one per unique upstream status
    unmapped: int                        # how many are still just auto-guesses


@router.get("/status-catalog", response_model=StatusCatalogResponse)
async def status_catalog(user: UserContext = Depends(get_current_user)):
    """Every UNIQUE ClickUp status across the user's connected projects, paired
    with the stage it maps to. A status the user hasn't explicitly mapped shows
    its auto-guessed stage (``mapped=False``) so the settings table is never
    blank — the user just confirms/adjusts. Powers the status-mapping UI."""
    uid = _uid(user)
    db = await _get_db()
    try:
        settings = await _load(db, uid)
        rows = (await db.execute(text(
            "SELECT schema_cache FROM task_accounts WHERE user_id = :uid"),
            {"uid": uid})).fetchall()
        # Unique upstream statuses (first spelling wins), normalized for dedup.
        seen: dict[str, str] = {}
        for r in rows:
            cache = _parse_jsonb(r.schema_cache) or {}
            for s in cache.get("statuses") or []:
                if not isinstance(s, str) or not s.strip():
                    continue
                key = s.strip().lower()
                seen.setdefault(key, s.strip())
        stages = settings.workflow_stages
        smap = settings.status_stage_map
        entries: list[StatusCatalogEntry] = []
        unmapped = 0
        for key, display in sorted(seen.items()):
            if key in smap:
                entries.append(StatusCatalogEntry(
                    status=display, stage=smap[key], mapped=True))
            else:
                entries.append(StatusCatalogEntry(
                    status=display,
                    stage=guess_stage_for_status(display, stages),
                    mapped=False))
                unmapped += 1
        return StatusCatalogResponse(
            stages=stages, entries=entries, unmapped=unmapped)
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
        import json
        if "workflow_stages" in fields:
            # Sanitize (trim, drop empties, cap) and JSON-encode for the JSONB
            # column. Guarantee a non-empty list with a "done" stage.
            stages = [str(s).strip() for s in fields["workflow_stages"]
                      if str(s).strip()][:24]
            if not stages:
                stages = list(DEFAULT_WORKFLOW_STAGES)
            fields["workflow_stages"] = json.dumps(stages)
        _jsonb_cols = {"workflow_stages", "status_stage_map", "energy_windows"}
        if "status_stage_map" in fields:
            # Normalize keys (lower/trim) + drop empties; JSON-encode for JSONB.
            raw = fields["status_stage_map"] or {}
            clean = {str(k).strip().lower(): str(v).strip()
                     for k, v in raw.items()
                     if str(k).strip() and str(v).strip()}
            fields["status_stage_map"] = json.dumps(clean)
        if "energy_windows" in fields:
            # Validate + JSON-encode for the JSONB column.
            fields["energy_windows"] = json.dumps(
                _energy_windows(fields["energy_windows"]))
        if fields:
            # JSONB columns need an explicit ::jsonb cast on the bind param.
            def _ph(k: str) -> str:
                return f":{k}::jsonb" if k in _jsonb_cols else f":{k}"
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
