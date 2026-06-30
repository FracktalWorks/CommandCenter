"""Inline images must not be ingested as attachments.

Inline ``cid:`` body images (signature logos, pasted screenshots) carry a
filename like a real file, so a naive "any part with a filename" rule turns a
one-line signature email into "3 attachments" and floods the reading pane.
Gmail and Outlook both used to do that; these tests pin the fix. (IMAP and the
inbound SMTP path already filter on ``Content-Disposition: attachment``.)
"""
from __future__ import annotations

from email_ingestion.providers.gmail import _collect_gmail_attachments
from email_ingestion.providers.outlook import (
    OutlookProvider,
    _outlook_attachments,
)

# ── Gmail ────────────────────────────────────────────────────────────────

def _gmail_part(filename, att_id, *, disposition=None, content_id=None, mime="image/png"):
    headers = []
    if disposition is not None:
        headers.append({"name": "Content-Disposition", "value": disposition})
    if content_id is not None:
        headers.append({"name": "Content-ID", "value": content_id})
    return {
        "filename": filename,
        "mimeType": mime,
        "headers": headers,
        "body": {"attachmentId": att_id, "size": 1234},
    }


def test_gmail_skips_inline_keeps_real_attachment() -> None:
    payload = {
        "parts": [
            _gmail_part("report.pdf", "att-real", disposition="attachment", mime="application/pdf"),
            _gmail_part("logo.png", "att-logo", disposition="inline", content_id="<logo>"),
        ]
    }
    atts = _collect_gmail_attachments(payload, "m1")
    assert [a.filename for a in atts] == ["report.pdf"]
    assert atts[0].provider_attachment_id == "att-real"
    assert atts[0].id == "m1_att-real"


def test_gmail_skips_part_with_content_id_and_no_disposition() -> None:
    # No explicit disposition but a Content-ID → referenced from the body.
    payload = {"parts": [_gmail_part("sig.gif", "att-sig", content_id="<sig>")]}
    assert _collect_gmail_attachments(payload, "m2") == []


def test_gmail_walks_nested_multiparts() -> None:
    # multipart/mixed → [ multipart/related → [text, inline img], real.pdf ]
    payload = {
        "parts": [
            {
                "mimeType": "multipart/related",
                "parts": [
                    {"mimeType": "text/html", "body": {"data": ""}},
                    _gmail_part("inline.png", "att-inline", disposition="inline", content_id="<x>"),
                ],
            },
            _gmail_part("deck.pdf", "att-deck", disposition="attachment", mime="application/pdf"),
        ]
    }
    atts = _collect_gmail_attachments(payload, "m3")
    assert [a.filename for a in atts] == ["deck.pdf"]


def test_gmail_requires_attachment_id() -> None:
    # A filename with no downloadable attachmentId isn't a real attachment.
    part = _gmail_part("ghost.png", "", disposition="attachment")
    assert _collect_gmail_attachments({"parts": [part]}, "m4") == []


# ── Outlook ──────────────────────────────────────────────────────────────

def _graph_att(att_id, name, *, is_inline=False):
    return {
        "id": att_id,
        "name": name,
        "contentType": "image/png",
        "size": 999,
        "isInline": is_inline,
    }


def test_outlook_skips_inline_keeps_real_attachment() -> None:
    raw = {
        "attachments": [
            _graph_att("a-logo", "logo.png", is_inline=True),
            _graph_att("a-file", "invoice.pdf"),
        ]
    }
    atts = _outlook_attachments(raw)
    assert [a.filename for a in atts] == ["invoice.pdf"]
    assert atts[0].provider_attachment_id == "a-file"


def _outlook_provider() -> OutlookProvider:
    return OutlookProvider({
        "access_token": "x", "refresh_token": "y",
        "client_id": "c", "client_secret": "s",
    })


def test_outlook_inline_only_message_has_no_attachments_flag() -> None:
    # Detail fetch (attachments expanded) of an inline-only signature email:
    # Graph's hasAttachments is True, but after filtering there are none, so the
    # paperclip must not promise files that aren't there.
    raw = {
        "id": "g1",
        "hasAttachments": True,
        "attachments": [_graph_att("a-logo", "logo.png", is_inline=True)],
        "body": {"contentType": "html", "content": "<p>hi</p>"},
    }
    msg = _outlook_provider()._parse_graph_message(raw)
    assert msg.attachments == []
    assert msg.has_attachments is False


def test_outlook_list_fetch_trusts_graph_flag() -> None:
    # List fetch doesn't $expand attachments, so fall back to Graph's flag.
    raw = {"id": "g2", "hasAttachments": True, "body": {"contentType": "html", "content": ""}}
    msg = _outlook_provider()._parse_graph_message(raw)
    assert msg.attachments == []
    assert msg.has_attachments is True
