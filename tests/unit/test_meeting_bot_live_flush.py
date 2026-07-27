"""Tests for deferred segment forwarding in the meeting-bot worker's live path.

An utterance's speaker embedding only exists once that utterance CLOSES, but the
ASR streams recognised segments *during* it. Forwarding immediately therefore
left almost every segment without a voiceprint (observed: 1 of 15 against real
audio), which silently defeats the whole point of the voiceprint gallery — the
gateway would fall back to label passthrough for nearly everything.

So segments are held briefly and released as soon as a covering window lands, or
untagged once they've waited ``LIVE_SEGMENT_MAX_WAIT``. These lock that contract.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps/services/meeting_bot"))

from app import live


def _seg(start: float, end: float, text: str = "hi") -> dict:
    return {"text": text, "start_s": start, "end_s": end}


def _run(coro):
    return asyncio.run(coro)


def _capture(monkeypatch) -> list[dict]:
    """Swap the network forward for an in-memory sink."""
    sent: list[dict] = []

    async def fake_forward(_cb: str, seg: dict) -> None:
        sent.append(seg)

    monkeypatch.setattr(live, "_forward_segment", fake_forward)
    return sent


def test_segment_waits_for_its_embedding(monkeypatch) -> None:
    """With no covering window yet, a fresh segment is held, not forwarded."""
    sent = _capture(monkeypatch)
    pending = [(_seg(0.0, 1.0), live.time.monotonic())]
    _run(live._flush_pending("cb", pending, []))
    assert sent == []
    assert len(pending) == 1  # still waiting


def test_segment_released_tagged_once_window_lands(monkeypatch) -> None:
    sent = _capture(monkeypatch)
    pending = [(_seg(0.0, 1.0), live.time.monotonic())]
    windows = [(0.0, 1.0, [0.5] * 4)]     # the utterance closed
    _run(live._flush_pending("cb", pending, windows))
    assert len(sent) == 1
    assert sent[0]["embedding"] == [0.5] * 4
    assert pending == []                  # drained


def test_segment_released_untagged_after_max_wait(monkeypatch) -> None:
    """Latency is bounded: a segment never waits forever for an embedding."""
    sent = _capture(monkeypatch)
    stale = live.time.monotonic() - (live._SEGMENT_MAX_WAIT + 1)
    pending = [(_seg(0.0, 1.0), stale)]
    _run(live._flush_pending("cb", pending, []))
    assert len(sent) == 1
    assert "embedding" not in sent[0]     # forwarded plain, not dropped
    assert pending == []


def test_force_drains_everything(monkeypatch) -> None:
    """On meeting end nothing may be stranded in the queue."""
    sent = _capture(monkeypatch)
    now = live.time.monotonic()
    pending = [(_seg(0.0, 1.0), now), (_seg(1.0, 2.0), now)]
    _run(live._flush_pending("cb", pending, [], force=True))
    assert len(sent) == 2
    assert pending == []


def test_only_the_ready_segment_is_released(monkeypatch) -> None:
    """A covered segment goes out while an uncovered, still-fresh one waits."""
    sent = _capture(monkeypatch)
    now = live.time.monotonic()
    pending = [(_seg(0.0, 1.0, "covered"), now), (_seg(9.0, 10.0, "later"), now)]
    _run(live._flush_pending("cb", pending, [(0.0, 1.0, [1.0])]))
    assert [s["text"] for s in sent] == ["covered"]
    assert len(pending) == 1
