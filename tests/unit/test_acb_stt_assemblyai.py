"""Tests for the native AssemblyAI STT provider.

AssemblyAI is submit-then-poll, so it can't ride LiteLLM like the other STT
models — it has its own provider, and the registry picks it by model prefix.
These cover the pure parts: option mapping, response normalisation (including
the speaker-label convention the rest of the app depends on), and routing.
"""
from __future__ import annotations

import pytest
from acb_stt.assemblyai_provider import (
    AssemblyAISTT,
    boost_terms,
    is_assemblyai_model,
    normalize,
    speech_model,
)
from acb_stt.types import SttOptions

# ── model identification / routing ───────────────────────────────────────────

def test_recognises_assemblyai_models() -> None:
    assert is_assemblyai_model("assemblyai/universal")
    assert is_assemblyai_model("AssemblyAI/Nano")      # case-insensitive
    assert not is_assemblyai_model("deepgram/nova-3")
    assert not is_assemblyai_model("groq/whisper-large-v3-turbo")
    assert not is_assemblyai_model("")


def test_speech_model_strips_the_provider_prefix() -> None:
    """The part after the slash is passed through as `speech_model`, so any id
    AssemblyAI accepts works even if we haven't catalogued it."""
    assert speech_model("assemblyai/universal") == "universal"
    assert speech_model("assemblyai/some-future-model") == "some-future-model"
    assert speech_model("assemblyai/") is None       # let AssemblyAI default


@pytest.mark.asyncio
async def test_registry_routes_assemblyai_to_native_provider() -> None:
    from acb_stt import LiteLLMSTT, resolve_stt_provider

    assert isinstance(await resolve_stt_provider("assemblyai/universal"), AssemblyAISTT)
    assert isinstance(await resolve_stt_provider("deepgram/nova-3"), LiteLLMSTT)


# ── request building ─────────────────────────────────────────────────────────

def test_request_asks_for_speakers_and_language_detection() -> None:
    body = AssemblyAISTT("assemblyai/universal").build_request(
        "https://cdn/audio", SttOptions(diarize=True)
    )
    assert body["audio_url"] == "https://cdn/audio"
    assert body["speaker_labels"] is True
    assert body["speech_model"] == "universal"
    # No language hint → detect, so Hindi/English meetings aren't forced to one.
    assert body["language_detection"] is True
    assert "language_code" not in body


def test_explicit_language_replaces_detection() -> None:
    body = AssemblyAISTT("assemblyai/universal").build_request(
        "u", SttOptions(language="en", diarize=False)
    )
    assert body["language_code"] == "en"
    assert "language_detection" not in body
    assert "speaker_labels" not in body


def test_glossary_prompt_becomes_word_boost() -> None:
    body = AssemblyAISTT("assemblyai/universal").build_request(
        "u", SttOptions(prompt="Fracktal Works, Julia printer; PETG")
    )
    assert body["word_boost"] == ["Fracktal Works", "Julia printer", "PETG"]


def test_boost_terms_rejects_sentences_and_empties() -> None:
    """word_boost wants vocabulary, not prose — a wordy glossary preamble must
    not be shipped as a 'term'."""
    terms = boost_terms("This is a long sentence that is clearly not a term, Julia")
    assert terms == ["Julia"]
    assert boost_terms(None) == []
    assert boost_terms("") == []


# ── response normalisation ───────────────────────────────────────────────────

def _payload() -> dict:
    return {
        "text": "Hi, I'm Priya. Good to meet you.",
        "audio_duration": 12.5,
        "language_code": "en",
        "utterances": [
            {"speaker": "A", "text": "Hi, I'm Priya.", "start": 0, "end": 2000,
             "confidence": 0.98,
             "words": [{"text": "Hi", "start": 0, "end": 400}]},
            {"speaker": "B", "text": "Good to meet you.", "start": 2000, "end": 4000},
        ],
    }


def test_utterances_become_diarized_segments() -> None:
    r = normalize(_payload(), "assemblyai/universal")
    assert r.diarized is True
    assert r.provider == "assemblyai"
    assert [s.speaker_label for s in r.segments] == ["S1", "S2"]
    assert [s.idx for s in r.segments] == [0, 1]
    assert r.language == "en"
    assert r.duration_s == 12.5


def test_offsets_convert_from_milliseconds_to_seconds() -> None:
    """AssemblyAI reports ms; the whole app (seek, reconciliation) assumes s."""
    r = normalize(_payload(), "assemblyai/universal")
    assert r.segments[0].start_s == 0.0
    assert r.segments[0].end_s == 2.0
    assert r.segments[1].start_s == 2.0
    assert r.segments[0].words[0].end_s == 0.4


def test_speaker_letters_map_onto_the_shared_S1_S2_space() -> None:
    """Deepgram gives ints, AssemblyAI letters — both must land on S1/S2 so
    speaker_names, the rename UI and live reconciliation stay provider-agnostic."""
    r = normalize({"text": "x", "utterances": [
        {"speaker": "C", "text": "third speaker", "start": 0, "end": 1000},
    ]}, "assemblyai/universal")
    assert r.segments[0].speaker_label == "S3"


def test_undiarized_response_falls_back_to_words() -> None:
    r = normalize(
        {"text": "hello world",
         "words": [{"text": "hello", "start": 0, "end": 500},
                   {"text": "world", "start": 500, "end": 1000}]},
        "assemblyai/nano",
    )
    assert r.diarized is False        # → local sherpa diarization can still run
    assert len(r.segments) == 1
    assert r.segments[0].end_s == 1.0


def test_empty_response_is_survivable() -> None:
    r = normalize({}, "assemblyai/universal")
    assert r.segments == []
    assert r.text == ""
    assert r.diarized is False
