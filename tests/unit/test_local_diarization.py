"""Unit tests for the optional sherpa-onnx local diarization pass.

The model inference itself needs ONNX weights (integration-tested on a box with
them provisioned); here we cover the pure merge logic + the opt-in / fail-safe
guards that must hold with NO models and NO sherpa-onnx installed.
"""
from __future__ import annotations

import os

from acb_stt import local_diarization as ld
from acb_stt.types import TranscriptResult, TranscriptSegmentData


def _seg(idx: int, start: float, end: float) -> TranscriptSegmentData:
    return TranscriptSegmentData(idx=idx, start_s=start, end_s=end, text=f"s{idx}")


def test_apply_speaker_turns_assigns_max_overlap_speaker() -> None:
    segs = [_seg(0, 0.0, 2.0), _seg(1, 2.0, 4.0), _seg(2, 4.0, 6.0)]
    # speaker 0 owns [0, 2.5); speaker 1 owns [2.5, 6)
    turns = [(0.0, 2.5, 0), (2.5, 6.0, 1)]
    n = ld.apply_speaker_turns(segs, turns)
    # Labels are 1-based S{n} to match the Deepgram convention.
    assert segs[0].speaker_label == "S1"  # fully inside speaker 0
    assert segs[1].speaker_label == "S2"  # 0.5s of spk0 vs 1.5s of spk1 → spk1
    assert segs[2].speaker_label == "S2"  # fully inside speaker 1
    assert n == 2  # two distinct speakers assigned


def test_apply_speaker_turns_leaves_unmatched_segment_unlabelled() -> None:
    segs = [_seg(0, 10.0, 11.0)]
    turns = [(0.0, 2.0, 0)]  # no overlap with the segment
    ld.apply_speaker_turns(segs, turns)
    assert segs[0].speaker_label is None


def test_enabled_reads_env_flag(monkeypatch) -> None:
    monkeypatch.delenv("NOTES_LOCAL_DIARIZATION", raising=False)
    assert ld.enabled() is False
    monkeypatch.setenv("NOTES_LOCAL_DIARIZATION", "true")
    assert ld.enabled() is True
    monkeypatch.setenv("NOTES_LOCAL_DIARIZATION", "0")
    assert ld.enabled() is False


def test_available_false_without_flag(monkeypatch) -> None:
    monkeypatch.delenv("NOTES_LOCAL_DIARIZATION", raising=False)
    assert ld.available() is False


async def test_maybe_diarize_noop_when_already_diarized() -> None:
    # Deepgram path: transcript is already diarized → sherpa is skipped entirely,
    # even if the flag were on. Segments must be untouched.
    segs = [_seg(0, 0.0, 1.0)]
    res = TranscriptResult(
        text="hi", segments=segs, provider="deepgram",
        model="deepgram/nova-3", diarized=True,
    )
    out = await ld.maybe_diarize(b"audio", "audio/webm", res)
    assert out is res
    assert segs[0].speaker_label is None
    assert out.model == "deepgram/nova-3"  # unchanged


async def test_maybe_diarize_noop_when_unavailable(monkeypatch) -> None:
    # Flag off (or models absent) → return the speaker-less transcript unchanged,
    # never raising. This is the fail-safe that makes enabling it risk-free.
    monkeypatch.delenv("NOTES_LOCAL_DIARIZATION", raising=False)
    segs = [_seg(0, 0.0, 1.0)]
    res = TranscriptResult(
        text="hi", segments=segs, provider="litellm",
        model="groq/whisper-large-v3-turbo", diarized=False,
    )
    out = await ld.maybe_diarize(b"audio", "audio/webm", res)
    assert out.diarized is False
    assert segs[0].speaker_label is None
    assert out.model == "groq/whisper-large-v3-turbo"
    assert os.environ.get("NOTES_LOCAL_DIARIZATION") is None
