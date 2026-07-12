"""Action Broker — the ONE component allowed to write back to source systems.

Every outward write (ClickUp / Zoho / Odoo / email) is meant to flow through
here so it is authority-gated and audited (root ``AGENTS.md`` non-negotiable #4).

This module now provides the real decision + execution core:

* :func:`decide_disposition` — the authority-tier policy (pure): given an actor's
  authority and whether the action is destructive/outward-facing, decide whether
  it auto-applies, needs a human, or is rejected. Destructive actions FAIL CLOSED
  (need a human) unless the authority is explicitly ``autonomous`` — mirroring the
  harness rule in ``AGENTS.md``.
* :func:`register_action_handler` / :func:`execute` — a fail-closed executor
  registry. A real source-of-truth write happens ONLY inside a registered
  handler, and an action with no handler is REFUSED (never silently applied).

Ships with **zero** handlers registered, so it cannot perform any real write yet
— it is non-breaking and inert until handlers are wired in. Still pending
(needs per-agent authority decisions + a queue table): persisting
``needs_approval`` proposals to a ``pending_actions`` table (mirror
``pending_commit``), the Control Plane approval binding, and routing the existing
ClickUp/email writes through :func:`execute`. See FOUNDATION_BUILDOUT_CHECKLIST
BO-1.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any
from uuid import UUID, uuid4

from acb_audit import AuditEvent, record


class AuthorityTier(StrEnum):
    READ = "read"
    SUGGEST = "suggest"
    SUGGEST_APPLY = "suggest+apply"
    AUTONOMOUS = "autonomous"


class Disposition(StrEnum):
    """What the broker decided to do with a proposed action."""

    AUTO_APPLY = "auto_apply"          # execute now (still audited)
    NEEDS_APPROVAL = "needs_approval"  # hold for a human in the approval inbox
    REJECTED = "rejected"              # not permitted at this authority tier


@dataclass(slots=True)
class ActionProposal:
    id: UUID
    actor: str            # e.g. "agent:delivery"
    action: str           # e.g. "clickup.comment", "zoho.email"
    target: str           # e.g. "task:<clickup_id>"
    payload: dict[str, Any]
    authority: AuthorityTier
    # Whether the action is destructive / outward-facing (irreversible or leaves
    # the system). Defaults True so an un-annotated action FAILS CLOSED.
    destructive: bool = True
    disposition: Disposition | None = None


def decide_disposition(
    authority: AuthorityTier, *, destructive: bool
) -> Disposition:
    """Pure authority-tier policy — the single place the rules live.

    * ``read``          → REJECTED (a read-only actor may not write).
    * ``autonomous``    → AUTO_APPLY (trusted to act without a human).
    * ``suggest``       → NEEDS_APPROVAL (always propose, never auto-apply).
    * ``suggest+apply`` → AUTO_APPLY for reversible/idempotent actions, but
      NEEDS_APPROVAL for destructive/outward-facing ones (fail closed).
    """
    if authority == AuthorityTier.READ:
        return Disposition.REJECTED
    if authority == AuthorityTier.AUTONOMOUS:
        return Disposition.AUTO_APPLY
    if authority == AuthorityTier.SUGGEST:
        return Disposition.NEEDS_APPROVAL
    # SUGGEST_APPLY
    return Disposition.NEEDS_APPROVAL if destructive else Disposition.AUTO_APPLY


def propose(
    actor: str,
    action: str,
    target: str,
    payload: dict[str, Any],
    authority: AuthorityTier = AuthorityTier.SUGGEST_APPLY,
    *,
    destructive: bool = True,
) -> ActionProposal:
    """Create an action proposal, compute its disposition, and audit it.

    Does NOT execute — the caller (or the approval flow) calls :func:`execute`
    once the proposal is auto-apply or human-approved. Persisting a
    ``needs_approval`` proposal to the queue is the pending follow-up (BO-1).
    """
    disposition = decide_disposition(authority, destructive=destructive)
    proposal = ActionProposal(
        id=uuid4(), actor=actor, action=action, target=target,
        payload=payload, authority=authority, destructive=destructive,
        disposition=disposition,
    )
    record(AuditEvent(
        actor=actor, action=f"propose:{action}", target=target,
        payload={
            "authority": authority.value,
            "disposition": disposition.value,
            "destructive": destructive,
            **payload,
        },
    ))
    return proposal


# ── Executor registry — the ONLY place a real source-of-truth write happens ──
# A handler performs the actual provider write for a given action name. Nothing
# is registered by default, so the broker cannot write anything until handlers
# are wired in (deliberately inert + non-breaking).
_HANDLERS: dict[str, Callable[[ActionProposal], Awaitable[Any]]] = {}


def register_action_handler(
    action: str, handler: Callable[[ActionProposal], Awaitable[Any]]
) -> None:
    """Register the write handler for *action* (e.g. ``"clickup.comment"``)."""
    _HANDLERS[action] = handler


def clear_action_handlers() -> None:
    """Drop all registered handlers (used in tests)."""
    _HANDLERS.clear()


async def execute(proposal: ActionProposal) -> dict[str, Any]:
    """Perform an auto-apply / approved proposal via its registered handler.

    Fails CLOSED:
    * a ``rejected`` proposal is never executed;
    * an action with no registered handler is REFUSED (never silently applied);
    both are audited. On success the handler's result is returned.
    """
    if proposal.disposition == Disposition.REJECTED:
        record(AuditEvent(
            actor="system:action_broker",
            action=f"execute_refused:{proposal.action}",
            target=proposal.target,
            payload={"reason": "rejected_by_authority"},
        ))
        return {"ok": False, "error": "rejected by authority policy"}

    handler = _HANDLERS.get(proposal.action)
    if handler is None:
        record(AuditEvent(
            actor="system:action_broker",
            action=f"execute_refused:{proposal.action}",
            target=proposal.target,
            payload={"reason": "no_handler"},
        ))
        return {
            "ok": False,
            "error": f"no handler registered for action {proposal.action!r}",
        }

    record(AuditEvent(
        actor="system:action_broker",
        action=f"execute:{proposal.action}",
        target=proposal.target,
        payload={"authority": proposal.authority.value},
    ))
    result = await handler(proposal)
    return {"ok": True, "result": result}
