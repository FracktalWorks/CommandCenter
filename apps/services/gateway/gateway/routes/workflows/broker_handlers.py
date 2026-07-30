"""Action Broker handlers owned by the Workflows package.

``workflow.resume_run`` — approving the proposal a paused run filed into the
approvals inbox resumes that run (spec F11). Registered at import time from
``main.py``, mirroring ``routes/tasks/broker_handlers.py``; the flat handler
registry is shared across owners, so the name is namespaced.
"""

from __future__ import annotations

from typing import Any

from acb_common import get_logger

_log = get_logger("gateway.workflows.broker")


async def _resume_run_handler(proposal: Any) -> dict[str, Any]:
    """Broker ``execute`` calls this on approve — resume the paused run."""
    from gateway.routes.workflows.service import resume_run

    payload = getattr(proposal, "payload", None) or {}
    run_id = str(payload.get("run_id") or "")
    if not run_id:
        return {"ok": False, "error": "proposal has no run_id"}
    result = await resume_run(run_id, resumed_by="approvals-inbox")
    _log.info(
        "workflows.approval_resume",
        run_id=run_id,
        ok=result.get("ok"),
        node_id=result.get("node_id"),
    )
    return result


def register_handlers() -> None:
    """Idempotent registration (main.py calls this once at import wiring)."""
    from action_broker.broker import register_action_handler

    register_action_handler("workflow.resume_run", _resume_run_handler)
