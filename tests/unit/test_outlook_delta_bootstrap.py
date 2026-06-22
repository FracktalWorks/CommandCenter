"""Unit tests for the Outlook inbox delta-token bootstrap.

The initial (full) sync must seed an @odata.deltaLink so the next cycle runs
incrementally and can detect upstream deletions. These tests mock the Graph
client; no network is touched.
"""
from __future__ import annotations

import types

from email_ingestion.providers.outlook import OutlookProvider


class _Resp:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


class _Client:
    """Returns queued responses in order, recording the URLs requested."""

    def __init__(self, pages: list[dict]) -> None:
        self._pages = pages
        self.urls: list[str] = []

    async def get(self, url, params=None):  # noqa: ANN001
        self.urls.append(url)
        return _Resp(self._pages.pop(0))


def _provider() -> OutlookProvider:
    return OutlookProvider({"access_token": "x"})


async def test_bootstrap_returns_deltalink_on_first_page() -> None:
    client = _Client([{"value": [], "@odata.deltaLink": "https://g/delta?$deltatoken=ABC"}])
    link = await _provider()._bootstrap_inbox_delta(client)
    assert link == "https://g/delta?$deltatoken=ABC"
    assert client.urls == ["/me/mailFolders/inbox/messages/delta"]


async def test_bootstrap_follows_nextlinks_to_deltalink() -> None:
    client = _Client([
        {"value": [{"id": "1"}], "@odata.nextLink": "https://g/page2"},
        {"value": [{"id": "2"}], "@odata.nextLink": "https://g/page3"},
        {"value": [{"id": "3"}], "@odata.deltaLink": "https://g/delta?$deltatoken=Z"},
    ])
    link = await _provider()._bootstrap_inbox_delta(client)
    assert link == "https://g/delta?$deltatoken=Z"
    # First call is the relative seed; subsequent calls use the absolute nextLinks.
    assert client.urls[0] == "/me/mailFolders/inbox/messages/delta"
    assert client.urls[1:] == ["https://g/page2", "https://g/page3"]


async def test_bootstrap_returns_none_when_no_links() -> None:
    client = _Client([{"value": [{"id": "1"}]}])  # neither next nor delta link
    assert await _provider()._bootstrap_inbox_delta(client) is None


async def test_bootstrap_swallows_errors() -> None:
    class _Boom:
        async def get(self, url, params=None):  # noqa: ANN001
            raise RuntimeError("graph down")

    assert await _provider()._bootstrap_inbox_delta(_Boom()) is None


async def test_bootstrap_respects_max_pages() -> None:
    # Always returns a nextLink → would loop forever without the cap.
    class _Loop:
        def __init__(self) -> None:
            self.calls = 0

        async def get(self, url, params=None):  # noqa: ANN001
            self.calls += 1
            return _Resp({"value": [], "@odata.nextLink": "https://g/next"})

    loop = _Loop()
    link = await _provider()._bootstrap_inbox_delta(loop, max_pages=5)
    assert link is None
    assert loop.calls == 5
