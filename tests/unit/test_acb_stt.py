"""Tests for acb_stt — LiteLLM response normalization + tier-based resolution."""
from __future__ import annotations

from dataclasses import dataclass

from acb_stt import LiteLLMSTT, normalize_transcription, resolve_stt_provider

# ── normalize_transcription (litellm verbose_json shape) ─────────────────────

def test_normalize_verbose_json_segments() -> None:
    resp = {
        "text": "Hello there. General Kenobi.",
        "language": "english",
        "duration": 3.4,
        "segments": [
            {"start": 0.0, "end": 1.5, "text": " Hello there."},
            {"start": 1.6, "end": 3.4, "text": " General Kenobi."},
        ],
    }
    r = normalize_transcription(resp, model="groq/whisper-large-v3-turbo", diarize=True)
    assert r.provider == "litellm"
    assert r.model == "groq/whisper-large-v3-turbo"
    assert r.text == "Hello there. General Kenobi."
    assert r.language == "english"
    assert r.duration_s == 3.4
    assert [s.text for s in r.segments] == ["Hello there.", "General Kenobi."]
    assert r.segments[1].idx == 1 and r.segments[1].start_s == 1.6
    # whisper carries no speaker labels → not diarized even when requested
    assert not r.diarized


def test_normalize_object_response_with_words() -> None:
    """litellm returns a pydantic-ish object, not a dict — attribute access."""

    @dataclass
    class _Word:
        word: str
        start: float
        end: float

    @dataclass
    class _Seg:
        start: float
        end: float
        text: str
        words: list

    @dataclass
    class _Resp:
        text: str
        language: str
        duration: float
        segments: list

    resp = _Resp(
        text="hi there",
        language="en",
        duration=1.0,
        segments=[_Seg(0.0, 1.0, "hi there", [_Word("hi", 0.0, 0.4), _Word("there", 0.4, 1.0)])],
    )
    r = normalize_transcription(resp, model="openai/whisper-1", diarize=False)
    assert r.segments[0].words is not None
    assert [w.text for w in r.segments[0].words] == ["hi", "there"]


def test_normalize_text_only_yields_one_segment() -> None:
    r = normalize_transcription({"text": "just text"}, model="m", diarize=False)
    assert len(r.segments) == 1
    assert r.segments[0].text == "just text"
    assert r.segments[0].end_s == 0.0


def test_normalize_diarized_when_speaker_present() -> None:
    resp = {
        "text": "a b",
        "segments": [
            {"start": 0, "end": 1, "text": "a", "speaker": 0},
            {"start": 1, "end": 2, "text": "b", "speaker": 1},
        ],
    }
    r = normalize_transcription(resp, model="deepgram/nova-3", diarize=True)
    assert [s.speaker_label for s in r.segments] == ["S1", "S2"]
    assert r.diarized


# ── resolution: model alias, default, and env override ───────────────────────

async def test_resolve_defaults_to_tier_stt(monkeypatch) -> None:
    monkeypatch.delenv("NOTES_STT_MODEL", raising=False)
    provider = await resolve_stt_provider()
    assert isinstance(provider, LiteLLMSTT)
    assert provider._alias == "tier-stt"


async def test_resolve_env_override(monkeypatch) -> None:
    monkeypatch.setenv("NOTES_STT_MODEL", "openai/whisper-1")
    provider = await resolve_stt_provider()
    assert provider._alias == "openai/whisper-1"


async def test_resolve_explicit_arg_wins(monkeypatch) -> None:
    monkeypatch.setenv("NOTES_STT_MODEL", "openai/whisper-1")
    provider = await resolve_stt_provider("groq/whisper-large-v3-turbo")
    assert provider._alias == "groq/whisper-large-v3-turbo"


def test_tier_stt_resolves_through_acb_llm() -> None:
    """The tier-stt alias must resolve via the shared tier machinery."""
    from acb_llm.client import _TIER_ALIAS_MAP, _TIER_MODEL
    from acb_llm.context import resolve_underlying_model

    assert _TIER_ALIAS_MAP.get("tier-stt") == "stt"
    assert "stt" in _TIER_MODEL
    # tier-stt resolves to a concrete provider/model (never left as the alias).
    resolved = resolve_underlying_model("tier-stt")
    assert "/" in resolved and resolved != "tier-stt"
