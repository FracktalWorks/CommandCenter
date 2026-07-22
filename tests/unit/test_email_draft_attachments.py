"""Drafts must carry attachments, not just Cc/Bcc.

Before this, attachment content forced every composer down a full-send detour
(a fresh, unthreaded message) because the draft write-path couldn't upload
files. Now create_draft/update_draft push the bytes onto the provider draft, so
a reply-with-attachment saves as a threaded draft and sends natively. These pin:

  * Outlook update_draft POSTs new attachments to the draft's collection;
  * a body-only autosave (no attachments) never touches the attachments endpoint
    — so repeated auto-saves can't duplicate files;
  * the endpoint resolver decodes base64 uploads into the provider shape.
"""
from __future__ import annotations

import base64
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from email_ingestion.providers.outlook import OutlookProvider


def _provider() -> OutlookProvider:
    return OutlookProvider({"access_token": "t", "refresh_token": "r"})


def _resp(json_body: dict | None = None):
    return SimpleNamespace(
        status_code=200, headers={},
        json=lambda: (json_body or {"id": "draft-1"}),
        raise_for_status=lambda: None)


def _attachment_posts(client: AsyncMock) -> list[dict]:
    """The JSON bodies of every POST to a draft's attachments collection."""
    return [
        c.kwargs["json"]
        for c in client.post.await_args_list
        if "/attachments" in c.args[0]
    ]


async def test_update_draft_uploads_attachments() -> None:
    p = _provider()
    client = AsyncMock()
    client.patch.return_value = _resp()
    client.post.return_value = _resp()
    p._http = client
    await p.update_draft(
        "draft-1", body_text="hi",
        attachments=[{"filename": "q.pdf", "content": b"PDF-BYTES",
                      "mime_type": "application/pdf"}])
    posts = _attachment_posts(client)
    assert len(posts) == 1
    att = posts[0]
    assert att["name"] == "q.pdf"
    assert att["contentType"] == "application/pdf"
    assert base64.b64decode(att["contentBytes"]) == b"PDF-BYTES"


async def test_update_draft_without_attachments_skips_the_endpoint() -> None:
    # A body-only autosave must not POST to /attachments — otherwise every
    # keystroke-save would re-upload and duplicate the files.
    p = _provider()
    client = AsyncMock()
    client.patch.return_value = _resp()
    client.post.return_value = _resp()
    p._http = client
    await p.update_draft("draft-1", body_text="hi")
    assert _attachment_posts(client) == []


async def test_create_standalone_draft_uploads_attachments() -> None:
    p = _provider()
    client = AsyncMock()
    client.post.return_value = _resp()
    p._http = client
    await p.create_draft(
        to=["a@x.com"], subject="s", body_text="b",
        attachments=[{"filename": "a.txt", "content": b"DATA",
                      "mime_type": "text/plain"}])
    posts = _attachment_posts(client)
    assert len(posts) == 1
    assert base64.b64decode(posts[0]["contentBytes"]) == b"DATA"


def test_resolver_decodes_base64_uploads() -> None:
    from gateway.routes.email.automation.drafting import (
        _resolve_draft_attachments,
    )
    from gateway.routes.email.transport.send import SendAttachment

    out = _resolve_draft_attachments(
        [SendAttachment(filename="x.bin", mime_type="application/octet-stream",
                        content_b64=base64.b64encode(b"\x00\x01\x02").decode())],
        None,
    )
    assert out == [{
        "filename": "x.bin",
        "mime_type": "application/octet-stream",
        "content": b"\x00\x01\x02",
    }]


def test_resolver_rejects_bad_base64() -> None:
    from fastapi import HTTPException
    from gateway.routes.email.automation.drafting import (
        _resolve_draft_attachments,
    )
    from gateway.routes.email.transport.send import SendAttachment

    with pytest.raises(HTTPException) as exc:
        _resolve_draft_attachments(
            [SendAttachment(filename="x", content_b64="!!not-base64!!")], None)
    assert exc.value.status_code == 400
