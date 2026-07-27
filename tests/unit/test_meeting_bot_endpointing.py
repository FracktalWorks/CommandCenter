"""Tests for the meeting-bot worker's pause endpointer (pause-chunked spine).

The worker lives outside the uv workspace (standalone Docker service), so we load
its *pure* endpointing module by path — it has no audio/model deps. These lock
the "chunk on pauses, not the clock" boundary logic + the ASR-segment↔utterance
embedding match, without ffmpeg or a VAD model.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys

_MOD_PATH = (
    pathlib.Path(__file__).resolve().parents[2]
    / "apps/services/meeting_bot/app/endpointing.py"
)


def _load():
    name = "meeting_bot_endpointing"
    spec = importlib.util.spec_from_file_location(name, _MOD_PATH)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    # Register before exec so dataclasses can resolve the module's annotations.
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


ep = _load()


# ── endpointer boundaries ────────────────────────────────────────────────────

def test_closes_utterance_after_a_pause() -> None:
    e = ep.Endpointer()  # 100ms frames, 600ms hangover, 300ms min
    out = [e.push(f"s{i}", True) for i in range(5)]      # 500ms of speech
    assert all(o is None for o in out)                    # nothing closed yet
    sil = [e.push("q", False) for _ in range(6)]          # 600ms silence → close
    assert all(o is None for o in sil[:5])                # not until hangover met
    utt = sil[5]
    assert utt is not None
    assert utt.start_s == 0.0
    assert round(utt.end_s, 3) == 0.5
    assert utt.frames[:5] == ["s0", "s1", "s2", "s3", "s4"]  # speech kept in order


def test_short_blip_is_dropped() -> None:
    e = ep.Endpointer()
    e.push("s0", True)
    e.push("s1", True)                       # only 200ms < 300ms min
    closed = [e.push("q", False) for _ in range(6)]
    assert all(o is None for o in closed)    # blip never emitted


def test_long_monologue_hits_hard_cap() -> None:
    e = ep.Endpointer(max_utt_ms=500)
    outs = [e.push(f"s{i}", True) for i in range(5)]  # 5th frame reaches 500ms
    assert outs[:4] == [None, None, None, None]
    assert outs[4] is not None
    assert round(outs[4].end_s, 3) == 0.5


def test_flush_closes_open_utterance() -> None:
    e = ep.Endpointer()
    for i in range(4):
        e.push(f"s{i}", True)                # 400ms, still open
    utt = e.flush()
    assert utt is not None and round(utt.end_s, 3) == 0.4
    assert e.flush() is None                 # nothing left


def test_idle_silence_never_opens_an_utterance() -> None:
    e = ep.Endpointer()
    assert all(e.push("q", False) is None for _ in range(20))


# ── ASR-segment ↔ utterance embedding match ──────────────────────────────────

def test_pick_embedding_by_max_overlap() -> None:
    windows = [(0.0, 1.0, [1.0, 0.0]), (1.0, 2.0, [0.0, 1.0])]
    assert ep.pick_embedding(0.4, 0.6, windows) == [1.0, 0.0]
    assert ep.pick_embedding(1.2, 1.9, windows) == [0.0, 1.0]


def test_pick_embedding_none_when_disjoint() -> None:
    windows = [(0.0, 1.0, [1.0, 0.0])]
    assert ep.pick_embedding(5.0, 6.0, windows) is None
    assert ep.pick_embedding(0.0, 1.0, []) is None


def test_overlap_math() -> None:
    assert ep.overlap(0.0, 1.0, 0.5, 1.5) == 0.5
    assert ep.overlap(0.0, 1.0, 2.0, 3.0) == 0.0
