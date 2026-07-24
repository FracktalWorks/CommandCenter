"""Unit tests for the WhatsApp digest projection + post-sync hook wiring."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class _StatusRow:
    status: str
    n: int


def test_status_counts_folds_rows() -> None:
    from gateway.routes.whatsapp.digest import status_counts
    counts = status_counts([
        _StatusRow("NEEDS_REPLY", 7),
        _StatusRow("AWAITING", 5),
        _StatusRow("FYI", 40),
    ])
    assert counts.needs_reply == 7
    assert counts.waiting == 5


def test_status_counts_handles_missing_statuses() -> None:
    from gateway.routes.whatsapp.digest import status_counts
    counts = status_counts([])
    assert counts.needs_reply == 0
    assert counts.waiting == 0


def test_top_needs_you_bounds_to_three() -> None:
    from gateway.routes.whatsapp.digest import DigestItem, top_needs_you
    items = [DigestItem(chat_id=str(i), name=f"c{i}") for i in range(6)]
    top = top_needs_you(items)
    assert len(top) == 3
    assert [i.chat_id for i in top] == ["0", "1", "2"]  # order preserved


def test_digest_route_registered() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    assert "/whatsapp/digest" in paths


def test_hook_registration_wires_both_callbacks() -> None:
    # Registering must make the ingestion registry's hooks non-None so the
    # webhook fires real work instead of no-ops.
    from gateway.routes.whatsapp.scheduler_hooks import (
        register_whatsapp_post_sync_hooks,
    )
    from whatsapp_ingestion import post_sync

    saved = post_sync.hooks
    post_sync.hooks = post_sync.PostSyncHooks()
    try:
        register_whatsapp_post_sync_hooks()
        assert post_sync.hooks.on_new_messages is not None
        assert post_sync.hooks.classify_chats is not None
    finally:
        post_sync.hooks = saved
