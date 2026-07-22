"""Outlook drafts must carry Cc/Bcc, so a Cc'd reply saves as a draft.

Before this, the draft write-path carried only To — a Cc/Bcc reply had to detour
through a full send (which starts a fresh, unthreaded message), the three-way
branch every composer had to special-case. Graph stores ccRecipients /
bccRecipients on the draft message, so these pin that create_draft/update_draft
put them there.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

from email_ingestion.providers.outlook import OutlookProvider


def _provider() -> OutlookProvider:
    return OutlookProvider({"access_token": "t", "refresh_token": "r"})


def _resp(json_body: dict | None = None):
    return SimpleNamespace(
        status_code=200, headers={},
        json=lambda: (json_body or {"id": "draft-1"}),
        raise_for_status=lambda: None)


def _addrs(recips: list[dict]) -> list[str]:
    return [r["emailAddress"]["address"] for r in recips]


async def test_create_standalone_draft_sets_cc_and_bcc() -> None:
    p = _provider()
    client = AsyncMock()
    client.post.return_value = _resp()
    p._http = client
    await p.create_draft(
        to=["a@x.com"], subject="hi", body_text="b",
        cc=["c@x.com"], bcc=["d@x.com"])
    # POST /me/messages with the recipients on the message body.
    body = client.post.await_args.kwargs["json"]
    assert _addrs(body["toRecipients"]) == ["a@x.com"]
    assert _addrs(body["ccRecipients"]) == ["c@x.com"]
    assert _addrs(body["bccRecipients"]) == ["d@x.com"]


async def test_create_reply_draft_patches_cc_onto_the_reply() -> None:
    p = _provider()
    client = AsyncMock()
    client.post.return_value = _resp({"id": "reply-1"})
    client.patch.return_value = _resp()
    p._http = client
    await p.create_draft(
        to=[], subject="", body_text="b",
        reply_to_message_id="m-1", cc=["c@x.com"])
    # createReply first, then a PATCH carrying the body AND the Cc.
    patch_body = client.patch.await_args.kwargs["json"]
    assert _addrs(patch_body["ccRecipients"]) == ["c@x.com"]
    assert "body" in patch_body


async def test_update_draft_sets_cc_and_bcc() -> None:
    p = _provider()
    client = AsyncMock()
    client.patch.return_value = _resp()
    p._http = client
    await p.update_draft("draft-1", to=["a@x.com"],
                         cc=["c@x.com"], bcc=["d@x.com"])
    patch_body = client.patch.await_args.kwargs["json"]
    assert _addrs(patch_body["ccRecipients"]) == ["c@x.com"]
    assert _addrs(patch_body["bccRecipients"]) == ["d@x.com"]


async def test_update_draft_leaves_cc_untouched_when_not_given() -> None:
    # cc=None must NOT emit ccRecipients — so a body-only autosave can't wipe a
    # Cc the draft already has.
    p = _provider()
    client = AsyncMock()
    client.patch.return_value = _resp()
    p._http = client
    await p.update_draft("draft-1", body_text="new body")
    patch_body = client.patch.await_args.kwargs["json"]
    assert "ccRecipients" not in patch_body
    assert "bccRecipients" not in patch_body
