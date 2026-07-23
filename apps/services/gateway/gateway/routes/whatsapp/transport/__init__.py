"""WhatsApp transport routes — registered on the shared core.router by import."""
from __future__ import annotations

from gateway.routes.whatsapp.transport import (  # noqa: F401
    accounts,
    capture,
    chats,
    messages,
    send,
    templates,
    webhook,
)
