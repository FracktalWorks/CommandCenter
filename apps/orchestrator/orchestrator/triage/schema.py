"""Wire types for email triage (WBS 1.4).

The classifier is deliberately small so it can survive on tier-1 LLMs *or*
a pure heuristic pass. Anything more granular (intent extraction, deal-id
resolution, suggested reply) is the job of downstream sub-agents triggered
by ``EmailTriageDecision.label``.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

# ---- Inputs ---------------------------------------------------------------

class EmailMessage(BaseModel):
    """Minimal envelope we need for triage. Maps cleanly from a Gmail
    `messages.get(format='metadata')` response (see WBS 1.3)."""

    model_config = ConfigDict(extra="ignore")

    message_id: str
    thread_id: str | None = None
    from_addr: EmailStr
    from_name: str | None = None
    to_addrs: list[EmailStr] = Field(default_factory=list)
    cc_addrs: list[EmailStr] = Field(default_factory=list)
    subject: str = ""
    snippet: str = ""               # Gmail's preview text
    body: str | None = None         # full body if we have it
    received_at: datetime | None = None
    headers: dict[str, str] = Field(default_factory=dict)

    @property
    def text(self) -> str:
        """All textual content joined for keyword scanning."""
        return "\n".join(filter(None, [self.subject, self.snippet, self.body or ""]))


# ---- Outputs --------------------------------------------------------------

TriageLabel = Literal[
    "spam",
    "newsletter",
    "automated",
    "internal_admin",
    "sales_lead",
    "sales_followup",
    "customer_request",
    "delivery_update",
    "meeting_logistics",
    "needs_human",
    "other",
]


class EmailTriageDecision(BaseModel):
    """Classifier output. Always include a ``rationale`` so the Annealer
    can mine bad calls for skill improvements."""

    model_config = ConfigDict(extra="forbid")

    label: TriageLabel
    confidence: float = Field(ge=0.0, le=1.0)
    source: Literal["rule", "llm", "fallback"]
    rationale: str
    suggested_route: Literal[
        "drop",                 # discard / archive — do nothing else
        "ingest_only",          # store in graph but no agent action
        "sales_agent",
        "delivery_agent",
        "ops_inbox",
        "needs_human_review",
    ]
    tier_used: int | None = None     # 1 / 2 / 3 if LLM was used


__all__ = [
    "EmailMessage",
    "EmailTriageDecision",
    "TriageLabel",
]
