"""Contact-card signature parsing — the card must not invent contact details.

The people card behind a sender's name reads phone/title/company out of the
sender's own signature. That parse is the only place the card guesses, so it is
pinned here from both directions: it finds what a real signature carries, and it
stays silent on order numbers, dates, and quoted replies (where the "signature"
belongs to whoever was being replied TO, not to the sender).
"""

from __future__ import annotations

import inspect

from gateway.routes.email.transport import contacts as C
from gateway.routes.email.transport.contacts import (
    _org_from_domain,
    _parse_links,
    _parse_phones,
    _parse_title_and_org,
    _preview,
    _signature_block,
)


class _Row:
    def __init__(self, snippet: str = "", body_text: str = ""):
        self.snippet = snippet
        self.body_text = body_text


_INTL_SIG = """Thanks, that works.

--
Priya Sharma
Head of Partnerships
Fracktal Works Pvt Ltd
Mobile: +91 98765 43210 | Office: 080-4567-8900
https://fracktal.in
"""

_US_SIG = """Best,
Alex Morgan
VP Engineering
Acme Corp
T: (415) 555-0132
www.acme.com
"""


def test_signature_block_stops_at_the_quoted_reply():
    body = _INTL_SIG + (
        "\nOn Mon, Jul 20, 2026 at 9:12 AM Alex <alex@acme.com> wrote:\n"
        "> Regards, Alex Morgan\n> Mobile: +1 415 555 0132\n"
    )
    block = _signature_block(body)
    assert "Priya Sharma" in block
    assert "Alex Morgan" not in block
    # The other person's number must not become this contact's number.
    assert _parse_phones(block) == ["+91 98765 43210", "080-4567-8900"]


def test_parses_international_signature():
    block = _signature_block(_INTL_SIG)
    assert _parse_phones(block) == ["+91 98765 43210", "080-4567-8900"]
    assert _parse_links(block) == ["https://fracktal.in"]
    assert _parse_title_and_org(block, "Priya Sharma") == (
        "Head of Partnerships", "Fracktal Works Pvt Ltd")


def test_parses_us_signature_with_parenthesised_area_code():
    block = _signature_block(_US_SIG)
    assert _parse_phones(block) == ["(415) 555-0132"]
    # A bare www. link is served href-ready.
    assert _parse_links(block) == ["https://www.acme.com"]
    assert _parse_title_and_org(block, "Alex Morgan") == ("VP Engineering", "Acme Corp")


def test_deduplicates_one_number_written_twice():
    block = _signature_block("Sam Rao\nCTO\nTel: +91 98765 43210\nWhatsApp: 9876543210\n")
    assert _parse_phones(block) == ["+91 98765 43210"]


def test_never_reads_a_phone_out_of_ids_or_dates():
    for body in (
        "Your order 20260727 has shipped. Invoice #98765432, total 12,499.00 INR.",
        "Meeting on 2026-07-27 at 14:30, room 4501.",
        "Tracking number 1Z999AA10123456784 is now active.",
    ):
        assert _parse_phones(_signature_block(body)) == [], body


def test_marketing_plumbing_is_not_the_senders_link():
    block = _signature_block(
        "Read more at https://news.example.com/a?utm_source=x\n"
        "Unsubscribe: https://click.list-manage.com/u/abc\n"
    )
    assert _parse_links(block) == []


def test_title_needs_the_name_to_anchor_on():
    # Without a display name to find in the block there is no reliable signal,
    # so the parser must decline rather than pick an arbitrary line.
    assert _parse_title_and_org(_signature_block(_US_SIG), None) == (None, None)
    assert _parse_title_and_org(_signature_block(_US_SIG), "Someone Else") == (None, None)


def test_free_mail_domain_is_never_an_organisation():
    assert _org_from_domain("gmail.com") is None
    assert _org_from_domain("proton.me") is None
    assert _org_from_domain("fracktal.in") == "Fracktal"
    assert _org_from_domain(None) is None


def test_every_query_is_scoped_to_the_callers_own_accounts():
    """The card is keyed by a bare email address, so nothing but the account
    scope stands between it and another user's mail. Every SELECT over
    email_messages must go through ``_account_scope`` (which resolves
    email_accounts.user_id), and the rollup lookups must filter on :uid too."""
    src = inspect.getsource(C.contact_card)
    assert "_account_scope(account_id, params)" in src
    # Three statements read mail/rollups; each must carry a user predicate.
    for fragment in ("FROM email_messages em\n                 WHERE {from_them}",
                     "WHERE {scope}"):
        assert fragment in src, fragment
    assert src.count("WHERE user_id = :uid") >= 2, (
        "the email_senders / email_newsletters lookups must be scoped to the "
        "caller's accounts, not matched on the address alone"
    )
    assert "user.email or \"anonymous\"" in src


def test_the_users_own_drafts_are_not_correspondence_from_the_contact():
    """A draft the user wrote sits in their mailbox; some providers echo the
    counterparty into from_address. Counting those would inflate every stat and
    put an unsent draft on the card as if the person had sent it."""
    src = inspect.getsource(C.contact_card)
    assert "<> 'drafts'" in src


def test_preview_prefers_the_snippet_and_truncates():
    assert _preview(_Row(snippet="  hello   there \n")) == "hello there"
    assert _preview(_Row(body_text="x" * 500)).endswith("…")
    assert len(_preview(_Row(body_text="x" * 500))) == 181
    assert _preview(_Row()) == ""
