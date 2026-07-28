"""Tests for the meeting bot's live-caption path.

A bot that joins a call and produces silence is the worst failure mode here,
because it looks like success right up until the meeting ends. These lock the
two things that decide whether captions appear at all: whether live is
considered possible, and whether the provider's messages are understood.

The worker lives outside the uv workspace (standalone Docker service), so its
module is loaded by path.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys

_MOD_PATH = (
    pathlib.Path(__file__).resolve().parents[2]
    / "apps/services/meeting_bot/app/live.py"
)


def _load(monkeypatch=None):
    name = "meeting_bot_live_asr"
    spec = importlib.util.spec_from_file_location(name, _MOD_PATH)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


live = _load()


# ── AssemblyAI streaming v3 ──────────────────────────────────────────────────

def _turn(transcript: str, *, end_of_turn: bool, words=None) -> dict:
    return {
        "type": "Turn",
        "turn_order": 0,
        "transcript": transcript,
        "end_of_turn": end_of_turn,
        "words": words or [],
    }


def test_completed_turn_becomes_a_segment() -> None:
    out = live._parse_assemblyai_message(
        _turn(
            "so the qualification time is the blocker",
            end_of_turn=True,
            words=[
                {"start": 1500, "end": 1800, "text": "so"},
                {"start": 4200, "end": 4600, "text": "blocker"},
            ],
        )
    )
    assert len(out) == 1
    seg = out[0]
    assert seg["text"] == "so the qualification time is the blocker"
    assert seg["is_final"] is True
    # Word timings are milliseconds; the bus works in seconds, and the spans
    # drive speaker reconciliation, so the conversion has to be right.
    assert seg["start_s"] == 1.5
    assert seg["end_s"] == 4.6


def test_partial_turns_are_dropped() -> None:
    """AssemblyAI streams a growing partial for every turn. The live bus appends
    rather than replaces, so forwarding partials would stutter the same sentence
    down the console one word at a time."""
    assert live._parse_assemblyai_message(_turn("so the", end_of_turn=False)) == []
    assert live._parse_assemblyai_message(
        _turn("so the qualification", end_of_turn=False)
    ) == []


def test_non_turn_messages_are_ignored() -> None:
    """Begin/Termination frames carry no transcript."""
    assert live._parse_assemblyai_message({"type": "Begin", "id": "x"}) == []
    assert live._parse_assemblyai_message({"type": "Termination"}) == []


def test_empty_transcript_is_not_a_segment() -> None:
    assert live._parse_assemblyai_message(_turn("   ", end_of_turn=True)) == []


def test_turn_without_words_still_yields_text() -> None:
    """Timings are a bonus; losing them must not lose the sentence."""
    out = live._parse_assemblyai_message(_turn("hello there", end_of_turn=True))
    assert len(out) == 1
    assert out[0]["start_s"] == 0.0


# ── protocol routing ─────────────────────────────────────────────────────────

def test_parser_routes_by_protocol() -> None:
    import json

    turn = json.dumps(_turn("hi", end_of_turn=True))
    assert live._parse_asr_message(turn, "assemblyai")[0]["text"] == "hi"
    # The same payload under the WhisperLive protocol has no 'text'/'segments'
    # key, so it must not be silently mis-parsed.
    assert live._parse_asr_message(turn, "whisperlive") == []


def test_whisperlive_shape_still_parses() -> None:
    import json

    raw = json.dumps({"segments": [{"text": "hello", "start": 1.0, "end": 2.0}]})
    out = live._parse_asr_message(raw, "whisperlive")
    assert out == [{"text": "hello", "start_s": 1.0, "end_s": 2.0, "is_final": True}]


def test_garbage_never_raises() -> None:
    assert live._parse_asr_message("not json", "assemblyai") == []
    assert live._parse_asr_message("[]", "assemblyai") == []


# ── enablement ───────────────────────────────────────────────────────────────

def test_live_needs_some_asr_source(monkeypatch) -> None:
    """Either a self-hosted socket or the gateway token endpoint. Neither means
    the bot records but never emits a caption — which is exactly the silent
    failure this guards."""
    monkeypatch.setattr(live, "LIVE_ASR_URL", "")
    monkeypatch.setattr(live, "LIVE_TOKEN_URL", "")
    assert live.live_enabled() is False

    monkeypatch.setattr(live, "LIVE_TOKEN_URL", "http://gw/notes/stt/bot-live-token")
    assert live.live_enabled() is True

    monkeypatch.setattr(live, "LIVE_TOKEN_URL", "")
    monkeypatch.setattr(live, "LIVE_ASR_URL", "ws://asr:9090")
    assert live.live_enabled() is True


async def _resolve(mod):
    return await mod._resolve_asr()


def test_selfhosted_asr_wins_over_the_paid_path(monkeypatch) -> None:
    """A self-hosted socket costs nothing per minute, so it must not be
    bypassed just because a provider key also exists."""
    import asyncio

    monkeypatch.setattr(live, "LIVE_ASR_URL", "ws://asr:9090")
    monkeypatch.setattr(live, "LIVE_TOKEN_URL", "http://gw/token")
    assert asyncio.run(_resolve(live)) == ("ws://asr:9090", "whisperlive")


def test_no_source_resolves_to_none(monkeypatch) -> None:
    import asyncio

    monkeypatch.setattr(live, "LIVE_ASR_URL", "")
    monkeypatch.setattr(live, "LIVE_TOKEN_URL", "")
    assert asyncio.run(_resolve(live)) is None
