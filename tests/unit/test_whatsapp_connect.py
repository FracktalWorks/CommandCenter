"""Unit tests for the Connect wizard backend (W11) — the pure Meta-error
extractor, the verify route (mocked provider), and the connection-info route."""

from __future__ import annotations

import gateway.routes.whatsapp.transport.connect as connect
from gateway.routes.whatsapp.transport.connect import friendly_meta_error

# ── pure error extractor ──────────────────────────────────────────────────────

class _Resp:
    def __init__(self, body, status=400):
        self._body = body
        self.status_code = status

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class _HttpErr(Exception):
    def __init__(self, body, status=400):
        self.response = _Resp(body, status)
        super().__init__("http error")


def test_extracts_meta_error_message() -> None:
    exc = _HttpErr({"error": {"message": "Invalid OAuth access token.", "code": 190}})
    assert friendly_meta_error(exc) == "Invalid OAuth access token. (Meta code 190)"


def test_extracts_message_without_code() -> None:
    exc = _HttpErr({"error": {"message": "Unsupported request."}})
    assert friendly_meta_error(exc) == "Unsupported request."


def test_non_json_error_falls_back_to_status() -> None:
    exc = _HttpErr(ValueError("not json"), status=401)
    assert friendly_meta_error(exc) == "Meta returned HTTP 401."


def test_no_response_falls_back_to_str() -> None:
    assert "boom" in friendly_meta_error(RuntimeError("boom"))


# ── verify route ──────────────────────────────────────────────────────────────

class _FakeProvider:
    def __init__(self, profile=None, raise_exc=None):
        self._profile = profile or {}
        self._raise = raise_exc

    async def get_phone_number_profile(self):
        if self._raise:
            raise self._raise
        return self._profile


async def test_verify_success_returns_profile(monkeypatch) -> None:
    prof = {"display_phone_number": "+91 98765 43210",
            "verified_name": "Fracktal Works", "quality_rating": "GREEN"}
    monkeypatch.setattr(connect, "_instantiate_provider",
                        lambda name, creds: _FakeProvider(profile=prof))
    out = await connect.verify_account(
        connect.VerifyRequest(phone_number_id="123", access_token="tok"),
        user=None)
    assert out.ok is True
    assert out.verified_name == "Fracktal Works"
    assert out.quality_rating == "GREEN"


async def test_verify_surfaces_meta_error(monkeypatch) -> None:
    monkeypatch.setattr(
        connect, "_instantiate_provider",
        lambda name, creds: _FakeProvider(
            raise_exc=_HttpErr({"error": {"message": "Bad token", "code": 190}})))
    out = await connect.verify_account(
        connect.VerifyRequest(phone_number_id="123", access_token="bad"),
        user=None)
    assert out.ok is False
    assert "Bad token" in out.error


async def test_verify_requires_both_fields() -> None:
    out = await connect.verify_account(
        connect.VerifyRequest(phone_number_id="  ", access_token="tok"), user=None)
    assert out.ok is False
    assert "required" in out.error


async def test_connection_info_generates_token_when_unset(monkeypatch) -> None:
    monkeypatch.delenv("WHATSAPP_PUBLIC_URL", raising=False)
    monkeypatch.delenv("WHATSAPP_VERIFY_TOKEN", raising=False)
    info = await connection_info_call()
    assert info.base_configured is False
    assert info.webhook_url == ""
    assert info.verify_token.startswith("cc-")


async def test_connection_info_uses_env(monkeypatch) -> None:
    monkeypatch.setenv("WHATSAPP_PUBLIC_URL", "https://api.example.com/")
    monkeypatch.setenv("WHATSAPP_VERIFY_TOKEN", "my-token")
    info = await connection_info_call()
    assert info.base_configured is True
    assert info.webhook_url == "https://api.example.com/whatsapp/webhook"
    assert info.verify_token == "my-token"


async def connection_info_call():
    return await connect.connection_info(user=None)


def test_connect_routes_registered() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    assert "/whatsapp/accounts/verify" in paths
    assert "/whatsapp/connection/info" in paths
    assert "/whatsapp/connect/embedded" in paths


# ── Embedded Signup (W12) ─────────────────────────────────────────────────────

async def test_connection_info_flags_embedded_when_configured(monkeypatch) -> None:
    monkeypatch.setenv("WHATSAPP_APP_ID", "123456")
    monkeypatch.setenv("WHATSAPP_ES_CONFIG_ID", "cfg-789")
    info = await connect.connection_info(user=None)
    assert info.embedded_signup is True
    assert info.fb_app_id == "123456"
    assert info.es_config_id == "cfg-789"


async def test_connection_info_no_embedded_without_config(monkeypatch) -> None:
    monkeypatch.delenv("WHATSAPP_APP_ID", raising=False)
    monkeypatch.delenv("WHATSAPP_ES_CONFIG_ID", raising=False)
    info = await connect.connection_info(user=None)
    assert info.embedded_signup is False


async def test_embedded_signup_400_when_unconfigured(monkeypatch) -> None:
    from fastapi import HTTPException
    monkeypatch.delenv("WHATSAPP_APP_ID", raising=False)
    monkeypatch.delenv("WHATSAPP_APP_SECRET", raising=False)
    try:
        await connect.embedded_signup(
            connect.EmbeddedSignupRequest(code="c", phone_number_id="p"),
            user=None)
        raise AssertionError("expected HTTPException")
    except HTTPException as exc:
        assert exc.status_code == 400
        assert "Embedded Signup" in exc.detail


class _FakeDB:
    async def commit(self):
        pass

    async def close(self):
        pass


async def test_embedded_signup_happy_path(monkeypatch) -> None:
    from types import SimpleNamespace

    monkeypatch.setenv("WHATSAPP_APP_ID", "app")
    monkeypatch.setenv("WHATSAPP_APP_SECRET", "secret")

    async def _exchange(code, app_id, app_secret, gv):
        return "TOKEN"

    subscribed_calls: list[str] = []

    async def _subscribe(waba_id, token, gv):
        subscribed_calls.append(waba_id)

    async def _get_db():
        return _FakeDB()

    async def _persist(db, **kw):
        return "ROW"

    monkeypatch.setattr(connect, "exchange_code_for_token", _exchange)
    monkeypatch.setattr(connect, "subscribe_app_to_waba", _subscribe)
    monkeypatch.setattr(connect, "_get_db", _get_db)
    monkeypatch.setattr(
        connect, "_instantiate_provider",
        lambda name, creds: _FakeProvider(profile={
            "display_phone_number": "+91 98765 43210",
            "verified_name": "Fracktal Works"}))
    monkeypatch.setattr(
        "gateway.routes.whatsapp.transport.accounts.persist_account", _persist)
    monkeypatch.setattr(
        "gateway.routes.whatsapp.transport.accounts._account_model",
        lambda row: SimpleNamespace(
            id="acc-1", display_name="Fracktal Works",
            phone_number="+91 98765 43210"))

    out = await connect.embedded_signup(
        connect.EmbeddedSignupRequest(
            code="auth-code", phone_number_id="pn-1", waba_id="waba-1"),
        user=SimpleNamespace(email="u@x"))
    assert out.account_id == "acc-1"
    assert out.subscribed is True
    assert subscribed_calls == ["waba-1"]
