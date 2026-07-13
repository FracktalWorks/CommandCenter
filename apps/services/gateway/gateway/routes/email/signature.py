"""Outbound HTML-signature assembly.

The account signature is stored as HTML (authored in the workbench's hybrid
rich-text / HTML editor). At SEND time it is appended to the message as a
rendered HTML block, with a plain-text fallback derived by stripping tags — so
mail goes out ``multipart/alternative`` and the signature renders in every
client. Kept in ONE place so every send path (the full ``/send`` endpoint and
the native draft-send) produces the signature identically.

Signature injection lives here, at send time, rather than in the drafter: the
AI drafter returns the reply body only, and the signature is appended once here.
That avoids a doubled signature and keeps raw HTML tags out of the plain-text
compose box.
"""
from __future__ import annotations

import html as _html
import re

# A value that contains an HTML tag is treated as HTML; otherwise it's plain
# text the user typed and we escape + linebreak it.
_LOOKS_HTML_RE = re.compile(r"<[a-zA-Z!/][^>]*>")
_TAG_RE = re.compile(r"<[^>]+>")


def _looks_html(s: str) -> bool:
    return bool(_LOOKS_HTML_RE.search(s or ""))


def _text_to_html(s: str) -> str:
    """Escape plain text and turn newlines into <br> for an HTML part."""
    return _html.escape(s or "").replace("\n", "<br>")


def html_to_text(s: str) -> str:
    """A crude but serviceable plain-text rendering of HTML: block/break tags
    become newlines, remaining tags are stripped, entities are unescaped."""
    s = re.sub(r"(?i)<\s*br\s*/?>", "\n", s or "")
    s = re.sub(r"(?i)</\s*(p|div|tr|li|h[1-6]|table)\s*>", "\n", s)
    s = _TAG_RE.sub("", s)
    s = _html.unescape(s)
    # Collapse the runs of blank lines a table/markup strip can leave behind.
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def signature_html(signature: str) -> str:
    """The signature as an HTML fragment (HTML kept as-is; plain text escaped)."""
    sig = (signature or "").strip()
    if not sig:
        return ""
    return sig if _looks_html(sig) else _text_to_html(sig)


def signature_text(signature: str) -> str:
    """The signature as plain text (tags stripped when it's HTML)."""
    sig = (signature or "").strip()
    if not sig:
        return ""
    return html_to_text(sig) if _looks_html(sig) else sig


def build_signed_bodies(
    signature: str, body_text: str, body_html: str | None = None,
) -> tuple[str, str | None]:
    """Append the signature to a message in both representations.

    Returns ``(body_text, body_html)``:
      * ``body_text`` — the body plus the plain-text signature (deduped: skipped
        if that text is already present, e.g. an older draft that still has it).
      * ``body_html`` — the caller's HTML (or the plain body rendered to HTML)
        followed by the signature HTML block.

    With no signature set, returns the inputs unchanged — ``body_html`` stays
    ``None`` so a plain-text-only send is preserved exactly as before.
    """
    sig = (signature or "").strip()
    if not sig:
        return body_text, body_html

    sig_text = signature_text(sig)
    sig_html = signature_html(sig)

    out_text = body_text or ""
    if sig_text and sig_text not in out_text:
        out_text = f"{out_text.rstrip()}\n\n{sig_text}" if out_text.strip() else sig_text

    base_html = (
        body_html if (body_html and body_html.strip())
        else _text_to_html(body_text or "")
    )
    out_html = f"{base_html}<br><br>{sig_html}"
    return out_text, out_html
