"""Regression tests — web_search provider chain (SerpAPI first, free fallback).

web_search is OUR injected tool (identical for MAF and Copilot SDK agents —
not GitHub Copilot's built-in search). Provider order, best-first:
SerpAPI (Google) whenever a key is configured → the free ddgs engines
(backend="auto" rotation) otherwise / on SerpAPI failure. Errors name each
provider tried so "search is down" reports are diagnosable.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from acb_skills import web_tools


@pytest.mark.asyncio
async def test_serpapi_is_primary_when_key_configured(monkeypatch):
    monkeypatch.setenv("SERPAPI_API_KEY", "test-key")

    class _MustNotRun:
        def __enter__(self):
            raise AssertionError("free engines must not run when SerpAPI succeeds")
        def __exit__(self, *a):
            return False

    fake_resp = SimpleNamespace(
        status_code=200,
        json=lambda: {"organic_results": [
            {"title": "Fracktal Works", "link": "https://fracktal.in",
             "snippet": "3D printers made in India."},
        ]},
        raise_for_status=lambda: None,
    )
    import ddgs as ddgs_mod
    monkeypatch.setattr(ddgs_mod, "DDGS", _MustNotRun)
    with patch("httpx.AsyncClient") as client_cls:
        http = client_cls.return_value.__aenter__.return_value
        http.get = AsyncMock(return_value=fake_resp)
        out = await web_tools.web_search("fracktal works", max_results=3)

    assert "Fracktal Works" in out
    assert "https://fracktal.in" in out
    assert "failed" not in out.lower()


@pytest.mark.asyncio
async def test_free_engines_used_when_no_serpapi_key(monkeypatch):
    monkeypatch.delenv("SERPAPI_API_KEY", raising=False)
    monkeypatch.setattr(
        web_tools, "_serpapi_search", AsyncMock(return_value=""))

    class _OkDDGS:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def text(self, *a, **k):
            return [{"title": "DDG hit", "href": "https://x.example",
                     "body": "free engine result"}]

    import ddgs as ddgs_mod
    monkeypatch.setattr(ddgs_mod, "DDGS", _OkDDGS)
    out = await web_tools.web_search("anything")
    assert "DDG hit" in out and "https://x.example" in out


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
