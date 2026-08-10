"""BO-2 residuals #3 and #4 — service identity vs. LLM key, and webhook signing.

Two holes that let a caller act as the platform:

* **The LLM key was the identity token.** ``_get_internal_token`` fell back to
  ``LITELLM_MASTER_KEY``, and the orchestrator handed agents whichever value it
  resolved to. Every agent therefore held a credential that grants
  ``SERVICE_ACCESS`` — it could call ``/admin/*`` and grant itself anything,
  defeating the entire org access model.

* **``/agent/webhook/{source}`` was unauthenticated.** It dispatches an agent
  run, so it was a fourth run path bypassing ``assert_can_run_agent``.
"""
from __future__ import annotations

import hashlib
import hmac

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from acb_auth import require_internal_auth, require_llm_api_auth
from acb_auth.deps import _get_internal_token, _get_llm_api_token

IDENTITY = "sk-identity-secret"
LLM_KEY = "sk-llm-api-key"


@pytest.fixture
def split_tokens(monkeypatch):
    """A correctly provisioned deployment: two distinct secrets."""
    monkeypatch.setenv("GATEWAY_INTERNAL_TOKEN", IDENTITY)
    monkeypatch.setenv("LITELLM_MASTER_KEY", LLM_KEY)
    return IDENTITY, LLM_KEY


# ── Token resolution ────────────────────────────────────────────────────────

def test_the_two_tokens_are_distinct_when_provisioned(split_tokens) -> None:
    assert _get_internal_token() == IDENTITY
    assert _get_llm_api_token() == LLM_KEY
    assert _get_internal_token() != _get_llm_api_token()


def test_identity_falls_back_to_the_llm_key_when_unprovisioned(monkeypatch) -> None:
    """Upgrade path: an un-migrated deployment must not 401 every internal call.

    The separation is absent while this holds — which is why the resolver logs
    a warning rather than falling back silently.
    """
    monkeypatch.delenv("GATEWAY_INTERNAL_TOKEN", raising=False)
    monkeypatch.setenv("LITELLM_MASTER_KEY", LLM_KEY)
    assert _get_internal_token() == LLM_KEY


def test_no_secrets_at_all_disables_bearer_auth(monkeypatch) -> None:
    monkeypatch.delenv("GATEWAY_INTERNAL_TOKEN", raising=False)
    monkeypatch.delenv("LITELLM_MASTER_KEY", raising=False)
    monkeypatch.setattr(
        "acb_auth.deps._get_llm_api_token", lambda: "", raising=True
    )
    assert _get_internal_token() == ""


# ── The fallback, made visible and refusable ────────────────────────────────
#
# While the fallback is in effect the identity token IS the LLM key, so the
# gateway cannot tell the Next.js BFF from any agent — and an agent (or anyone
# who obtained that semi-public key) can assert a colleague's X-User-Email.
# `GATEWAY_REFUSE_LLM_KEY_IDENTITY` is the opt-in refusal. It defaults OFF:
# the BFF mirrors the same fallback, so refusing by default would 401 every
# signed-in member on a deployment that has not provisioned the token yet.

VICTIM = "someone-else@fracktal.in"


@pytest.fixture
def llm_key_only(monkeypatch):
    """An un-migrated deployment: identity has fallen back to the LLM key."""
    monkeypatch.delenv("GATEWAY_INTERNAL_TOKEN", raising=False)
    monkeypatch.setenv("LITELLM_MASTER_KEY", LLM_KEY)

    async def _passthrough(user):
        return user

    monkeypatch.setattr("acb_auth.deps._with_resolved_access", _passthrough)
    return LLM_KEY


def test_the_fallback_reports_itself(llm_key_only) -> None:
    from acb_auth.deps import _internal_token_is_llm_fallback

    assert _internal_token_is_llm_fallback() is True


def test_a_provisioned_token_is_not_a_fallback(split_tokens) -> None:
    from acb_auth.deps import _internal_token_is_llm_fallback

    assert _internal_token_is_llm_fallback() is False


async def test_by_default_the_llm_key_may_still_assert_an_identity(
    llm_key_only, monkeypatch
) -> None:
    """The hole, pinned as the DEFAULT so the fix cannot silently change it.

    This is the lockout guard: an un-migrated deployment keeps working exactly
    as it did, and the hardening is something the owner turns on.
    """
    from acb_auth.deps import get_current_user

    monkeypatch.delenv("GATEWAY_REFUSE_LLM_KEY_IDENTITY", raising=False)
    user = await get_current_user(
        x_user_email=VICTIM, x_user_role=None,
        authorization=f"Bearer {LLM_KEY}",
    )
    assert user.email == VICTIM


async def test_the_flag_refuses_an_identity_asserted_on_the_llm_key(
    llm_key_only, monkeypatch
) -> None:
    from acb_auth.deps import get_current_user

    monkeypatch.setenv("GATEWAY_REFUSE_LLM_KEY_IDENTITY", "1")
    user = await get_current_user(
        x_user_email=VICTIM, x_user_role=None,
        authorization=f"Bearer {LLM_KEY}",
    )
    assert user.email is None
    assert not user.has_permission("*")


async def test_the_flag_also_refuses_service_access_on_the_llm_key(
    llm_key_only, monkeypatch
) -> None:
    """A bare Bearer resolves to SERVICE_ACCESS (branch 1b) — everything.

    Refusing the assertion but leaving that open would be a fix in name only:
    the same key would still be the platform, just anonymously.
    """
    from acb_auth.deps import get_current_user

    monkeypatch.setenv("GATEWAY_REFUSE_LLM_KEY_IDENTITY", "1")
    user = await get_current_user(
        x_user_email=None, x_user_role=None,
        authorization=f"Bearer {LLM_KEY}",
    )
    assert user.email != "system:internal"
    assert not user.has_permission("*")


async def test_the_flag_is_inert_once_a_distinct_token_is_provisioned(
    split_tokens, monkeypatch
) -> None:
    """Which is why flipping it is safe in that order and only that order."""
    from acb_auth.deps import get_current_user

    async def _passthrough(user):
        return user

    monkeypatch.setattr("acb_auth.deps._with_resolved_access", _passthrough)
    monkeypatch.setenv("GATEWAY_REFUSE_LLM_KEY_IDENTITY", "1")

    proxied = await get_current_user(
        x_user_email=VICTIM, x_user_role=None,
        authorization=f"Bearer {IDENTITY}",
    )
    assert proxied.email == VICTIM

    # ...and the LLM key no longer matches the internal token at all.
    agent = await get_current_user(
        x_user_email=VICTIM, x_user_role=None,
        authorization=f"Bearer {LLM_KEY}",
    )
    assert agent.email is None


# ── The guards ──────────────────────────────────────────────────────────────

def _client() -> TestClient:
    from fastapi import Depends

    app = FastAPI()

    @app.get("/identity", dependencies=[Depends(require_internal_auth)])
    async def _identity() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/v1/models", dependencies=[Depends(require_llm_api_auth)])
    async def _v1() -> dict[str, bool]:
        return {"ok": True}

    return TestClient(app)


def test_llm_key_does_not_open_identity_routes(split_tokens) -> None:
    """The headline fix: an agent's key is not a platform credential."""
    res = _client().get("/identity", headers={"Authorization": f"Bearer {LLM_KEY}"})
    assert res.status_code == 401


def test_identity_token_opens_identity_routes(split_tokens) -> None:
    res = _client().get("/identity", headers={"Authorization": f"Bearer {IDENTITY}"})
    assert res.status_code == 200


def test_v1_accepts_the_llm_key(split_tokens) -> None:
    """Agents route completions with it, so /v1 must keep working."""
    res = _client().get("/v1/models", headers={"Authorization": f"Bearer {LLM_KEY}"})
    assert res.status_code == 200


def test_v1_also_accepts_the_identity_token(split_tokens) -> None:
    """The Next.js server and internal jobs route completions too."""
    res = _client().get("/v1/models", headers={"Authorization": f"Bearer {IDENTITY}"})
    assert res.status_code == 200


def test_v1_rejects_an_unknown_token(split_tokens) -> None:
    res = _client().get("/v1/models", headers={"Authorization": "Bearer nope"})
    assert res.status_code == 401


def test_both_routes_reject_a_missing_header(split_tokens) -> None:
    client = _client()
    assert client.get("/identity").status_code == 401
    assert client.get("/v1/models").status_code == 401


# ── The BYOK clients must not carry identity ────────────────────────────────

def test_llm_api_key_accessor_never_returns_the_identity_token(
    split_tokens, monkeypatch
) -> None:
    """`settings.llm_api_key` is what every /v1 client is pointed at."""
    from acb_common import Settings

    settings = Settings(
        litellm_master_key=LLM_KEY, gateway_internal_token=IDENTITY
    )
    assert settings.llm_api_key == LLM_KEY
    assert settings.llm_api_key != settings.gateway_internal_token


def test_no_v1_client_reads_the_identity_token() -> None:
    """Guards against a regression re-introducing the escalation.

    Every module that builds a `/v1` provider config must resolve its key from
    `llm_api_key`. Modules calling gateway *business* APIs still legitimately
    use `gateway_internal_token` and are excluded by name.
    """
    import pathlib

    v1_client_modules = [
        "apps/services/orchestrator/orchestrator/agents.py",
        "apps/services/orchestrator/orchestrator/_model_resolution.py",
        "apps/services/orchestrator/orchestrator/code_session.py",
        "apps/services/orchestrator/orchestrator/mutation.py",
    ]
    root = pathlib.Path(__file__).resolve().parents[2]
    for rel in v1_client_modules:
        source = (root / rel).read_text(encoding="utf-8")
        offending = [
            line.strip()
            for line in source.split("\n")
            if "gateway_internal_token" in line and not line.strip().startswith("#")
        ]
        assert not offending, (
            f"{rel} resolves gateway_internal_token for a /v1 client: {offending}. "
            f"Use settings.llm_api_key — the identity token must not reach "
            f"model-authored code."
        )


# ── Webhook signing ─────────────────────────────────────────────────────────

BODY = b'{"event_type":"taskCreated","payload":{}}'


def _sign(secret: str, body: bytes = BODY) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_webhook_accepts_a_valid_signature(monkeypatch) -> None:
    from gateway.routes.agent import verify_webhook_signature

    monkeypatch.setenv("AGENT_WEBHOOK_SECRET", "wh-secret")
    verify_webhook_signature("clickup", BODY, _sign("wh-secret"))  # must not raise


def test_webhook_accepts_a_bare_hex_signature(monkeypatch) -> None:
    """The `sha256=` prefix is conventional, not required."""
    from gateway.routes.agent import verify_webhook_signature

    monkeypatch.setenv("AGENT_WEBHOOK_SECRET", "wh-secret")
    bare = _sign("wh-secret").removeprefix("sha256=")
    verify_webhook_signature("clickup", BODY, bare)


def test_webhook_rejects_a_wrong_signature(monkeypatch) -> None:
    from fastapi import HTTPException
    from gateway.routes.agent import verify_webhook_signature

    monkeypatch.setenv("AGENT_WEBHOOK_SECRET", "wh-secret")
    with pytest.raises(HTTPException) as exc:
        verify_webhook_signature("clickup", BODY, _sign("wrong-secret"))
    assert exc.value.status_code == 401


def test_webhook_rejects_a_tampered_body(monkeypatch) -> None:
    from fastapi import HTTPException
    from gateway.routes.agent import verify_webhook_signature

    monkeypatch.setenv("AGENT_WEBHOOK_SECRET", "wh-secret")
    signature = _sign("wh-secret")
    with pytest.raises(HTTPException) as exc:
        verify_webhook_signature("clickup", b'{"event_type":"evil"}', signature)
    assert exc.value.status_code == 401


def test_webhook_rejects_a_missing_signature(monkeypatch) -> None:
    from fastapi import HTTPException
    from gateway.routes.agent import verify_webhook_signature

    monkeypatch.setenv("AGENT_WEBHOOK_SECRET", "wh-secret")
    with pytest.raises(HTTPException) as exc:
        verify_webhook_signature("clickup", BODY, None)
    assert exc.value.status_code == 401


def test_webhook_fails_closed_when_unconfigured(monkeypatch) -> None:
    """No secret means the endpoint is shut, not open.

    This endpoint starts an agent run and is internet-reachable, so an
    implicit allow would leave the hole this change exists to close.
    """
    from fastapi import HTTPException
    from gateway.routes.agent import verify_webhook_signature

    monkeypatch.delenv("AGENT_WEBHOOK_SECRET", raising=False)
    monkeypatch.delenv("AGENT_WEBHOOK_SECRET_CLICKUP", raising=False)
    with pytest.raises(HTTPException) as exc:
        verify_webhook_signature("clickup", BODY, _sign("anything"))
    assert exc.value.status_code == 503
    assert "AGENT_WEBHOOK_SECRET" in exc.value.detail


def test_per_source_secret_overrides_the_global(monkeypatch) -> None:
    """One leaked integration must not authorise every agent on the platform."""
    from fastapi import HTTPException
    from gateway.routes.agent import verify_webhook_signature

    monkeypatch.setenv("AGENT_WEBHOOK_SECRET", "global-secret")
    monkeypatch.setenv("AGENT_WEBHOOK_SECRET_CLICKUP", "clickup-secret")

    verify_webhook_signature("clickup", BODY, _sign("clickup-secret"))
    # The global secret no longer works for this source...
    with pytest.raises(HTTPException):
        verify_webhook_signature("clickup", BODY, _sign("global-secret"))
    # ...but still does for a source with no override.
    verify_webhook_signature("zoho", BODY, _sign("global-secret"))


def test_source_name_is_normalised_for_the_env_lookup(monkeypatch) -> None:
    """`zoho-crm` → AGENT_WEBHOOK_SECRET_ZOHO_CRM (dashes are not env-safe)."""
    monkeypatch.setenv("AGENT_WEBHOOK_SECRET_ZOHO_CRM", "zoho-secret")
    from gateway.routes.agent import verify_webhook_signature

    verify_webhook_signature("zoho-crm", BODY, _sign("zoho-secret"))
