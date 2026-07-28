"""Tests for the agenda — planned with the copilot, measured against live.

The reason the agenda is a structured list rather than more prose in the brief
is that a list can be **measured**: the copilot can tell you "you haven't
touched pricing and you're 40 minutes in", which is impossible against a
paragraph. So the parts that matter here are the coercion (models return messy
shapes), the coverage check (runs on every window, must be free), and the
guarantee that a bad model response can't destroy an agenda the user built.
"""
from __future__ import annotations

import asyncio

from gateway.routes.notes import copilot_agenda as ag

# ── shape coercion ───────────────────────────────────────────────────────────

def test_accepts_the_shape_the_model_returns() -> None:
    items = ag.normalize_agenda(
        [{"title": "Pricing", "notes": "renewal discount"}, {"title": "Timeline"}]
    )
    assert [i["title"] for i in items] == ["Pricing", "Timeline"]
    assert items[0]["notes"] == "renewal discount"


def test_accepts_plain_strings_and_a_json_string() -> None:
    """Hand-edited lists and raw model output both turn up in practice."""
    assert [i["title"] for i in ag.normalize_agenda(["Pricing", "Timeline"])] == [
        "Pricing", "Timeline",
    ]
    assert ag.normalize_agenda('[{"title": "Pricing"}]')[0]["title"] == "Pricing"


def test_strips_bullets_and_numbering_models_add() -> None:
    items = ag.normalize_agenda(["- Pricing", "2) Timeline", "• Next steps"])
    assert [i["title"] for i in items] == ["Pricing", "Timeline", "Next steps"]


def test_drops_junk_and_caps_the_list() -> None:
    assert ag.normalize_agenda(None) == []
    assert ag.normalize_agenda("not json, not a list") != []   # falls back to lines
    assert ag.normalize_agenda([""]) == []
    assert len(ag.normalize_agenda([f"item {i}" for i in range(50)])) <= ag._MAX_ITEMS


# ── coverage: the thing that makes an agenda useful live ─────────────────────

def test_an_item_is_covered_once_it_is_actually_discussed() -> None:
    item = {"title": "Pricing renewal", "notes": ""}
    assert ag.item_covered(item, "let's talk about the pricing for the renewal")


def test_a_passing_word_is_not_coverage() -> None:
    """Otherwise every item goes green the moment one common word is said, and
    the copilot stops nudging about things nobody discussed."""
    item = {"title": "Pricing renewal discount", "notes": ""}
    assert not ag.item_covered(item, "the weather has been pricing... sorry, nice")


def test_untouched_items_stay_uncovered() -> None:
    items = [{"title": "Pricing"}, {"title": "Hiring plan"}]
    assert ag.coverage(items, "we discussed pricing at length") == [True, False]


def test_coverage_is_survivable_on_empty_input() -> None:
    assert ag.item_covered({"title": ""}, "anything") is False
    assert ag.coverage([], "text") == []


# ── rendering ────────────────────────────────────────────────────────────────

def test_prompt_shows_what_is_still_outstanding() -> None:
    """The contrast between done and not-done is what the copilot nudges on."""
    items = [{"title": "Pricing"}, {"title": "Timeline"}]
    out = ag.agenda_prompt(items, [True, False])
    assert "1 of 2 still to cover" in out
    assert "[x] Pricing" in out
    assert "[ ] Timeline" in out


def test_no_agenda_renders_to_nothing() -> None:
    assert ag.agenda_prompt([]) == ""


def test_prompt_defaults_everything_to_uncovered() -> None:
    out = ag.agenda_prompt([{"title": "Pricing"}])
    assert "1 of 1 still to cover" in out


# ── conversational drafting ──────────────────────────────────────────────────

def _reply(payload: str):
    class _Msg:
        content = payload

    class _Choice:
        message = _Msg()

    class _Resp:
        choices = (_Choice(),)   # tuple: ruff dislikes a mutable class attr
        usage = None

    async def fake(*_a, **_k):
        return _Resp(), None

    return fake


def test_drafting_returns_reply_and_agenda(monkeypatch) -> None:
    monkeypatch.setattr(
        "acb_llm.context.acompletion_with_fallback",
        _reply('{"reply": "Drafted 2 items.", "agenda": '
               '[{"title": "Pricing"}, {"title": "Timeline"}]}'),
    )
    reply, agenda = asyncio.run(ag.draft_agenda("30 min pricing call", []))
    assert reply == "Drafted 2 items."
    assert [i["title"] for i in agenda] == ["Pricing", "Timeline"]


def test_a_model_failure_never_destroys_the_users_agenda(monkeypatch) -> None:
    """The agenda is work the user did — a hiccup must not wipe it."""
    async def boom(*_a, **_k):
        raise RuntimeError("model down")

    monkeypatch.setattr("acb_llm.context.acompletion_with_fallback", boom)
    existing = [{"title": "Pricing", "notes": ""}]
    reply, agenda = asyncio.run(ag.draft_agenda("add timeline", existing))
    assert agenda == existing
    assert "unchanged" in reply


def test_an_empty_agenda_from_the_model_is_treated_as_a_bad_response(monkeypatch) -> None:
    """Far likelier a malformed reply than a genuine 'clear everything'."""
    monkeypatch.setattr(
        "acb_llm.context.acompletion_with_fallback",
        _reply('{"reply": "ok", "agenda": []}'),
    )
    existing = [{"title": "Pricing", "notes": ""}]
    _reply_text, agenda = asyncio.run(ag.draft_agenda("hmm", existing))
    assert agenda == existing


def test_non_json_response_keeps_the_agenda(monkeypatch) -> None:
    monkeypatch.setattr(
        "acb_llm.context.acompletion_with_fallback", _reply("I'm afraid I can't")
    )
    existing = [{"title": "Pricing", "notes": ""}]
    _r, agenda = asyncio.run(ag.draft_agenda("x", existing))
    assert agenda == existing


# ── standing instructions ────────────────────────────────────────────────────

def test_instructions_are_prepended_to_the_system_prompt() -> None:
    from gateway.routes.notes.copilot import _system

    out = _system("BASE RULES", "I run a 3D-printing company.")
    assert out.startswith("BASE RULES")
    assert "3D-printing" in out
    assert "always apply" in out.lower()


def test_no_instructions_leaves_the_prompt_untouched() -> None:
    from gateway.routes.notes.copilot import _system

    assert _system("BASE RULES", "") == "BASE RULES"
