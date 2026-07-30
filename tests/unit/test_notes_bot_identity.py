"""Guards for the notetaker's Google-identity endpoints.

Why these matter: Google auto-declines anonymous participants, so this sign-in
is the difference between a notetaker that can join unattended and one that
can't join at all. It used to be reachable only over SSH + a loopback curl, and
moving it onto an authenticated app surface means the *failure* text is now the
product — a scripted-login refusal and a 2FA prompt need opposite responses from
the user, so they must never collapse into "sign-in failed".

These pin the parts that hold with no worker and no network: the provider's
error translation, the "which provider owns identity" branch, and the promise
that a password never comes back out.
"""
from __future__ import annotations

import httpx
import pytest
from fastapi import HTTPException
from gateway.routes.notes import meeting_bot as mb
from pydantic import ValidationError


def _status_error(code: int, detail: object) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "http://worker/google-login")
    response = httpx.Response(code, json={"detail": detail}, request=request)
    return httpx.HTTPStatusError("boom", request=request, response=response)


# ── error translation ────────────────────────────────────────────────────────

def test_worker_409_stays_409_and_explains_the_busy_browser() -> None:
    """A bot mid-call locks the browser profile. That's a "try later", not a
    failure — flattening it to 502 would send someone debugging the network."""
    exc = mb._worker_error(_status_error(409, "a bot is in a call"))
    assert isinstance(exc, HTTPException)
    assert exc.status_code == 409
    assert "call" in str(exc.detail).lower()


def test_worker_400_preserves_the_diagnostics_verbatim() -> None:
    """The worker's 400 carries which wall Google put up (`blocked` = scripted
    login is impossible, `needs_human` = 2FA). That payload IS the answer, so it
    must survive the hop to the UI intact."""
    detail = {"error": "google refused", "diagnostics": {"verdict": "needs_human"}}
    exc = mb._worker_error(_status_error(400, detail))
    assert exc.status_code == 400
    assert exc.detail == detail


def test_unreachable_worker_is_502_not_a_sign_in_failure() -> None:
    """A dead worker must not read as "wrong password"."""
    exc = mb._worker_error(httpx.ConnectError("no route"))
    assert exc.status_code == 502
    assert "worker" in str(exc.detail).lower()


def test_worker_400_without_a_json_body_still_degrades_cleanly() -> None:
    request = httpx.Request("POST", "http://worker/google-login")
    response = httpx.Response(400, text="not json", request=request)
    exc = mb._worker_error(
        httpx.HTTPStatusError("boom", request=request, response=response)
    )
    assert exc.status_code == 400


# ── provider ownership ───────────────────────────────────────────────────────

def test_identity_is_a_no_op_for_providers_that_manage_their_own_accounts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Recall runs its own pools of bot accounts. Offering our sign-in form for
    it would be a lie, so the endpoint reports `supported: false` and the UI
    hides the section rather than rendering a control that does nothing."""
    monkeypatch.setattr(mb, "resolve_bot_provider", lambda: object())
    with pytest.raises(HTTPException) as caught:
        mb._worker_or_503()
    assert caught.value.status_code == 503


def test_worker_or_503_returns_the_selfhosted_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MEETING_BOT_URL", "http://127.0.0.1:8095")
    provider = mb.SelfHostedProvider()
    monkeypatch.setattr(mb, "resolve_bot_provider", lambda: provider)
    assert mb._worker_or_503() is provider


# ── the password must never come back ────────────────────────────────────────

def test_sign_in_request_model_has_no_default_password() -> None:
    """Both fields are required — a missing password must be rejected at the
    schema, never silently attempted as an empty string."""
    with pytest.raises(ValidationError):
        mb.BotIdentityRequest(email="a@b.com")  # type: ignore[call-arg]


@pytest.mark.asyncio
async def test_sign_in_response_never_echoes_the_password(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Whatever the worker returns, the endpoint's response is built from an
    explicit allow-list of fields — so a worker that echoed the credential
    could not leak it through us."""
    monkeypatch.setenv("MEETING_BOT_URL", "http://127.0.0.1:8095")
    provider = mb.SelfHostedProvider()

    async def fake_sign_in(email: str, password: str) -> dict:
        # A hostile/buggy worker echoing the secret back.
        return {"signed_in": True, "email": email, "password": password}

    provider.identity_sign_in = fake_sign_in  # type: ignore[method-assign]
    monkeypatch.setattr(mb, "resolve_bot_provider", lambda: provider)

    class _User:
        email = "owner@example.com"

    out = await mb.bot_identity_sign_in(
        mb.BotIdentityRequest(email="bot@example.com", password="hunter2"),
        user=_User(),  # type: ignore[arg-type]
    )
    assert out == {"ok": True, "signed_in": True, "email": "bot@example.com"}
    assert "hunter2" not in str(out)


@pytest.mark.asyncio
async def test_sign_in_rejects_a_missing_or_malformed_email(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MEETING_BOT_URL", "http://127.0.0.1:8095")
    monkeypatch.setattr(mb, "resolve_bot_provider", lambda: mb.SelfHostedProvider())

    class _User:
        email = "owner@example.com"

    for bad in ("", "   ", "not-an-email"):
        with pytest.raises(HTTPException) as caught:
            await mb.bot_identity_sign_in(
                mb.BotIdentityRequest(email=bad, password="x"),
                user=_User(),  # type: ignore[arg-type]
            )
        assert caught.value.status_code == 400


# ── status reporting ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_identity_status_reports_unreachable_rather_than_signed_out(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """"Can't tell" and "signed out" lead to different actions — restart the
    worker vs sign the bot in. `signed_in: null` keeps them distinguishable."""
    monkeypatch.setenv("MEETING_BOT_URL", "http://127.0.0.1:8095")
    provider = mb.SelfHostedProvider()

    async def boom() -> dict:
        raise httpx.ConnectError("no route")

    provider.identity = boom  # type: ignore[method-assign]
    monkeypatch.setattr(mb, "resolve_bot_provider", lambda: provider)

    out = await mb.bot_identity(_user=None)  # type: ignore[arg-type]
    assert out["signed_in"] is None
    assert out["unreachable"] is True
    assert out["supported"] is True


@pytest.mark.asyncio
async def test_identity_status_flattens_the_workers_nested_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MEETING_BOT_URL", "http://127.0.0.1:8095")
    provider = mb.SelfHostedProvider()

    async def fake_identity() -> dict:
        return {
            "signed_in": True,
            "email": "notetaker@example.com",
            "profile": "/profile",
            "credentials_configured": False,
            "interactive": {"running": False, "vnc_enabled": True},
        }

    provider.identity = fake_identity  # type: ignore[method-assign]
    monkeypatch.setattr(mb, "resolve_bot_provider", lambda: provider)

    out = await mb.bot_identity(_user=None)  # type: ignore[arg-type]
    assert out["signed_in"] is True
    assert out["email"] == "notetaker@example.com"
    assert out["profile"] is True
    assert out["vnc_enabled"] is True
    assert out["interactive_running"] is False


@pytest.mark.asyncio
async def test_identity_status_is_not_an_error_for_other_providers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GET must stay cheap and non-throwing for any provider — the UI calls it
    on open and only hides the section based on the answer."""
    monkeypatch.setattr(mb, "resolve_bot_provider", lambda: object())
    monkeypatch.setattr(mb, "_provider_name", lambda: "recall")
    out = await mb.bot_identity(_user=None)  # type: ignore[arg-type]
    assert out["supported"] is False
    assert out["provider"] == "recall"


# ── authorization ────────────────────────────────────────────────────────────

def test_writing_the_identity_is_executive_only() -> None:
    """Signing the bot in writes a credential that then acts on the org's
    behalf, so it must carry a role guard; reading the status is safe for
    anyone and must NOT (a failed join is everyone's question).

    The router applies its own baseline dependency to every route, so "guarded"
    means *more* dependencies than a route we know is unguarded — comparing to a
    hardcoded count would break the day that baseline changes.
    """
    routes = {
        r.path: r
        for r in mb.router.routes
        if getattr(r, "path", "").startswith("/notes/bot")
    }
    for path in (
        "/notes/bot/identity",
        "/notes/bot/identity/sign-in",
        "/notes/bot/identity/interactive",
    ):
        assert path in routes, f"{path} is not registered"

    def dep_count(path: str) -> int:
        return len(getattr(routes[path], "dependencies", []) or [])

    baseline = dep_count("/notes/bot/identity")
    assert dep_count("/notes/bot/identity/sign-in") > baseline, (
        "sign-in must carry a role guard above the router baseline"
    )
    assert dep_count("/notes/bot/identity/interactive") > baseline, (
        "interactive sign-in must carry a role guard above the router baseline"
    )


def test_identity_write_guard_names_the_executive_role() -> None:
    """Pin the actual role, not just "some guard" — a guard that admitted every
    employee would satisfy the count test above while giving anyone in the org
    the ability to repoint the notetaker's account."""
    import inspect

    from gateway.routes.notes import meeting_bot as module

    src = inspect.getsource(module)
    marker = 'dependencies=[require_role(UserRole.EXECUTIVE, UserRole.AGENT)]'
    assert src.count(marker) >= 2, (
        "both identity-writing endpoints must be EXECUTIVE-gated"
    )
