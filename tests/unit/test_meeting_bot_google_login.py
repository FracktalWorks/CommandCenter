"""Signing the notetaker into Google — the classification that routes an operator.

Google's sign-in screen has two distinct dead ends for automation, and they
need opposite responses: "this browser may not be secure" means a scripted
login can NEVER work (go finish it by hand over VNC), while a 2FA prompt means
the password was accepted and only the second factor is missing. Conflating
them sends someone retrying a login that cannot succeed.

The worker lives outside the uv workspace, so its modules load by path with a
stub for the `.meet` import (no Playwright, no browser).
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys
import types

_APP = (
    pathlib.Path(__file__).resolve().parents[2]
    / "apps/services/meeting_bot/app"
)


def _load():
    # google_login does `from .meet import ...`; provide a package + a stub meet
    # so the module imports without Playwright present.
    pkg = types.ModuleType("mbapp")
    pkg.__path__ = [str(_APP)]
    sys.modules["mbapp"] = pkg

    meet_stub = types.ModuleType("mbapp.meet")
    meet_stub.DIAG_DIR = "/tmp"
    meet_stub.PROFILE_DIR = ""
    meet_stub.chrome_launch_args = lambda: ["--no-sandbox"]
    sys.modules["mbapp.meet"] = meet_stub

    spec = importlib.util.spec_from_file_location(
        "mbapp.google_login", _APP / "google_login.py"
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["mbapp.google_login"] = mod
    spec.loader.exec_module(mod)
    return mod


gl = _load()


def test_browser_refusal_is_classified_as_blocked() -> None:
    """Scripted login can't recover from this — the caller must be told to
    switch to the interactive/VNC path rather than retry."""
    for body in (
        "This browser or app may not be secure. Try using a different browser.",
        "Couldn't sign you in",
    ):
        assert gl.classify_login_page(body) == "blocked", body


def test_second_factor_prompts_need_a_human() -> None:
    for body in (
        "2-Step Verification. Check your phone",
        "Verify it's you",
        "Enter the code we sent",
        "Use your passkey to sign in",
    ):
        assert gl.classify_login_page(body) == "needs_human", body


def test_ordinary_sign_in_page_is_neither() -> None:
    assert gl.classify_login_page("Sign in. Use your Google Account") is None
    assert gl.classify_login_page("") is None


def test_classification_is_case_and_whitespace_insensitive() -> None:
    assert (
        gl.classify_login_page("THIS BROWSER OR APP   MAY NOT BE\n SECURE")
        == "blocked"
    )


def test_missing_credentials_refuse_before_a_browser_is_launched(monkeypatch) -> None:
    """Cheapest failure first: no credentials must be caught before Playwright
    is even imported, so the error is about credentials rather than a driver."""
    import asyncio

    monkeypatch.delenv("MEET_GOOGLE_EMAIL", raising=False)
    monkeypatch.delenv("MEET_GOOGLE_PASSWORD", raising=False)
    try:
        asyncio.run(gl.sign_in())
    except gl.LoginError as exc:
        assert "credentials" in str(exc).lower()
    else:  # pragma: no cover — would mean the guard vanished
        raise AssertionError("expected a LoginError with no credentials")


def test_interactive_login_refuses_without_a_persistent_profile() -> None:
    """Without a profile dir there is nothing for cookies to persist INTO — a
    "successful" sign-in would be silently useless next join."""
    assert gl.PROFILE_DIR == ""  # the stub's value
    try:
        gl.start_interactive()
    except gl.LoginError as exc:
        assert "MEET_PROFILE_DIR" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("expected a LoginError without a profile dir")


def test_credentials_can_come_from_the_environment(monkeypatch) -> None:
    monkeypatch.setenv("MEET_GOOGLE_EMAIL", "notetaker@example.com")
    monkeypatch.setenv("MEET_GOOGLE_PASSWORD", "s3cret")
    assert gl.configured_credentials() == ("notetaker@example.com", "s3cret")


def test_no_credentials_configured_reads_as_empty(monkeypatch) -> None:
    monkeypatch.delenv("MEET_GOOGLE_EMAIL", raising=False)
    monkeypatch.delenv("MEET_GOOGLE_PASSWORD", raising=False)
    assert gl.configured_credentials() == ("", "")
