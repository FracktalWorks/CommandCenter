"""max_mutation_attempts is now a REAL enforced counter (audit BO-3 / H4).

Both call sites historically passed mutation_attempts=0, so the old `0 >= 1`
guard never fired — the "one attempt per failure event" guarantee was only an
emergent property of control flow. These lock the real per-run counter.
"""
from __future__ import annotations

import asyncio

import pytest

from orchestrator import mutation
from orchestrator.mutation import (
    MAX_MUTATION_ATTEMPTS,
    _MUTATION_ATTEMPTS,
    _register_mutation_attempt,
    attempt_self_mutation,
)


@pytest.fixture(autouse=True)
def _clear_counter():
    _MUTATION_ATTEMPTS.clear()
    yield
    _MUTATION_ATTEMPTS.clear()


def test_first_attempt_allowed_then_refused_for_same_run():
    allowed, n = _register_mutation_attempt("run-a")
    assert allowed is True and n == 1
    # Second attempt for the SAME run is refused (max = 1).
    allowed2, n2 = _register_mutation_attempt("run-a")
    assert allowed2 is False and n2 == MAX_MUTATION_ATTEMPTS


def test_distinct_runs_are_independent():
    assert _register_mutation_attempt("run-b")[0] is True
    assert _register_mutation_attempt("run-c")[0] is True  # different run → allowed


def test_explicit_prior_at_limit_is_refused_without_incrementing():
    allowed, _ = _register_mutation_attempt("run-d", explicit_prior=MAX_MUTATION_ATTEMPTS)
    assert allowed is False
    assert "run-d" not in _MUTATION_ATTEMPTS  # refused calls don't record


def test_attempt_self_mutation_skips_when_limit_reached():
    # Pre-seed the run at the limit; the real entry point must short-circuit to a
    # skipped result BEFORE spawning any Docker sandbox.
    _MUTATION_ATTEMPTS["run-e"] = MAX_MUTATION_ATTEMPTS
    result = asyncio.run(
        attempt_self_mutation("some-agent", "run-e", RuntimeError("boom"))
    )
    assert result.attempted is False
    assert "max_mutation_attempts" in (result.skipped_reason or "")


def test_counter_is_bounded(monkeypatch):
    # The unbounded-growth guard clears the map past the cap (rare path).
    monkeypatch.setattr(mutation, "_MUTATION_ATTEMPTS_MAX_KEYS", 3)
    for i in range(5):
        _register_mutation_attempt(f"run-{i}")
    assert len(_MUTATION_ATTEMPTS) <= 3 + 1
