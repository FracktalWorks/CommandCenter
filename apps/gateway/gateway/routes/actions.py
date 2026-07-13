"""Action Broker approval inbox API (audit BO-1 / A2).

The operator-facing face of the ``pending_actions`` queue — the outward-write
sibling of the self-mutation approval routes in ``agent.py``. Lists the
proposals the broker is holding for a human and lets an operator approve
(execute) or reject them.

    GET  /actions/pending               → the approval queue (pending, newest first)
    POST /actions/pending/{id}/approve  → run the registered handler via execute()
    POST /actions/pending/{id}/reject   → refuse it; never executed

Every endpoint is gated on ``require_internal_auth`` (the queue payloads carry
outward-write bodies — CRM/email content — so it is never anonymous-reachable).
Approve/reject go through ``action_broker.approve``/``reject``, which fail
CLOSED: a missing or non-pending row is never run, and a handler error marks the
row ``failed``, not ``applied``. The broker ships with **zero** handlers, so
until real ones are registered, ``approve`` returns a refusal ("no handler") —
the queue is visible and auditable but still cannot perform any real write
(non-negotiable #4 stays intact).
"""
from __future__ import annotations

from acb_auth import UserContext, get_current_user, require_internal_auth
from acb_common import get_logger
from fastapi import APIRouter, Depends

_log = get_logger("gateway.actions")

router = APIRouter(prefix="/actions", tags=["actions"])


def _reviewer(user: UserContext | None) -> str:
    """Best-effort human identity for the audit trail."""
    for attr in ("email", "user_email", "name"):
        val = getattr(user, attr, None)
        if val:
            return str(val)
    return "operator"


@router.get("/pending", dependencies=[Depends(require_internal_auth)])
async def list_pending_actions(
    _user: UserContext = Depends(get_current_user),
) -> dict:
    """Return the Action Broker approval queue (pending proposals, newest first)."""
    from action_broker import list_pending

    rows = list_pending()
    return {"pending": rows, "count": len(rows)}


@router.post(
    "/pending/{action_id}/approve", status_code=200,
    dependencies=[Depends(require_internal_auth)],
)
async def approve_action(
    action_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Approve a pending action → the broker executes its registered handler."""
    from action_broker import approve

    res = await approve(action_id, _reviewer(user))
    _log.info(
        "action.approve", action_id=action_id,
        ok=res.get("ok"), status=res.get("status"),
    )
    return res


@router.post(
    "/pending/{action_id}/reject", status_code=200,
    dependencies=[Depends(require_internal_auth)],
)
async def reject_action(
    action_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Reject a pending action — it is never executed."""
    from action_broker import reject

    res = reject(action_id, _reviewer(user))
    _log.info("action.reject", action_id=action_id)
    return res
