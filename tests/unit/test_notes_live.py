"""Tests for the live-transcription token endpoint — the pure, testable parts:
key lookup, model resolution, and the config guard. The live Deepgram HTTP calls
need a real key and aren't exercised here."""
from __future__ import annotations

import pytest
from gateway.routes.notes import live


def test_deepgram_key_reads_env(monkeypatch) -> None:
    monkeypatch.setenv("DEEPGRAM_API_KEY", "  dg-secret  ")
    assert live._deepgram_key() == "dg-secret"
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    assert live._deepgram_key() == ""


def test_live_model_defaults_to_nova3(monkeypatch) -> None:
    # tier-stt resolves to a whisper model by default → live falls back to nova-3
    # (whisper can't stream), so live always has a usable Deepgram model.
    monkeypatch.setattr(
        "acb_llm.context.resolve_underlying_model",
        lambda _alias: "groq/whisper-large-v3-turbo",
    )
    assert live._live_model() == "nova-3"


def test_live_model_uses_configured_deepgram(monkeypatch) -> None:
    monkeypatch.setattr(
        "acb_llm.context.resolve_underlying_model",
        lambda _alias: "deepgram/nova-2",
    )
    assert live._live_model() == "nova-2"


async def test_live_token_503_without_key(monkeypatch) -> None:
    """No Deepgram key → 503, so the recorder falls back to the batch path."""
    from fastapi import HTTPException

    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    with pytest.raises(HTTPException) as ei:
        await live.live_token(_user=None)  # type: ignore[arg-type]
    assert ei.value.status_code == 503
    assert "Deepgram" in ei.value.detail
