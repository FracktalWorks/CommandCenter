"""Unit tests for learned classification-pattern matching (inbox-zero parity:
bidirectional FROM, number-generalised SUBJECT)."""
from __future__ import annotations

from gateway.routes import email as m

_eng = m.automation.engine


def test_generalize_subject_strips_numbers_parens_and_ids() -> None:
    assert _eng._generalize_subject("Invoice (#1234) - Order 5678") == "Invoice - Order"


def test_subject_pattern_matches_across_different_numbers() -> None:
    # A learned "Invoice …" pattern should still match a differently-numbered one.
    assert _eng._pattern_hit(("SUBJECT", "Invoice 0001"),
                             {"subject": "Invoice 9999 is due"})


def test_subject_pattern_plain_substring_still_matches() -> None:
    assert _eng._pattern_hit(("SUBJECT", "newsletter"),
                             {"subject": "Weekly newsletter"})


def test_from_pattern_is_bidirectional() -> None:
    # Stored value broader than the from, and vice-versa, both match.
    assert _eng._pattern_hit(("FROM", "Alice <alice@acme.com>"),
                             {"from": "alice@acme.com"})
    assert _eng._pattern_hit(("FROM", "@acme.com"), {"from": "bob@acme.com"})


def test_from_pattern_empty_from_never_matches() -> None:
    assert not _eng._pattern_hit(("FROM", "alice@acme.com"), {"from": ""})


# ── Over-match guards ───────────────────────────────────────────────────────
# A learned pattern SHORT-CIRCUITS the classifier (engine._match_email_to_rule
# returns on a pattern hit with source="pattern" — no LLM, no static check), so
# an over-broad pattern doesn't just add noise, it silently overrides every
# other signal for as long as it exists. These pin the two ways that happened.


def test_generalised_subject_that_collapses_to_noise_never_matches() -> None:
    """The Fix dialog pre-fills the subject box with the FULL subject, so a user
    correcting an email titled "Re: 12345" stores exactly that. Generalised, it
    becomes "re:" — a substring of every reply in the mailbox. One click used to
    permanently mislabel all replies."""
    assert not _eng._pattern_hit(("SUBJECT", "Re: 12345"),
                                 {"subject": "Re: lunch tomorrow?"})
    assert not _eng._pattern_hit(("SUBJECT", "Fwd: 88"),
                                 {"subject": "Fwd: the deck"})


def test_generalised_single_short_word_does_not_match_unrelated_mail() -> None:
    # "Order #1042" generalises to "order" — must not match "Reorder …".
    assert not _eng._pattern_hit(("SUBJECT", "Order #1042"),
                                 {"subject": "Reorder your prescription"})


def test_specific_generalised_subjects_still_match() -> None:
    # The guard must not break the feature it protects: a real multi-word
    # pattern still matches across differing IDs.
    assert _eng._pattern_hit(("SUBJECT", "Invoice #1042 from Acme"),
                             {"subject": "Invoice #99 from Acme"})
    # And an exact literal always matches, however short.
    assert _eng._pattern_hit(("SUBJECT", "Re: 12345"),
                             {"subject": "Re: 12345"})


def test_from_pattern_does_not_match_a_suffix_address() -> None:
    """"reply@github.com" is a substring of "noreply@github.com" but a DIFFERENT
    address. The bidirectional FROM check used to accept it, routing genuine
    reply-address mail onto a rule learned for the no-reply address."""
    assert not _eng._pattern_hit(("FROM", "noreply@github.com"),
                                 {"from": "reply@github.com"})
    assert not _eng._pattern_hit(("FROM", "no-reply@stripe.com"),
                                 {"from": "reply@stripe.com"})


def test_from_pattern_still_matches_the_real_cases() -> None:
    assert _eng._pattern_hit(("FROM", "noreply@github.com"),
                             {"from": "noreply@github.com"})
    assert _eng._pattern_hit(("FROM", "Jo <jo@x.com>"), {"from": "jo@x.com"})
    # Bare-domain patterns keep matching every address on that domain.
    assert _eng._pattern_hit(("FROM", "github.com"),
                             {"from": "noreply@github.com"})
    assert _eng._pattern_hit(("FROM", "github.com"),
                             {"from": "x@mail.github.com"})
    assert not _eng._pattern_hit(("FROM", "github.com"),
                                 {"from": "x@notgithub.com"})
