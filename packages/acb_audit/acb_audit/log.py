"""Append-only audit log.

Phase-0: writes to Postgres `audit_event` (schema in infra/postgres/01_schema.sql)
AND mirrors to structlog so traces show up locally even if the DB is down.
The Annealer (Phase 4) reads from this table to mine intervention patterns.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from acb_common import get_logger

_log = get_logger("acb_audit")


@dataclass(slots=True)
class AuditEvent:
    actor: str                                # e.g. "agent:sales", "user:vijay@..."
    action: str                               # e.g. "draft_email", "approve", "reject"
    target: str                               # e.g. "deal:<uuid>"
    payload: dict[str, Any] = field(default_factory=dict)
    id: UUID = field(default_factory=uuid4)
    at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


def record(event: AuditEvent) -> None:
    """Persist an audit event. Logs always; DB write is best-effort."""
    _log.info("audit", **asdict(event))
    try:
        # Local import avoids a hard dep from acb_audit -> acb_graph at import time
        # (acb_audit is intentionally usable without the DB layer).
        from acb_graph import get_session
        from acb_graph.models import AuditEvent as AuditRow

        with get_session() as s:
            s.add(
                AuditRow(
                    id=event.id,
                    at=event.at,
                    actor=event.actor,
                    action=event.action,
                    target=event.target,
                    payload=event.payload,
                )
            )
    except Exception as exc:  # never block the caller on audit-DB failures
        _log.warning("audit.persist_failed", error=str(exc))
