"""Wire the gateway's WhatsApp post-sync callbacks into the ingestion registry.

Mirrors ``gateway.routes.email.scheduler_hooks.register_email_post_sync_hooks``:
the gateway (higher layer) registers its classify callbacks DOWN into
``whatsapp_ingestion.post_sync`` at startup, so the webhook receiver can run them
without importing up into the gateway. Called once from ``main.py``.
"""

from __future__ import annotations

from acb_common import get_logger

_log = get_logger("gateway.whatsapp.hooks")


def register_whatsapp_post_sync_hooks() -> None:
    """Register the WhatsApp new-message + chat-status hooks + broker handlers.
    Idempotent."""
    from gateway.routes.whatsapp.automation.intent import process_new_messages
    from gateway.routes.whatsapp.automation.outbound import register_whatsapp_handlers
    from gateway.routes.whatsapp.automation.replyzero import classify_chats
    from whatsapp_ingestion.post_sync import register_post_sync_hooks

    register_post_sync_hooks(
        on_new_messages=process_new_messages,
        classify_chats=classify_chats,
    )
    # The Action Broker write handlers (broadcast, and later single auto-send) —
    # the only place a system-initiated WhatsApp send happens.
    register_whatsapp_handlers()
    _log.info("whatsapp.post_sync_hooks_registered")
