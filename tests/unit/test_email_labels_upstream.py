"""Unit test: Outlook creates missing master categories on apply (so applied
categories are real, coloured Outlook categories — parity with Gmail labels)."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from email_ingestion.providers.outlook import OutlookProvider


def _provider() -> OutlookProvider:
    return OutlookProvider({
        "access_token": "x", "refresh_token": "y",
        "client_id": "c", "client_secret": "s",
    })


async def test_ensure_categories_creates_only_missing() -> None:
    p = _provider()
    client = AsyncMock()
    get_resp = MagicMock()
    get_resp.raise_for_status = MagicMock()
    get_resp.json = MagicMock(return_value={"value": [{"displayName": "Work"}]})
    client.get.return_value = get_resp
    p._get_client = AsyncMock(return_value=client)  # type: ignore[method-assign]

    await p._ensure_categories(["Work", "Newsletter"])

    # "Work" already exists → skipped; "Newsletter" is created upstream.
    client.post.assert_awaited_once()
    kwargs = client.post.await_args.kwargs
    assert kwargs["json"]["displayName"] == "Newsletter"
    assert kwargs["json"]["color"].startswith("preset")


async def test_ensure_categories_noop_for_empty() -> None:
    p = _provider()
    client = AsyncMock()
    p._get_client = AsyncMock(return_value=client)  # type: ignore[method-assign]
    await p._ensure_categories([])
    client.get.assert_not_called()
    client.post.assert_not_called()
