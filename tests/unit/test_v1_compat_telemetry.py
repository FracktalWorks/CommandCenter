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


# The internal Bearer token every /v1 caller must now present (audit F1).
# Set via GATEWAY_INTERNAL_TOKEN so it wins over Settings/LITELLM_MASTER_KEY.
_TOKEN = "test-internal-token"
_AUTH = {"Authorization": f"Bearer {_TOKEN}"}


def _mk_app(monkeypatch, captured: list[dict]) -> TestClient:
    monkeypatch.setenv("GATEWAY_INTERNAL_TOKEN", _TOKEN)

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

    resp = client.post("/v1/chat/completions", headers=_AUTH, json={
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


def test_v1_compat_populates_tier_label_from_alias(monkeypatch):
    # A tier alias in the request now populates the usage event's tier label,
    # so the per-tier cost/usage breakdown is no longer blank for agent traffic.
    captured: list[dict] = []
    client = _mk_app(monkeypatch, captured)
    resp = client.post("/v1/chat/completions", headers=_AUTH, json={
        "model": "tier-balanced",
        "messages": [{"role": "user", "content": "hi"}], "stream": False})
    assert resp.status_code == 200
    ev = next(e for e in captured if e.get("kind") == "model")
    assert ev.get("tier") == "tier-balanced"


def test_v1_compat_attributes_agent_from_header(monkeypatch):
    # The agent runtime stamps X-CC-Agent / X-CC-Source via default_headers so
    # the model call + cost tie back to the specific agent (not just the app).
    captured: list[dict] = []
    client = _mk_app(monkeypatch, captured)

    resp = client.post(
        "/v1/chat/completions",
        headers={**_AUTH, "X-CC-Agent": "sales", "X-CC-Source": "chat"},
        json={"model": "gpt-4o-mini",
              "messages": [{"role": "user", "content": "hi"}], "stream": False},
    )
    assert resp.status_code == 200
    ev = [e for e in captured if e.get("kind") == "model"][0]
    assert ev["agent"] == "sales"
    assert ev["source"] == "chat"


def test_v1_compat_without_header_falls_back_to_chat(monkeypatch):
    # Fail-soft: no attribution header → source="chat", no agent (today's behaviour).
    captured: list[dict] = []
    client = _mk_app(monkeypatch, captured)
    resp = client.post("/v1/chat/completions", headers=_AUTH, json={
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "hi"}], "stream": False})
    assert resp.status_code == 200
    ev = [e for e in captured if e.get("kind") == "model"][0]
    assert ev["source"] == "chat"
    assert ev.get("agent") is None


def test_v1_compat_rejects_anonymous(monkeypatch):
    # audit F1: the OpenAI-compatible proxy must not be world-reachable.
    captured: list[dict] = []
    client = _mk_app(monkeypatch, captured)
    resp = client.post("/v1/chat/completions", json={
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "hi"}], "stream": False})
    assert resp.status_code == 401
    # A wrong token is also rejected.
    resp = client.post(
        "/v1/chat/completions",
        headers={"Authorization": "Bearer wrong"},
        json={"model": "gpt-4o-mini",
              "messages": [{"role": "user", "content": "hi"}], "stream": False},
    )
    assert resp.status_code == 401


def test_v1_compat_completion_error_does_not_emit(monkeypatch):
    captured: list[dict] = []

    async def _no_keys() -> None:
        return None

    async def _boom(**kw):
        raise RuntimeError("provider down")

    monkeypatch.setenv("GATEWAY_INTERNAL_TOKEN", _TOKEN)
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

    resp = client.post("/v1/chat/completions", headers=_AUTH, json={
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "hi"}],
        "stream": False,
    })
    # A 200 body with no ``choices`` makes the MAF/OpenAI client iterate a None
    # ``choices`` and fail with "'NoneType' object is not iterable", masking the
    # real cause. The endpoint returns a non-2xx so the client raises cleanly.
    # RuntimeError has no status_code → defaults to 502; the reason survives.
    assert resp.status_code == 502
    err = resp.json()["error"]
    assert err["code"] == 502
    assert "provider down" in err["message"]
    # No usage → no model activation emitted.
    assert [e for e in captured if e.get("kind") == "model"] == []


def test_v1_compat_upstream_error_surfaces_status_and_redacts_secrets(monkeypatch):
    """An upstream failure propagates its status + a SANITIZED reason.

    The provider's reason (rate limit / bad key / context length) is what makes
    the error actionable, but its string may embed a key or endpoint URL. The
    gateway must forward the status code and reason while redacting secrets, so
    the frontend can classify it and the operator sees the real cause — not an
    opaque "upstream completion error" dead-end.
    """
    captured: list[dict] = []

    async def _no_keys() -> None:
        return None

    class _RateLimited(Exception):
        status_code = 429

        def __init__(self):
            super().__init__(
                "RateLimitError: quota exceeded for key sk-abcdef123456 at "
                "https://api.deepseek.com/v1/chat/completions"
            )

    async def _boom(**kw):
        raise _RateLimited()

    monkeypatch.setenv("GATEWAY_INTERNAL_TOKEN", _TOKEN)
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

    resp = client.post("/v1/chat/completions", headers=_AUTH, json={
        "model": "tier-balanced",
        "messages": [{"role": "user", "content": "hi"}],
        "stream": False,
    })
    # Status propagates so the client/frontend can classify it as a rate limit.
    assert resp.status_code == 429
    err = resp.json()["error"]
    assert err["code"] == 429
    msg = err["message"]
    assert "(429)" in msg
    assert "quota exceeded" in msg          # the actionable reason survives
    assert "sk-abcdef123456" not in msg     # key fragment redacted
    assert "api.deepseek.com" not in msg    # endpoint URL redacted
    assert "[redacted]" in msg


def test_v1_compat_nonstreaming_missing_choices_becomes_error(monkeypatch):
    """A 200 upstream body without ``choices`` must not reach the client as 200.

    litellm (or a provider) can return a soft-error body that has no
    ``choices``; forwarded as 200 it crashes the MAF/OpenAI client on
    ``for choice in response.choices`` (choices=None → 'NoneType' object is not
    iterable). We surface it as a 502 so the client raises a clear error.
    """
    captured: list[dict] = []

    async def _no_keys() -> None:
        return None

    async def _no_choices(**kw):
        # An error-shaped 200 with no choices (what triggered the original bug).
        return {"error": {"message": "content policy", "type": "InvalidRequest"}}

    monkeypatch.setenv("GATEWAY_INTERNAL_TOKEN", _TOKEN)
    monkeypatch.setattr(v1_compat, "_ensure_keys_loaded", _no_keys)
    monkeypatch.setattr(litellm, "acompletion", _no_choices)
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

    resp = client.post("/v1/chat/completions", headers=_AUTH, json={
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "hi"}],
        "stream": False,
    })
    assert resp.status_code == 502
    assert resp.json()["error"]["type"] == "UpstreamResponseError"


def test_v1_compat_streaming_null_choices_normalized_to_list(monkeypatch):
    """A streamed chunk with ``choices=None`` is emitted as ``choices=[]``.

    The MAF/OpenAI client calls ``len(chunk.choices)`` on every streamed chunk,
    so a null there crashes the whole run. Normalising to an empty list keeps
    the stream valid (the client already skips empty, usage-only chunks).
    """
    captured: list[dict] = []

    async def _no_keys() -> None:
        return None

    class _Chunk:
        def __init__(self, data):
            self._data = data

        def model_dump(self):
            return dict(self._data)

    async def _stream(**kw):
        async def _gen():
            # A usage-only final chunk some providers send with choices=null.
            yield _Chunk({"id": "c1", "model": "gpt-4o-mini", "choices": None,
                          "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                                    "total_tokens": 2}})
        return _gen()

    monkeypatch.setenv("GATEWAY_INTERNAL_TOKEN", _TOKEN)
    monkeypatch.setattr(v1_compat, "_ensure_keys_loaded", _no_keys)
    monkeypatch.setattr(litellm, "acompletion", _stream)
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

    resp = client.post("/v1/chat/completions", headers=_AUTH, json={
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "hi"}],
        "stream": True,
    })
    assert resp.status_code == 200
    body = resp.text
    # The emitted chunk carries an empty list, never a null.
    assert '"choices": []' in body
    assert '"choices": null' not in body
