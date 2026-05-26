"""Phase-0 placeholder for the Action Broker (WBS 3.1).

The broker is the *only* component allowed to write back to ClickUp/Zoho/Odoo.
Every write goes through approval gating per the configured authority tier
(read | suggest | suggest+apply | autonomous).
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any
from uuid import UUID, uuid4

from acb_audit import AuditEvent, record


class AuthorityTier(StrEnum):
    READ = "read"
    SUGGEST = "suggest"
    SUGGEST_APPLY = "suggest+apply"
    AUTONOMOUS = "autonomous"


@dataclass(slots=True)
class ActionProposal:
    id: UUID
    actor: str            # e.g. "agent:delivery"
    action: str           # e.g. "clickup.comment", "zoho.email"
    target: str           # e.g. "task:<clickup_id>"
    payload: dict[str, Any]
    authority: AuthorityTier


def propose(actor: str, action: str, target: str, payload: dict[str, Any],
            authority: AuthorityTier = AuthorityTier.SUGGEST_APPLY) -> ActionProposal:
    """Phase-0 stub: records the proposal in the audit log. Full queue lands in WBS 3.1."""
    proposal = ActionProposal(
        id=uuid4(), actor=actor, action=action, target=target,
        payload=payload, authority=authority,
    )
    record(AuditEvent(
        actor=actor, action=f"propose:{action}", target=target,
        payload={"authority": authority.value, **payload},
    ))
    return proposal
