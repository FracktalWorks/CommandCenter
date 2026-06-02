"""Smoke tests — prove the workspace imports cleanly and basic plumbing works."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


def test_settings_load() -> None:
    from acb_common import get_settings

    s = get_settings()
    assert s.acb_env in {"dev", "staging", "prod"}
    assert s.database_url.startswith("postgresql")


def test_schemas_roundtrip() -> None:
    from acb_schemas import Person

    p = Person(canonical_name="Jane Doe", email="jane@fracktal.in")
    dumped = p.model_dump_json()
    restored = Person.model_validate_json(dumped)
    assert restored.canonical_name == "Jane Doe"


def test_router_tiers() -> None:
    from acb_llm import LLMTier
    from orchestrator.router import pick_tier

    assert pick_tier("what is the status of project X?") == LLMTier.TIER_2
    assert pick_tier("why did we lose deal Y?") == LLMTier.TIER_3
    assert pick_tier("ping") == LLMTier.TIER_1


def test_gateway_health() -> None:
    from gateway.main import app

    with TestClient(app) as client:
        r = client.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"


@pytest.mark.parametrize(
    "text, ok",
    [
        ("Customer Foo last met on Mon [person:11111111-1111-1111-1111-111111111111].", True),
        ("Customer Foo last met on Mon.", False),
    ],
)
def test_citation_guardrail(text: str, ok: bool) -> None:
    from acb_llm.guardrails import CitationError, require_citations

    if ok:
        assert require_citations(text) == text
    else:
        with pytest.raises(CitationError):
            require_citations(text)
