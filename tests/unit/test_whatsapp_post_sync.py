"""The WhatsApp post-sync hook registry: register/run/no-op + typo guard."""

from __future__ import annotations

import pytest
from whatsapp_ingestion import post_sync


@pytest.fixture(autouse=True)
def _reset_hooks():
    # Registry is module-global; reset around each test so ordering can't leak.
    saved = post_sync.hooks
    post_sync.hooks = post_sync.PostSyncHooks()
    yield
    post_sync.hooks = saved


async def test_unregistered_hook_is_a_noop() -> None:
    # No hook registered → run_hook must simply do nothing (standalone ingest).
    await post_sync.run_hook(post_sync.hooks.on_new_messages, "acc")


async def test_registered_hook_runs_with_account_id() -> None:
    seen: list[str] = []

    async def hook(account_id: str) -> None:
        seen.append(account_id)

    post_sync.register_post_sync_hooks(on_new_messages=hook)
    await post_sync.run_hook(post_sync.hooks.on_new_messages, "acc-7")
    assert seen == ["acc-7"]


def test_unknown_hook_name_raises() -> None:
    with pytest.raises(AttributeError):
        post_sync.register_post_sync_hooks(nonexistent_hook=lambda _a: None)
