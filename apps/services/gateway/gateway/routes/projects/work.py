"""Projects · work — start, pause, resume, complete, block, hand off.

Spec: ``project-docs/specs/project_management_app.md`` (WS-27) · owner brief
2026-08-12 §§12-17 · migration 171 · rules in ``operations.py``.

    POST   /projects/tasks/{task_id}/work/start
    POST   /projects/tasks/{task_id}/work/pause
    POST   /projects/tasks/{task_id}/work/complete
    GET    /projects/work/current
    GET    /projects/tasks/{task_id}/work/sessions

    POST   /projects/tasks/{task_id}/blockers
    GET    /projects/tasks/{task_id}/blockers
    POST   /projects/blockers/{blocker_id}/resolve

    PUT    /projects/tasks/{task_id}/next-action
    POST   /projects/tasks/{task_id}/handoff

**The clock is the server's.** Every duration here is derived from stored
timestamps (``operations.elapsed_seconds``), never from a number a client sent,
and ``pm_time_entries.duration_secs`` is a GENERATED column so no handler in
this file *could* write one. That is what makes the timer survive a refresh,
a navigation and a closed laptop: there is nothing client-side to lose.

**Every verb here is three writes, not one**: the lifecycle move (checked), the
time session, and the activity row. A route that did only the first would leave
a project whose status says paused and whose timeline cannot say when, by whom
or why — which is the thing §45 says must be reconstructable six months later.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.projects import operations as ops
from gateway.routes.projects.core import (
    _tenant_session,
    actor,
    apply_status_transition,
    load_visible_task,
    now,
    record_activity,
    require_row,
    resolve_visibility,
    router,
    update_row,
)
from pydantic import BaseModel
from sqlalchemy import text

# ── Payloads ────────────────────────────────────────────────────────────────

class StartIn(BaseModel):
    """Starting is the cheap action — §49 wants one click, so nothing here is
    required. A note is accepted for the case where somebody wants to say what
    they are about to do."""

    remark: str | None = None


class PauseIn(BaseModel):
    reason: str | None = None
    remark: str | None = None
    next_action: str | None = None
    next_action_owner: str | None = None
    expected_resume: str | None = None
    #: Pausing because you are waiting on somebody else raises a blocker in the
    #: same act. Optional: "end of day" is a pause and not a blocker, and
    #: forcing a blocker on every pause is how the Blocked view fills with noise
    #: and stops being read.
    blocker_kind: str | None = None
    blocker_waiting_on: str | None = None


class CompleteIn(BaseModel):
    remark: str | None = None
    deliverable: str | None = None


class BlockerIn(BaseModel):
    kind: str | None = None
    title: str | None = None
    description: str | None = None
    waiting_on: str | None = None
    owner: str | None = None


class ResolveIn(BaseModel):
    resolution: str | None = None
    #: Resolving the last open blocker normally resumes the work. Suppressible,
    #: because "the client answered but the engineer is on leave" is real.
    resume: bool = True


class NextActionIn(BaseModel):
    next_action: str | None = None
    next_action_owner: str | None = None
    next_action_due: str | None = None


class HandoffIn(BaseModel):
    to: str | None = None
    reason: str | None = None
    message: str | None = None
    due: str | None = None
    #: Whether the sender stays on the task. Default False — a handoff that
    #: silently keeps the old owner assigned is the "do not silently change
    #: ownership" failure (§17) wearing the opposite mask.
    keep_me: bool = False


BLOCKER_KINDS: tuple[str, ...] = (
    "client_input", "client_approval", "supplier", "material", "prototype",
    "engineering", "information", "internal_review", "capacity",
    "dependency", "other",
)


# ── Status lookup by category ───────────────────────────────────────────────

async def _status_for(db: Any, task: Any, category: str) -> Any:
    """The status row this project uses for a lifecycle category.

    Statuses are per-project DATA (§3.3), so "pause this" cannot mean a
    hard-coded id — it means "whichever lane this project calls paused". A
    project that has never been given one gets a 422 naming the fix rather than
    a silent no-op, because a Pause button that appears to work and moves
    nothing is worse than one that explains itself.
    """
    row = (await db.execute(
        text(
            "SELECT * FROM pm_task_statuses "
            "WHERE project_id = CAST(:root AS uuid) AND category = :category "
            "ORDER BY position LIMIT 1"
        ),
        {"root": str(task.root_project_id), "category": category},
    )).fetchone()
    if row is None:
        raise HTTPException(
            status_code=422,
            detail=(
                f"This project has no '{category}' status. Add one in the "
                f"project's status settings, then try again."
            ),
        )
    return row


async def _current_category(db: Any, task: Any) -> str:
    status = await require_row(db, "pm_task_statuses", str(task.status_id), "Status")
    return str(status.category)


# ── Sessions ────────────────────────────────────────────────────────────────

async def _open_session(db: Any, who: str) -> Any:
    return (await db.execute(
        text(
            "SELECT * FROM pm_time_entries WHERE actor = :who AND ended_at IS NULL "
            "ORDER BY started_at DESC LIMIT 1"
        ),
        {"who": who},
    )).fetchone()


async def _close_session(
    db: Any, session: Any, *, reason: str | None, remark: str | None,
) -> int:
    """End a session and return its measured length.

    Reads the duration back from the row rather than computing it here: the
    column is GENERATED, so what the database stored IS the number, and
    recomputing it in Python would create a second answer that can disagree.
    """
    row = (await db.execute(
        text(
            "UPDATE pm_time_entries SET ended_at = now(), end_reason = :reason, "
            "remark = :remark WHERE id = CAST(:sid AS uuid) RETURNING duration_secs"
        ),
        {"reason": reason, "remark": remark, "sid": str(session.id)},
    )).fetchone()
    return int(row.duration_secs or 0)


def _session_dict(row: Any, at: Any) -> dict[str, Any]:
    seconds = ops.elapsed_seconds(row.started_at, row.ended_at, at)
    return {
        "id": str(row.id),
        "task_id": str(row.task_id),
        "actor": row.actor,
        "started_at": row.started_at,
        "ended_at": row.ended_at,
        "seconds": seconds,
        "elapsed": ops.format_duration(seconds),
        "running": row.ended_at is None,
        "runaway": ops.is_runaway(row.started_at, row.ended_at, at),
        "end_reason": row.end_reason,
        "remark": row.remark,
    }


# ── Start ───────────────────────────────────────────────────────────────────

@router.post("/tasks/{task_id}/work/start")
async def start_work(
    task_id: str, payload: StartIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Begin (or resume) work. One click, no remark.

    Starting a second task auto-closes the first rather than refusing. The
    database enforces one open session per actor
    (``uq_pm_time_entries_one_open_per_actor``), so the alternative is a 409 the
    user can do nothing useful with — they clicked start on the thing they are
    now doing, and telling them "you are already working on something" is a
    dialog whose only answer is yes.
    """
    who = actor(user)
    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        task = await load_visible_task(db, vis, task_id)

        switched_from = None
        open_session = await _open_session(db, who)
        if open_session is not None:
            if str(open_session.task_id) == str(task.id):
                # Already running on this task. Idempotent — a double click, or
                # two tabs, must not close and reopen the session and lose the
                # elapsed time in between.
                return {
                    "session": _session_dict(open_session, now()),
                    "switched_from": None,
                    "already_running": True,
                }
            switched_from = str(open_session.task_id)
            seconds = await _close_session(
                db, open_session, reason="switched", remark=None,
            )
            await record_activity(
                db, activity_type="work_session", created_by=who,
                task_id=switched_from,
                body=f"Paused after {ops.format_duration(seconds)} (switched task)",
                meta={"action": "paused", "seconds": seconds, "reason": "switched"},
            )

        category = await _current_category(db, task)
        if category != ops.IN_PROGRESS:
            status = await _status_for(db, task, ops.IN_PROGRESS)
            await apply_status_transition(
                db, task, str(status.id), created_by=who, enforce=True,
            )

        session = (await db.execute(
            text(
                "INSERT INTO pm_time_entries (task_id, actor, remark) "
                "VALUES (CAST(:tid AS uuid), :who, :remark) RETURNING *"
            ),
            {"tid": str(task.id), "who": who, "remark": payload.remark},
        )).fetchone()

        await record_activity(
            db, activity_type="work_session", created_by=who, task_id=str(task.id),
            body="Started work", meta={"action": "started"},
        )
        return {
            "session": _session_dict(session, now()),
            "switched_from": switched_from,
            "already_running": False,
        }


# ── Pause ───────────────────────────────────────────────────────────────────

@router.post("/tasks/{task_id}/work/pause")
async def pause_work(
    task_id: str, payload: PauseIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Stop working, and say why. §15.

    The remark is required and enforced by ``operations.check_transition``, not
    by an ``if`` here — so the rule holds for every future caller of the state
    machine rather than for this handler only.
    """
    who = actor(user)
    remark = (payload.remark or "").strip()
    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        task = await load_visible_task(db, vis, task_id)
        # No need to read the current category here: `apply_status_transition`
        # loads it and runs the state machine over it. Reading it twice would
        # be a second answer to the same question, and the one this handler
        # held was already unused.
        blocked = bool(payload.blocker_kind)
        target = ops.BLOCKED if blocked else ops.PAUSED
        status = await _status_for(db, task, target)

        # Checked BEFORE any write, so a rejected pause leaves nothing behind.
        await apply_status_transition(
            db, task, str(status.id), created_by=who, remark=remark, enforce=True,
        )

        seconds = 0
        session = await _open_session(db, who)
        if session is not None and str(session.task_id) == str(task.id):
            seconds = await _close_session(
                db, session, reason=payload.reason or "paused", remark=remark,
            )

        values: dict[str, Any] = {}
        if payload.next_action is not None:
            values["next_action"] = payload.next_action.strip() or None
            values["next_action_owner"] = payload.next_action_owner or who
        if payload.expected_resume:
            values["next_action_due"] = payload.expected_resume
        if values:
            await update_row(db, "pm_tasks", str(task.id), values)

        blocker = None
        if blocked:
            if payload.blocker_kind not in BLOCKER_KINDS:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"Unknown blocker kind '{payload.blocker_kind}'. "
                        f"One of: {', '.join(BLOCKER_KINDS)}."
                    ),
                )
            blocker = await _raise_blocker(
                db, task, who,
                kind=str(payload.blocker_kind),
                title=remark or "Blocked",
                description=None,
                waiting_on=payload.blocker_waiting_on,
                owner=who,
            )

        await record_activity(
            db, activity_type="work_session", created_by=who, task_id=str(task.id),
            body=f"{'Blocked' if blocked else 'Paused'}: {remark}",
            meta={
                "action": "blocked" if blocked else "paused",
                "reason": payload.reason,
                "seconds": seconds,
                "next_action": values.get("next_action"),
            },
        )
        return {
            "status": target,
            "seconds": seconds,
            "elapsed": ops.format_duration(seconds),
            "blocker": blocker,
        }


# ── Complete ────────────────────────────────────────────────────────────────

@router.post("/tasks/{task_id}/work/complete")
async def complete_work(
    task_id: str, payload: CompleteIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Finish the work, with a final remark. §16.

    Resolves any open blocker on the way out: work that is done is not still
    waiting on the customer, and a blocker left open on a completed task shows
    up in the Blocked view forever.
    """
    who = actor(user)
    remark = (payload.remark or "").strip()
    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        task = await load_visible_task(db, vis, task_id)
        status = await _status_for(db, task, ops.COMPLETED)

        await apply_status_transition(
            db, task, str(status.id), created_by=who, remark=remark, enforce=True,
        )

        seconds = 0
        session = await _open_session(db, who)
        if session is not None and str(session.task_id) == str(task.id):
            seconds = await _close_session(
                db, session, reason="completed", remark=remark,
            )

        await db.execute(
            text(
                "UPDATE pm_blockers SET resolved_at = now(), resolved_by = :who, "
                "resolution = 'Work completed' "
                "WHERE task_id = CAST(:tid AS uuid) AND resolved_at IS NULL"
            ),
            {"who": who, "tid": str(task.id)},
        )
        # A completed task has no next move; leaving one behind puts it in the
        # "waiting on me" list of whoever owned it.
        await update_row(
            db, "pm_tasks", str(task.id),
            {"next_action": None, "next_action_owner": None, "next_action_due": None},
        )

        total = await _task_total_seconds(db, str(task.id))
        await record_activity(
            db, activity_type="work_session", created_by=who, task_id=str(task.id),
            body=f"Completed: {remark}",
            meta={
                "action": "completed",
                "seconds": seconds,
                "total_seconds": total,
                "deliverable": payload.deliverable,
            },
        )
        return {
            "status": ops.COMPLETED,
            "seconds": seconds,
            "total_seconds": total,
            "total": ops.format_duration(total),
        }


async def _task_total_seconds(db: Any, task_id: str) -> int:
    row = (await db.execute(
        text(
            "SELECT COALESCE(SUM(duration_secs), 0) AS total FROM pm_time_entries "
            "WHERE task_id = CAST(:tid AS uuid) AND ended_at IS NOT NULL"
        ),
        {"tid": task_id},
    )).fetchone()
    return int(row.total or 0)


# ── Reads ───────────────────────────────────────────────────────────────────

@router.get("/work/current")
async def current_work(user: UserContext = Depends(get_current_user)) -> dict:
    """What am I working on right now, and for how long.

    The one read My Work polls. Returns the session plus enough of the task to
    render the header without a second round trip.
    """
    who = actor(user)
    at = now()
    async with _tenant_session() as db:
        session = await _open_session(db, who)
        if session is None:
            return {"session": None, "task": None}
        task = (await db.execute(
            text(
                "SELECT t.id, t.title, t.task_number, p.name AS project_name "
                "FROM pm_tasks t JOIN pm_projects p ON p.id = t.project_id "
                "WHERE t.id = CAST(:tid AS uuid)"
            ),
            {"tid": str(session.task_id)},
        )).fetchone()
        return {
            "session": _session_dict(session, at),
            "task": None if task is None else {
                "id": str(task.id),
                "title": task.title,
                "task_number": task.task_number,
                "project_name": task.project_name,
            },
        }


@router.get("/tasks/{task_id}/work/sessions")
async def list_sessions(
    task_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    at = now()
    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        await load_visible_task(db, vis, task_id)
        rows = (await db.execute(
            text(
                "SELECT * FROM pm_time_entries WHERE task_id = CAST(:tid AS uuid) "
                "ORDER BY started_at DESC"
            ),
            {"tid": task_id},
        )).fetchall()
        total = await _task_total_seconds(db, task_id)
        return {
            "rows": [_session_dict(r, at) for r in rows],
            "total": len(rows),
            "total_seconds": total,
            "total_elapsed": ops.format_duration(total),
        }


# ── Blockers ────────────────────────────────────────────────────────────────

async def _raise_blocker(
    db: Any, task: Any, who: str, *, kind: str, title: str,
    description: str | None, waiting_on: str | None, owner: str | None,
) -> dict[str, Any]:
    row = (await db.execute(
        text(
            "INSERT INTO pm_blockers "
            "(task_id, kind, title, description, waiting_on, owner, created_by) "
            "VALUES (CAST(:tid AS uuid), :kind, :title, :description, "
            "        :waiting_on, :owner, :who) RETURNING *"
        ),
        {
            "tid": str(task.id), "kind": kind, "title": title,
            "description": description, "waiting_on": waiting_on,
            "owner": owner or who, "who": who,
        },
    )).fetchone()
    await record_activity(
        db, activity_type="blocker", created_by=who, task_id=str(task.id),
        body=f"Blocked: {title}",
        meta={
            "action": "raised", "kind": kind, "waiting_on": waiting_on,
            "blocker_id": str(row.id),
        },
    )
    return _blocker_dict(row)


def _blocker_dict(row: Any) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "task_id": str(row.task_id),
        "kind": row.kind,
        "title": row.title,
        "description": row.description,
        "waiting_on": row.waiting_on,
        "owner": row.owner,
        "created_by": row.created_by,
        "created_at": row.created_at,
        "resolved_at": row.resolved_at,
        "resolved_by": row.resolved_by,
        "resolution": row.resolution,
        "open": row.resolved_at is None,
    }


@router.post("/tasks/{task_id}/blockers", status_code=201)
async def create_blocker(
    task_id: str, payload: BlockerIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Raise a blocker, and move the task to blocked.

    Both, always. A blocker without the status move leaves the board saying the
    work is in progress; a status move without the blocker leaves the Blocked
    view unable to say why. They are one act.
    """
    who = actor(user)
    kind = payload.kind or "other"
    if kind not in BLOCKER_KINDS:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown blocker kind '{kind}'. One of: {', '.join(BLOCKER_KINDS)}.",
        )
    title = (payload.title or "").strip()
    if not title:
        raise HTTPException(status_code=422, detail="A blocker needs a title.")

    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        task = await load_visible_task(db, vis, task_id)
        status = await _status_for(db, task, ops.BLOCKED)
        await apply_status_transition(
            db, task, str(status.id), created_by=who, remark=title, enforce=True,
        )
        blocker = await _raise_blocker(
            db, task, who, kind=kind, title=title,
            description=payload.description, waiting_on=payload.waiting_on,
            owner=payload.owner,
        )
        session = await _open_session(db, who)
        if session is not None and str(session.task_id) == str(task.id):
            await _close_session(db, session, reason="blocked", remark=title)
        return blocker


@router.get("/tasks/{task_id}/blockers")
async def list_blockers(
    task_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        await load_visible_task(db, vis, task_id)
        rows = (await db.execute(
            text(
                "SELECT * FROM pm_blockers WHERE task_id = CAST(:tid AS uuid) "
                "ORDER BY resolved_at NULLS FIRST, created_at DESC"
            ),
            {"tid": task_id},
        )).fetchall()
        return {"rows": [_blocker_dict(r) for r in rows], "total": len(rows)}


@router.post("/blockers/{blocker_id}/resolve")
async def resolve_blocker(
    blocker_id: str, payload: ResolveIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Resolve a blocker, and put the work back in progress if it was the last.

    The resolution text is required by the TABLE as well as here
    (``pm_blockers_resolution_check``) — three call paths can resolve a blocker
    and a handler check only covers the one it is in.
    """
    who = actor(user)
    resolution = (payload.resolution or "").strip()
    if not resolution:
        raise HTTPException(
            status_code=422,
            detail="Say how it was resolved — a blocker with no resolution is unreadable later.",
        )
    async with _tenant_session() as db:
        existing = await require_row(db, "pm_blockers", blocker_id, "Blocker")
        vis = await resolve_visibility(db, user)
        task = await load_visible_task(db, vis, str(existing.task_id))
        if existing.resolved_at is not None:
            return _blocker_dict(existing)

        row = (await db.execute(
            text(
                "UPDATE pm_blockers SET resolved_at = now(), resolved_by = :who, "
                "resolution = :resolution WHERE id = CAST(:bid AS uuid) RETURNING *"
            ),
            {"who": who, "resolution": resolution, "bid": blocker_id},
        )).fetchone()
        await record_activity(
            db, activity_type="blocker", created_by=who, task_id=str(task.id),
            body=f"Unblocked: {resolution}",
            meta={"action": "resolved", "kind": row.kind, "blocker_id": blocker_id},
        )

        still_open = (await db.execute(
            text(
                "SELECT count(*) AS n FROM pm_blockers "
                "WHERE task_id = CAST(:tid AS uuid) AND resolved_at IS NULL"
            ),
            {"tid": str(task.id)},
        )).fetchone()
        resumed = False
        if payload.resume and not int(still_open.n):
            current = await _current_category(db, task)
            if current == ops.BLOCKED:
                status = await _status_for(db, task, ops.IN_PROGRESS)
                await apply_status_transition(
                    db, task, str(status.id), created_by=who, enforce=True,
                )
                resumed = True
        return {**_blocker_dict(row), "resumed": resumed,
                "still_blocked_by": int(still_open.n)}


# ── Next action ─────────────────────────────────────────────────────────────

@router.put("/tasks/{task_id}/next-action")
async def set_next_action(
    task_id: str, payload: NextActionIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Set, change or clear the next move. §11.

    A PUT rather than a PATCH because it replaces the whole next action —
    passing ``next_action: null`` clears it, and there is exactly one at a time.
    """
    who = actor(user)
    text_value = (payload.next_action or "").strip() or None
    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        task = await load_visible_task(db, vis, task_id)
        before = task.next_action
        row = await update_row(db, "pm_tasks", str(task.id), {
            "next_action": text_value,
            "next_action_owner": (payload.next_action_owner or who) if text_value else None,
            "next_action_due": payload.next_action_due if text_value else None,
        })
        await record_activity(
            db, activity_type="next_action", created_by=who, task_id=str(task.id),
            body=text_value or "Next action cleared",
            meta={
                "action": "set" if text_value else "cleared",
                "from": before, "to": text_value,
                "owner": row.next_action_owner,
            },
        )
        return {
            "next_action": row.next_action,
            "next_action_owner": row.next_action_owner,
            "next_action_due": row.next_action_due,
        }


# ── Handoff ─────────────────────────────────────────────────────────────────

@router.post("/tasks/{task_id}/handoff")
async def hand_off(
    task_id: str, payload: HandoffIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Hand the work to somebody else, on the record. §17.

    Never silent: the recipient is added as an assignee, the sender is removed
    unless they asked to stay, a ``handoff`` activity names both ends and the
    reason, and the next action becomes the thing the recipient is being asked
    to do. Ownership changing with no trace is the failure this route exists to
    prevent.
    """
    who = actor(user)
    to = (payload.to or "").strip()
    reason = (payload.reason or "").strip()
    if not to:
        raise HTTPException(status_code=422, detail="Name who is taking it on.")
    if not reason:
        raise HTTPException(
            status_code=422,
            detail="A handoff needs a reason — it is the part the recipient reads.",
        )

    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        task = await load_visible_task(db, vis, task_id)

        # Shape copied from `tasks.py:700` rather than reinvented: `assigned_by`
        # is NOT NULL, and the conflict target is the real (task_id, assignee)
        # key. Writing it from memory produced a 500 on the first live run —
        # which is the argument for reading the existing seam, not recalling it.
        await db.execute(
            text(
                "INSERT INTO pm_task_assignees (task_id, assignee, assigned_by) "
                "VALUES (CAST(:tid AS uuid), :who, :by) "
                "ON CONFLICT (task_id, assignee) DO NOTHING"
            ),
            {"tid": str(task.id), "who": to, "by": who},
        )
        if not payload.keep_me:
            await db.execute(
                text(
                    "DELETE FROM pm_task_assignees "
                    "WHERE task_id = CAST(:tid AS uuid) AND assignee = :me"
                ),
                {"tid": str(task.id), "me": who},
            )

        # The handoff IS the next action — "please verify mounting alignment"
        # is what the recipient needs to see, and making them read the timeline
        # for it is how a handoff gets dropped.
        await update_row(db, "pm_tasks", str(task.id), {
            "next_action": payload.message or reason,
            "next_action_owner": to,
            "next_action_due": payload.due,
        })

        # The sender's clock stops. Their session belongs to their work, and
        # leaving it open bills the recipient's time to them.
        session = await _open_session(db, who)
        if session is not None and str(session.task_id) == str(task.id):
            await _close_session(db, session, reason="handoff", remark=reason)

        await record_activity(
            db, activity_type="handoff", created_by=who, task_id=str(task.id),
            body=f"{who} → {to}: {reason}",
            meta={
                "action": "handed_off", "from": who, "to": to,
                "reason": reason, "message": payload.message,
            },
        )
        return {"task_id": str(task.id), "from": who, "to": to, "reason": reason}
