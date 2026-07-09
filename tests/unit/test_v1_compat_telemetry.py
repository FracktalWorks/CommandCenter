"""v1_compat is THE choke point every agent runtime (chat) POSTs completions to.

Before E2, it called litellm directly and emitted nothing — so chat-agent model
calls + their cost were invisible to /observability. This drives the real
endpoint (litellm mocked) and asserts it now emits a priced model activation
attributed to source="chat".
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


def _mk_app(monkeypatch, captured: list[dict]) -> TestClient:
    async def _no_keys() -> None:
        return None

    async def _fake_acompletion(**kw):
        return ModelResponse(
            model="gpt-4o-mini",
            choices=[{
                "index": 0,
                "message": {"role": "assistant", "content": "hi"},
                "finish_reason": "stop",
            }],
            usage={"prompt_tokens": 1000, "completion_tokens": 500,
                   "total_tokens": 1500},
        )

    monkeypatch.setattr(v1_compat, "_ensure_keys_loaded", _no_keys)
    monkeypatch.setattr(litellm, "acompletion", _fake_acompletion)
    monkeypatch.setattr(llm_client, "ensure_model_registered", lambda m: "openai")
    monkeypatch.setattr(
        _pc, "apply_prompt_caching",
        lambda **kw: (kw["messages"], kw.get("tools"), {}),
    )
    monkeypatch.setattr(acb_common, "publish_activity",
                        lambda **kw: captured.append(kw))

    app = FastAPI()
    for r in v1_compat.routers:
        app.include_router(r)
    return TestClient(app)


def test_v1_compat_nonstreaming_emits_priced_model_activation(monkeypatch):
    captured: list[dict] = []
    client = _mk_app(monkeypatch, captured)

    resp = client.post("/v1/chat/completions", json={
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "hi"}],
        "stream": False,
    })
    assert resp.status_code == 200

    model_events = [e for e in captured if e.get("kind") == "model"]
    assert len(model_events) == 1, model_events
    ev = model_events[0]
    assert ev["source"] == "chat"          # attributed to interactive agent traffic
    assert ev["tokens"] == 1500
    assert isinstance(ev["cost_usd"], float) and ev["cost_usd"] > 0


def test_v1_compat_completion_error_does_not_emit(monkeypatch):
    captured: list[dict] = []

    async def _no_keys() -> None:
        return None

    async def _boom(**kw):
        raise RuntimeError("provider down")

    monkeypatch.setattr(v1_compat, "_ensure_keys_loaded", _no_keys)
    monkeypatch.setattr(litellm, "acompletion", _boom)
    monkeypatch.setattr(llm_client, "ensure_model_registered", lambda m: "openai")
    monkeypatch.setattr(
        _pc, "apply_prompt_caching",
        lambda **kw: (kw["messages"], kw.get("tools"), {}),
    )
    monkeypatch.setattr(acb_common, "publish_activity",
                        lambda **kw: captured.append(kw))

    app = FastAPI()
    for r in v1_compat.routers:
        app.include_router(r)
    client = TestClient(app)

    resp = client.post("/v1/chat/completions", json={
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "hi"}],
        "stream": False,
    })
    # Endpoint returns a soft error body; no usage → no model activation emitted.
    assert resp.status_code == 200
    assert [e for e in captured if e.get("kind") == "model"] == []
