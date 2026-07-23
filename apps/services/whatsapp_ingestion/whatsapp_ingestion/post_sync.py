"""Post-sync hook registry — the gateway registers its classify / status / digest
callbacks here so the webhook receiver can run them WITHOUT importing up into the
gateway package. The same layering-inversion fix the email vertical made (its C2
inversion); direction is correct here from day one.

Every hook is optional and takes a single ``account_id``; an unregistered hook is
a no-op, so ``whatsapp_ingestion`` still runs standalone (unit tests, or any
process that ingests WhatsApp without the gateway wired in).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

PostSyncHook = Callable[[str], Awaitable[None]]


@dataclass
class PostSyncHooks:
    """The callbacks invoked after a webhook batch is persisted for an account."""

    # The new-message pipeline (classify intent → categorize → chat status →
    # auto-answer rules), run when a batch brought in new inbound messages (W2+).
    on_new_messages: PostSyncHook | None = None
    # Reply Zero chat-status classification. Kept separate from on_new_messages
    # because it has a backlog to work through and must catch up on a quiet
    # number, exactly as the email classify_threads hook does (W2+).
    classify_chats: PostSyncHook | None = None
    send_digest: PostSyncHook | None = None


hooks = PostSyncHooks()


def register_post_sync_hooks(**kwargs: PostSyncHook | None) -> None:
    """Wire the gateway's post-sync callbacks in — called once at app startup.

    Raises ``AttributeError`` for an unknown hook name so a typo fails loudly.
    """
    for name, fn in kwargs.items():
        if not hasattr(hooks, name):
            raise AttributeError(f"unknown post-sync hook: {name!r}")
        setattr(hooks, name, fn)


async def run_hook(hook: PostSyncHook | None, account_id: str) -> None:
    """Await ``hook`` if one is registered; no-op otherwise."""
    if hook is not None:
        await hook(account_id)
