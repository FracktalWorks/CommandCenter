"""WhatsApp transport routes — registered on the shared core.router by import."""
from __future__ import annotations

from gateway.routes.whatsapp.transport import (  # noqa: F401
    accounts,
    bridge,
    calls,
    capture,
    chats,
    connect,
    context,
    labels,
    messages,
    saved_replies,
    send,
    snooze,
    templates,
    webhook,
)
