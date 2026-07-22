"""The classifier must tell "no rule fits" apart from "the model was down".

The rule runner stamps a permanent ``rules_processed_at`` watermark on every
message it evaluates (``/rules/run`` selects ``WHERE rules_processed_at IS
NULL``). For years the LLM pick "failed closed" to None, which the runner could
not distinguish from a genuine no-match — so one bad LLM window (a gateway blip)
marked a whole batch processed forever and that mail was never looked at again.

The pick now RAISES ``LLMUnavailable`` when the model call itself fails, while
still returning None/[] for a real "nothing applies". These pin both directions.
"""
from __future__ import annotations

import pytest

from gateway.routes.email.automation import engine as e

_EMAIL = {"from": "x@y.com", "subject": "Hi", "body": "hello", "to": ""}
_RULES = [{"id": "r1", "name": "Newsletter", "instructions": "newsletters"}]


def _patch_llm_json(monkeypatch, result=None, exc=None) -> None:
    async def fake(*a, **kw):
        if exc is not None:
            raise exc
        return result
    monkeypatch.setattr(e, "_llm_json", fake)


# ── the call failing is NOT a no-match ──────────────────────────────────────

async def test_pick_rule_raises_when_the_model_call_fails(monkeypatch) -> None:
    _patch_llm_json(monkeypatch, exc=RuntimeError("gateway 502"))
    with pytest.raises(e.LLMUnavailable):
        await e._llm_pick_rule(_EMAIL, _RULES)


async def test_pick_rules_raises_when_the_model_call_fails(monkeypatch) -> None:
    _patch_llm_json(monkeypatch, exc=RuntimeError("timeout"))
    with pytest.raises(e.LLMUnavailable):
        await e._llm_pick_rules(_EMAIL, _RULES)


# ── a genuine "nothing applies" still returns empty, never raises ───────────

async def test_pick_rule_returns_none_on_a_real_no_match(monkeypatch) -> None:
    # A well-formed reply that selects nothing (index -1) is a real verdict.
    _patch_llm_json(monkeypatch, result=({"index": -1}, '{"index": -1}', "m"))
    assert await e._llm_pick_rule(_EMAIL, _RULES) is None


async def test_pick_rules_returns_empty_on_a_real_no_match(monkeypatch) -> None:
    _patch_llm_json(monkeypatch, result=({"matches": []}, '{"matches": []}', "m"))
    assert await e._llm_pick_rules(_EMAIL, _RULES) == []


async def test_unparseable_reply_is_a_no_match_not_an_outage(monkeypatch) -> None:
    # The model answered (prose we couldn't parse) — a persistent quality issue,
    # not a transient outage, so treat it as no-match rather than retry forever.
    _patch_llm_json(monkeypatch, result=(None, "sorry, I can't help", "m"))
    assert await e._llm_pick_rule(_EMAIL, _RULES) is None
