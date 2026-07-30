"""Event sink registry — lets higher layers subscribe to normalized provider
events without ingestion importing upward (the ``email_ingestion/post_sync.py``
hook pattern).

The gateway registers the Workflows event dispatcher here at startup
(``gateway/main.py``), so a ClickUp/Zoho/Gmail webhook can fire workflow
event triggers. With nothing registered, ``emit_event`` is a no-op — the
receivers behave exactly as before, and ingestion keeps working standalone.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from acb_common import get_logger

_log = get_logger("ingestion.event_hooks")

EventSink = Callable[[str, str, dict[str, Any]], Awaitable[Any]]
"""async sink(source, event_type, payload)."""

_SINKS: list[EventSink] = []


def register_event_sink(sink: EventSink) -> None:
    """Subscribe to normalized provider events (idempotent per function)."""
    if sink not in _SINKS:
        _SINKS.append(sink)


def clear_event_sinks() -> None:
    """Drop all sinks (tests)."""
    _SINKS.clear()


async def emit_event(source: str, event_type: str, payload: dict[str, Any]) -> None:
    """Fan an event out to every sink. Best-effort — a sink error never
    propagates back into a provider webhook response."""
    for sink in list(_SINKS):
        try:
            await sink(source, event_type, payload)
        except Exception as exc:
            _log.warning(
                "event_hooks.sink_failed",
                source=source,
                event_type=event_type,
                error=str(exc)[:160],
            )
