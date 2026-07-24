"""WhatsApp gateway routes (package).

Mirrors the email route package's acyclic layering:

    core        shared kernel: router, models, DB, provider adapter
    transport   accounts, chats, messages, send, webhook

Submodules are imported in dependency order so their routes register on the
shared ``core.router``; the package re-exports ``router`` for ``main.py``.
"""
from __future__ import annotations

from gateway.routes.whatsapp import (  # noqa: F401
    automation,
    core,
    digest,
    pulse,
    transport,
)
from gateway.routes.whatsapp.core import router  # noqa: F401
