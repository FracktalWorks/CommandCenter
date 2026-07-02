"""Regression tests — web_search resilience (engine rotation + SerpAPI fallback).

The agent-reported "websearch is down": web_search is OUR injected ddgs tool
(identical for MAF and Copilot SDK agents — not GitHub's built-in search, and
previously not connected to SerpAPI at all). A single blocked egress path
killed it with an opaque error. Now: ddgs rotates engines (backend="auto"),
falls back to SerpAPI when SERPAPI_API_KEY is configured, and reports a
diagnosable error naming both failures otherwise.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from acb_skills import web_tools


@pytest.mark.asyncio
async def test_serpapi_fallback_used_when_ddgs_fails(monkeypatch):
    monkeypatch.setenv("SERPAPI_API_KEY", "test-key")

    class _BoomDDGS:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def text(self, *a, **k):
            raise RuntimeError("403 Forbidden (blocked egress)")

    fake_resp = SimpleNamespace(
        status_code=200,
        json=lambda: {"organic_results": [
            {"title": "Fracktal Works", "link": "https://fracktal.in",
             "snippet": "3D printers made in India."},
        ]},
        raise_for_status=lambda: None,
    )
    with patch.object(web_tools, "DDGS", _BoomDDGS, create=True), \
         patch("httpx.AsyncClient") as client_cls:
        # web_search imports DDGS inside the function — patch the module it
        # imports from instead.
        import ddgs as ddgs_mod
        monkeypatch.setattr(ddgs_mod, "DDGS", _BoomDDGS)
        http = client_cls.return_value.__aenter__.return_value
        http.get = AsyncMock(return_value=fake_resp)
        out = await web_tools.web_search("fracktal works", max_results=3)

    assert "Fracktal Works" in out
    assert "https://fracktal.in" in out
    assert "failed" not in out.lower()


@pytest.mark.asyncio
async def test_error_message_is_diagnosable_without_serpapi_key(monkeypatch):
    monkeypatch.delenv("SERPAPI_API_KEY", raising=False)

    class _BoomDDGS:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def text(self, *a, **k):
            raise RuntimeError("403 Forbidden (blocked egress)")

    import ddgs as ddgs_mod
    monkeypatch.setattr(ddgs_mod, "DDGS", _BoomDDGS)
    # get_settings may supply a key from the environment store — force empty.
    monkeypatch.setattr(
        web_tools, "_serpapi_search", AsyncMock(return_value=""))
    out = await web_tools.web_search("anything")
    assert "web_search failed" in out
    assert "403 Forbidden" in out
    # The message must tell the operator what to do / what to suspect.
    assert "SERPAPI_API_KEY" in out or "egress" in out


@pytest.mark.asyncio
async def test_serpapi_helper_returns_empty_string_without_key(monkeypatch):
    monkeypatch.delenv("SERPAPI_API_KEY", raising=False)
    with patch("acb_common.get_settings",
               return_value=SimpleNamespace(serpapi_api_key="")):
        res = await web_tools._serpapi_search("q", 5)
    assert res == ""
