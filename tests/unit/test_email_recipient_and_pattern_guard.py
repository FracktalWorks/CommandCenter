"""Unit tests for two robustness fixes:
  1. `_recipient_role` — a DETERMINISTIC direct-To vs Cc-only signal fed to the
     classifier and thread-status determiner (instead of the model parsing To/Cc).
  2. `_pattern_hit` FROM specificity guard — a short/generic learned value must
     not substring-match every sender (avoids over-granular pins)."""
from __future__ import annotations

from gateway.routes.email.automation.engine import _pattern_hit, _recipient_role


def _addr(*emails):
    return [{"name": "", "email": e} for e in emails]


# ── recipient role ───────────────────────────────────────────────────────────

def test_owner_in_to_is_direct() -> None:
    assert _recipient_role("me@acme.com", _addr("me@acme.com"), _addr("x@y.com")) \
        == "direct"


def test_owner_only_in_cc_is_cc() -> None:
    assert _recipient_role("me@acme.com", _addr("lead@y.com"), _addr("me@acme.com")) \
        == "cc"


def test_owner_in_both_prefers_direct() -> None:
    assert _recipient_role("me@acme.com", _addr("me@acme.com"),
                           _addr("me@acme.com")) == "direct"


def test_owner_absent_is_empty() -> None:
    assert _recipient_role("me@acme.com", _addr("a@y.com"), _addr("b@y.com")) == ""


def test_no_self_email_is_empty() -> None:
    assert _recipient_role("", _addr("me@acme.com"), []) == ""


def test_case_insensitive_and_str_json_tolerant() -> None:
    assert _recipient_role("ME@Acme.com", '[{"email":"me@acme.com"}]', "[]") \
        == "direct"


# ── FROM-pattern specificity guard ───────────────────────────────────────────

def test_domain_value_still_matches() -> None:
    assert _pattern_hit(("FROM", "acme.com"),
                        {"from": "billing@acme.com"}) is True


def test_full_address_value_matches() -> None:
    assert _pattern_hit(("FROM", "jo@acme.com"),
                        {"from": "jo@acme.com"}) is True


def test_full_sender_inside_value_matches() -> None:
    # value carries a display name around the address; sender is contained in it.
    assert _pattern_hit(("FROM", "jo <jo@acme.com>"),
                        {"from": "jo@acme.com"}) is True


def test_short_generic_value_no_longer_matches_everyone() -> None:
    # "abc" has no address/domain shape → must NOT substring-match a sender.
    assert _pattern_hit(("FROM", "abc"),
                        {"from": "abcdef@x.com"}) is False


def test_nonmatching_domain_is_false() -> None:
    assert _pattern_hit(("FROM", "other.com"),
                        {"from": "billing@acme.com"}) is False
