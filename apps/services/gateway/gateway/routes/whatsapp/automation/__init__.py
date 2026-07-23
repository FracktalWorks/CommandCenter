"""WhatsApp automation — the triage brain (chat status, intent, categories).

Mirrors the email vertical's ``automation`` layer: deterministic-first
classifiers that write onto the message/chat store, plus the post-sync hook
functions the webhook fires after a batch lands. Imported by the package so any
routes it defines register on the shared ``core.router``.
"""
from __future__ import annotations

from gateway.routes.whatsapp.automation import intent, replyzero  # noqa: F401
