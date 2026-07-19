"""Unit tests for the uncategorized-inbox sweep (automation/cleanup.py).

The sweep PROJECTS existing categorization onto inbox mail the rules never
reached — learned patterns first, then per-sender history, then per-domain
history. It must never invent a category: a message with no evidence is reported
as `no_evidence` and left alone for an actual rules run. These tests pin that
boundary, because a second classifier here is exactly the parallel-categorization
drift the rest of the email stack keeps paying down.
"""
from __future__ import annotations

from types import SimpleNamespace

from gateway.routes.email.automation import cleanup as c


def _msg(sender, subject="Hi", mid="m1"):
    return SimpleNamespace(
        id=mid, provider_message_id=f"p-{mid}", subject=subject,
        from_address={"email": sender, "name": ""}, received_at=None,
    )


def _decide(msg, *, patterns=None, rule_labels=None, sender=None, domain=None):
    return c._decide(msg, patterns or {}, rule_labels or {},
                     sender or {}, domain or {})


# ── evidence 1: learned patterns ────────────────────────────────────────────


def test_learned_from_pattern_wins() -> None:
    verdict = _decide(
        _msg("deals@shop.com"),
        patterns={"r1": {"include": [("FROM", "deals@shop.com")], "exclude": []}},
        rule_labels={"r1": "Marketing"},
    )
    assert verdict == ("Marketing", "learned pattern")


def test_learned_exclude_pattern_blocks_its_own_rule() -> None:
    """The user explicitly taught us this sender is NOT that rule. Honouring the
    exclude is the difference between learning and nagging."""
    verdict = _decide(
        _msg("deals@shop.com"),
        patterns={"r1": {"include": [("FROM", "shop.com")],
                         "exclude": [("FROM", "deals@shop.com")]}},
        rule_labels={"r1": "Marketing"},
    )
    assert verdict is None


def test_pattern_pointing_at_a_conversation_rule_is_ignored() -> None:
    """Only rules whose LABEL is a cleanup category feed the sweep. A pattern on
    a Reply/Awaiting rule is Reply Zero's business — the sweep must not stamp a
    conversation label as if it were a cleanup category."""
    verdict = _decide(
        _msg("boss@work.com"),
        patterns={"r1": {"include": [("FROM", "boss@work.com")], "exclude": []}},
        rule_labels={},          # the Reply rule was filtered out upstream
    )
    assert verdict is None


# ── evidence 2 & 3: sender / domain consensus ───────────────────────────────


def test_sender_history_consensus() -> None:
    verdict = _decide(_msg("news@site.com"),
                      sender={"news@site.com": {"Newsletter": 6}})
    assert verdict == ("Newsletter", "sender history")


def test_split_sender_history_is_not_a_coin_flip() -> None:
    """A sender evenly split between two categories teaches nothing. Guessing
    would be worse than leaving it uncategorized, because the cleaner offers
    destructive bulk actions on top of the category."""
    verdict = _decide(_msg("mixed@site.com"),
                      sender={"mixed@site.com": {"Newsletter": 3, "Receipt": 3}})
    assert verdict is None


def test_single_labelled_message_is_below_the_sender_bar() -> None:
    verdict = _decide(_msg("new@site.com"),
                      sender={"new@site.com": {"Newsletter": 1}})
    assert verdict is None


def test_domain_history_covers_a_brand_new_subaddress() -> None:
    verdict = _decide(_msg("billing@stripe.com"),
                      domain={"stripe.com": {"Receipt": 9}})
    assert verdict == ("Receipt", "domain history (stripe.com)")


def test_shared_free_mail_domains_never_form_a_consensus() -> None:
    """Every personal contact shares gmail.com. Inheriting one newsletter's
    category across that domain would bulk-label the user's actual humans."""
    verdict = _decide(_msg("friend@gmail.com"),
                      domain={"gmail.com": {"Marketing": 50}})
    assert verdict is None


def test_sender_history_outranks_domain_history() -> None:
    verdict = _decide(
        _msg("support@stripe.com"),
        sender={"support@stripe.com": {"Notification": 5}},
        domain={"stripe.com": {"Receipt": 40}},
    )
    assert verdict == ("Notification", "sender history")


def test_no_evidence_yields_nothing() -> None:
    assert _decide(_msg("stranger@nowhere.io")) is None


def test_message_with_no_sender_is_skipped() -> None:
    row = SimpleNamespace(id="m", provider_message_id="p", subject="x",
                          from_address={}, received_at=None)
    assert _decide(row) is None


# ── consensus helper ────────────────────────────────────────────────────────


def test_consensus_requires_both_volume_and_dominance() -> None:
    assert c._consensus({"Newsletter": 5}, 2, 0.8) == "Newsletter"
    assert c._consensus({"Newsletter": 1}, 2, 0.8) is None          # too few
    assert c._consensus({"Newsletter": 5, "Receipt": 4}, 2, 0.8) is None  # split
