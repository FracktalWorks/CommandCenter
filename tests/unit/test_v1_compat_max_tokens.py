"""Regression: the /v1 default output ceiling (2026-07-17).

v1_compat is THE choke point every agent runtime POSTs through, so its
``max_tokens`` default IS the platform's real output cap whenever the caller
omits the field — and the Copilot SDK ALWAYS omits it (its wire protocol has no
max_tokens field, so the SessionConfig ``max_tokens`` / ``COPILOT_MAX_OUTPUT_TOKENS``
never reach the gateway).

The old default of 4096 was therefore the effective ceiling for every Copilot
agent. It truncated long tool-call arguments mid-JSON: the model emits a large
file's content as a tool argument, gets cut at 4096, and the malformed JSON
fails the tool call ("Unterminated string in JSON at position ...").

Measured on the live gateway (deepseek-v4-pro):
    no max_tokens  -> completion_tokens=4096,  finish_reason="length" (cut off)
    max_tokens=32k -> completion_tokens=10940, finish_reason="stop"   (finished)
"""
from __future__ import annotations

import acb_common
import litellm
from acb_llm import client as llm_client
from acb_llm import prompt_cache as _pc
from fastapi import FastAPI
from fastapi.testclient import TestClient
from gateway.routes import v1_compat
from litellm import ModelResponse

_TOKEN = "test-internal-token"
_AUTH = {"Authorization": f"Bearer {_TOKEN}"}


def _mk_app(monkeypatch, seen: list[dict]) -> TestClient:
    monkeypatch.setenv("GATEWAY_INTERNAL_TOKEN", _TOKEN)

    async def _no_keys() -> None:
        return None

    async def _fake_acompletion(**kw):
        seen.append(kw)  # capture what actually reaches the provider
        return ModelResponse(
            model="deepseek/deepseek-v4-pro",
            choices=[{
                "index": 0,
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop",
            }],
            usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        )

    monkeypatch.setattr(v1_compat, "_ensure_keys_loaded", _no_keys)
    monkeypatch.setattr(litellm, "acompletion", _fake_acompletion)
    monkeypatch.setattr(llm_client, "ensure_model_registered", lambda m: "deepseek")
    monkeypatch.setattr(
        _pc, "apply_prompt_caching",
        lambda **kw: (kw["messages"], kw.get("tools"), {}),
    )
    monkeypatch.setattr(acb_common, "publish_activity", lambda **kw: None)

    app = FastAPI()
    for r in v1_compat.routers:
        app.include_router(r)
    return TestClient(app)


def _post(client: TestClient, body: dict):
    return client.post("/v1/chat/completions", json=body, headers=_AUTH)


def test_omitted_max_tokens_does_not_fall_back_to_4096(monkeypatch) -> None:
    """A Copilot-SDK-shaped request (no max_tokens) must NOT be capped at 4096."""
    seen: list[dict] = []
    client = _mk_app(monkeypatch, seen)

    r = _post(client, {
        "model": "tier-powerful",
        "messages": [{"role": "user", "content": "write something long"}],
    })
    assert r.status_code == 200
    assert seen, "acompletion was never called"

    forwarded = seen[0].get("max_tokens")
    assert forwarded != 4096, (
        "regression: the old 4096 default is back — this silently truncates "
        "every Copilot agent's output mid tool-call"
    )
    assert forwarded == v1_compat._DEFAULT_MAX_OUTPUT_TOKENS
    # Must be generous enough for the ~10.9k-token completions we measured.
    assert forwarded >= 16000


def test_explicit_max_tokens_is_respected(monkeypatch) -> None:
    """An explicit caller value still wins over the default."""
    seen: list[dict] = []
    client = _mk_app(monkeypatch, seen)

    r = _post(client, {
        "model": "tier-powerful",
        "max_tokens": 256,
        "messages": [{"role": "user", "content": "hi"}],
    })
    assert r.status_code == 200
    assert seen[0].get("max_tokens") == 256


def test_default_is_env_tunable(monkeypatch) -> None:
    """Operators can retune the ceiling without a code change."""
    import importlib
    monkeypatch.setenv("GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS", "12345")
    mod = importlib.reload(v1_compat)
    try:
        assert mod._DEFAULT_MAX_OUTPUT_TOKENS == 12345
    finally:
        monkeypatch.delenv("GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS", raising=False)
        importlib.reload(v1_compat)
