"""Action-item dispatch — the routing rules that must never guess.

The dispatcher sends real emails and creates real tasks from meeting
transcripts, so the safety-critical parts are pure and tested directly:
recipient resolution (a wrong guess emails a real, wrong person) and the
kind gate that decides which system an item goes to.
"""
from __future__ import annotations

from gateway.routes.notes import dispatch


# ── Recipient resolution: send only when unambiguous ─────────────────────────

_ATTENDEES = [
    {"name": "Sarah Chen", "email": "sarah@acme.com"},
    {"name": "Rahul Mehta", "email": "rahul@fracktal.in"},
    {"name": "No Email Listed"},
]


def test_literal_address_passes_through() -> None:
    assert dispatch.resolve_recipient("ops@acme.com", []) == "ops@acme.com"


def test_first_name_resolves_to_the_single_matching_attendee() -> None:
    assert dispatch.resolve_recipient("Sarah", _ATTENDEES) == "sarah@acme.com"
    assert dispatch.resolve_recipient("sarah", _ATTENDEES) == "sarah@acme.com"


def test_full_name_resolves() -> None:
    assert dispatch.resolve_recipient("Sarah Chen", _ATTENDEES) == "sarah@acme.com"


def test_ambiguous_or_unknown_names_refuse() -> None:
    """The core guarantee: no match and multi-match both mean 'do not send'."""
    two_sarahs = _ATTENDEES + [{"name": "Sarah Lopez", "email": "sl@x.com"}]
    assert dispatch.resolve_recipient("Sarah", two_sarahs) is None
    assert dispatch.resolve_recipient("someone from finance", _ATTENDEES) is None
    assert dispatch.resolve_recipient("", _ATTENDEES) is None
    assert dispatch.resolve_recipient(None, _ATTENDEES) is None


def test_attendee_without_address_never_matches() -> None:
    assert dispatch.resolve_recipient("No Email Listed", _ATTENDEES) is None


def test_malformed_literal_is_not_an_address() -> None:
    assert dispatch.resolve_recipient("sarah@", _ATTENDEES) is None
    assert dispatch.resolve_recipient("@acme.com", _ATTENDEES) is None


# ── Document slugs ───────────────────────────────────────────────────────────

def test_slugify_is_filesystem_safe_and_bounded() -> None:
    assert dispatch.slugify("Q3 Pricing Proposal — Acme!") == "q3-pricing-proposal-acme"
    assert dispatch.slugify("") == "untitled"
    assert len(dispatch.slugify("x" * 500)) <= 60


# ── Kinds ────────────────────────────────────────────────────────────────────

def test_kinds_are_the_three_dispatchable_systems() -> None:
    assert dispatch.KINDS == ("task", "email", "document")


def test_auto_confidence_gate_matches_bulk_approve() -> None:
    """Auto-dispatch inherits the same 0.8 bar the approve-all button set —
    lowering it silently would auto-send lower-quality extractions."""
    assert dispatch.MIN_AUTO_CONFIDENCE == 0.8
