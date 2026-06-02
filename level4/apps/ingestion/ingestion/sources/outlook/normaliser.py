"""Project a Microsoft Graph message resource into an EmailMessage for triage."""
from __future__ import annotations

from datetime import datetime, timezone

from orchestrator.triage.schema import EmailMessage

from .client import OutlookMessageRaw, _extract_addresses, _extract_email, _extract_name


def normalise(raw: OutlookMessageRaw) -> EmailMessage:
    """Convert a Graph API message into the orchestrator's EmailMessage schema."""
    from_addr = _extract_email(raw.sender) or "unknown@example.com"
    from_name = _extract_name(raw.sender) or None
    to_addrs = _extract_addresses(raw.to_recipients)
    cc_addrs = _extract_addresses(raw.cc_recipients)

    # Build a header dict from internetMessageHeaders for downstream inspection.
    headers = {
        (h.get("name") or "").lower(): (h.get("value") or "")
        for h in raw.internet_message_headers
    }

    # Parse ISO-8601 receivedDateTime (Graph returns UTC strings like "2026-05-27T10:00:00Z").
    try:
        received_at = datetime.fromisoformat(raw.received_at.rstrip("Z")).replace(
            tzinfo=timezone.utc
        )
    except (ValueError, AttributeError):
        received_at = datetime.now(tz=timezone.utc)

    return EmailMessage(
        message_id=raw.id,
        thread_id=raw.conversation_id,
        from_addr=from_addr,
        from_name=from_name,
        to_addrs=to_addrs,
        cc_addrs=cc_addrs,
        subject=raw.subject or "(no subject)",
        snippet=raw.body_preview,
        body=raw.body_content,
        received_at=received_at,
        headers=headers,
    )


__all__ = ["normalise"]

