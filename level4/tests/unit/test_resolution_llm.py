"""Unit tests for the live resolver LLM tiebreak (WBS 1.2)."""
from __future__ import annotations

from uuid import uuid4

import pytest

from acb_graph.resolver import ResolutionCandidate
from orchestrator.resolution import (
    _format_candidates,
    _format_incoming,
    _parse_choice,
    resolve_with_llm,
)


def test_parse_choice_strict_integer() -> None:
    assert _parse_choice("0", 3) == 0
    assert _parse_choice("2", 3) == 2
    assert _parse_choice("3", 3) == 3


def test_parse_choice_out_of_range_returns_none() -> None:
    assert _parse_choice("99", 3) is None
    assert _parse_choice("-1", 3) is None


def test_parse_choice_loose_extracts_first_integer() -> None:
    assert _parse_choice("The answer is 1.", 3) == 1
    assert _parse_choice("```\n2\n```", 3) == 2


def test_parse_choice_garbage_returns_none() -> None:
    assert _parse_choice("none of the above", 3) is None
    assert _parse_choice("", 3) is None


def test_format_incoming_skips_empties() -> None:
    out = _format_incoming({"name": "Acme", "email": None, "company": ""})
    assert "name: 'Acme'" in out
    assert "email" not in out


def test_format_candidates_includes_score_and_summary() -> None:
    cid = uuid4()
    cs = [ResolutionCandidate(entity_id=cid, score=0.81, reason="email match")]
    blob = _format_candidates(cs, {cid: "Acme Inc, contact@acme.com"})
    assert "1." in blob
    assert "0.81" in blob
    assert "Acme Inc" in blob


@pytest.mark.asyncio
async def test_resolve_with_llm_empty_candidates_returns_none(monkeypatch) -> None:
    out = await resolve_with_llm(incoming={"name": "Acme"}, candidates=[], candidate_summaries={})
    assert out is None


@pytest.mark.asyncio
async def test_resolve_with_llm_picks_candidate(monkeypatch) -> None:
    cid = uuid4()
    cs = [ResolutionCandidate(entity_id=cid, score=0.8, reason="name match")]

    async def fake_complete(*, tier, messages):
        return "1"

    monkeypatch.setattr("orchestrator.resolution.complete", fake_complete)
    out = await resolve_with_llm(
        incoming={"name": "Acme"}, candidates=cs, candidate_summaries={cid: "Acme Inc"}
    )
    assert out == cid


@pytest.mark.asyncio
async def test_resolve_with_llm_zero_means_new(monkeypatch) -> None:
    cid = uuid4()
    cs = [ResolutionCandidate(entity_id=cid, score=0.8, reason="name match")]

    async def fake_complete(*, tier, messages):
        return "0"

    monkeypatch.setattr("orchestrator.resolution.complete", fake_complete)
    out = await resolve_with_llm(
        incoming={"name": "Acme"}, candidates=cs, candidate_summaries={cid: "Acme Inc"}
    )
    assert out is None


@pytest.mark.asyncio
async def test_resolve_with_llm_swallows_exceptions(monkeypatch) -> None:
    cid = uuid4()
    cs = [ResolutionCandidate(entity_id=cid, score=0.8, reason="name match")]

    async def boom(*, tier, messages):
        raise RuntimeError("LLM down")

    monkeypatch.setattr("orchestrator.resolution.complete", boom)
    out = await resolve_with_llm(
        incoming={"name": "Acme"}, candidates=cs, candidate_summaries={cid: "Acme Inc"}
    )
    assert out is None
