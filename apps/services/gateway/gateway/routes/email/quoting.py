"""Quoted / trailing-mail detection — the Python counterpart of the frontend's
``email/lib/quoting.ts``.

A reply carries the whole earlier conversation quoted underneath the new text.
Two server-side jobs need to know where that boundary is:

* **Signing** — the account signature belongs directly under the *new* text, not
  at the very bottom of the message. Appending it to the end put it below the
  quoted thread on every signed reply.
* **Drafting** — the AI drafter is told never to quote the thread back; this is
  the belt-and-braces strip for when it does anyway.

The markers mirror ``TEXT_BOUNDARY`` / ``findQuoteBoundary`` in quoting.ts, so
the client and the server agree on where a quote starts. Both splitters are
conservative: anything they can't confidently split is returned whole, because
losing the user's own words is far worse than a misplaced signature.
"""
from __future__ import annotations

import re

# Plain-text markers that begin a quoted block (quoting.ts TEXT_BOUNDARY).
_TEXT_BOUNDARY: tuple[re.Pattern[str], ...] = (
    re.compile(r"^>"),
    re.compile(r"^\s*On\b.+\bwrote:\s*$", re.IGNORECASE),
    re.compile(r"^-{2,}\s*Original Message\s*-{2,}", re.IGNORECASE),
    re.compile(r"^-{2,}\s*Forwarded message\s*-{2,}", re.IGNORECASE),
    re.compile(r"^_{5,}\s*$"),
    re.compile(r"^From:\s.+\S", re.IGNORECASE),
)
_FROM_LINE = re.compile(r"^From:\s", re.IGNORECASE)
_HEADER_AHEAD = re.compile(r"\n(Sent|Date|To|Subject):", re.IGNORECASE)


def split_quoted_text(text: str) -> tuple[str, str]:
    """Split a plain-text body into ``(new_text, quoted_trailing)``.

    ``quoted_trailing`` is "" when there is no quote, when the quote would start
    at line 0 (a forward that is *only* a quote), or when nothing meaningful is
    left above it — in those cases ``new_text`` is the input verbatim.
    """
    lines = (text or "").split("\n")
    idx = -1
    # Scanned from line 0, unlike quoting.ts (which starts at 1). If the FIRST
    # line is already inside a quote the whole body is one — the ``idx < 1``
    # guard below then returns it whole, instead of cutting between two quoted
    # lines and signing in the middle of somebody else's email.
    for i in range(len(lines)):
        line = lines[i]
        if not any(rx.match(line) for rx in _TEXT_BOUNDARY):
            continue
        # "From:" alone is a weak signal — only a quote boundary when it heads a
        # header block (a nearby Sent/Date/To/Subject line follows). Otherwise a
        # sentence like "From: the team" would truncate the message.
        if _FROM_LINE.match(line):
            ahead = "\n" + "\n".join(lines[i:i + 5])
            if not _HEADER_AHEAD.search(ahead):
                continue
        idx = i
        break
    if idx < 1:
        return text, ""
    main = "\n".join(lines[:idx]).rstrip()
    if not main.strip():
        return text, ""
    quoted = "\n".join(lines[idx:]).strip()
    return (main, quoted) if quoted else (text, "")


# HTML containers that begin a quoted block, most reliable first (quoting.ts
# findQuoteBoundary). Regex rather than a DOM parse: the gateway has no HTML
# parser dependency, and an unrecognised body simply falls through unsplit.
_HTML_BOUNDARY: tuple[re.Pattern[str], ...] = (
    re.compile(r"<div[^>]*\bid=[\"']?appendonsend\b", re.IGNORECASE),      # Outlook web
    re.compile(r"<div[^>]*\bid=[\"']?divRplyFwdMsg\b", re.IGNORECASE),     # Outlook desktop
    re.compile(r"<div[^>]*\bclass=[\"'][^\"']*gmail_quote", re.IGNORECASE),
    re.compile(r"<div[^>]*\bclass=[\"'][^\"']*moz-cite-prefix", re.IGNORECASE),
    re.compile(r"<blockquote[^>]*\btype=[\"']?cite", re.IGNORECASE),
    re.compile(r"<blockquote\b", re.IGNORECASE),
)
# Outlook draws a divider above the quote header; pull it into the quote so the
# signature doesn't land between the rule and the thread it belongs to.
_HR_BEFORE = re.compile(r"<hr\b[^>]*>(?:\s|<br\s*/?>|<div[^>]*>|</div>)*$", re.IGNORECASE)


def split_quoted_html(raw: str) -> tuple[str, str]:
    """Split an HTML body into ``(new_html, quoted_html)``.

    Same contract as :func:`split_quoted_text`: returns ``("", …)`` never — on
    anything it cannot split it returns ``(raw, "")``. A boundary at position 0
    is ignored (the body would be nothing but a quote).
    """
    if not (raw or "").strip():
        return raw, ""
    cut = -1
    for rx in _HTML_BOUNDARY:
        m = rx.search(raw)
        if m:
            cut = m.start()
            break
    if cut <= 0:
        return raw, ""
    head = raw[:cut]
    hr = _HR_BEFORE.search(head)
    if hr:
        cut = hr.start()
        head = raw[:cut]
    # Nothing but markup above the quote → don't split (an empty "new" part would
    # put the signature at the top of a bare forward).
    if not re.sub(r"<[^>]*>", "", head).replace("&nbsp;", " ").strip() \
            and "<img" not in head.lower():
        return raw, ""
    return head, raw[cut:]
