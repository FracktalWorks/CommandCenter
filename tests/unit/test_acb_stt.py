"""Tests for acb_stt — response parsing and provider resolution."""
from __future__ import annotations

import pytest
from acb_stt.providers.deepgram import DeepgramSTT
from acb_stt.providers.openai_compat import GroqSTT
from acb_stt.registry import resolve_stt_provider
from acb_stt.types import SttError

# ── OpenAI-compatible verbose_json parsing ───────────────────────────────────

def test_openai_compat_parse_verbose_json() -> None:
    payload = {
        "text": "Hello there. General Kenobi.",
        "language": "english",
        "duration": 3.4,
        "segments": [
            {"start": 0.0, "end": 1.5, "text": " Hello there."},
            {"start": 1.6, "end": 3.4, "text": " General Kenobi."},
        ],
    }
    result = GroqSTT(api_key="k").parse(payload, model="whisper-large-v3-turbo")
    assert result.provider == "groq"
    assert result.text == "Hello there. General Kenobi."
    assert result.duration_s == 3.4
    assert not result.diarized
    assert [s.text for s in result.segments] == ["Hello there.", "General Kenobi."]
    assert result.segments[1].idx == 1
    assert result.segments[1].start_s == 1.6


def test_openai_compat_parse_json_only_fallback() -> None:
    # json (no segments) responses still yield one renderable segment.
    result = GroqSTT(api_key="k").parse({"text": "hi"}, model="m")
    assert len(result.segments) == 1
    assert result.segments[0].text == "hi"
    assert result.segments[0].end_s == 0.0


# ── Deepgram utterances parsing ──────────────────────────────────────────────

def test_deepgram_parse_utterances_with_speakers() -> None:
    payload = {
        "metadata": {"duration": 5.0},
        "results": {
            "channels": [
                {
                    "detected_language": "en",
                    "alternatives": [{"transcript": "Hi. Hello back."}],
                }
            ],
            "utterances": [
                {
                    "start": 0.1, "end": 1.0, "transcript": "Hi.",
                    "confidence": 0.98, "speaker": 0,
                    "words": [
                        {"word": "hi", "punctuated_word": "Hi.", "start": 0.1, "end": 0.9}
                    ],
                },
                {
                    "start": 1.2, "end": 4.8, "transcript": "Hello back.",
                    "confidence": 0.91, "speaker": 1,
                },
            ],
        },
    }
    result = DeepgramSTT(api_key="k").parse(payload, model="nova-3", diarized=True)
    assert result.diarized
    assert result.language == "en"
    assert result.duration_s == 5.0
    assert [s.speaker_label for s in result.segments] == ["S1", "S2"]
    assert result.segments[0].words is not None
    assert result.segments[0].words[0].text == "Hi."
    assert result.text == "Hi. Hello back."


def test_deepgram_parse_no_utterances_is_safe() -> None:
    result = DeepgramSTT(api_key="k").parse({"results": {}}, model="nova-3", diarized=True)
    assert result.segments == []
    assert result.text == ""
    assert not result.diarized  # nothing carried a speaker label


# ── Registry resolution (env fallback path) ──────────────────────────────────

def _kill_key_store(monkeypatch: pytest.MonkeyPatch) -> None:
    import acb_llm.key_store as ks

    def _raise():
        raise RuntimeError("store unavailable in tests")

    monkeypatch.setattr(ks, "get_key_store", _raise)


async def test_registry_prefers_groq_env(monkeypatch: pytest.MonkeyPatch) -> None:
    _kill_key_store(monkeypatch)
    monkeypatch.delenv("NOTES_STT_PROVIDER", raising=False)
    monkeypatch.setenv("GROQ_API_KEY", "g")
    monkeypatch.setenv("OPENAI_API_KEY", "o")
    provider = await resolve_stt_provider()
    assert provider.name == "groq"


async def test_registry_explicit_provider_and_env_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _kill_key_store(monkeypatch)
    monkeypatch.setenv("DEEPGRAM_API_KEY", "d")
    provider = await resolve_stt_provider("deepgram")
    assert provider.name == "deepgram"
    assert provider.capabilities().diarization
    monkeypatch.setenv("NOTES_STT_PROVIDER", "deepgram")
    assert (await resolve_stt_provider()).name == "deepgram"


async def test_registry_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    _kill_key_store(monkeypatch)
    monkeypatch.delenv("NOTES_STT_PROVIDER", raising=False)
    for var in ("GROQ_API_KEY", "OPENAI_API_KEY", "DEEPGRAM_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(SttError):
        await resolve_stt_provider("nonexistent-provider")
    with pytest.raises(SttError):
        await resolve_stt_provider("groq")  # known, but no key anywhere
    with pytest.raises(SttError):
        await resolve_stt_provider()  # nothing configured at all
