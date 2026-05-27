"""User roles and context for the AI Company Brain RBAC scaffold (WBS 1.7).

Two user-facing roles exist in Phase 1:
    EXECUTIVE -- full access, including sensitive sales/pipeline data.
    EMPLOYEE  -- general internal access; sales pipeline is gated.

A third internal role, AGENT, is reserved for service-to-service calls
(e.g. the orchestrator calling itself via the gateway).

The role is derived from the X-User-Role header set by the Next.js SSO proxy.
No DB lookup happens here. The Next.js layer reads Person.role from Postgres
once at session creation and stamps it on every downstream request header.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class UserRole(StrEnum):
    EXECUTIVE = "executive"
    EMPLOYEE = "employee"
    AGENT = "agent"      # service-to-service


def _coerce_role(raw: str | None) -> "UserRole":
    """Parse a role string case-insensitively; unknown values fall back to EMPLOYEE."""
    if not raw:
        return UserRole.EMPLOYEE
    try:
        return UserRole(raw.lower().strip())
    except ValueError:
        return UserRole.EMPLOYEE


@dataclass(slots=True, frozen=True)
class UserContext:
    """Resolved identity for one request."""

    email: str | None
    role: UserRole

    @property
    def is_executive(self) -> bool:
        return self.role is UserRole.EXECUTIVE

    @property
    def is_employee(self) -> bool:
        return self.role is UserRole.EMPLOYEE

    @property
    def is_agent(self) -> bool:
        return self.role is UserRole.AGENT