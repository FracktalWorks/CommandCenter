"""Persistent Action Broker handlers for task-provider writes (audit BO-1 / A2).

Registered at gateway startup (see ``main.py``). When ``ACTION_BROKER_ENFORCE``
queues a ClickUp write, approving it in the ``/actions`` inbox calls
``action_broker.execute()``, which dispatches here. We **re-resolve the account's
token** from the ``account_id`` stored in the queued proposal (the token itself
is NEVER persisted) and run the raw provider write — completing the
enqueue → approve → execute loop end-to-end.

Dormant unless enforcement is on: with the kill-switch off (default) nothing is
queued, so these handlers never run.
"""
from __future__ import annotations

import json
from typing import Any

from acb_common import get_logger

_log = get_logger("gateway.tasks.broker_handlers")

# broker action → (raw-writer method on the provider, ordered arg keys in `args`)
_WRITERS: dict[str, tuple[str, tuple[str, ...]]] = {
    "clickup.create_task": ("_raw_create_task", ("project_ref", "body")),
    "clickup.update_task": ("_raw_update_task", ("provider_task_id", "body")),
    "clickup.create_project": (
        "_raw_create_project", ("name", "space_id", "folder_id"),
    ),
}


async def _resolve_provider(account_id: str):
    """Rebuild a provider (with its token) from a ``task_accounts`` id."""
    from gateway.routes.tasks.core import _get_db, _key_store
    from gateway.routes.tasks.providers import build_provider
    from sqlalchemy import text

    db = await _get_db()
    try:
        row = (await db.execute(
            text("SELECT provider, workspace_id, credentials_encrypted "
                 "FROM task_accounts WHERE id = :id"),
            {"id": account_id},
        )).mappings().first()
    finally:
        await db.close()
    if row is None:
        raise RuntimeError(f"task account {account_id} not found")
    creds = json.loads(_key_store().decrypt(row["credentials_encrypted"]))
    return build_provider(
        row["provider"], creds, row["workspace_id"], account_id,
    )


async def _handle_task_write(proposal) -> dict[str, Any]:
    """Execute a queued task write on approval (the registered broker handler)."""
    spec = proposal.payload or {}
    account_id = spec.get("account_id")
    args = spec.get("args") or {}
    entry = _WRITERS.get(proposal.action)
    if entry is None:
        raise RuntimeError(f"no writer for action {proposal.action!r}")
    if not account_id:
        raise RuntimeError(
            f"cannot execute {proposal.action}: no account_id in the queued spec")
    method_name, keys = entry
    provider = await _resolve_provider(account_id)
    writer = getattr(provider, method_name)
    result = await writer(*[args.get(k) for k in keys])
    _log.info(
        "broker.task_write_applied", action=proposal.action, account_id=account_id,
    )
    return result


def register_task_broker_handlers() -> None:
    """Wire the persistent handlers so queued task writes execute on approval.
    Idempotent — safe to call once at startup."""
    from action_broker import register_action_handler

    for action in _WRITERS:
        register_action_handler(action, _handle_task_write)
    _log.info("broker.task_handlers_registered", actions=list(_WRITERS))
