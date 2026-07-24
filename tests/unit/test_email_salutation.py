"""Every AI-drafted email must OPEN with a salutation ("Dear <name>," /
"Hi <name>," / "Hello,").

The drafters' prompts ask for a greeting, but a model that skips it ships a
draft that jumps straight into the body and reads abrupt/informal. The
deterministic backstop is ``_ensure_salutation``: applied to every reply draft
(`_llm_draft_reply` — /draft-reply, compose "Draft with AI", rule
REPLY/DRAFT_EMAIL actions, follow-up nudges) and to fresh compose-assist drafts
(`_llm_compose_assist`) — but NEVER when improving the owner's own text, where
a greeting they chose not to write must stay absent.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from gateway.routes.email.automation import drafting as dr

_EMAIL = {"from": "alice@example.com", "from_name": "Alice Kumar",
          "subject": "Quote", "body": "Can you send pricing?"}


# ── _ensure_salutation: never double an existing greeting ────────────────────

@pytest.mark.parametrize("body", [
    "Dear Alice,\n\nThanks for reaching out.",
    "Hi John,\n\nSounds good.",
    "Hello,\n\nThanks for your email.",
    "Hey team,\n\nQuick update below.",
    "Good morning Priya,\n\nThe order shipped.",
    "Greetings,\n\nPlease find the details below.",
    "Respected Sir,\n\nThe invoice is attached.",
    "Namaste Ravi,\n\nThe demo is confirmed.",
    "Hola Juan,\n\nGracias por tu mensaje.",
    # Any short comma-terminated first line reads as a greeting (covers
    # languages the opener list doesn't) — must not be doubled.
    "Team,\n\nFYI — the deploy is done.",
])
def test_existing_greeting_is_kept_verbatim(body: str) -> None:
    assert dr._ensure_salutation(body, "Alice Kumar") == body


def test_missing_greeting_gets_dear_first_name() -> None:
    out = dr._ensure_salutation(
        "Thanks for reaching out about pricing. The quote is attached.",
        "Alice Kumar")
    assert out.startswith("Dear Alice,\n\n")
    assert "quote is attached" in out


def test_honorific_names_greet_honorific_and_surname() -> None:
    out = dr._ensure_salutation("The results look good.", "Dr. Jane Smith")
    assert out.startswith("Dear Dr. Smith,\n\n")


@pytest.mark.parametrize("name", ["", "alice@example.com", '" "'])
def test_no_usable_name_falls_back_to_hello(name: str) -> None:
    out = dr._ensure_salutation("The shipment left the warehouse today.", name)
    assert out.startswith("Hello,\n\n")


def test_body_first_word_resembling_greeting_is_not_fooled() -> None:
    # "Higher..." must not be mistaken for "Hi" — word-anchored matching.
    out = dr._ensure_salutation(
        "Higher volumes are possible if we start the run early next week.",
        "Alice Kumar")
    assert out.startswith("Dear Alice,\n\n")


def test_empty_body_is_untouched() -> None:
    assert dr._ensure_salutation("", "Alice Kumar") == ""


def test_recipient_greeting_name_parses_display_name() -> None:
    assert dr._recipient_greeting_name("Bob Mehta <bob@x.com>") == "Bob Mehta"
    assert dr._recipient_greeting_name("bob@x.com") == ""
    assert dr._recipient_greeting_name("") == ""


# ── The reply drafter enforces the salutation on every draft ─────────────────

def _resp(content: str) -> SimpleNamespace:
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


def _patch(monkeypatch, fake_acwf) -> None:
    monkeypatch.setattr(
        "acb_llm.context.acompletion_with_fallback", fake_acwf)


async def test_reply_draft_without_greeting_gains_one(monkeypatch) -> None:
    async def fake_acwf(*, model, messages, **kw):
        return _resp("Thanks for your email. Pricing is attached."), model

    _patch(monkeypatch, fake_acwf)
    body = await dr._llm_draft_reply(
        _EMAIL, about="", signature="", model="tier-powerful")
    assert body.startswith("Dear Alice,\n\n")
    assert "Pricing is attached" in body


async def test_reply_draft_with_greeting_is_not_doubled(monkeypatch) -> None:
    async def fake_acwf(*, model, messages, **kw):
        return _resp("Hi Alice,\n\nPricing is attached."), model

    _patch(monkeypatch, fake_acwf)
    body = await dr._llm_draft_reply(
        _EMAIL, about="", signature="", model="tier-powerful")
    assert body == "Hi Alice,\n\nPricing is attached."


async def test_no_draft_sentinel_never_gains_a_greeting(monkeypatch) -> None:
    async def fake_acwf(*, model, messages, **kw):
        return _resp("NO_DRAFT"), model

    _patch(monkeypatch, fake_acwf)
    body = await dr._llm_draft_reply(
        _EMAIL, about="", signature="", model="tier-powerful")
    assert body == dr.DRAFT_NO_DRAFT_SENTINEL


# ── Compose assist: fresh drafts greet; improving the owner's text doesn't ──

async def test_compose_fresh_draft_gains_salutation(monkeypatch) -> None:
    seen: list[list[dict]] = []

    async def fake_acwf(*, model, messages, **kw):
        seen.append(messages)
        return _resp("Following up on our call — the samples ship Monday."), model

    _patch(monkeypatch, fake_acwf)
    body = await dr._llm_compose_assist(
        about="", signature="", current_body="", instruction="tell Bob the "
        "samples ship Monday", mode="new", recipient="Bob Mehta <bob@x.com>")
    assert body.startswith("Dear Bob,\n\n")
    # The drafting prompt itself also demands the greeting, so the backstop
    # should rarely fire in practice.
    assert "START with a greeting" in seen[0][0]["content"]


async def test_compose_improve_never_forces_a_greeting(monkeypatch) -> None:
    async def fake_acwf(*, model, messages, **kw):
        return _resp("Samples ship Monday — tracking to follow."), model

    _patch(monkeypatch, fake_acwf)
    body = await dr._llm_compose_assist(
        about="", signature="", current_body="samples ship monday, tracking "
        "later", instruction="tighten this up", mode="new",
        recipient="Bob Mehta <bob@x.com>")
    assert body == "Samples ship Monday — tracking to follow."
