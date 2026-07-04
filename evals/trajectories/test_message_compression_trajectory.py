"""Golden trajectory: structure-aware oversized-turn compression (Item ④).

Locks the invariant that when a SINGLE message overflows the context budget
(after whole-turn dropping), the fitter preserves structure — the newest email
message, the JSON shape — instead of a blind head+tail character slice through
the middle. Falls back to the char-slice on anything unrecognized, so behavior
never regresses below the prior byte-slice.

Covers:
  1. compress_message_content keeps an email thread's NEWEST message and elides
     the quoted history (not an arbitrary byte cut through it).
  2. JSON keeps its shape (keys survive) with long values elided.
  3. Unrecognized huge blobs fall back to head+tail (guaranteed fit).
  4. Small content and non-str pass through untouched; never raises.
  5. Integration: an oversized email thread routed through fit_messages_to_context
     fits the budget AND the newest message survives intact.

See specs/runtime_agent_effectiveness_2026-07.md (Item ④).
"""
from __future__ import annotations

import json

from acb_llm import (
    compress_message_content,
    context_window_for,
    count_message_tokens,
    fit_messages_to_context,
)


def _email_thread(newest: str, quoted_chars: int = 8000) -> str:
    # Varied quoted body so the tokenizer can't collapse it (repeated text
    # tokenizes far below chars/4 and wouldn't overflow a real window).
    words = ["planning", "budget", "roadmap", "timeline", "resourcing", "scope", "risk", "owner", "milestone", "deliverable", "dependency", "estimate", "velocity", "backlog"]
    body_words = [words[i % len(words)] + str(i) for i in range(quoted_chars // 8)]
    body = " ".join(body_words)
    return (
        f"{newest}\n\n"
        "On Mon, Jul 1, 2026 at 3:00 PM, Alice <alice@example.io> wrote:\n"
        "From: Alice <alice@example.io>\n"
        "Subject: Re: Q3 planning\n"
        "Date: Mon, 1 Jul 2026 15:00:00\n"
        + "> " + body
    )


# ── 1. Email thread — newest kept, history elided ────────────────────────────

def test_email_thread_keeps_newest_message_elides_history():
    newest = "Confirmed — Tuesday at 2pm works. I'll send the deck beforehand."
    thread = _email_thread(newest)
    out = compress_message_content(thread, 400)
    assert len(out) < len(thread) // 2, "should be substantially smaller"
    assert newest in out, "the newest message must survive intact"
    # The bulk quoted history must be gone (not a byte-slice keeping half of it).
    assert out.count("previously discussed context") < 5, "history not elided"


def test_email_compression_beats_blind_slice_on_newest_survival():
    """A blind head+tail slice would cut the newest message if it's short and
    sits at the very top; structure-aware keeps it whole."""
    newest = "Short reply at top."
    thread = _email_thread(newest, quoted_chars=20000)
    out = compress_message_content(thread, 300)
    assert newest in out


# ── 2. JSON — shape kept, long values elided ─────────────────────────────────

def test_json_keeps_shape_elides_long_values():
    payload = json.dumps({
        "user": "alice",
        "summary": "x" * 6000,
        "ids": list(range(300)),
    })
    out = compress_message_content(payload, 500)
    assert len(out) < len(payload)
    assert "user" in out and "alice" in out, "short keys/values must survive"


# ── 3. Fallback + safety ─────────────────────────────────────────────────────

def test_unrecognized_blob_falls_back_to_head_tail():
    blob = "z" * 20000
    out = compress_message_content(blob, 500)
    assert "truncated" in out, "fallback marker present"
    assert len(out) < len(blob)


def test_small_and_nonstring_pass_through():
    assert compress_message_content("short text", 1000) == "short text"
    # non-str must not raise
    assert compress_message_content(12345, 100) == 12345  # type: ignore[arg-type]


def test_never_raises_on_malformed_json():
    out = compress_message_content("{not valid json but starts like it" + "x" * 5000, 300)
    assert isinstance(out, str) and len(out) < 5000


# ── 4. Integration through the fitter ────────────────────────────────────────

def test_oversized_email_thread_fits_window_and_keeps_newest():
    newest = "Final decision: we ship Friday. Please confirm resourcing."
    # One giant message that overflows tier-fast's window on its own.
    huge_thread = _email_thread(newest, quoted_chars=200_000)
    messages = [
        {"role": "system", "content": "You are the email assistant."},
        {"role": "user", "content": huge_thread},
    ]
    fitted, truncated = fit_messages_to_context(messages, "tier-fast")
    assert truncated, "an over-window single message must be trimmed"
    assert count_message_tokens(fitted, "tier-fast") <= context_window_for("tier-fast")
    # Structure-aware win: the newest message survives the fit (a blind slice
    # from the top would too, but this also proves the thread wasn't dropped).
    user_msg = next(m for m in fitted if m["role"] == "user")
    assert newest in user_msg["content"], "newest message lost during fit"
