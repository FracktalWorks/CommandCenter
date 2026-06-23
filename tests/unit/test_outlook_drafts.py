"""Outlook provider: native draft update + send (reverse-sync write path).

These back the Gmail/Outlook-style auto-save: edits update the SAME provider
draft in place (no duplicates) and sending uses Graph's native send so the
message moves Drafts → Sent without a leftover draft.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from email_ingestion.providers.outlook import OutlookProvider


def _provider() -> OutlookProvider:
    return OutlookProvider({
        "access_token": "x", "refresh_token": "y",
        "client_id": "c", "client_secret": "s",
    })


def _resp(json_value: dict | None = None) -> MagicMock:
    r = MagicMock()
    r.raise_for_status = MagicMock()
    r.json = MagicMock(return_value=json_value or {})
    return r


async def test_update_draft_patches_in_place() -> None:
    p = _provider()
    client = AsyncMock()
    client.patch.return_value = _resp({"id": "draft-1"})
    p._get_client = AsyncMock(return_value=client)  # type: ignore[method-assign]

    out = await p.update_draft(
        "draft-1", to=["a@b.com"], subject="Re: hi", body_text="hello")

    assert out == "draft-1"                       # same id → no duplicate draft
    call = client.patch.await_args
    assert call.args[0] == "/me/messages/draft-1"
    body = call.kwargs["json"]
    assert body["body"]["content"] == "hello"
    assert body["body"]["contentType"] == "text"
    assert body["subject"] == "Re: hi"
    assert body["toRecipients"][0]["emailAddress"]["address"] == "a@b.com"


async def test_update_draft_only_patches_supplied_fields() -> None:
    p = _provider()
    client = AsyncMock()
    client.patch.return_value = _resp({})
    p._get_client = AsyncMock(return_value=client)  # type: ignore[method-assign]

    await p.update_draft("draft-1", body_text="just the body")
    body = client.patch.await_args.kwargs["json"]
    assert set(body) == {"body"}                  # subject/recipients untouched


async def test_send_draft_posts_native_send() -> None:
    p = _provider()
    client = AsyncMock()
    client.post.return_value = _resp({})
    p._get_client = AsyncMock(return_value=client)  # type: ignore[method-assign]

    out = await p.send_draft("draft-1")
    assert out is None
    assert client.post.await_args.args[0] == "/me/messages/draft-1/send"
