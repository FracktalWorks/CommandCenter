"""Unit tests for acb_graph.resolver — pure-Python paths only (no DB).

DB-backed paths (`resolve_person`, `resolve_customer`, `resolve_by_name`) are
exercised in the integration test suite, which spins up the docker-compose
Postgres. Here we only need the canonicalisers + similarity + verdict thresholds.
"""
from __future__ import annotations

import pytest

from acb_graph.resolver import (
    DETERMINISTIC_AUTO_MERGE,
    LLM_DELEGATE_MIN,
    canonical_email,
    canonical_name,
    email_domain,
    is_corporate_domain,
    jaro_winkler,
    name_similarity,
)


# ---------- canonical_email -------------------------------------------------

@pytest.mark.parametrize(
    "raw, expected",
    [
        ("Jane.Doe+sales@Gmail.com", "janedoe@gmail.com"),
        ("  vijay@FRACKTAL.in ", "vijay@fractal.in".replace("fractal", "fracktal")),
        ("ops+billing@fastmail.com", "ops@fastmail.com"),
        ("  ", None),
        ("@fracktal.in", None),
        ("noemail", None),
    ],
)
def test_canonical_email(raw: str, expected: str | None) -> None:
    assert canonical_email(raw) == expected


def test_email_domain_helpers() -> None:
    assert email_domain("VIJAY@Fracktal.in") == "fracktal.in"
    assert is_corporate_domain("fracktal.in") is True
    assert is_corporate_domain("gmail.com") is False
    assert is_corporate_domain(None) is False


# ---------- canonical_name --------------------------------------------------

@pytest.mark.parametrize(
    "raw, expected",
    [
        ("Acme Pvt Ltd", "acme"),
        ("  Acme   Corporation  ", "acme"),
        ("Fracktal Works Private Limited", "fracktal works"),
        ("José Müller LLC", "jose muller"),
        ("", ""),
        (None, ""),
    ],
)
def test_canonical_name(raw: str | None, expected: str) -> None:
    assert canonical_name(raw) == expected


# ---------- jaro_winkler / name_similarity ---------------------------------

def test_jaro_winkler_identical() -> None:
    assert jaro_winkler("vijay", "vijay") == 1.0


def test_jaro_winkler_prefix_bonus() -> None:
    # Prefix bonus must lift a near-match above plain Jaro.
    score = jaro_winkler("vijaya", "vijay")
    assert score > 0.9


def test_name_similarity_collapses_punctuation_to_one() -> None:
    # Identical after stripping company suffix and punctuation.
    assert name_similarity("Acme, Inc.", "Acme Inc") == 1.0


def test_name_similarity_domain_bonus_clamped() -> None:
    plain = name_similarity("Acme Robotics", "Acme Robotic")
    boosted = name_similarity("Acme Robotics", "Acme Robotic", domain_bonus=True)
    assert boosted >= plain
    assert boosted <= 1.0


def test_name_similarity_empty_returns_zero() -> None:
    assert name_similarity("", "Acme") == 0.0
    assert name_similarity(None, None) == 0.0


# ---------- threshold sanity ------------------------------------------------

def test_thresholds_ordered() -> None:
    assert 0 < LLM_DELEGATE_MIN < DETERMINISTIC_AUTO_MERGE <= 1.0
