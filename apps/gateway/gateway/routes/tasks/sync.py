"""Tasks · sync — pull existing provider tasks into the GTD mirror (§9.3 #1).

Until now sync was push-only: locally clarified items could be pushed to a
connected workspace, but the tasks that ALREADY live there never appeared in
CommandCenter. This module adds the pull:

  POST /tasks/sync {account_id?, full?}
    → for one account (or every sync-enabled account of the user), pull the
      workspace's tasks through the provider interface layer and upsert them
      into ``gtd_items`` as SYNCED rows. Incremental by default (provider
      ``updated_since_ms`` cursor stored in ``task_accounts.last_delta_token``);
      ``full=true`` re-pulls everything.

GTD lens applied to NEW pulled rows (the reverse of the push mapping P7 —
someday→Backlog / actioned→To-do):

  closed in the tool          → DONE (completed_at from the tool)
  backlog-ish stage           → SOMEDAY
  assigned to me              → NEXT      (actioned in the tool = clarified)
  assigned to someone else    → WAITING   (+ open ``gtd_waiting`` record,
                                           is_mine=false — a monitored task)
  unassigned                  → NEXT, is_mine=false (team pool, not my list)

Re-syncs only refresh the MIRRORED fields (title, description, stage,
assignee, due, completion) — the user's GTD overlay (context, energy,
project refile, a deliberate disposition) is never clobbered. The one
exception is completion state, where the provider is the source of truth
for SYNCED rows (§5.1): closed upstream forces DONE; reopened upstream
un-DONEs back to the mapped open disposition.

Read-only toward the provider (constraint C-04 untouched: the only upstream
write remains the explicit ``POST /items/{id}/push``).
"""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.tasks.core import (
    _assert_account_owner,
    _get_db,
    _key_store,
    _log,
    _uid,
    router,
)
from gateway.routes.tasks.providers import build_provider
from pydantic import BaseModel
from sqlalchemy import text

# Stage names that read as "parked / not actioned yet" across PM tools.
_BACKLOG_STAGES = ("backlog", "icebox", "someday", "later", "parked", "on hold")


class SyncRequest(BaseModel):
    account_id: str | None = None   # None → every sync-enabled account
    full: bool = False              # ignore the incremental cursor


class AccountSyncResult(BaseModel):
    account_id: str
    label: str = ""
    pulled: int = 0                 # tasks returned by the provider
    created: int = 0                # new gtd_items rows
    updated: int = 0                # existing rows refreshed
    completed: int = 0              # rows flipped to DONE this run
    error: str | None = None


def map_pulled_task(task: dict[str, Any], my_provider_id: str) -> dict[str, Any]:
    """Pure GTD mapping for ONE pulled provider task (unit-tested).

    Returns the fields the upsert binds: disposition, is_mine, assignee
    (JSON-ready dict or None), completed_at_ms, waiting_on (dict or None —
    set only for the WAITING case).
    """
    assignees = task.get("assignees") or []
    mine = any(
        str(a.get("provider_user_id") or "") == str(my_provider_id or "")
        for a in assignees
    ) if my_provider_id else False

    closed = bool(task.get("closed_at_ms")) or (
        (task.get("status_type") or "").lower() in ("closed", "done")
    )
    stage = (task.get("status") or "").lower()
    backlogish = any(b in stage for b in _BACKLOG_STAGES)

    # Prefer me among the assignees for the display assignee; else the first.
    assignee = None
    if assignees:
        assignee = next(
            (a for a in assignees
             if str(a.get("provider_user_id") or "") == str(my_provider_id or "")),
            assignees[0],
        )

    if closed:
        disposition = "DONE"
    elif backlogish:
        disposition = "SOMEDAY"
    elif assignees and not mine:
        disposition = "WAITING"
    else:
        disposition = "NEXT"

    return {
        "disposition": disposition,
        "is_mine": mine,
        "assignee": assignee,
        "completed_at_ms": task.get("closed_at_ms") if closed else None,
        # A monitored task: record who we're waiting on (drives gtd_waiting).
        "waiting_on": assignee if disposition == "WAITING" else None,
    }


def _dt(ms: Any) -> datetime | None:
    try:
        return datetime.fromtimestamp(int(ms) / 1000, tz=UTC) if ms else None
    except (TypeError, ValueError, OSError):
        return None


_UPSERT_SQL = text("""
    INSERT INTO gtd_items
        (id, user_id, source, account_id, provider_task_id, provider_url,
         title, description, disposition, project_id, provider_status,
         assignee, is_mine, due_at, completed_at, sync_state, synced_at)
    VALUES
        (:id, :uid, 'SYNCED', :aid, :tid, :url,
         :title, :descr, :disp, :pid, :status,
         :assignee, :mine, :due, :completed, 'synced', now())
    ON CONFLICT (account_id, provider_task_id) WHERE source <> 'LOCAL'
    DO UPDATE SET
        title           = EXCLUDED.title,
        description     = coalesce(EXCLUDED.description, gtd_items.description),
        provider_url    = coalesce(EXCLUDED.provider_url, gtd_items.provider_url),
        provider_status = EXCLUDED.provider_status,
        assignee        = EXCLUDED.assignee,
        is_mine         = EXCLUDED.is_mine,
        due_at          = EXCLUDED.due_at,
        completed_at    = EXCLUDED.completed_at,
        -- Provider owns completion for SYNCED rows; the user owns the rest of
        -- the GTD overlay, so an open task keeps its current disposition
        -- unless the row was DONE and got reopened upstream.
        disposition = CASE
            WHEN EXCLUDED.completed_at IS NOT NULL THEN 'DONE'
            WHEN gtd_items.disposition = 'DONE'
                 AND EXCLUDED.completed_at IS NULL THEN EXCLUDED.disposition
            ELSE gtd_items.disposition
        END,
        project_id  = coalesce(gtd_items.project_id, EXCLUDED.project_id),
        sync_state  = 'synced',
        synced_at   = now(),
        updated_at  = now()
    RETURNING id, (xmax = 0) AS inserted, disposition, completed_at
""")


async def _sync_account(db: Any, account: Any, *, full: bool) -> AccountSyncResult:
    """Pull one account's tasks and upsert the mirror. Commits on success."""
    result = AccountSyncResult(account_id=str(account.id),
                               label=account.label or "")
    creds = json.loads(_key_store().decrypt(account.credentials_encrypted))
    provider = build_provider(account.provider, creds, account.workspace_id)

    # Whose list is "mine": the identity that connected this workspace.
    identity = await provider.verify()
    my_id = str((identity.get("user") or {}).get("provider_user_id") or "")

    # Incremental cursor: epoch-ms of the previous sync start (safe overlap).
    since_ms: int | None = None
    if not full and account.last_delta_token:
        try:
            since_ms = int(account.last_delta_token)
        except ValueError:
            since_ms = None
    run_started_ms = int(time.time() * 1000)

    tasks = await provider.list_tasks(account.workspace_id,
                                      updated_since_ms=since_ms)
    result.pulled = len(tasks)

    # provider list/project ref → mirrored gtd_projects id (for linkage).
    proj_rows = (await db.execute(
        text("""SELECT id, provider_ref FROM gtd_projects
                WHERE account_id = :aid AND source <> 'LOCAL'"""),
        {"aid": str(account.id)},
    )).fetchall()
    project_by_ref = {r.provider_ref: str(r.id) for r in proj_rows
                      if r.provider_ref}

    for task in tasks:
        tid = task.get("provider_task_id")
        if not tid:
            continue
        mapped = map_pulled_task(task, my_id)
        row = (await db.execute(_UPSERT_SQL, {
            "id": str(uuid4()),
            "uid": account.user_id,
            "aid": str(account.id),
            "tid": tid,
            "url": task.get("provider_url"),
            "title": task.get("title") or "Untitled",
            "descr": task.get("description"),
            "disp": mapped["disposition"],
            "pid": project_by_ref.get(task.get("project_ref")),
            "status": task.get("status"),
            "assignee": json.dumps(mapped["assignee"])
            if mapped["assignee"] else None,
            "mine": mapped["is_mine"],
            "due": _dt(task.get("due_at_ms")),
            "completed": _dt(mapped["completed_at_ms"]),
        })).fetchone()

        if row.inserted:
            result.created += 1
        else:
            result.updated += 1

        if row.completed_at is not None:
            result.completed += 1
            # A finished task can't be waited on — resolve open records.
            await db.execute(
                text("""UPDATE gtd_waiting SET resolved = true
                        WHERE item_id = :iid AND resolved = false"""),
                {"iid": str(row.id)},
            )
        elif row.disposition == "WAITING" and mapped["waiting_on"]:
            # Monitored task (assigned to someone else): keep exactly one
            # open waiting-for record pointing at the current assignee.
            await db.execute(
                text("""INSERT INTO gtd_waiting
                            (item_id, waiting_on, delegated_at, expected_by)
                        SELECT :iid, :who, :delegated, :expected
                        WHERE NOT EXISTS (SELECT 1 FROM gtd_waiting
                                          WHERE item_id = :iid
                                            AND resolved = false)"""),
                {"iid": str(row.id),
                 "who": json.dumps(mapped["waiting_on"]),
                 "delegated": _dt(task.get("created_at_ms"))
                 or datetime.now(tz=UTC),
                 "expected": _dt(task.get("due_at_ms"))},
            )

    await db.execute(
        text("""UPDATE task_accounts
                SET sync_status = 'idle', sync_error = NULL,
                    last_synced_at = now(), last_delta_token = :cursor,
                    updated_at = now()
                WHERE id = :id"""),
        {"id": str(account.id), "cursor": str(run_started_ms)},
    )
    await db.commit()
    return result


@router.post("/sync", response_model=list[AccountSyncResult])
async def sync_tasks(
    req: SyncRequest,
    user: UserContext = Depends(get_current_user),
):
    """Pull provider tasks into the GTD mirror for one or all accounts.

    Sequential per account (a user has a handful of workspaces, and the
    provider rate limits are per token anyway). One account failing records
    its error on the account row and in the response — it doesn't abort the
    other accounts' syncs.
    """
    uid = _uid(user)
    db = await _get_db()
    try:
        if req.account_id:
            rows = [await _assert_account_owner(db, req.account_id, uid)]
        else:
            rows = (await db.execute(
                text("""SELECT * FROM task_accounts
                        WHERE user_id = :uid AND sync_enabled = true
                        ORDER BY created_at"""),
                {"uid": uid},
            )).fetchall()
        if not rows:
            raise HTTPException(status_code=400,
                                detail="No sync-enabled accounts to sync")

        results: list[AccountSyncResult] = []
        for account in rows:
            await db.execute(
                text("""UPDATE task_accounts SET sync_status = 'syncing',
                        updated_at = now() WHERE id = :id"""),
                {"id": str(account.id)},
            )
            await db.commit()
            try:
                results.append(await _sync_account(db, account, full=req.full))
            except Exception as exc:
                await db.rollback()
                msg = str(getattr(exc, "detail", None) or exc)[:500]
                _log.warning("tasks.sync.account_failed",
                             account_id=str(account.id)[:12], error=msg)
                await db.execute(
                    text("""UPDATE task_accounts SET sync_status = 'error',
                            sync_error = :e, updated_at = now()
                            WHERE id = :id"""),
                    {"id": str(account.id), "e": msg},
                )
                await db.commit()
                results.append(AccountSyncResult(
                    account_id=str(account.id),
                    label=account.label or "", error=msg,
                ))
        return results
    finally:
        await db.close()
