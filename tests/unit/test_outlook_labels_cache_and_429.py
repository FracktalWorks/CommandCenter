"""Outlook label apply: cache master categories, honour a 429 Retry-After.

Every rule LABEL action and every cleaner sweep goes through set_labels, which
used to GET the full master-category list on EVERY apply just to check a category
existed — a third Graph call per message. On a bulk sweep that both wastes calls
and invites throttling. Two fixes, pinned here:

  * master categories are fetched once per provider instance and cached, so a
    warm apply makes NO masterCategories call at all;
  * a throttled apply honours one Graph 429 Retry-After and retries, instead of
    surfacing the 429 as a phantom failed apply.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from email_ingestion.providers.outlook import OutlookProvider


def _provider() -> OutlookProvider:
    p = OutlookProvider({"access_token": "t", "refresh_token": "r"})
    return p


def _resp(status: int = 200, json_body: dict | None = None,
          headers: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        status_code=status,
        headers=headers or {},
        json=lambda: (json_body or {}),
        raise_for_status=lambda: None,
    )


# ── masterCategories cache ──────────────────────────────────────────────────

async def test_master_categories_are_fetched_once_then_cached() -> None:
    p = _provider()
    client = AsyncMock()
    client.get.return_value = _resp(json_body={"value": [
        {"displayName": "Newsletter"}, {"displayName": "Receipt"}]})
    p._http = client  # skip auth/_get_client construction

    first = await p._master_category_names()
    second = await p._master_category_names()
    assert first == {"newsletter", "receipt"} == second
    # Fetched exactly once across both calls.
    assert client.get.call_count == 1


async def test_ensure_categories_makes_no_call_when_all_exist() -> None:
    p = _provider()
    p._master_categories = {"newsletter"}  # pre-warmed cache
    client = AsyncMock()
    p._http = client
    await p._ensure_categories(["Newsletter"])
    # Everything requested already exists → no GET and no POST.
    client.get.assert_not_called()
    client.post.assert_not_called()


async def test_ensure_categories_creates_missing_and_updates_cache() -> None:
    p = _provider()
    p._master_categories = {"newsletter"}
    client = AsyncMock()
    client.post.return_value = _resp()
    p._http = client
    await p._ensure_categories(["Newsletter", "Marketing"])
    # Only the missing one is created...
    assert client.post.call_count == 1
    # ...and the cache learns it, so a repeat makes no further call.
    assert "marketing" in p._master_categories
    client.post.reset_mock()
    await p._ensure_categories(["Marketing"])
    client.post.assert_not_called()


# ── 429 Retry-After ─────────────────────────────────────────────────────────

async def test_graph_send_retries_once_on_429_honouring_retry_after() -> None:
    p = _provider()
    client = AsyncMock()
    client.request.side_effect = [
        _resp(status=429, headers={"Retry-After": "2"}),
        _resp(status=200),
    ]
    p._http = client
    with patch("email_ingestion.providers.outlook.asyncio.sleep",
               new=AsyncMock()) as sleep:
        resp = await p._graph_send("PATCH", "/me/messages/x", json={})
    assert resp.status_code == 200
    assert client.request.call_count == 2       # retried once
    sleep.assert_awaited_once()                 # waited out Retry-After
    assert sleep.await_args[0][0] == 2.0        # the header value, seconds


async def test_graph_send_caps_the_retry_after_wait() -> None:
    p = _provider()
    client = AsyncMock()
    client.request.side_effect = [
        _resp(status=429, headers={"Retry-After": "99999"}),
        _resp(status=200),
    ]
    p._http = client
    with patch("email_ingestion.providers.outlook.asyncio.sleep",
               new=AsyncMock()) as sleep:
        await p._graph_send("PATCH", "/me/messages/x", json={})
    # A hostile/huge Retry-After never blocks the whole cycle.
    assert sleep.await_args[0][0] == 30.0


async def test_graph_send_does_not_retry_a_success() -> None:
    p = _provider()
    client = AsyncMock()
    client.request.return_value = _resp(status=200)
    p._http = client
    resp = await p._graph_send("GET", "/me/messages/x")
    assert resp.status_code == 200
    assert client.request.call_count == 1


if __name__ == "__main__":  # pragma: no cover
    pytest.main([__file__, "-q"])
