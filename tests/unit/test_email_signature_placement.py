"""The signature belongs under the NEW text, above the quoted thread.

Reported from production: an AI-drafted reply went out as

    Hi Suresh,
    Noted. Hope the appointment goes well.

    On 2026-07-19T14:47:23+00:00, Fracktal Finance wrote:
    > Hi, …

    Vijay              <- the signature, below the whole quoted thread

Two independent defects produced that, and each is covered here:

1. ``build_signed_bodies`` appended the signature to the END of ``body_text``.
   The composer sends ONE body — new text + "\\n\\n" + quote — so the signature
   landed under the quote on EVERY signed reply, AI-drafted or hand-written.
2. ``_llm_draft_reply`` never told the model not to quote the thread back (its
   sibling ``_llm_compose_assist`` did). The ISO-8601 timestamp in that quote
   header is our own ``_fetch_thread_context`` formatting, echoed by the model.
"""
from __future__ import annotations

import inspect

from gateway.routes.email.automation import drafting as dr
from gateway.routes.email.quoting import split_quoted_html, split_quoted_text
from gateway.routes.email.signature import build_signed_bodies

_SIG = "Vijay"
_QUOTE = (
    "On 2026-07-19T14:47:23+00:00, Fracktal Finance wrote:\n"
    "> Hi,\n"
    ">\n"
    "> Please consider my half day leave by tomorrow 20th July.\n"
)
_REPLY = "Hi Suresh,\n\nNoted. Hope the appointment goes well."


# ── the split ───────────────────────────────────────────────────────────────


def test_the_reported_quote_header_is_recognised() -> None:
    """An ISO timestamp in the header is unusual, so the marker must match on
    the "On … wrote:" shape rather than on any date format."""
    main, quoted = split_quoted_text(f"{_REPLY}\n\n{_QUOTE}")
    assert main == _REPLY
    assert quoted.startswith("On 2026-07-19T14:47:23+00:00")


def test_a_bare_angle_bracket_chain_is_a_quote() -> None:
    main, quoted = split_quoted_text("Sounds good.\n\n> earlier text\n> more")
    assert main == "Sounds good."
    assert quoted == "> earlier text\n> more"


def test_from_alone_is_not_a_boundary() -> None:
    """"From:" only counts when it heads a real header block — otherwise a
    sentence that happens to start with it would truncate the message."""
    body = "Thanks!\n\nFrom: the whole team, congratulations.\n\nSee you Monday."
    main, quoted = split_quoted_text(body)
    assert quoted == ""
    assert main == body


def test_from_heading_a_header_block_is_a_boundary() -> None:
    body = ("Thanks!\n\nFrom: Suresh Nagaraj\nSent: 19 July 2026\n"
            "To: Vijay\nSubject: Leave\n\nHi,")
    main, quoted = split_quoted_text(body)
    assert main == "Thanks!"
    assert quoted.startswith("From: Suresh Nagaraj")


def test_a_body_that_is_only_a_quote_is_left_whole() -> None:
    """A forward can be nothing but the quoted mail. Splitting it would leave no
    "new text" for the signature to sit under, so don't split at all."""
    body = "> just the quote\n> and more"
    assert split_quoted_text(body) == (body, "")


def test_an_unquoted_body_is_returned_verbatim() -> None:
    main, quoted = split_quoted_text(_REPLY)
    assert (main, quoted) == (_REPLY, "")


# ── placement ───────────────────────────────────────────────────────────────


def test_signature_sits_above_the_quote() -> None:
    """The regression itself: signature between the reply and the quote."""
    text, _html = build_signed_bodies(_SIG, f"{_REPLY}\n\n{_QUOTE}")
    assert text.index(_SIG) < text.index("On 2026-07-19"), (
        "the signature is below the quoted thread again"
    )
    assert text.startswith(_REPLY)


def test_the_quote_survives_signing_verbatim() -> None:
    """Repositioning must never drop or rewrite the quoted conversation."""
    text, _html = build_signed_bodies(_SIG, f"{_REPLY}\n\n{_QUOTE}")
    for line in _QUOTE.strip().splitlines():
        assert line in text


def test_html_part_places_the_signature_the_same_way() -> None:
    """The composer sends no HTML, so the HTML part is derived from the text —
    and it had the identical bug."""
    _text, html = build_signed_bodies(_SIG, f"{_REPLY}\n\n{_QUOTE}")
    assert html is not None
    assert html.index(_SIG) < html.index("On 2026-07-19")


def test_an_unquoted_message_still_gets_the_signature_appended() -> None:
    text, html = build_signed_bodies(_SIG, "Quick note.")
    assert text == "Quick note.\n\nVijay"
    assert html is not None and _SIG in html


def test_no_signature_configured_changes_nothing() -> None:
    body = f"{_REPLY}\n\n{_QUOTE}"
    assert build_signed_bodies("", body) == (body, None)


def test_an_already_signed_body_is_not_signed_twice() -> None:
    """Re-sending a stored draft must not stack signatures — in either part."""
    body = f"{_REPLY}\n\n{_SIG}\n\n{_QUOTE}"
    text, html = build_signed_bodies(_SIG, body)
    assert text.count(_SIG) == 1
    assert html is not None and html.count(_SIG) == 1


def test_html_bodies_split_on_provider_quote_containers() -> None:
    main, quoted = split_quoted_html(
        '<div>Noted.</div><div id="appendonsend"></div><blockquote>old</blockquote>'
    )
    assert main == "<div>Noted.</div>"
    assert quoted.startswith('<div id="appendonsend"')


def test_unrecognised_html_falls_back_to_appending() -> None:
    """No known marker → behave exactly as before rather than guess."""
    raw = "<p>Just a note.</p>"
    _text, html = build_signed_bodies(_SIG, "Just a note.", raw)
    assert html is not None and html.startswith(raw)


# ── the drafter ─────────────────────────────────────────────────────────────


def test_the_reply_drafter_forbids_quoting() -> None:
    """The rule ``_llm_compose_assist`` had and ``_llm_draft_reply`` lacked."""
    src = inspect.getsource(dr._llm_draft_reply)
    assert "NEVER quote the earlier" in src
    assert "wrote:" in src, "the quote-header example was dropped from the rule"


def test_a_model_authored_quote_is_stripped_from_the_draft() -> None:
    """Belt and braces — the prompt is an instruction, not a guarantee, and the
    client reattaches the real quote itself."""
    assert dr._clean_draft_body(f"{_REPLY}\n\n{_QUOTE}") == _REPLY


def test_cleaning_leaves_an_honest_draft_alone() -> None:
    assert dr._clean_draft_body(_REPLY) == _REPLY


def test_cleaning_still_removes_placeholder_lines() -> None:
    """The original job of _clean_draft_body must survive the addition."""
    assert "[Your Name]" not in dr._clean_draft_body(f"{_REPLY}\n\n[Your Name]")
