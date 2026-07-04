"""Structure-aware compression of a single oversized message.

When one message overflows the context budget after whole-turn dropping (a long
email thread, a big JSON tool result, a huge pasted block), the context fitter
must shrink it. The default was a blind head+tail CHARACTER slice at arbitrary
byte offsets — which cuts through the middle of an email thread or JSON and
mangles the structure the model relies on.

``compress_message_content`` replaces that blind slice with structure detectors
that preserve meaning where they can, and falls back to the exact head+tail
slice on anything it doesn't recognize — so behavior never regresses below the
previous byte-slice, only improves on recognized shapes.

Detectors (deliberately few and well-tested):
  * email thread — keep the NEWEST message whole + a one-line header
    (from/subject/date) for each older quoted message that gets elided;
  * JSON — keep the structure, elide long string values to a marker;
  * fallback — head + tail around the truncation marker (the prior behavior).

Pure and deterministic (no LLM), so it stays fast and cache-friendly. Placed at
the per-message seam in ``fit_messages_to_context`` so BOTH callers
(``assemble_run_context`` and ``acompletion_with_fallback``) benefit.

See specs/runtime_agent_effectiveness_2026-07.md (Item ④).
"""
from __future__ import annotations

import json
import re

_ELIDED = "[… elided …]"

# Quoted-reply boundaries common to Gmail/Outlook/plain email threads.
# A line that starts a quoted older message: "On <date>, <person> wrote:",
# ">"-prefixed quote blocks, or Outlook "From:/Sent:/To:/Subject:" headers.
_EMAIL_BOUNDARY_RE = re.compile(
    r"(^On .+ wrote:$)"
    r"|(^-{2,} ?Original Message ?-{2,}$)"
    r"|(^_{5,}$)"
    r"|(^From: .+$)"
    r"|(^\s*>{1,}.*$)",
    re.MULTILINE,
)

_HEADER_RE = re.compile(
    r"^(From|To|Cc|Subject|Sent|Date): .+$", re.MULTILINE | re.IGNORECASE
)


def _head_tail(content: str, target_chars: int, marker: str) -> str:
    """The prior behavior: keep a head + tail around ``marker``. Guaranteed
    fallback — always fits ~target_chars, never fails."""
    keep = max(200, target_chars)
    head = (keep * 3) // 4
    tail = keep - head
    return content[:head] + marker + (content[-tail:] if tail else "")


def _compress_email_thread(content: str, target_chars: int, marker: str) -> str | None:
    """Keep the newest message whole; replace each older quoted message with a
    one-line header. Returns None if this doesn't look like a thread or can't
    be made to fit."""
    m = _EMAIL_BOUNDARY_RE.search(content)
    if not m:
        return None  # no quoted history — not a multi-message thread

    newest = content[: m.start()].rstrip()
    older = content[m.start():]

    # One-line summary of the elided history: the header lines that survive.
    header_lines = [ln for ln in older.splitlines() if _HEADER_RE.match(ln)]
    summary_bits = header_lines[:6]  # a few From/Subject/Date lines, no more
    summary = "\n".join(summary_bits)

    result = newest
    if summary:
        result += f"\n\n{marker}{summary}\n{_ELIDED}"
    else:
        result += f"\n\n{marker}{_ELIDED}"

    # If the newest message ALONE still overflows, fall back (head+tail the
    # newest). Better a clean slice of one message than a mangled thread.
    if len(result) > target_chars * 2:
        return _head_tail(newest, target_chars, marker)
    return result


def _compress_json(content: str, target_chars: int) -> str | None:
    """Keep JSON structure; elide long string values. Returns None if the
    content isn't JSON or the compacted form still overflows badly."""
    stripped = content.strip()
    if not (stripped.startswith("{") or stripped.startswith("[")):
        return None
    try:
        obj = json.loads(stripped)
    except (json.JSONDecodeError, ValueError):
        return None

    cap = max(80, target_chars // 40)  # per-string-value char cap

    def _walk(o):
        if isinstance(o, str):
            return o if len(o) <= cap else o[:cap] + _ELIDED
        if isinstance(o, list):
            # Keep the shape but cap very long arrays.
            if len(o) > 50:
                return [_walk(x) for x in o[:50]] + [_ELIDED]
            return [_walk(x) for x in o]
        if isinstance(o, dict):
            return {k: _walk(v) for k, v in o.items()}
        return o

    try:
        compacted = json.dumps(_walk(obj), separators=(",", ":"))
    except (TypeError, ValueError):
        return None
    if len(compacted) > target_chars * 2:
        return None  # still too big — let head+tail handle it
    return compacted


def compress_message_content(
    content: str,
    target_chars: int,
    *,
    marker: str = "\n\n[… content truncated to fit the model context window …]\n\n",
) -> str:
    """Shrink one oversized message toward ``target_chars``, structure-aware.

    Tries, in order: email-thread compression (keep newest + elide quoted
    history), JSON compaction (keep shape, elide long values), then the blind
    head+tail slice as a guaranteed fallback. Always returns a string that is
    substantially smaller than the input; never raises.
    """
    if not isinstance(content, str) or len(content) <= target_chars:
        return content
    try:
        email = _compress_email_thread(content, target_chars, marker)
        if email is not None and len(email) < len(content):
            return email
        js = _compress_json(content, target_chars)
        if js is not None and len(js) < len(content):
            return js
    except Exception:  # compression must never break the run
        pass
    return _head_tail(content, target_chars, marker)
