"""Project a Gmail API message resource into an EmailMessage for triage."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from orchestrator.triage.schema import EmailMessage

from .client import GmailMessageRaw, _extract_body, _header

_ADDRESS_RX = re.compile(r"<([^>]+)>")


def _split_addresses(value: str) -> list[str]:
    """Split an RFC-5322 header value (\"Vijay <vijay@x>, Other <o@y>\") into addresses."""
    if not value:
        return []
    out: list[str] = []
    for raw in value.split(","):
        raw = raw.strip()
        if not raw:
            continue
        m = _ADDRESS_RX.search(raw)
        out.append((m.group(1) if m else raw).strip().lower())
    return [a for a in out if "@" in a]


def _split_name_addr(value: str) -> tuple[str, str]:
    """Return (display_name, address) for the first address in a header value."""
    if not value:
        return ("", "")
    m = _ADDRESS_RX.search(value)
    if m:
        addr = m.group(1).strip().lower()
        name = value.split("<", 1)[0].strip(' "')
        return (name, addr)
    return ("", value.strip().lower())


def normalise(raw: GmailMessageRaw) -> EmailMessage:
    """Convert a Gmail API message into the orchestrator's EmailMessage schema."""
    payload: dict[str, Any] = raw.payload or {}
    from_name, from_addr = _split_name_addr(_header(payload, "From"))
    to_addrs = _split_addresses(_header(payload, "To"))
    cc_addrs = _split_addresses(_header(payload, "Cc"))
    headers = {(h.get("name") or "").lower(): h.get("value") or "" for h in payload.get("headers") or []}
    body = _extract_body(payload)
    return EmailMessage(
        message_id=raw.id,
        thread_id=raw.thread_id,
        from_addr=from_addr or "unknown@example.com",
        from_name=from_name or None,
        to_addrs=to_addrs,
        cc_addrs=cc_addrs,
        subject=_header(payload, "Subject") or "(no subject)",
        snippet=raw.snippet,
        body=body,
        received_at=datetime.fromtimestamp(raw.internal_date_ms / 1000, tz=timezone.utc),
        headers=headers,
    )


__all__ = ["normalise", "_split_addresses", "_split_name_addr"]
