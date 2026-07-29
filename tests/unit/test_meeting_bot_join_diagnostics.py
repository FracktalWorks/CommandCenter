"""Tests for why a Google Meet join failed — the part that has to survive.

Browser automation against a UI that is not a public API breaks eventually; the
thing that must not break is the *explanation*. A sign-in wall, a device dialog
covering the green room, and a host who never clicked Admit all end with "the
bot didn't join", and they need three different responses from a human.

The worker lives outside the uv workspace (standalone Docker service), so its
module is loaded by path. Only the pure parts are exercised here — no Playwright,
no browser.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys

_MOD_PATH = (
    pathlib.Path(__file__).resolve().parents[2]
    / "apps/services/meeting_bot/app/meet.py"
)


def _load():
    name = "meeting_bot_meet"
    spec = importlib.util.spec_from_file_location(name, _MOD_PATH)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


meet = _load()


# ── refusal vs waiting ───────────────────────────────────────────────────────

def test_refusal_copy_is_recognised() -> None:
    """Meet says these when the bot will never get in, however long it waits."""
    for body in (
        "You can't join this video call",
        "Your request to join was denied",
        "No one responded to your request to join",
        "You've been removed from the meeting",
        "Check your meeting code and try again",
    ):
        assert meet.classify_body(body) == "refused", body


def test_waiting_room_copy_is_not_a_refusal() -> None:
    """The single most costly confusion: knocking looks terminal if you squint.

    These two states are one polling tick apart in the DOM and mean opposite
    things — one needs a human to click Admit, the other needs a different link.
    """
    for body in (
        "Asking to be let in...",
        "Waiting for the host to let you in",
        "You're waiting to be let in",
    ):
        assert meet.classify_body(body) == "waiting", body


def test_ordinary_green_room_is_neither() -> None:
    assert meet.classify_body("Ready to join? No one else is here") is None
    assert meet.classify_body("") is None


def test_classification_is_case_insensitive() -> None:
    assert meet.classify_body("YOU CAN'T JOIN THIS CALL") == "refused"
    assert meet.classify_body("ASKING TO BE LET IN") == "waiting"


# ── the error carries what the page showed ───────────────────────────────────

def test_error_carries_status_and_diagnostics() -> None:
    exc = meet.MeetingBotError(
        "no join button", status="not_admitted", diagnostics={"controls": ["Join now"]}
    )
    assert exc.status == "not_admitted"
    assert exc.diagnostics["controls"] == ["Join now"]


def test_error_defaults_are_safe() -> None:
    """A bare raise must still be inspectable — callers read .diagnostics
    unconditionally."""
    exc = meet.MeetingBotError("boom")
    assert exc.status == "failed"
    assert exc.diagnostics == {}


# ── timeouts are the caller's budget, not Playwright's default ───────────────

def test_join_timeout_is_configurable_and_sane() -> None:
    assert meet.JOIN_TIMEOUT_S > 0
    # Below ~60s a host realistically cannot notice and click Admit in time.
    assert meet.JOIN_TIMEOUT_S >= 60
