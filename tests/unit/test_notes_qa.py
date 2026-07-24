"""Tests for ask-the-meeting segment selection (no LLM / DB needed)."""
from __future__ import annotations

from dataclasses import dataclass

import gateway.routes.notes.qa as qa
from gateway.routes.notes.qa import _keywords, _select_segments


@dataclass
class _Seg:
    idx: int
    text: str
    speaker_label: str | None = "S1"
    channel: str | None = None


def test_keywords_drops_stopwords_and_short_tokens() -> None:
    kw = _keywords("What did we decide about the extruder budget?")
    assert "extruder" in kw
    assert "budget" in kw
    assert "decide" in kw
    # stopwords + <3-char tokens removed
    assert "the" not in kw
    assert "we" not in kw
    assert "did" not in kw


def test_select_returns_all_when_it_fits() -> None:
    segs = [_Seg(i, "short line") for i in range(5)]
    chosen, truncated = _select_segments(segs, "anything")
    assert not truncated
    assert chosen == segs


def test_select_prefers_relevant_segments_when_over_budget(monkeypatch) -> None:
    monkeypatch.setattr(qa, "_PASS_CHARS", 60)  # tiny budget forces selection
    segs = [
        _Seg(0, "unrelated chatter about lunch"),
        _Seg(1, "the extruder budget is forty lakh"),  # relevant
        _Seg(2, "more small talk"),
        _Seg(3, "weather today is fine"),
    ]
    chosen, truncated = _select_segments(segs, "extruder budget")
    assert truncated
    idxs = [s.idx for s in chosen]
    # The relevant segment (1) must be included; order is preserved.
    assert 1 in idxs
    assert idxs == sorted(idxs)


def test_select_never_returns_empty(monkeypatch) -> None:
    monkeypatch.setattr(qa, "_PASS_CHARS", 10)
    segs = [_Seg(i, "aaaaaaaaaaaaaaaaaaaa") for i in range(8)]
    chosen, truncated = _select_segments(segs, "nomatch xyz")
    assert truncated
    assert len(chosen) >= 1  # falls back to a head slice rather than nothing
