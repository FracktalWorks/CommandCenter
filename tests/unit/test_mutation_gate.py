"""Self-mutation eval-gate + auto-push governance (audit H3).

These are the pure decision helpers that decide whether a sandbox-produced
commit is treated as verified and whether it may be pushed without a human.
The full mutation flow needs Docker; these guard the policy in isolation.
"""
from __future__ import annotations

from orchestrator.mutation import _auto_push_enabled, _tests_passed


def test_tests_passed_requires_positive_evidence():
    # No output / no tests / skipped → NOT verified (was previously True).
    assert _tests_passed("") is False
    assert _tests_passed("no tests") is False
    assert _tests_passed("No tests found") is False
    assert _tests_passed("skipped") is False


def test_tests_passed_true_only_on_explicit_pass():
    assert _tests_passed("12 passed in 3.1s") is True


def test_tests_passed_false_on_failure_keywords():
    assert _tests_passed("1 failed, 3 passed") is False
    assert _tests_passed("Traceback (most recent call last)") is False
    assert _tests_passed("some ambiguous output") is False


def test_auto_push_disabled_by_default(monkeypatch):
    monkeypatch.delenv("MUTATION_AUTO_PUSH", raising=False)
    assert _auto_push_enabled() is False


def test_auto_push_opt_in(monkeypatch):
    for val in ("1", "true", "YES", "on"):
        monkeypatch.setenv("MUTATION_AUTO_PUSH", val)
        assert _auto_push_enabled() is True
    monkeypatch.setenv("MUTATION_AUTO_PUSH", "0")
    assert _auto_push_enabled() is False
