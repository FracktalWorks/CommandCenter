"""Unit tests for `_draft_direction_note` — the drafter's direction (internal vs
external) + recipient-role (To vs Cc-only) steer. These signals are computed for
the classifier (sender_scope + To/Cc) but were being dropped at the drafting
stage, so a reply to a colleague read the same as one to an external customer and
a Cc-only mail still got a full draft."""
from __future__ import annotations

from gateway.routes.email.automation.drafting import _draft_direction_note


def test_internal_sender_gets_collegial_note() -> None:
    note = _draft_direction_note({"sender_scope": "internal"}, "", "")
    assert "INTERNAL" in note


def test_external_sender_gets_professional_note() -> None:
    note = _draft_direction_note({"sender_scope": "external"}, "", "")
    assert "EXTERNAL" in note


def test_self_scope_gets_no_direction_note() -> None:
    # The owner's own outbound mail isn't an inbound direction to steer on.
    assert _draft_direction_note({"sender_scope": "self"}, "", "") == ""


def test_cc_only_recipient_is_flagged_as_informational() -> None:
    email = {"sender_scope": "external", "self": "me@acme.com"}
    note = _draft_direction_note(
        email, to_line="lead@x.com", cc_line="me@acme.com, other@x.com")
    assert "only CC'd" in note
    assert "informational" in note


def test_direct_to_recipient_is_not_flagged_cc() -> None:
    email = {"sender_scope": "external", "self": "me@acme.com"}
    note = _draft_direction_note(
        email, to_line="me@acme.com", cc_line="other@x.com")
    assert "only CC'd" not in note


def test_no_signal_returns_empty() -> None:
    assert _draft_direction_note({}, "", "") == ""
