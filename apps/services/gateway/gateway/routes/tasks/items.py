"""Tasks · items — capture, browse, clarify-apply, and the approved push.

The GTD flow, server-side:
  capture (POST /items, /items/batch)      → INBOX rows, LOCAL by default
  browse  (GET /items?view=…)              → unified across LOCAL + SYNCED
  clarify (POST /items/{id}/organize)      → apply one decision atomically:
            disposition + next action + destination (LOCAL or a connected
            workspace) + project/stage/assignee/due + waiting-for record
  push    (POST /items/{id}/push)          → the explicit user-approved write
            that creates the staged (sync_state='pending') task in the PM
            tool. Suggest-only posture per C-04 — nothing writes upstream
            without this user action until the Action Broker lands.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.tasks.core import (
    DEFAULT_CONTEXTS,
    ITEM_SELECT,
    PROJECT_SELECT,
    GtdItemModel,
    GtdProjectModel,
    PersonModel,
    _assert_account_owner,
    _get_db,
    _key_store,
    _log,
    _parse_jsonb,
    _row_to_item,
    _row_to_project,
    _uid,
    router,
)
from gateway.routes.tasks.providers import build_provider
from pydantic import BaseModel
from sqlalchemy import text

DISPOSITIONS = {"INBOX", "NEXT", "WAITING", "SOMEDAY", "PROJECT",
                "REFERENCE", "DONE", "TRASH"}

VIEW_WHERE: dict[str, str] = {
    "inbox": "i.disposition = 'INBOX'",
    "next": "i.disposition = 'NEXT'",
    "waiting": "i.disposition = 'WAITING'",
    "someday": "i.disposition = 'SOMEDAY'",
    "reference": "i.disposition = 'REFERENCE'",
    "done": "i.disposition = 'DONE'",
    "calendar": "i.due_at IS NOT NULL AND i.is_hard_date "
                "AND i.disposition NOT IN ('DONE','TRASH')",
    # The default working board: everything still in play. DONE is EXCLUDED here
    # (it has its own "done" view) so a large synced backlog of completed tasks
    # can't swamp the list and push LOCAL/open items past the row cap. Trashed
    # rows are always hidden.
    "all": "i.disposition NOT IN ('DONE', 'TRASH')",
    # Archived tasks — hidden from every active view, shown only here.
    "archive": "i.archived_at IS NOT NULL",
}

# Active views never show archived rows; the "archive" view shows only them.
_ARCHIVE_EXCLUDE = "i.archived_at IS NULL"

# Soft-deleted (tombstoned) rows are hidden from EVERY view, including Archive —
# they're gone as far as the UI is concerned, pending restore or purge.
_DELETED_EXCLUDE = "i.deleted_at IS NULL"


class CaptureRequest(BaseModel):
    title: str
    notes: str | None = None
    # Context refs from the capture UI: {kind: file|image|link, name, url,
    # attachment_id?, mime?, size?}. Links need no upload.
    attachments: list[dict] | None = None
    # Capture-time tickler / deadline (GTD, optional — capture stays pure):
    # defer_until hides the item until that date, then it resurfaces in the
    # inbox; due_at (+ is_hard_date) is a deadline that shows on the Calendar.
    defer_until: str | None = None
    due_at: str | None = None
    is_hard_date: bool = False


class CaptureBatchRequest(BaseModel):
    titles: list[str]


class ItemPatch(BaseModel):
    """In-place edits to a task's metadata — used both for inbox captures
    (rename/note/tickler/quick-dispose) and for editing a clarified task's
    overlay (context/energy/estimate/due/stage/assignee). For a SYNCED task the
    mapped fields also back-sync to the connected tool (see _push_patch_upstream).
    """
    title: str | None = None
    notes: str | None = None
    disposition: str | None = None
    defer_until: str | None = None       # ISO; "" clears (un-snooze)
    next_action: str | None = None
    context: str | None = None
    energy: str | None = None
    time_estimate_mins: int | None = None
    due_at: str | None = None
    provider_status: str | None = None   # the tool's stage, e.g. 'To-do'
    workflow_stage: str | None = None    # the local Kanban stage (board move)
    sort_key: float | None = None        # manual (drag) rank within a group/column
    assignee: PersonModel | None = None   # a PersonModel to set; sentinel below to clear
    clear_assignee: bool = False          # explicit unassign (assignee=None is "unchanged")
    # Personal "My Next Actions" membership (My Next Actions = NEXT & is_mine).
    # A LOCAL overlay only — never back-synced to the connected tool.
    is_mine: bool | None = None
    attachments: list[dict] | None = None  # replaces the whole list
    # Prioritization matrix flags (local overlay, never back-synced). urgent is
    # derived from due_at, so it is NOT a patchable field.
    important: bool | None = None
    leveraged: bool | None = None
    kept_mine: bool | None = None          # dismiss the delegate/schedule hint


class OrganizeRequest(BaseModel):
    """One clarify decision — mirrors the UI's ClarifyDecision (§2.2).

    Sort→Shape (the redesigned Clarify card): `kind` carries the SORT decision
    (next|project|calendar|do-now|someday|reference|trash) plus SIZE (project
    vs next, with `subtasks`). `assignee` is the independent OWNER axis — it
    can be set on ANY actionable kind (not just the legacy `delegate` kind), so
    a task can be a project AND delegated AND scheduled AND broken into steps,
    all at once. The legacy `kind="delegate"` still works unchanged (owner-only,
    single action) for older callers.
    """
    kind: str                            # next|project|delegate|calendar|do-now|someday|reference|trash
    next_action: str | None = None
    outcome: str | None = None           # project kind: the wild-success statement
    context: str | None = None
    energy: str | None = None
    time_estimate_mins: int | None = None
    due_at: str | None = None            # ISO
    account_id: str | None = None        # destination: None → LOCAL; else a task_account
    project_id: str | None = None        # existing project to file under
    status: str | None = None            # provider stage, e.g. 'Backlog' | 'To-do'
    assignee: PersonModel | None = None
    subtasks: list[str] | None = None    # break this task into child subtasks


class BulkRequest(BaseModel):
    ids: list[str]
    disposition: str


def _parse_ts(val: str | None) -> datetime | None:
    if not val:
        return None
    try:
        return datetime.fromisoformat(val.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400,
                            detail=f"Bad timestamp: {val!r}") from exc


async def _fetch_item(
    db: Any, item_id: str, user_id: str, *, include_deleted: bool = False,
) -> Any:
    """Fetch one item by id. Soft-deleted (tombstoned) rows are hidden by
    default; restore/purge pass include_deleted=True to reach them."""
    tomb = "" if include_deleted else f" AND {_DELETED_EXCLUDE}"
    row = (await db.execute(
        text(ITEM_SELECT + f" WHERE i.id = :id AND i.user_id = :uid{tomb}"),
        {"id": item_id, "uid": user_id},
    )).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Item not found")
    return row


# ── Capture ──────────────────────────────────────────────────────────────────

@router.post("/items", response_model=GtdItemModel, status_code=201)
async def capture_item(
    req: CaptureRequest,
    user: UserContext = Depends(get_current_user),
):
    title = req.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Empty capture")
    db = await _get_db()
    try:
        item_id = str(uuid4())
        await db.execute(
            text("""INSERT INTO gtd_items
                    (id, user_id, title, description, attachments,
                     defer_until, due_at, is_hard_date)
                    VALUES (:id, :uid, :title, :notes, :atts,
                            :defer, :due, :hard)"""),
            {"id": item_id, "uid": _uid(user), "title": title,
             "notes": req.notes,
             "atts": json.dumps(req.attachments) if req.attachments else None,
             "defer": _parse_ts(req.defer_until),
             "due": _parse_ts(req.due_at),
             "hard": bool(req.is_hard_date and req.due_at)},
        )
        await db.commit()
        return _row_to_item(await _fetch_item(db, item_id, _uid(user)))
    finally:
        await db.close()


@router.post("/items/batch", response_model=list[GtdItemModel], status_code=201)
async def capture_batch(
    req: CaptureBatchRequest,
    user: UserContext = Depends(get_current_user),
):
    """Mind-sweep commit: the reviewed lines land as separate INBOX items."""
    titles = [t.strip() for t in req.titles if t.strip()]
    if not titles:
        raise HTTPException(status_code=400, detail="No items to capture")
    db = await _get_db()
    try:
        out = []
        for title in titles:
            item_id = str(uuid4())
            await db.execute(
                text("""INSERT INTO gtd_items (id, user_id, title)
                        VALUES (:id, :uid, :title)"""),
                {"id": item_id, "uid": _uid(user), "title": title},
            )
            out.append(item_id)
        await db.commit()
        rows = (await db.execute(
            text(ITEM_SELECT + " WHERE i.id::text = ANY(:ids)"), {"ids": out},
        )).fetchall()
        by_id = {str(r.id): r for r in rows}
        return [_row_to_item(by_id[i]) for i in out if i in by_id]
    finally:
        await db.close()


# ── Browse ───────────────────────────────────────────────────────────────────

@router.get("/items", response_model=list[GtdItemModel])
async def list_items(
    view: str = "all",
    q: str = "",
    context: str = "",
    project_id: str = "",
    source: str = "",          # "" all sources | "local" | "synced"
    limit: int = 500,
    user: UserContext = Depends(get_current_user),
):
    where = VIEW_WHERE.get(view)
    if where is None:
        raise HTTPException(status_code=400, detail=f"Unknown view: {view}")
    params: dict[str, Any] = {"uid": _uid(user), "limit": max(1, min(limit, 1000))}
    clauses = ["i.user_id = :uid", where]
    # Soft-deleted rows never surface in any view (including Archive).
    clauses.append(_DELETED_EXCLUDE)
    # Subtasks are nested under their parent in the detail panel — they never
    # appear as standalone rows in the list/board views.
    clauses.append("i.parent_item_id IS NULL")
    # Every active view hides archived rows; only the archive view shows them.
    if view != "archive":
        clauses.append(_ARCHIVE_EXCLUDE)
    if q.strip():
        clauses.append("(i.title ILIKE :q OR coalesce(i.description,'') ILIKE :q)")
        params["q"] = f"%{q.strip()}%"
    if context.strip():
        clauses.append("i.context = :ctx")
        params["ctx"] = context.strip()
    if project_id.strip():
        clauses.append("i.project_id = :pid")
        params["pid"] = project_id.strip()
    # Source filter (the "Mine only / All" toggle): LOCAL rows are ours,
    # everything else is a mirrored PM tool.
    src = source.strip().lower()
    if src == "local":
        clauses.append("i.source = 'LOCAL'")
    elif src == "synced":
        clauses.append("i.source <> 'LOCAL'")
    db = await _get_db()
    try:
        # LOCAL (unprocessed / ours) rows ALWAYS sort first, so a large synced
        # mirror can never push our own captures past the row cap — the Inbox
        # invariant ("unprocessed items are always visible") holds regardless of
        # how many tasks a connected workspace imports. Within each group,
        # manually-ranked rows (a drag set sort_key) come first in rank order;
        # everything else falls back to newest-first.
        rows = (await db.execute(
            text(ITEM_SELECT + " WHERE " + " AND ".join(clauses)
                 + " ORDER BY (i.source = 'LOCAL') DESC,"
                 + " i.sort_key ASC NULLS LAST, i.created_at DESC"
                 + " LIMIT :limit"),
            params,
        )).fetchall()
        return [_row_to_item(r) for r in rows]
    finally:
        await db.close()


@router.get("/projects", response_model=list[GtdProjectModel])
async def list_projects(user: UserContext = Depends(get_current_user)):
    db = await _get_db()
    try:
        rows = (await db.execute(
            text(PROJECT_SELECT + " WHERE p.user_id = :uid "
                 "ORDER BY p.source, p.created_at DESC"),
            {"uid": _uid(user)},
        )).fetchall()
        return [_row_to_project(r) for r in rows]
    finally:
        await db.close()


@router.get("/contexts")
async def list_contexts(user: UserContext = Depends(get_current_user)):
    """The user's @ lists — seeded with the GTD defaults on first read."""
    db = await _get_db()
    try:
        for i, (name, icon) in enumerate(DEFAULT_CONTEXTS):
            await db.execute(
                text("""INSERT INTO gtd_contexts (user_id, name, icon, sort_order)
                        VALUES (:uid, :name, :icon, :ord)
                        ON CONFLICT (user_id, name) DO NOTHING"""),
                {"uid": _uid(user), "name": name, "icon": icon, "ord": i},
            )
        await db.commit()
        rows = (await db.execute(
            text("""SELECT name, icon FROM gtd_contexts
                    WHERE user_id = :uid ORDER BY sort_order, name"""),
            {"uid": _uid(user)},
        )).fetchall()
        return {"contexts": [{"name": r.name, "icon": r.icon} for r in rows]}
    finally:
        await db.close()


@router.get("/items/{item_id}", response_model=GtdItemModel)
async def get_item(item_id: str, user: UserContext = Depends(get_current_user)):
    db = await _get_db()
    try:
        return _row_to_item(await _fetch_item(db, item_id, _uid(user)))
    finally:
        await db.close()


@router.delete("/items/{item_id}", status_code=204)
async def delete_item(item_id: str, user: UserContext = Depends(get_current_user)):
    """SOFT-delete an item: set deleted_at so it vanishes from every view but
    stays fully intact (provider linkage, notes, disposition) for a lossless
    Undo. The row is only physically removed — and a SYNCED task's upstream
    ClickUp task deleted — by an explicit purge (POST /items/{id}/purge) once
    the client's undo window has passed. Idempotent: re-deleting a tombstoned
    row just refreshes the timestamp."""
    db = await _get_db()
    try:
        res = (await db.execute(
            text("""UPDATE gtd_items
                    SET deleted_at = now(), updated_at = now()
                    WHERE id = :id AND user_id = :uid RETURNING id"""),
            {"id": item_id, "uid": _uid(user)},
        )).fetchone()
        if res is None:
            raise HTTPException(status_code=404, detail="Item not found")
        await db.commit()
    finally:
        await db.close()


@router.post("/items/{item_id}/restore", response_model=GtdItemModel)
async def restore_item(item_id: str, user: UserContext = Depends(get_current_user)):
    """Undo a soft delete: clear deleted_at so the task returns to its view,
    exactly as it was (nothing was touched upstream). 404 if there's no
    soft-deleted row with this id (already purged, or never deleted)."""
    uid = _uid(user)
    db = await _get_db()
    try:
        res = (await db.execute(
            text("""UPDATE gtd_items
                    SET deleted_at = NULL, updated_at = now()
                    WHERE id = :id AND user_id = :uid
                      AND deleted_at IS NOT NULL RETURNING id"""),
            {"id": item_id, "uid": uid},
        )).fetchone()
        if res is None:
            raise HTTPException(status_code=404, detail="No deleted item to restore")
        await db.commit()
        return _row_to_item(await _fetch_item(db, item_id, uid))
    finally:
        await db.close()


@router.post("/items/{item_id}/purge", status_code=204)
async def purge_item(item_id: str, user: UserContext = Depends(get_current_user)):
    """Finalize a delete: physically remove the (already soft-deleted) row and,
    for a pushed SYNCED task, propagate the deletion to the connected tool. The
    client calls this after the undo window closes. Idempotent — a row that's
    already gone returns 204.

    The upstream ClickUp DELETE is best-effort and runs BEFORE the local row is
    removed so we still have its provider linkage; an upstream failure logs but
    never blocks the local purge (the user asked to delete — we don't strand the
    task locally because ClickUp hiccuped)."""
    uid = _uid(user)
    db = await _get_db()
    try:
        row = (await db.execute(
            text(ITEM_SELECT + " WHERE i.id = :id AND i.user_id = :uid"),
            {"id": item_id, "uid": uid},
        )).fetchone()
        if row is None:
            return  # already purged → idempotent success
        # Propagate the deletion upstream for a pushed SYNCED task.
        if row.source != "LOCAL" and row.provider_task_id and row.account_id:
            await _delete_upstream(db, row, uid)
        await db.execute(
            text("DELETE FROM gtd_items WHERE id = :id AND user_id = :uid"),
            {"id": item_id, "uid": uid},
        )
        await db.commit()
    finally:
        await db.close()


async def _delete_upstream(db: Any, row: Any, uid: str) -> None:
    """Best-effort: delete a pushed SYNCED task's counterpart in the connected
    tool. Never raises — a failed upstream delete must not block the local
    purge (mirrors _push_patch_upstream's posture)."""
    try:
        account = await _assert_account_owner(db, str(row.account_id), uid)
        creds = json.loads(_key_store().decrypt(account.credentials_encrypted))
        provider = build_provider(
            account.provider, creds, account.workspace_id, str(account.id))
        await provider.delete_task(str(row.provider_task_id))
    except Exception as exc:  # best-effort — never fail the local purge
        _log.warning("tasks.delete.upstream_failed",
                     item_id=str(row.id)[:12], error=str(exc)[:160])


# ── Small edits (rename / note / tickler / quick-dispose) ────────────────────

def _build_item_update(
    item_id: str, uid: str, patch: ItemPatch,
) -> tuple[list[str], dict[str, Any]]:
    """Translate an ItemPatch into (SET clauses, bound params). Raises 400 on
    an empty title or bad disposition. Extracted so patch_item stays thin."""
    sets: list[str] = []
    params: dict[str, Any] = {"id": item_id, "uid": uid}
    # Simple column → (clause, value) mappings. Each only fires when the field
    # was provided (is not None), so a partial patch touches only what changed.
    simple: list[tuple[Any, str, Any]] = [
        (patch.notes, "description = :notes", patch.notes),
        (patch.next_action, "next_action = :na", patch.next_action),
        (patch.context, "context = :ctx", patch.context),
        (patch.energy, "energy = :energy", patch.energy),
        (patch.time_estimate_mins, "time_estimate_mins = :tem",
         (patch.time_estimate_mins or None)),
        (patch.provider_status, "provider_status = :pstatus",
         (patch.provider_status or None)),
        (patch.workflow_stage, "workflow_stage = :wstage",
         (patch.workflow_stage or None)),
        (patch.sort_key, "sort_key = :sortkey", patch.sort_key),
        # Prioritization matrix flags (local overlay).
        (patch.important, "important = :important", patch.important),
        (patch.leveraged, "leveraged = :leveraged", patch.leveraged),
        (patch.kept_mine, "kept_mine = :kept_mine", patch.kept_mine),
    ]
    keys = ["notes", "na", "ctx", "energy", "tem", "pstatus", "wstage",
            "sortkey", "important", "leveraged", "kept_mine"]
    for (present, clause, value), key in zip(simple, keys, strict=True):
        if present is not None:
            sets.append(clause)
            params[key] = value
    if patch.title is not None:
        if not patch.title.strip():
            raise HTTPException(status_code=400, detail="Title cannot be empty")
        sets.append("title = :title")
        params["title"] = patch.title.strip()
    if patch.disposition is not None:
        if patch.disposition not in DISPOSITIONS:
            raise HTTPException(status_code=400,
                                detail=f"Bad disposition: {patch.disposition}")
        sets.append("disposition = :disp")
        params["disp"] = patch.disposition
        if patch.disposition == "DONE":
            sets.append("completed_at = now()")
        if patch.disposition != "INBOX":
            sets.append("clarified_at = coalesce(clarified_at, now())")
    if patch.defer_until is not None:
        sets.append("defer_until = :defer")
        params["defer"] = _parse_ts(patch.defer_until)  # "" → None → clears
    if patch.due_at is not None:
        sets.append("due_at = :due")
        params["due"] = _parse_ts(patch.due_at)
    if patch.clear_assignee:
        sets.append("assignee = NULL")
    elif patch.assignee is not None:
        sets.append("assignee = :assignee")
        params["assignee"] = json.dumps(patch.assignee.model_dump())
    # Personal "My Next Actions" membership — a LOCAL overlay (My Next Actions =
    # NEXT & is_mine). Lets the user drop a task they've handed off/unassigned
    # from their own list without deleting it upstream; never back-synced.
    if patch.is_mine is not None:
        sets.append("is_mine = :is_mine")
        params["is_mine"] = patch.is_mine
    if patch.attachments is not None:
        sets.append("attachments = :atts")
        params["atts"] = json.dumps(patch.attachments) or None
    if not sets:
        raise HTTPException(status_code=400, detail="No fields to update")
    sets.append("updated_at = now()")
    return sets, params


@router.patch("/items/{item_id}", response_model=GtdItemModel)
async def patch_item(
    item_id: str,
    patch: ItemPatch,
    user: UserContext = Depends(get_current_user),
):
    from gateway.routes.tasks.settings import gtd_workflow_stages
    db = await _get_db()
    try:
        # Moving a card to the LAST configured stage ("done" stage) also marks
        # the task DONE (disposition + completed_at + ClickUp close).
        if patch.workflow_stage and patch.disposition is None:
            stages = await gtd_workflow_stages(db, _uid(user))
            if stages and patch.workflow_stage == stages[-1]:
                patch.disposition = "DONE"
        sets, params = _build_item_update(item_id, _uid(user), patch)
        # Snapshot the row BEFORE the write — we need the prior assignee id to
        # build ClickUp's assignee add/rem delta, and provider linkage.
        before = await _fetch_item(db, item_id, _uid(user))
        if not before:
            raise HTTPException(status_code=404, detail="Item not found")
        res = (await db.execute(
            text(f"UPDATE gtd_items SET {', '.join(sets)} "
                 "WHERE id = :id AND user_id = :uid RETURNING id"),
            params,
        )).fetchone()
        if not res:
            raise HTTPException(status_code=404, detail="Item not found")
        await db.commit()
        # Back-sync the edit to the connected tool (SYNCED tasks only). Runs
        # AFTER the local commit and is best-effort: the user's edit is already
        # saved, so an upstream hiccup logs but never loses the edit.
        await _push_patch_upstream(db, before, patch, _uid(user))
        return _row_to_item(await _fetch_item(db, item_id, _uid(user)))
    finally:
        await db.close()


async def _status_for_stage(
    provider: Any, provider_task_id: str, stage: str,
    status_stage_map: dict[str, str],
) -> str | None:
    """Reverse the status→stage map for ONE task: find a status in THIS task's
    own ClickUp project whose mapping equals `stage`, so a board drag into a
    local stage writes a concrete upstream status. Returns None when the task's
    project has no status mapped to that stage (→ caller keeps the move local).
    When several of the project's statuses map to the stage, the first in the
    project's own order wins (stable + predictable)."""
    try:
        statuses = await provider.list_statuses_for_task(provider_task_id)
    except Exception:
        return None
    for s in statuses:
        if status_stage_map.get((s or "").strip().lower()) == stage:
            return s
    return None


async def _build_upstream_payload(
    db: Any, before: Any, patch: ItemPatch, uid: str,
    provider: Any, marks_done: bool,
) -> dict[str, Any]:
    """Assemble the ClickUp update payload from a patch (extracted to keep
    _push_patch_upstream flat). Translates a Next-Actions stage move into a
    concrete upstream status for THIS task's project (or leaves it out — local
    only — when nothing maps)."""
    from gateway.routes.tasks.settings import gtd_status_stage_map
    payload: dict[str, Any] = {}
    if patch.title is not None:
        payload["title"] = patch.title.strip()
    if patch.notes is not None:
        payload["description"] = patch.notes
    if patch.provider_status is not None:
        payload["status"] = patch.provider_status
    # Board drag → local stage: resolve THIS task's project status for it. Not
    # for the "done" stage (marks_done already closes it via mark_done).
    if (patch.workflow_stage is not None and "status" not in payload
            and not marks_done):
        mapped = await _status_for_stage(
            provider, str(before.provider_task_id), patch.workflow_stage,
            await gtd_status_stage_map(db, uid))
        if mapped:
            payload["status"] = mapped
    if patch.due_at is not None:
        due = _parse_ts(patch.due_at)
        payload["due_at_ms"] = int(due.timestamp() * 1000) if due else None
    if marks_done:
        payload["mark_done"] = True
    prev = _parse_jsonb(before.assignee) or {}
    if patch.clear_assignee:
        payload["clear_assignee"] = True
        payload["prev_assignee_id"] = prev.get("provider_user_id")
    elif patch.assignee is not None:
        payload["assignee_id"] = patch.assignee.provider_user_id
        payload["prev_assignee_id"] = prev.get("provider_user_id")
    return payload


async def _push_patch_upstream(
    db: Any, before: Any, patch: ItemPatch, uid: str,
) -> None:
    """Back-sync a PATCH to the connected PM tool for a SYNCED, already-pushed
    task. No-op for LOCAL/pending items. Best-effort — never raises to the
    caller (a failed upstream write must not undo the saved local edit)."""
    if before.source == "LOCAL" or not before.provider_task_id \
            or not before.account_id:
        return
    # Only the ClickUp-writable fields warrant a call. A DONE disposition also
    # closes the task upstream. A workflow_stage move on a synced task translates
    # (via the status map) into a concrete upstream status for THIS task's
    # project — unless nothing maps, in which case the move stays local.
    marks_done = patch.disposition == "DONE"
    writable = any(v is not None for v in (
        patch.title, patch.notes, patch.provider_status, patch.due_at,
        patch.workflow_stage,
    )) or patch.assignee is not None or patch.clear_assignee or marks_done
    if not writable:
        return
    try:
        account = await _assert_account_owner(db, str(before.account_id), uid)
        creds = json.loads(_key_store().decrypt(account.credentials_encrypted))
        provider = build_provider(
        account.provider, creds, account.workspace_id, str(account.id))
        payload = await _build_upstream_payload(
            db, before, patch, uid, provider, marks_done)
        result = await provider.update_task(str(before.provider_task_id), payload)
        # Persist the tool's normalized stage/url back onto the mirror.
        upd, uparams = [], {"id": str(before.id)}
        if result.get("provider_status"):
            upd.append("provider_status = :ps")
            uparams["ps"] = result["provider_status"]
        if result.get("provider_url"):
            upd.append("provider_url = :url")
            uparams["url"] = result["provider_url"]
        if upd:
            await db.execute(
                text(f"UPDATE gtd_items SET {', '.join(upd)} WHERE id = :id"),
                uparams,
            )
            await db.commit()
    except Exception as exc:  # best-effort back-sync — never fail the local edit
        _log.warning("tasks.patch.backsync_failed",
                     item_id=str(before.id)[:12], error=str(exc)[:160])


class MergeIntoRequest(BaseModel):
    """Fold an inbox capture INTO an existing PM-tool task (the dedup
    'add to the existing task instead of creating a duplicate' path)."""
    target_id: str


@router.post("/items/{item_id}/merge-into", response_model=GtdItemModel)
async def merge_into_existing(
    item_id: str,
    req: MergeIntoRequest,
    user: UserContext = Depends(get_current_user),
):
    """Merge an inbox capture into an existing SYNCED task rather than creating
    a duplicate: append the capture's title + notes to the target task's
    description, back-sync that to the connected tool, then trash the capture.
    Powers the 'a similar task already exists on ClickUp → add to it' choice."""
    uid = _uid(user)
    if str(req.target_id) == str(item_id):
        raise HTTPException(status_code=400,
                            detail="Cannot merge an item into itself")
    db = await _get_db()
    try:
        source = await _fetch_item(db, item_id, uid)
        target = await _fetch_item(db, req.target_id, uid)
        if not source or not target:
            raise HTTPException(status_code=404, detail="Item not found")
        if target.source == "LOCAL":
            raise HTTPException(status_code=400,
                                detail="Target is not a synced task")
        # Compose the appended note: the capture's title + its own notes.
        addition = (source.title or "").strip()
        src_notes = (getattr(source, "description", None) or "").strip()
        if src_notes:
            addition = f"{addition}\n{src_notes}" if addition else src_notes
        prev = (getattr(target, "description", None) or "").strip()
        merged = f"{prev}\n\n---\n{addition}".strip() if prev else addition
        await db.execute(
            text("""UPDATE gtd_items SET description = :d, updated_at = now()
                    WHERE id = :id AND user_id = :uid"""),
            {"d": merged, "id": req.target_id, "uid": uid},
        )
        # The capture is absorbed — trash it (hidden from views, recoverable).
        await db.execute(
            text("""UPDATE gtd_items SET disposition = 'TRASH', updated_at = now()
                    WHERE id = :id AND user_id = :uid"""),
            {"id": item_id, "uid": uid},
        )
        await db.commit()
        # Best-effort: push the enriched description upstream to the tool.
        await _push_patch_upstream(db, target, ItemPatch(notes=merged), uid)
        return _row_to_item(await _fetch_item(db, req.target_id, uid))
    finally:
        await db.close()


class FileUnderRequest(BaseModel):
    """File an inbox capture as a SUB-STEP of an existing task (the clarify
    'this is a step of X' path)."""
    parent_id: str


@router.post("/items/{item_id}/file-under", response_model=GtdItemModel)
async def file_under_parent(
    item_id: str,
    req: FileUnderRequest,
    user: UserContext = Depends(get_current_user),
):
    """Convert an inbox capture INTO a subtask of an existing task. The capture
    is re-homed as a NEXT-action child inheriting the parent's project + home;
    a SYNCED parent's new child pushes to ClickUp as a subtask on next push.
    Powers the clarify 'looks like a step of {task}' suggestion."""
    uid = _uid(user)
    if str(req.parent_id) == str(item_id):
        raise HTTPException(status_code=400,
                            detail="Cannot file an item under itself")
    db = await _get_db()
    try:
        await _fetch_item(db, item_id, uid)      # 404 before any writes
        parent = await _fetch_item(db, req.parent_id, uid)
        if parent.parent_item_id:
            raise HTTPException(status_code=400,
                                detail="Target is itself a subtask")
        await db.execute(
            text("""UPDATE gtd_items
                    SET parent_item_id = :pid,
                        disposition = 'NEXT',
                        project_id = :proj,
                        source = :src,
                        account_id = :aid,
                        sync_state = :sync,
                        clarified_at = now(),
                        updated_at = now()
                    WHERE id = :id AND user_id = :uid"""),
            {"pid": req.parent_id,
             "proj": str(parent.project_id) if parent.project_id else None,
             "src": parent.source,
             "aid": str(parent.account_id) if parent.account_id else None,
             "sync": "pending" if parent.source != "LOCAL" else "local",
             "id": item_id, "uid": uid},
        )
        await db.commit()
        return _row_to_item(await _fetch_item(db, req.parent_id, uid))
    finally:
        await db.close()


# ── Archive ──────────────────────────────────────────────────────────────────

class ArchiveRequest(BaseModel):
    archived: bool = True   # false → un-archive (restore to active views)


@router.post("/items/{item_id}/archive", response_model=GtdItemModel)
async def archive_item(
    item_id: str,
    req: ArchiveRequest,
    user: UserContext = Depends(get_current_user),
):
    """Archive (hide from every active view) or un-archive a task. Independent
    of the DONE disposition — you can archive anything and restore it later."""
    uid = _uid(user)
    db = await _get_db()
    try:
        res = (await db.execute(
            text("""UPDATE gtd_items
                    SET archived_at = CASE WHEN :on THEN now() ELSE NULL END,
                        updated_at = now()
                    WHERE id = :id AND user_id = :uid RETURNING id"""),
            {"id": item_id, "uid": uid, "on": req.archived},
        )).fetchone()
        if not res:
            raise HTTPException(status_code=404, detail="Item not found")
        await db.commit()
        return _row_to_item(await _fetch_item(db, item_id, uid))
    finally:
        await db.close()


@router.post("/items/bulk", response_model=list[GtdItemModel])
async def bulk_dispose(
    req: BulkRequest,
    user: UserContext = Depends(get_current_user),
):
    if req.disposition not in DISPOSITIONS:
        raise HTTPException(status_code=400,
                            detail=f"Bad disposition: {req.disposition}")
    db = await _get_db()
    try:
        await db.execute(
            text("""UPDATE gtd_items
                    SET disposition = :disp,
                        clarified_at = coalesce(clarified_at, now()),
                        completed_at = CASE WHEN :disp = 'DONE'
                                            THEN now() ELSE completed_at END,
                        updated_at = now()
                    WHERE id::text = ANY(:ids) AND user_id = :uid"""),
            {"disp": req.disposition, "ids": req.ids, "uid": _uid(user)},
        )
        await db.commit()
        rows = (await db.execute(
            text(ITEM_SELECT + " WHERE i.id::text = ANY(:ids) AND i.user_id = :uid"),
            {"ids": req.ids, "uid": _uid(user)},
        )).fetchall()
        return [_row_to_item(r) for r in rows]
    finally:
        await db.close()


class BulkArchiveRequest(BaseModel):
    ids: list[str]
    archived: bool = True   # false → un-archive the whole selection


@router.post("/items/bulk-archive", response_model=list[GtdItemModel])
async def bulk_archive(
    req: BulkArchiveRequest,
    user: UserContext = Depends(get_current_user),
):
    """Archive (or un-archive) many tasks at once — the multi-select 'Archive
    selected' action. A LOCAL-only overlay, identical to single archive: it
    hides the tasks from active views but never touches the connected tool, so
    it's safe for SYNCED (ClickUp) tasks too."""
    db = await _get_db()
    try:
        await db.execute(
            text("""UPDATE gtd_items
                    SET archived_at = CASE WHEN :on THEN now() ELSE NULL END,
                        updated_at = now()
                    WHERE id::text = ANY(:ids) AND user_id = :uid"""),
            {"ids": req.ids, "on": req.archived, "uid": _uid(user)},
        )
        await db.commit()
        rows = (await db.execute(
            text(ITEM_SELECT + " WHERE i.id::text = ANY(:ids) AND i.user_id = :uid"),
            {"ids": req.ids, "uid": _uid(user)},
        )).fetchall()
        return [_row_to_item(r) for r in rows]
    finally:
        await db.close()


# ── Clarify → organize (the decision applier) ────────────────────────────────

_KIND_TO_DISPOSITION = {
    "next": "NEXT", "calendar": "NEXT", "delegate": "WAITING",
    "someday": "SOMEDAY", "do-now": "DONE", "reference": "REFERENCE",
    "trash": "TRASH", "project": "NEXT",
}


@router.post("/items/{item_id}/organize", response_model=GtdItemModel)
async def organize_item(
    item_id: str,
    req: OrganizeRequest,
    user: UserContext = Depends(get_current_user),
):
    """Apply one clarify decision atomically.

    Destination (§5.1): ``account_id`` empty → LOCAL (we are source of truth);
    set → the item is staged for that workspace as ``sync_state='pending'``
    until the user pushes it (POST /items/{id}/push).
    """
    disposition = _KIND_TO_DISPOSITION.get(req.kind)
    if disposition is None:
        raise HTTPException(status_code=400, detail=f"Unknown kind: {req.kind}")
    if req.kind in ("next", "calendar", "delegate", "project") and not (
        req.next_action or ""
    ).strip():
        raise HTTPException(status_code=400, detail="next_action is required")
    if req.kind == "delegate" and not req.assignee:
        raise HTTPException(status_code=400, detail="assignee is required")
    if req.kind == "project" and not (req.outcome or "").strip():
        raise HTTPException(status_code=400, detail="outcome is required")
    if req.kind == "calendar" and not (req.due_at or "").strip():
        # GTD hard landscape: a calendar decision WITHOUT a date silently
        # produced a hard-date item with no date — invisible on the Calendar
        # view. Refuse with the reason instead.
        raise HTTPException(status_code=400,
                            detail="due_at is required for a calendar decision")

    # Sort→Shape: OWNER is an axis independent of SIZE/WHEN. The legacy
    # `kind="delegate"` always delegates; any other actionable kind (next/
    # project/calendar) ALSO delegates when it carries an `assignee` — so a
    # task can be a project, delegated, with a deadline, all at once. Only the
    # disposition/is_mine/waiting-record logic changes; size (project+
    # subtasks) and when (due_at) are untouched.
    delegated = req.kind == "delegate" or (
        req.kind in ("next", "project", "calendar") and req.assignee is not None
    )
    if delegated:
        disposition = "WAITING"

    uid = _uid(user)
    db = await _get_db()
    try:
        await _fetch_item(db, item_id, uid)  # 404 before any writes

        source, sync_state = "LOCAL", "local"
        if req.account_id:
            await _assert_account_owner(db, req.account_id, uid)
            source, sync_state = "SYNCED", "pending"

        # Delegating to a connected tool means the teammate has to SEE the task
        # there — which needs a list/project to create it in. Refuse up front
        # (before any write) when a synced delegation has no destination project,
        # rather than committing a WAITING row that can never be pushed and
        # strands invisibly (the clarify-delegate gap). `kind="project"` mints a
        # LOCAL project row with no provider_ref, so it can't host a push either.
        if delegated and source == "SYNCED" and (
            req.kind == "project" or not req.project_id
        ):
            raise HTTPException(
                status_code=400,
                detail="Pick a project/list in the workspace to delegate into — "
                       "the tool needs a list to create the task in so your "
                       "teammate can see it.",
            )

        project_id = req.project_id or None
        if req.kind == "project":
            project_id = str(uuid4())
            await db.execute(
                text("""INSERT INTO gtd_projects
                        (id, user_id, source, account_id, outcome, status,
                         has_next_action)
                        VALUES (:id, :uid, :src, :aid, :outcome, 'ACTIVE', true)"""),
                {"id": project_id, "uid": uid, "src": source,
                 "aid": req.account_id, "outcome": req.outcome.strip()},
            )
        elif project_id:
            owned = (await db.execute(
                text("SELECT 1 FROM gtd_projects WHERE id = :id AND user_id = :uid"),
                {"id": project_id, "uid": uid},
            )).fetchone()
            if not owned:
                raise HTTPException(status_code=404, detail="Project not found")

        due = _parse_ts(req.due_at)
        await db.execute(
            text("""UPDATE gtd_items
                    SET disposition = :disp,
                        next_action = :na,
                        context = :ctx,
                        energy = :energy,
                        time_estimate_mins = :mins,
                        is_two_minute = :two_min,
                        project_id = :pid,
                        source = :src,
                        account_id = :aid,
                        sync_state = :sync_state,
                        provider_status = :status,
                        assignee = :assignee,
                        is_mine = :is_mine,
                        due_at = coalesce(:due, due_at),
                        is_hard_date = :hard,
                        completed_at = CASE WHEN :disp = 'DONE'
                                            THEN now() ELSE completed_at END,
                        clarified_at = now(),
                        updated_at = now()
                    WHERE id = :id AND user_id = :uid"""),
            {
                "id": item_id, "uid": uid, "disp": disposition,
                "na": (req.next_action or "").strip() or None,
                "ctx": req.context, "energy": req.energy,
                "mins": req.time_estimate_mins,
                "two_min": req.kind == "do-now",
                "pid": project_id, "src": source, "aid": req.account_id,
                "sync_state": sync_state, "status": req.status,
                "assignee": json.dumps(req.assignee.model_dump())
                if req.assignee else None,
                "is_mine": not delegated,
                "due": due, "hard": req.kind == "calendar",
            },
        )
        if delegated:
            await db.execute(
                text("""INSERT INTO gtd_waiting
                        (item_id, waiting_on, delegated_at, expected_by)
                        VALUES (:iid, :who, now(), :expected)"""),
                {"iid": item_id,
                 "who": json.dumps(req.assignee.model_dump()),
                 "expected": due},
            )
        # Subtasks: clarify a single task INTO concrete child steps. Each becomes
        # a NEXT child gtd_item inheriting the parent's project/home; a SYNCED
        # parent's children push as ClickUp subtasks (see _push_child_subtasks).
        if req.subtasks:
            await _create_subtasks(
                db, uid, item_id, req.subtasks, source, req.account_id,
                project_id, sync_state)
        await db.commit()

        # Delegating to a connected tool auto-pushes so the teammate actually
        # sees it (parity with POST /items/{id}/delegate). Extracted so the tail
        # stays flat.
        pushed = await _maybe_push_delegated(
            db, item_id, uid, delegated=delegated, source=source,
            project_id=project_id)
        return pushed or _row_to_item(await _fetch_item(db, item_id, uid))
    finally:
        await db.close()


async def _maybe_push_delegated(
    db: Any, item_id: str, uid: str, *,
    delegated: bool, source: str, project_id: str | None,
) -> GtdItemModel | None:
    """Auto-push a clarify-delegation to the connected tool so the teammate can
    see it — parity with POST /items/{id}/delegate; a clarify-delegate must not
    stay local-only and invisible upstream. Only fires for a SYNCED delegation
    with a chosen project; a push hiccup (e.g. the project isn't in the tool yet)
    is deferred — the delegation is saved and WAITING with the manual Push
    affordance, never fatal to the clarify. Returns the pushed row, or None to
    signal the caller to return the un-pushed row (staged / not a delegation)."""
    if not (delegated and source == "SYNCED" and project_id):
        return None
    try:
        return await _push_pending_item(db, item_id, uid)
    except HTTPException:
        _log.warning("tasks.organize.delegate_push_deferred",
                     item_id=str(item_id)[:12])
        return None


async def _create_subtasks(
    db: Any, uid: str, parent_id: str, titles: list[str],
    source: str, account_id: str | None, project_id: str | None,
    sync_state: str,
) -> None:
    """Insert child gtd_items under a parent, each a NEXT action inheriting the
    parent's project + home. Ranked by input order so they keep their sequence."""
    rank = 0.0
    for title in titles:
        t = (title or "").strip()
        if not t:
            continue
        await db.execute(
            text("""INSERT INTO gtd_items
                    (id, user_id, parent_item_id, title, next_action,
                     disposition, source, account_id, project_id, sync_state,
                     sort_key, clarified_at)
                    VALUES (:id, :uid, :pid, :title, :title, 'NEXT', :src,
                            :aid, :proj, :sync, :rank, now())"""),
            {"id": str(uuid4()), "uid": uid, "pid": parent_id, "title": t,
             "src": source, "aid": account_id, "proj": project_id,
             "sync": sync_state, "rank": rank},
        )
        rank += 1000.0


# ── Subtasks (children of a clarified task) ──────────────────────────────────

class SubtaskAddRequest(BaseModel):
    titles: list[str]


@router.get("/items/{item_id}/subtasks", response_model=list[GtdItemModel])
async def list_subtasks(
    item_id: str,
    user: UserContext = Depends(get_current_user),
):
    """The child subtasks of a task, in manual order (the detail panel list)."""
    uid = _uid(user)
    db = await _get_db()
    try:
        rows = (await db.execute(
            text(ITEM_SELECT + " WHERE i.parent_item_id = :pid "
                 "AND i.user_id = :uid "
                 "ORDER BY i.sort_key ASC NULLS LAST, i.created_at ASC"),
            {"pid": item_id, "uid": uid},
        )).fetchall()
        return [_row_to_item(r) for r in rows]
    finally:
        await db.close()


@router.post("/items/{item_id}/subtasks", response_model=list[GtdItemModel])
async def add_subtasks(
    item_id: str,
    req: SubtaskAddRequest,
    user: UserContext = Depends(get_current_user),
):
    """Add child subtasks to an existing task (post-clarify edit). Children
    inherit the parent's home; a SYNCED parent's new children push on next
    push. Returns the full, ordered child list."""
    uid = _uid(user)
    titles = [t.strip() for t in req.titles if t.strip()]
    if not titles:
        raise HTTPException(status_code=400, detail="No subtasks to add")
    db = await _get_db()
    try:
        parent = await _fetch_item(db, item_id, uid)
        # Append after the last existing child so order is preserved.
        last = (await db.execute(
            text("""SELECT max(sort_key) AS m FROM gtd_items
                     WHERE parent_item_id = :pid AND user_id = :uid"""),
            {"pid": item_id, "uid": uid},
        )).fetchone()
        base_rank = (last.m + 1000.0) if last and last.m is not None else 0.0
        for offset, title in enumerate(titles):
            await db.execute(
                text("""INSERT INTO gtd_items
                        (id, user_id, parent_item_id, title, next_action,
                         disposition, source, account_id, project_id,
                         sync_state, sort_key, clarified_at)
                        VALUES (:id, :uid, :pid, :title, :title, 'NEXT', :src,
                                :aid, :proj, :sync, :rank, now())"""),
                {"id": str(uuid4()), "uid": uid, "pid": item_id, "title": title,
                 "src": parent.source,
                 "aid": str(parent.account_id) if parent.account_id else None,
                 "proj": str(parent.project_id) if parent.project_id else None,
                 "sync": "pending" if parent.source != "LOCAL" else "local",
                 "rank": base_rank + offset * 1000.0},
            )
        await db.commit()
        rows = (await db.execute(
            text(ITEM_SELECT + " WHERE i.parent_item_id = :pid "
                 "AND i.user_id = :uid "
                 "ORDER BY i.sort_key ASC NULLS LAST, i.created_at ASC"),
            {"pid": item_id, "uid": uid},
        )).fetchall()
        return [_row_to_item(r) for r in rows]
    finally:
        await db.close()


# ── The approved push (staged → provider) ────────────────────────────────────

async def _push_pending_item(db: Any, item_id: str, uid: str) -> Any:
    """Create a staged (sync_state='pending') task in its destination workspace
    and mark it synced. Shared by the manual Push and the delegate-promotion
    path. Commits and returns the refreshed row. Raises 400 with a reason when
    the item isn't in a pushable state (no account, no provider project)."""
    row = await _fetch_item(db, item_id, uid)
    if row.sync_state != "pending" or not row.account_id:
        raise HTTPException(status_code=400,
                            detail="Item has no pending destination")
    account = await _assert_account_owner(db, str(row.account_id), uid)

    project_ref = None
    if row.project_id:
        proj = (await db.execute(
            text("SELECT provider_ref FROM gtd_projects WHERE id = :id"),
            {"id": str(row.project_id)},
        )).fetchone()
        project_ref = proj.provider_ref if proj else None
    if not project_ref:
        raise HTTPException(
            status_code=400,
            detail="Pick a project that exists in the workspace first — "
                   "the tool needs a list/project to create the task in",
        )

    creds = json.loads(_key_store().decrypt(account.credentials_encrypted))
    provider = build_provider(
        account.provider, creds, account.workspace_id, str(account.id))
    assignee = _parse_jsonb(row.assignee) or {}
    due_ms = int(row.due_at.timestamp() * 1000) if row.due_at else None
    # Email-origin items carry their source reference INTO the PM tool so
    # the assignee sees where the task came from (lifecycle-long linkage).
    description = row.description or ""
    origin = _parse_jsonb(getattr(row, "origin", None)) or {}
    if origin.get("kind") == "email":
        ref = (
            f"Captured from email — {origin.get('from_name') or origin.get('from_email') or 'unknown sender'}"
            + (f" <{origin['from_email']}>" if origin.get("from_email") else "")
            + (f": \"{origin['subject']}\"" if origin.get("subject") else "")
        )
        description = (description + "\n\n— " + ref).strip()
    created = await provider.create_task(project_ref, {
        "title": row.next_action or row.title,
        "description": description or None,
        "status": row.provider_status,
        "due_at_ms": due_ms,
        "assignee_id": assignee.get("provider_user_id"),
    })
    parent_tid = created.get("provider_task_id")
    await db.execute(
        text("""UPDATE gtd_items
                SET provider_task_id = :tid, provider_url = :url,
                    provider_status = coalesce(:status, provider_status),
                    sync_state = 'synced', synced_at = now(), updated_at = now()
                WHERE id = :id"""),
        {"id": item_id, "tid": parent_tid,
         "url": created.get("provider_url"),
         "status": created.get("provider_status")},
    )
    # Push any local subtasks as ClickUp subtasks of the just-created parent
    # (best-effort per child — a failed child never rolls back the parent).
    if parent_tid:
        await _push_child_subtasks(
            db, item_id, uid, provider, project_ref, parent_tid)
    await db.commit()
    return _row_to_item(await _fetch_item(db, item_id, uid))


@router.post("/items/{item_id}/push", response_model=GtdItemModel)
async def push_item(
    item_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Create the staged task in its destination workspace — an explicit,
    user-initiated apply (C-04: no autonomous provider writes)."""
    uid = _uid(user)
    db = await _get_db()
    try:
        return await _push_pending_item(db, item_id, uid)
    finally:
        await db.close()


class DelegateRequest(BaseModel):
    """Delegate a LOCAL task to a teammate — it MUST land in the PM tool so the
    assignee actually sees it. Carries the destination the UI picked."""
    assignee: PersonModel
    account_id: str                      # which connected workspace
    project_id: str                      # which project/list in that workspace
    next_action: str | None = None       # optional re-phrase for the delegated ask
    status: str | None = None            # provider stage
    due_at: str | None = None


@router.post("/items/{item_id}/delegate", response_model=GtdItemModel)
async def delegate_item(
    item_id: str,
    req: DelegateRequest,
    user: UserContext = Depends(get_current_user),
):
    """Promote a LOCAL task to a ClickUp task assigned to someone else.

    Assigning a local task to a non-me teammate can't stay local — the teammate
    lives in the PM tool. So we re-home the row onto the chosen workspace/project
    as WAITING (not mine), stage it pending, and push it upstream in one step.
    Already-synced tasks don't use this path: a plain assignee PATCH back-syncs
    to their existing ClickUp task."""
    uid = _uid(user)
    db = await _get_db()
    try:
        row = await _fetch_item(db, item_id, uid)
        if row.source == "SYNCED":
            raise HTTPException(
                status_code=400,
                detail="Already a synced task — change the assignee with PATCH "
                       "(it back-syncs to the existing ClickUp task).")
        await _assert_account_owner(db, req.account_id, uid)
        owned = (await db.execute(
            text("SELECT 1 FROM gtd_projects WHERE id = :id AND user_id = :uid "
                 "AND account_id = :aid"),
            {"id": req.project_id, "uid": uid, "aid": req.account_id},
        )).fetchone()
        if not owned:
            raise HTTPException(status_code=404,
                                detail="Project not found in that workspace")
        due = _parse_ts(req.due_at)
        await db.execute(
            text("""UPDATE gtd_items
                    SET disposition = 'WAITING', is_mine = false,
                        source = 'SYNCED', account_id = :aid, project_id = :pid,
                        assignee = :assignee,
                        next_action = coalesce(:na, next_action, title),
                        provider_status = coalesce(:status, provider_status),
                        due_at = coalesce(:due, due_at),
                        sync_state = 'pending', clarified_at = now(),
                        updated_at = now()
                    WHERE id = :id AND user_id = :uid"""),
            {"id": item_id, "uid": uid, "aid": req.account_id,
             "pid": req.project_id,
             "assignee": json.dumps(req.assignee.model_dump()),
             "na": (req.next_action or "").strip() or None,
             "status": req.status, "due": due},
        )
        # A delegated task is one we're waiting on — open a waiting-for record.
        await db.execute(
            text("""INSERT INTO gtd_waiting
                    (item_id, waiting_on, delegated_at, expected_by)
                    VALUES (:iid, :who, now(), :expected)"""),
            {"iid": item_id, "who": json.dumps(req.assignee.model_dump()),
             "expected": due},
        )
        await db.commit()
        # Now create it in ClickUp assigned to the teammate.
        return await _push_pending_item(db, item_id, uid)
    finally:
        await db.close()


async def _push_child_subtasks(
    db: Any, parent_id: str, uid: str, provider: Any,
    project_ref: str, parent_tid: str,
) -> None:
    """Create the local subtasks of a just-pushed parent as ClickUp subtasks.
    Each child POSTs to the same list with `parent` set; a child that fails is
    left LOCAL (its row keeps parent_item_id) so a later push can retry it."""
    children = (await db.execute(
        text("""SELECT id, title, next_action, description, provider_status
                  FROM gtd_items
                 WHERE parent_item_id = :pid AND user_id = :uid
                   AND (provider_task_id IS NULL OR provider_task_id = '')
                 ORDER BY sort_key ASC NULLS LAST, created_at ASC"""),
        {"pid": parent_id, "uid": uid},
    )).fetchall()
    for c in children:
        try:
            sub = await provider.create_task(project_ref, {
                "title": c.next_action or c.title,
                "description": c.description or None,
                "status": c.provider_status,
                "parent": parent_tid,
            })
        except Exception:
            _log.warning("tasks.push.subtask_failed", child_id=str(c.id))
            continue
        await db.execute(
            text("""UPDATE gtd_items
                    SET provider_task_id = :tid, provider_url = :url,
                        sync_state = 'synced', synced_at = now(),
                        updated_at = now()
                    WHERE id = :id"""),
            {"id": str(c.id), "tid": sub.get("provider_task_id"),
             "url": sub.get("provider_url")},
        )


# ── Rich provider detail (comments / attachments / subtasks) ─────────────────

@router.get("/items/{item_id}/detail")
async def item_detail(
    item_id: str,
    user: UserContext = Depends(get_current_user),
):
    """On-demand rich detail for a SYNCED task's detail panel: the connected
    tool's comments, attachments, and subtasks. Empty sections for a LOCAL task
    or one not yet pushed. Read-only, best-effort — a provider hiccup returns
    empty sections with an ``error`` note rather than failing the panel."""
    uid = _uid(user)
    empty = {"comments": [], "attachments": [], "subtasks": []}
    db = await _get_db()
    try:
        row = await _fetch_item(db, item_id, uid)
        if not row:
            raise HTTPException(status_code=404, detail="Item not found")
        if row.source == "LOCAL" or not row.provider_task_id \
                or not row.account_id:
            return empty
        account = await _assert_account_owner(db, str(row.account_id), uid)
        creds = json.loads(_key_store().decrypt(account.credentials_encrypted))
        provider = build_provider(
        account.provider, creds, account.workspace_id, str(account.id))
        try:
            return await provider.get_task_detail(str(row.provider_task_id))
        except Exception as exc:  # provider hiccup — panel still renders
            _log.warning("tasks.item_detail.failed",
                         item_id=item_id[:12], error=str(exc)[:160])
            return {**empty, "error": "Could not load live detail"}
    finally:
        await db.close()
