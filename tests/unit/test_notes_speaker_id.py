"""Tests for the automatic speaker-identification pure logic.

The LLM call + DB write are integration concerns; here we lock the pure,
deterministic parts: which labels are diarized, how the DATA sample is built,
and — most importantly — the non-destructive merge that must never clobber a
name the user already set.
"""
from __future__ import annotations

from dataclasses import dataclass

from gateway.routes.notes.speaker_id import (
    build_sample,
    distinct_labels,
    merge_inferred,
)


@dataclass
class _Seg:
    idx: int
    text: str
    speaker_label: str | None = None


# ── distinct_labels ──────────────────────────────────────────────────────────

def test_distinct_labels_keeps_diarized_order_deduped() -> None:
    segs = [
        _Seg(0, "hi", "S1"),
        _Seg(1, "hello", "S2"),
        _Seg(2, "again", "S1"),
        _Seg(3, "no label", None),
    ]
    assert distinct_labels(segs) == ["S1", "S2"]


def test_distinct_labels_ignores_non_diarized_labels() -> None:
    # Channel-derived priors ("mic"/"system") aren't S-labels → not diarized.
    segs = [_Seg(0, "a", "mic"), _Seg(1, "b", "system"), _Seg(2, "c", None)]
    assert distinct_labels(segs) == []


# ── build_sample ─────────────────────────────────────────────────────────────

def test_build_sample_tags_lines_and_reports_untruncated() -> None:
    segs = [_Seg(0, "I'm Priya", "S1"), _Seg(1, "Alex here", "S2")]
    data, truncated = build_sample(segs)
    assert "[#0 S1] I'm Priya" in data
    assert "[#1 S2] Alex here" in data
    assert truncated is False


def test_build_sample_truncates_long_transcript() -> None:
    segs = [_Seg(i, "word " * 50, "S1") for i in range(200)]
    data, truncated = build_sample(segs, max_chars=500)
    assert truncated is True
    assert len(data) <= 500


# ── merge_inferred (the safety-critical part) ────────────────────────────────

def test_merge_fills_only_empty_labels_by_default() -> None:
    existing = {"S1": "Vijay"}  # user already named S1
    inferred = {"S1": "WRONG", "S2": "Priya"}
    merged, applied = merge_inferred(existing, inferred)
    # S1 is preserved (user wins); only S2 is newly applied.
    assert merged == {"S1": "Vijay", "S2": "Priya"}
    assert applied == {"S2": "Priya"}


def test_merge_overwrite_replaces_existing() -> None:
    existing = {"S1": "Vijay"}
    inferred = {"S1": "Vijay Varada"}
    merged, applied = merge_inferred(existing, inferred, overwrite=True)
    assert merged == {"S1": "Vijay Varada"}
    assert applied == {"S1": "Vijay Varada"}


def test_merge_skips_blank_and_noop_names() -> None:
    existing = {"S2": "Priya"}
    inferred = {"S1": "  ", "S2": "Priya", "S3": ""}
    merged, applied = merge_inferred(existing, inferred)
    # Blank names ignored; S2 unchanged (same value) → nothing applied.
    assert merged == {"S2": "Priya"}
    assert applied == {}


def test_merge_does_not_mutate_inputs() -> None:
    existing = {"S1": "Vijay"}
    inferred = {"S2": "Priya"}
    merge_inferred(existing, inferred)
    assert existing == {"S1": "Vijay"}
    assert inferred == {"S2": "Priya"}
