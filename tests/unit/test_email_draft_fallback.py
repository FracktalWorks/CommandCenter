"""Unit tests for the draft-generation model handoff (`_llm_draft_reply`).

The assistant drafts on the cheap primary model and must hand off to the
more-powerful fallback when the primary isn't confident (returns the NO_DRAFT
sentinel). These mock the shared completion helper so no provider is touched.
"""
from __future__ import annotations

from types import SimpleNamespace

from gateway.routes import email as m

_EMAIL = {"from": "alice@example.com", "subject": "Quote",
          "body": "Can you send pricing?"}

# How the tier aliases resolve to concrete model ids in these tests.
_RESOLVE = {
    "tier-balanced": "deepseek/deepseek-chat",
    "tier-powerful": "deepseek/deepseek-reasoner",
}


def _resp(content: str) -> SimpleNamespace:
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


def _patch(monkeypatch, fake_acwf) -> None:
    monkeypatch.setattr(
        "acb_llm.context.acompletion_with_fallback", fake_acwf)
    monkeypatch.setattr(
        "acb_llm.context.resolve_underlying_model",
        lambda mid: _RESOLVE.get(mid, mid))


async def test_draft_escalates_to_fallback_on_low_confidence(monkeypatch) -> None:
    calls: list[str] = []

    async def fake_acwf(*, model, fallback_model, messages, **kw):
        calls.append(model)
        if model == "tier-balanced":
            return _resp("NO_DRAFT"), _RESOLVE["tier-balanced"]
        return _resp("Hi Alice,\n\nHappy to help — the quote is attached."), \
            _RESOLVE["tier-powerful"]

    _patch(monkeypatch, fake_acwf)
    body = await m._llm_draft_reply(
        _EMAIL, about="", signature="",
        instructions="Return NO_DRAFT if not confident.",
        model="tier-balanced", fallback_model="tier-powerful",
    )
    # Primary declined → the powerful fallback produced the draft.
    assert "Happy to help" in body
    assert calls == ["tier-balanced", "tier-powerful"]


async def test_draft_no_escalation_when_primary_confident(monkeypatch) -> None:
    calls: list[str] = []

    async def fake_acwf(*, model, fallback_model, messages, **kw):
        calls.append(model)
        return _resp("Hi Alice,\n\nThanks — sending pricing now."), \
            _RESOLVE["tier-balanced"]

    _patch(monkeypatch, fake_acwf)
    body = await m._llm_draft_reply(
        _EMAIL, about="", signature="",
        model="tier-balanced", fallback_model="tier-powerful",
    )
    # Primary was confident → fallback is never called.
    assert calls == ["tier-balanced"]
    assert "Thanks" in body


async def test_no_draft_propagates_without_signature(monkeypatch) -> None:
    # Both models decline → the bare NO_DRAFT sentinel must survive (no signature
    # appended) so the caller's confidence gate skips the draft.
    async def fake_acwf(*, model, fallback_model, messages, **kw):
        return _resp("NO_DRAFT"), _RESOLVE.get(model, model)

    _patch(monkeypatch, fake_acwf)
    body = await m._llm_draft_reply(
        _EMAIL, about="", signature="— Vijay",
        instructions="Return NO_DRAFT if not confident.",
        model="tier-balanced", fallback_model="tier-powerful",
    )
    assert body.strip() == m.DRAFT_NO_DRAFT_SENTINEL
