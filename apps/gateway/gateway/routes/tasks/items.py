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


class CaptureRequest(BaseModel):
    title: str
    notes: str | None = None
    # Context refs from the capture UI: {kind: file|image|link, name, url,
    # attachment_id?, mime?, size?}. Links need no upload.
    attachments: list[dict] | None = None


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
    attachments: list[dict] | None = None  # replaces the whole list


class OrganizeRequest(BaseModel):
    """One clarify decision — mirrors the UI's ClarifyDecision (§2.2)."""
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


async def _fetch_item(db: Any, item_id: str, user_id: str) -> Any:
    row = (await db.execute(
        text(ITEM_SELECT + " WHERE i.id = :id AND i.user_id = :uid"),
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
                    (id, user_id, title, description, attachments)
                    VALUES (:id, :uid, :title, :notes, :atts)"""),
            {"id": item_id, "uid": _uid(user), "title": title,
             "notes": req.notes,
             "atts": json.dumps(req.attachments) if req.attachments else None},
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
    """Hard-delete an item (undo-capture). Clarified items should be TRASHed
    (kept for review) — deletion is for takebacks of fresh captures."""
    db = await _get_db()
    try:
        res = (await db.execute(
            text("""DELETE FROM gtd_items
                    WHERE id = :id AND user_id = :uid RETURNING id"""),
            {"id": item_id, "uid": _uid(user)},
        )).fetchone()
        if res is None:
            raise HTTPException(status_code=404, detail="Item not found")
        await db.commit()
    finally:
        await db.close()


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
    ]
    keys = ["notes", "na", "ctx", "energy", "tem", "pstatus", "wstage", "sortkey"]
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
    # closes the task upstream.
    marks_done = patch.disposition == "DONE"
    writable = any(v is not None for v in (
        patch.title, patch.notes, patch.provider_status, patch.due_at,
    )) or patch.assignee is not None or patch.clear_assignee or marks_done
    if not writable:
        return
    try:
        account = await _assert_account_owner(db, str(before.account_id), uid)
        creds = json.loads(_key_store().decrypt(account.credentials_encrypted))
        provider = build_provider(account.provider, creds, account.workspace_id)
        payload: dict[str, Any] = {}
        if patch.title is not None:
            payload["title"] = patch.title.strip()
        if patch.notes is not None:
            payload["description"] = patch.notes
        if patch.provider_status is not None:
            payload["status"] = patch.provider_status
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

    uid = _uid(user)
    db = await _get_db()
    try:
        await _fetch_item(db, item_id, uid)  # 404 before any writes

        source, sync_state = "LOCAL", "local"
        if req.account_id:
            await _assert_account_owner(db, req.account_id, uid)
            source, sync_state = "SYNCED", "pending"

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
                "is_mine": req.kind != "delegate",
                "due": due, "hard": req.kind == "calendar",
            },
        )
        if req.kind == "delegate":
            await db.execute(
                text("""INSERT INTO gtd_waiting
                        (item_id, waiting_on, delegated_at, expected_by)
                        VALUES (:iid, :who, now(), :expected)"""),
                {"iid": item_id,
                 "who": json.dumps(req.assignee.model_dump()),
                 "expected": due},
            )
        await db.commit()
        return _row_to_item(await _fetch_item(db, item_id, uid))
    finally:
        await db.close()


# ── The approved push (staged → provider) ────────────────────────────────────

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
        provider = build_provider(account.provider, creds, account.workspace_id)
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
        await db.execute(
            text("""UPDATE gtd_items
                    SET provider_task_id = :tid, provider_url = :url,
                        provider_status = coalesce(:status, provider_status),
                        sync_state = 'synced', synced_at = now(), updated_at = now()
                    WHERE id = :id"""),
            {"id": item_id, "tid": created.get("provider_task_id"),
             "url": created.get("provider_url"),
             "status": created.get("provider_status")},
        )
        await db.commit()
        return _row_to_item(await _fetch_item(db, item_id, uid))
    finally:
        await db.close()


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
        provider = build_provider(account.provider, creds, account.workspace_id)
        try:
            return await provider.get_task_detail(str(row.provider_task_id))
        except Exception as exc:  # provider hiccup — panel still renders
            _log.warning("tasks.item_detail.failed",
                         item_id=item_id[:12], error=str(exc)[:160])
            return {**empty, "error": "Could not load live detail"}
    finally:
        await db.close()
