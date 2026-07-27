"""Tests for the live-transcription token endpoint — the pure, testable parts:
key lookup, provider selection, model resolution, and the config guard. Minting
a real token needs a real key and isn't exercised here."""
from __future__ import annotations

import pytest
from gateway.routes.notes import live


def test_keys_read_env(monkeypatch) -> None:
    monkeypatch.setenv("DEEPGRAM_API_KEY", "  dg-secret  ")
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "  aai-secret  ")
    assert live._deepgram_key() == "dg-secret"
    assert live._assemblyai_key() == "aai-secret"
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    monkeypatch.delenv("ASSEMBLYAI_API_KEY", raising=False)
    assert live._deepgram_key() == ""
    assert live._assemblyai_key() == ""


# ── provider selection ───────────────────────────────────────────────────────

def test_live_follows_the_configured_stt_provider() -> None:
    """Choosing an AssemblyAI model for batch gets AssemblyAI live too — the
    whole point of "everything via AssemblyAI" needing no second setting."""
    assert live.choose_provider("assemblyai/universal", True, True) == "assemblyai"
    assert live.choose_provider("deepgram/nova-3", True, True) == "deepgram"


def test_prefers_assemblyai_when_the_tier_cant_stream() -> None:
    """Whisper can't stream, so the batch tier gives no signal — prefer the
    cheaper provider that also diarizes live."""
    assert live.choose_provider("groq/whisper-large-v3-turbo", True, True) == "assemblyai"


def test_falls_back_to_whichever_key_exists() -> None:
    assert live.choose_provider("assemblyai/universal", False, True) == "deepgram"
    assert live.choose_provider("deepgram/nova-3", True, False) == "assemblyai"
    assert live.choose_provider("", False, True) == "deepgram"
    assert live.choose_provider("", True, False) == "assemblyai"


def test_no_keys_means_no_live() -> None:
    assert live.choose_provider("assemblyai/universal", False, False) is None


# ── model resolution ─────────────────────────────────────────────────────────

def test_deepgram_live_model_defaults_to_nova3(monkeypatch) -> None:
    # tier-stt resolves to a whisper model → live falls back to nova-3 (whisper
    # can't stream), so the Deepgram path always has a usable model.
    monkeypatch.setattr(
        "acb_llm.context.resolve_underlying_model",
        lambda _alias: "groq/whisper-large-v3-turbo",
    )
    assert live._live_model("deepgram") == "nova-3"


def test_deepgram_live_model_uses_configured_model(monkeypatch) -> None:
    monkeypatch.setattr(
        "acb_llm.context.resolve_underlying_model",
        lambda _alias: "deepgram/nova-2",
    )
    assert live._live_model("deepgram") == "nova-2"


def test_assemblyai_live_model_defaults_to_provider_default(monkeypatch) -> None:
    """Empty → AssemblyAI picks its own default streaming model; overridable per
    deployment without a code change."""
    monkeypatch.delenv("ASSEMBLYAI_LIVE_MODEL", raising=False)
    assert live._live_model("assemblyai") == ""
    monkeypatch.setenv("ASSEMBLYAI_LIVE_MODEL", "universal-3.5-pro")
    assert live._live_model("assemblyai") == "universal-3.5-pro"


# ── guard ────────────────────────────────────────────────────────────────────

async def test_live_token_503_without_any_key(monkeypatch) -> None:
    """No streaming key at all → 503, so the recorder falls back to batch."""
    from fastapi import HTTPException

    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    monkeypatch.delenv("ASSEMBLYAI_API_KEY", raising=False)
    with pytest.raises(HTTPException) as ei:
        await live.live_token(_user=None)  # type: ignore[arg-type]
    assert ei.value.status_code == 503
    assert "AssemblyAI" in ei.value.detail
