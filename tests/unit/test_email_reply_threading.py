"""Reply threading: a sent reply must land in its conversation, not show up as
a standalone message in Sent.

These lock the provider-level threading contract that the reported bug broke:
  * Gmail send/update-draft must carry the conversation ``threadId`` (a reply
    that omits it starts a new thread — the "separate email in Sent" symptom).
  * Gmail must prefer the real ``thread_id`` over a message id for threadId.
  * IMAP must thread via In-Reply-To/References from the reply reference.
  * Gmail update_draft must keep an HTML (signed) body as HTML.
"""
from __future__ import annotations

import base64
from email import message_from_bytes
from unittest.mock import AsyncMock, MagicMock

from email_ingestion.providers.gmail import GmailProvider
from email_ingestion.providers.imap import IMAPProvider


def _gmail() -> GmailProvider:
    return GmailProvider({"access_token": "x", "refresh_token": "y",
                          "client_id": "c", "client_secret": "s"})


def _resp(json_value: dict | None = None) -> MagicMock:
    r = MagicMock()
    r.raise_for_status = MagicMock()
    r.is_success = True
    r.json = MagicMock(return_value=json_value or {})
    return r


async def test_gmail_send_threads_by_thread_id() -> None:
    """A reply carries the conversation threadId so Gmail keeps it in-thread."""
    p = _gmail()
    client = AsyncMock()
    client.post.return_value = _resp({"id": "m2"})
    p._get_client = AsyncMock(return_value=client)  # type: ignore[method-assign]

    await p.send_message(
        to=["a@b.com"], subject="Re: hi", body_text="hello",
        reply_to_message_id="msg-99", thread_id="thread-42")

    body = client.post.await_args.kwargs["json"]
    # Real thread id wins over the message id — passing the message id as
    # threadId is exactly what failed to thread before.
    assert body["threadId"] == "thread-42"


async def test_gmail_send_falls_back_to_reply_id_when_no_thread() -> None:
    p = _gmail()
    client = AsyncMock()
    client.post.return_value = _resp({"id": "m2"})
    p._get_client = AsyncMock(return_value=client)  # type: ignore[method-assign]

    await p.send_message(
        to=["a@b.com"], subject="Re: hi", body_text="hi",
        reply_to_message_id="thread-7")
    assert client.post.await_args.kwargs["json"]["threadId"] == "thread-7"


async def test_gmail_send_new_message_has_no_thread() -> None:
    p = _gmail()
    client = AsyncMock()
    client.post.return_value = _resp({"id": "m2"})
    p._get_client = AsyncMock(return_value=client)  # type: ignore[method-assign]

    await p.send_message(to=["a@b.com"], subject="Hi", body_text="new")
    assert "threadId" not in client.post.await_args.kwargs["json"]


async def test_gmail_send_carries_bcc() -> None:
    p = _gmail()
    client = AsyncMock()
    client.post.return_value = _resp({"id": "m2"})
    p._get_client = AsyncMock(return_value=client)  # type: ignore[method-assign]

    await p.send_message(
        to=["a@b.com"], subject="Hi", body_text="x", bcc=["secret@b.com"])
    raw = client.post.await_args.kwargs["json"]["raw"]
    msg = message_from_bytes(base64.urlsafe_b64decode(raw))
    assert msg["Bcc"] == "secret@b.com"


async def test_gmail_update_draft_keeps_thread_and_html() -> None:
    """Updating a reply draft must re-supply threadId (else Gmail un-threads it)
    and keep an HTML signed body as HTML."""
    p = _gmail()
    client = AsyncMock()
    client.put.return_value = _resp({"id": "draft-1"})
    p._get_client = AsyncMock(return_value=client)  # type: ignore[method-assign]

    await p.update_draft(
        "draft-1", to=["a@b.com"], subject="Re: hi",
        body_text="plain fallback", body_html="<p>signed</p>",
        thread_id="thread-42")

    message = client.put.await_args.kwargs["json"]["message"]
    assert message["threadId"] == "thread-42"
    msg = message_from_bytes(base64.urlsafe_b64decode(message["raw"]))
    assert msg.get_content_type() == "text/html"
    assert "<p>signed</p>" in msg.get_payload(decode=True).decode()


def _imap() -> IMAPProvider:
    return IMAPProvider({
        "smtp_host": "smtp.example.com", "smtp_port": 587,
        "smtp_username": "me@example.com", "smtp_password": "pw",
    })


async def test_imap_send_sets_reply_headers_from_thread_id() -> None:
    """IMAP threads via In-Reply-To/References; a message's thread_id is its own
    RFC Message-ID, so the reply target's thread_id is the right reference."""
    p = _imap()
    captured: dict[str, object] = {}

    def _fake_send(msg):  # type: ignore[no-untyped-def]
        captured["in_reply_to"] = msg["In-Reply-To"]
        captured["references"] = msg["References"]

    import smtplib
    server = MagicMock()
    server.send_message = _fake_send
    orig = smtplib.SMTP
    smtplib.SMTP = MagicMock(return_value=server)  # type: ignore[assignment]
    try:
        await p.send_message(
            to=["a@b.com"], subject="Re: hi", body_text="hello",
            thread_id="<msg-id@example.com>")
    finally:
        smtplib.SMTP = orig  # type: ignore[assignment]

    assert captured["in_reply_to"] == "<msg-id@example.com>"
    assert captured["references"] == "<msg-id@example.com>"
