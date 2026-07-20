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

The signature goes directly under the NEW text, ABOVE any quoted trailing
thread. The composer sends one ``body_text`` containing both (new text + "\\n\\n"
+ quote), so appending to the end of it put the signature underneath the whole
quoted conversation on every signed reply — see :mod:`.quoting` for the split.
"""
from __future__ import annotations

import html as _html
import re

from gateway.routes.email.quoting import split_quoted_html, split_quoted_text

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

    The signature is inserted directly under the NEW text and ABOVE any quoted
    trailing thread, which is where every mail client puts it. A reply arrives
    here as ONE ``body_text`` holding both parts, so a plain append pushed the
    signature below the entire quoted conversation.

    Returns ``(body_text, body_html)``:
      * ``body_text`` — new text + plain-text signature + the quote (deduped:
        the whole insert is skipped if the signature text is already present,
        e.g. an older draft that still carries it).
      * ``body_html`` — the caller's HTML (or the plain body rendered to HTML)
        with the signature HTML block in the same position.

    With no signature set, returns the inputs unchanged — ``body_html`` stays
    ``None`` so a plain-text-only send is preserved exactly as before.
    """
    sig = (signature or "").strip()
    if not sig:
        return body_text, body_html

    sig_text = signature_text(sig)
    sig_html = signature_html(sig)
    body_text = body_text or ""

    # Already signed (a re-signed draft): leave the text alone AND skip the HTML
    # block, so re-sending a stored draft can't end up with two signatures.
    if sig_text and sig_text in body_text:
        return body_text, (
            body_html if (body_html and body_html.strip())
            else _text_to_html(body_text)
        )

    main_text, quoted_text = split_quoted_text(body_text)
    out_text = (
        f"{main_text.rstrip()}\n\n{sig_text}" if main_text.strip() else sig_text
    )
    if quoted_text:
        out_text = f"{out_text}\n\n{quoted_text}"

    if body_html and body_html.strip():
        main_html, quoted_html = split_quoted_html(body_html)
        out_html = f"{main_html}<br><br>{sig_html}{quoted_html}"
    else:
        # Derived from the plain body — render the two halves separately so the
        # signature keeps its place above the quote here too.
        out_html = f"{_text_to_html(main_text)}<br><br>{sig_html}"
        if quoted_text:
            out_html += f"<br><br>{_text_to_html(quoted_text)}"
    return out_text, out_html
