"""CRM · broker_handlers — the Action-Broker gate every Zoho push goes through.

Spec: ``ai-company-brain/specs/crm_app.md`` D-CRM-8 · §7.1 · ticket WS-26b
done-when 1 and 5. Modelled 1:1 on the tasks app's ClickUp path —
``routes/tasks/providers.py::_broker_gate`` (the gate) plus
``routes/tasks/broker_handlers.py`` (the persistent handlers registered from
``main.py``) — because that pair is *"the single audited chokepoint for
source-of-truth writes"* and root ``AGENTS.md`` #4 applies to Zoho exactly as
it applies to ClickUp.

Three action names, one per verb: ``crm.zoho_create`` / ``crm.zoho_update`` /
``crm.zoho_delete``.

**Default disposition auto-applies.** With ``ACTION_BROKER_ENFORCE`` off (the
default, and the state of every environment) the broker AUDITS the push and the
write runs immediately — the sync stays continuous. Flipping enforcement on
turns each push into a queued proposal in the ``/actions`` inbox and the sync
becomes *supervised* rather than continuous. That consequence is accepted
deliberately (D-CRM-8), and unlike the ClickUp gate — which routes six action
names through the gate but registers only four handlers, so approving one of
the other two is marked ``failed`` (BO-1a) — **all three CRM actions have a
handler here**, so an approved CRM push really executes.

⚠️ **This module deliberately does not import the writer.** The single-caller
rule (§7.1) says ``ingestion/sources/zoho/writer.py`` has exactly one caller,
the sync engine; an approved queued push therefore re-enters through
``sync_zoho.execute_push`` rather than reaching Zoho from here. Keeping the
writer's import site singular is the property the grep assertion in
``tests/unit/test_crm_zoho_sync.py`` measures.
"""

from __future__ import annotations

import contextlib
import os
from typing import Any

from acb_common import get_logger

_log = get_logger("gateway.crm.broker")

#: The three broker actions a Zoho push can be. Registered as handlers and used
#: as the gate's action names — one list, so a verb cannot be gated without
#: also being executable on approval.
CRM_ZOHO_ACTIONS: tuple[str, ...] = (
    "crm.zoho_create", "crm.zoho_update", "crm.zoho_delete",
)

#: The actor recorded on every proposal and audit row. Never a credential.
BROKER_ACTOR = "crm:zoho-sync"


def broker_enforced(action: str) -> bool:
    """Whether ``ACTION_BROKER_ENFORCE`` routes *action* to the approval QUEUE.

    The SAME environment variable the tasks app reads, on purpose: the owner
    gets one kill-switch for outward writes, not one per app. Unset / ``none``
    / ``off`` → ``False`` → auto-apply. ``1``/``all``/``on`` → queue
    everything. A comma-list queues the named actions only.

    Re-implemented here rather than imported from ``routes/tasks/providers``:
    importing another app package's private helper is the cross-app coupling
    D-CRM-4 rejects, and this is four lines of env parsing.
    """
    raw = (os.environ.get("ACTION_BROKER_ENFORCE") or "").strip().lower()
    if not raw or raw in ("0", "none", "off", "false"):
        return False
    if raw in ("1", "all", "on", "true"):
        return True
    return action in {a.strip() for a in raw.split(",") if a.strip()}


async def broker_gate(
    action: str, target: str, audit_payload: dict[str, Any], do_write: Any,
) -> dict[str, Any]:
    """Route one outward Zoho write through the Action Broker.

    Returns the writer's result on the auto-apply path, or a
    ``{"pending": True, ...}`` marker when enforcement queued it. **The caller
    must check for that marker**: a queued push has not happened, so clearing
    ``zoho_dirty`` on it would lose the change permanently — the row would
    look synced while Zoho never saw it. (That is BO-1b's bug on the ClickUp
    side; ``sync_zoho`` checks.)

    Fail-safe in the same direction as the tasks gate: a broker-LAYER failure
    (module missing, DB down) never silently drops the sync — the write still
    runs and is logged as a bypass. ``do_write`` executes **exactly once**; its
    own errors propagate untouched so the engine can count them and leave the
    row dirty for the next cycle.
    """
    try:
        from action_broker import AuthorityTier, Disposition, enqueue, propose

        queued = broker_enforced(action)
        proposal = propose(
            BROKER_ACTOR, action, target, audit_payload,
            authority=(
                AuthorityTier.SUGGEST_APPLY if queued else AuthorityTier.AUTONOMOUS
            ),
            destructive=queued,
        )
        disposition = proposal.disposition
    except Exception as exc:  # broker unavailable → never lose the write
        _log.warning("crm.broker.gate_bypass", action=action, error=str(exc)[:200])
        return await do_write()

    if disposition == Disposition.NEEDS_APPROVAL:
        action_id = None
        with contextlib.suppress(Exception):
            action_id = enqueue(proposal)
        _log.info("crm.broker.push_queued", action=action, action_id=action_id)
        return {"pending": True, "pending_action_id": action_id}
    if disposition == Disposition.REJECTED:
        raise RuntimeError(f"Zoho push {action} rejected by authority policy")
    return await do_write()


async def _handle_crm_zoho_write(proposal: Any) -> dict[str, Any]:
    """Execute a queued Zoho push on approval (the registered handler).

    The proposal's payload is the whole spec of the write — module, verb, the
    Zoho id when there is one, and the field body — so approving it months
    later needs nothing that was only in memory. Nothing sensitive is stored:
    the OAuth token is re-derived by the client at call time and is never
    persisted on the proposal.
    """
    from gateway.routes.crm.sync_zoho import execute_push

    spec = proposal.payload or {}
    args = spec.get("args") or {}
    if proposal.action not in CRM_ZOHO_ACTIONS:
        raise RuntimeError(f"no Zoho writer for action {proposal.action!r}")
    result = await execute_push(
        module=args.get("module"),
        op=args.get("op"),
        record_id=args.get("record_id"),
        body=args.get("body") or {},
    )
    _log.info(
        "crm.broker.push_applied",
        action=proposal.action, module=args.get("module"),
    )
    return result


def register_crm_broker_handlers() -> None:
    """Wire the three handlers so a queued Zoho push executes on approval.

    Called once from the gateway lifespan/startup block in ``main.py``, exactly
    like ``register_task_broker_handlers``. Idempotent.
    """
    from action_broker import register_action_handler

    for action in CRM_ZOHO_ACTIONS:
        register_action_handler(action, _handle_crm_zoho_write)
    _log.info("crm.broker.handlers_registered", actions=list(CRM_ZOHO_ACTIONS))


__all__ = [
    "BROKER_ACTOR",
    "CRM_ZOHO_ACTIONS",
    "broker_enforced",
    "broker_gate",
    "register_crm_broker_handlers",
]
