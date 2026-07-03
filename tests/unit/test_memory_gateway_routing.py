"""Regression tests for the memory-client OpenRouter hijack fix.

Bug (2026-07-03): mem0 2.0.4 (and graphiti-core) build their own OpenAI client
and short-circuit to OpenRouter when ``OPENROUTER_API_KEY`` is set in the
environment — BEFORE honouring the ``openai_base_url`` we pass.  Because that
env var is legitimately set platform-wide, memory extraction sent our gateway
tier alias (``tier-fast``) straight to OpenRouter → ``400 tier-fast is not a
valid model ID``, silently breaking memory write-back for every agent.

Fix: ``acb_memory._gateway_env.gateway_only_env`` removes the override vars for
the duration of client construction so the client honours our gateway base_url
and can resolve the tier alias.  These tests lock that behaviour.
"""
from __future__ import annotations

import os

import pytest

from acb_memory._gateway_env import HIJACK_ENV_VARS, gateway_only_env


# ---------------------------------------------------------------------------
# The guard itself — pure, no external deps
# ---------------------------------------------------------------------------

def test_gateway_only_env_removes_override_vars_inside_block() -> None:
    """Inside the block, all hijack vars are absent; outside, restored."""
    saved = {k: os.environ.get(k) for k in HIJACK_ENV_VARS}
    try:
        os.environ["OPENROUTER_API_KEY"] = "sk-or-sentinel"
        os.environ["OPENAI_BASE_URL"] = "https://example.invalid/v1"
        assert os.environ.get("OPENROUTER_API_KEY") == "sk-or-sentinel"

        with gateway_only_env():
            for k in HIJACK_ENV_VARS:
                assert k not in os.environ, f"{k} should be removed inside block"

        # Restored after the block.
        assert os.environ.get("OPENROUTER_API_KEY") == "sk-or-sentinel"
        assert os.environ.get("OPENAI_BASE_URL") == "https://example.invalid/v1"
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_gateway_only_env_restores_on_exception() -> None:
    """Env is restored even if the guarded block raises."""
    saved = os.environ.get("OPENROUTER_API_KEY")
    try:
        os.environ["OPENROUTER_API_KEY"] = "sk-or-sentinel"
        with pytest.raises(RuntimeError):
            with gateway_only_env():
                assert "OPENROUTER_API_KEY" not in os.environ
                raise RuntimeError("boom")
        assert os.environ.get("OPENROUTER_API_KEY") == "sk-or-sentinel"
    finally:
        if saved is None:
            os.environ.pop("OPENROUTER_API_KEY", None)
        else:
            os.environ["OPENROUTER_API_KEY"] = saved


def test_gateway_only_env_noop_when_vars_absent() -> None:
    """When no override vars are set, the block is a clean no-op."""
    saved = {k: os.environ.pop(k, None) for k in HIJACK_ENV_VARS}
    try:
        with gateway_only_env():
            for k in HIJACK_ENV_VARS:
                assert k not in os.environ
        for k in HIJACK_ENV_VARS:
            assert k not in os.environ
    finally:
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v


# ---------------------------------------------------------------------------
# End-to-end: a mem0 OpenAI LLM built the way mem0_client does routes to OUR
# gateway even when OPENROUTER_API_KEY is set.  Skips if mem0 isn't installed.
# ---------------------------------------------------------------------------

def test_mem0_llm_client_uses_gateway_base_url_despite_openrouter_key() -> None:
    """Building mem0's OpenAILLM under gateway_only_env points its client at our
    gateway base_url, NOT openrouter.ai — even with OPENROUTER_API_KEY set.

    This reproduces the exact failure path: mem0's OpenAILLM.__init__ prefers
    OPENROUTER_API_KEY unless we neutralise it during construction.
    """
    OpenAILLM = pytest.importorskip("mem0.llms.openai").OpenAILLM

    gateway = "http://127.0.0.1:8080/v1"
    cfg = {
        "model": "tier-fast",
        "api_key": "sk-master-test",
        "openai_base_url": gateway,
    }

    saved = {k: os.environ.get(k) for k in HIJACK_ENV_VARS}
    try:
        # Simulate prod: OpenRouter key present, no OPENAI_BASE_URL override.
        os.environ["OPENROUTER_API_KEY"] = "sk-or-prod-key"
        os.environ.pop("OPENAI_BASE_URL", None)
        os.environ.pop("OPENAI_API_BASE", None)

        # WITHOUT the guard → mem0 diverts to openrouter.ai (the bug).
        bug = OpenAILLM(dict(cfg))
        assert "openrouter" in str(bug.client.base_url), (
            "precondition: without the guard mem0 should hit openrouter "
            "(if this fails, mem0's routing changed — revisit the fix)"
        )

        # WITH the guard → mem0 honours our gateway base_url (the fix).
        with gateway_only_env():
            fixed = OpenAILLM(dict(cfg))
        assert gateway.rstrip("/") in str(fixed.client.base_url).rstrip("/"), (
            f"expected gateway base_url, got {fixed.client.base_url}"
        )
        assert "openrouter" not in str(fixed.client.base_url)
        # The tier alias is preserved for the gateway to resolve.
        assert fixed.config.model == "tier-fast"
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
