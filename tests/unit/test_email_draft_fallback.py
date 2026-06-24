"""Unit tests for draft generation (`_llm_draft_reply`).

Drafting runs on the account's single draft-writing model (no fallback
escalation). A confidence gate may make the model return the NO_DRAFT sentinel,
which must propagate to the caller (without a signature appended). These mock the
shared completion helper so no provider is touched.
"""
from __future__ import annotations

from types import SimpleNamespace

from gateway.routes import email as m

_EMAIL = {"from": "alice@example.com", "subject": "Quote",
          "body": "Can you send pricing?"}


def _resp(content: str) -> SimpleNamespace:
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


def _patch(monkeypatch, fake_acwf) -> None:
    monkeypatch.setattr(
        "acb_llm.context.acompletion_with_fallback", fake_acwf)


async def test_draft_runs_on_the_draft_model(monkeypatch) -> None:
    calls: list[str] = []

    async def fake_acwf(*, model, messages, **kw):
        calls.append(model)
        return _resp("Hi Alice,\n\nThanks — sending pricing now."), model

    _patch(monkeypatch, fake_acwf)
    body = await m._llm_draft_reply(
        _EMAIL, about="", signature="", model="tier-powerful",
    )
    # Drafts on the single configured model — no second (fallback) call.
    assert calls == ["tier-powerful"]
    assert "Thanks" in body


async def test_draft_appends_signature(monkeypatch) -> None:
    async def fake_acwf(*, model, messages, **kw):
        return _resp("Hi Alice,\n\nHappy to help."), model

    _patch(monkeypatch, fake_acwf)
    body = await m._llm_draft_reply(
        _EMAIL, about="", signature="— Vijay", model="tier-powerful",
    )
    assert "Happy to help" in body
    assert body.strip().endswith("— Vijay")


async def test_no_draft_propagates_without_signature(monkeypatch) -> None:
    # The model declines (confidence gate) → the bare NO_DRAFT sentinel must
    # survive (no signature appended) so the caller's gate skips the draft.
    async def fake_acwf(*, model, messages, **kw):
        return _resp("NO_DRAFT"), model

    _patch(monkeypatch, fake_acwf)
    body = await m._llm_draft_reply(
        _EMAIL, about="", signature="— Vijay",
        instructions="Return NO_DRAFT if not confident.",
        model="tier-powerful",
    )
    assert body.strip() == m.DRAFT_NO_DRAFT_SENTINEL
