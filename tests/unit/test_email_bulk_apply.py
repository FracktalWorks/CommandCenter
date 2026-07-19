"""Bulk actions at mailbox scale.

The Email Cleaner used to cap a bulk action at 1000 messages: "archive
everything from this sender" quietly stopped, reported success, and left the
rest sitting there. The cap was never a database limit — one set-based UPDATE
costs the same at 50 rows or 50,000 — it was the PROVIDER, which the reconciler
walked one HTTP call per message.

These tests pin the replacement: providers collapse the work into batches, one
failure never strands the rest, and the id re-keys Outlook hands back are
actually returned so the caller can persist them.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from email_ingestion.providers.gmail import GmailProvider


def _gmail() -> GmailProvider:
    return GmailProvider({"access_token": "t", "refresh_token": "r"})


# ── Gmail: batchModify collapses N messages into N/1000 calls ────────────────


@pytest.mark.parametrize(
    ("action", "add", "remove"),
    [
        ("archive", None, ["INBOX"]),
        ("read", None, ["UNREAD"]),
        ("unread", ["UNREAD"], None),
        ("star", ["STARRED"], None),
        ("unstar", None, ["STARRED"]),
    ],
)
async def test_gmail_bulk_action_is_one_batch_call(action, add, remove) -> None:
    g = _gmail()
    client = MagicMock()
    client.post = AsyncMock(return_value=MagicMock(raise_for_status=MagicMock()))

    with patch.object(g, "_get_client", AsyncMock(return_value=client)):
        rekeys = await g.bulk_apply([f"m{i}" for i in range(250)], action)

    assert client.post.await_count == 1
    path, kwargs = client.post.await_args[0][0], client.post.await_args[1]
    assert path == "/users/me/messages/batchModify"
    assert len(kwargs["json"]["ids"]) == 250
    assert kwargs["json"].get("addLabelIds") == add
    assert kwargs["json"].get("removeLabelIds") == remove
    # Gmail never re-keys a message id.
    assert rekeys == {}


async def test_gmail_chunks_at_the_api_ceiling() -> None:
    """2,500 messages is 3 calls, not 2,500. This is the whole point: the old
    per-message loop would have been 2,500 sequential round-trips."""
    g = _gmail()
    client = MagicMock()
    client.post = AsyncMock(return_value=MagicMock(raise_for_status=MagicMock()))

    with patch.object(g, "_get_client", AsyncMock(return_value=client)):
        await g.bulk_apply([f"m{i}" for i in range(2500)], "archive")

    sizes = [c[1]["json"]["ids"] for c in client.post.await_args_list]
    assert [len(s) for s in sizes] == [1000, 1000, 500]
    # Every id is covered exactly once — no chunk-boundary drops.
    flat = [i for s in sizes for i in s]
    assert len(set(flat)) == 2500


async def test_a_failed_batch_retries_message_by_message() -> None:
    """batchModify is all-or-nothing, so one stale id would cost the other 999
    their update. Falling back per-message costs a slow retry instead."""
    g = _gmail()
    client = MagicMock()
    client.post = AsyncMock(side_effect=RuntimeError("400 invalid id"))
    modified: list[str] = []

    async def fake_modify(pmid, add_labels=None, remove_labels=None):
        modified.append(pmid)

    with patch.object(g, "_get_client", AsyncMock(return_value=client)), \
            patch.object(g, "modify_message", fake_modify):
        await g.bulk_apply(["a", "b", "c"], "archive")

    assert modified == ["a", "b", "c"]


async def test_trash_is_not_routed_through_batch_modify() -> None:
    """Trash has its own endpoint and its own semantics. Assuming batchModify
    accepts the TRASH system label is not something to discover on a
    destructive path."""
    g = _gmail()
    trashed: list[str] = []

    async def fake_trash(pmid):
        trashed.append(pmid)

    client = MagicMock()
    client.post = AsyncMock()
    with patch.object(g, "_get_client", AsyncMock(return_value=client)), \
            patch.object(g, "trash_message", fake_trash):
        await g.bulk_apply(["a", "b"], "trash")

    assert trashed == ["a", "b"]
    client.post.assert_not_awaited()


# ── Base: per-message fallback, failure isolation, id re-keys ───────────────


async def test_base_bulk_apply_returns_provider_rekeys() -> None:
    """Outlook's /move mints a NEW id and invalidates the old one. Dropping
    these leaves every bulk-archived message pointing at a dead id, so the next
    action on it 404s until a full re-sync happens to notice."""
    from email_ingestion.providers.base import BaseEmailProvider

    async def fake_move(pmid, folder):
        return f"new-{pmid}"

    p = MagicMock(spec=BaseEmailProvider)
    p.move_to_folder = fake_move
    rekeys = await BaseEmailProvider.bulk_apply(p, ["a", "b"], "archive")

    assert rekeys == {"a": "new-a", "b": "new-b"}


async def test_base_bulk_apply_reports_no_rekey_when_the_id_is_stable() -> None:
    from email_ingestion.providers.base import BaseEmailProvider

    async def fake_move(pmid, folder):
        return None

    p = MagicMock(spec=BaseEmailProvider)
    p.move_to_folder = fake_move
    assert await BaseEmailProvider.bulk_apply(p, ["a"], "archive") == {}


async def test_one_bad_message_never_strands_the_rest() -> None:
    """At 10,000 messages a single 404 on a since-deleted mail must not leave
    the other 9,999 half-applied."""
    from email_ingestion.providers.base import BaseEmailProvider

    touched: list[str] = []

    async def fake_move(pmid, folder):
        if pmid == "b":
            raise RuntimeError("404 not found")
        touched.append(pmid)
        return None

    p = MagicMock(spec=BaseEmailProvider)
    p.move_to_folder = fake_move
    await BaseEmailProvider.bulk_apply(p, ["a", "b", "c"], "archive")

    assert touched == ["a", "c"]


# ── The route: uncapped, but not unguarded ──────────────────────────────────


async def test_an_unfiltered_bulk_action_is_refused() -> None:
    """Removing the row cap made "trash my entire mailbox" reachable in one
    request. A cap was never the right guard against that — an explicit refusal
    is, because it doesn't also truncate the legitimate case."""
    from fastapi import HTTPException
    from gateway.routes.email.automation.senders import (
        BulkActionRequest,
        bulk_action,
    )

    req = BulkActionRequest(action="trash", account_id="acc-1")
    with pytest.raises(HTTPException) as exc:
        await bulk_action(req, MagicMock(), MagicMock(email="u@x.io"))
    assert exc.value.status_code == 400
    assert "unfiltered" in exc.value.detail.lower()


@pytest.mark.parametrize(
    "kwargs",
    [
        {"sender_email": "news@site.com"},
        {"message_ids": ["m1"]},
        {"folder": "inbox"},
        {"older_than_days": 30},
        {"only_read": True},
    ],
)
async def test_any_filter_is_enough_to_proceed(kwargs) -> None:
    """The guard is about scope, not about which filter — every one of these
    narrows the action to something the user actually pointed at."""
    from gateway.routes.email.automation import senders as s

    class _DB:
        async def execute(self, clause, params=None):
            return MagicMock(fetchall=MagicMock(return_value=[]))

        async def commit(self): ...
        async def close(self): ...

    req = s.BulkActionRequest(action="archive", account_id="acc-1", **kwargs)
    with patch.object(s, "_get_db", AsyncMock(return_value=_DB())):
        res = await s.bulk_action(req, MagicMock(), MagicMock(email="u@x.io"))
    assert res == {"affected": 0}
