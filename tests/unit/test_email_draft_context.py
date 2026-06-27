"""Regression: the drafter must pass the FULL incoming email + thread to the
model, not a pre-truncated stub.

The old caps cut the message being replied to at [:2000] chars, so a long email
reached the model as just its opening — and the draft would say "only the
introductory lines came through" / "the communication appears to be truncated".
Fitting the prompt to the model's context window is the LLM layer's job
(acompletion_with_fallback), NOT a hard pre-cut here. The LLM call is mocked to
capture the assembled prompt.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from gateway.routes import email as m

_drafting = m.automation.drafting


def _one(obj):
    res = MagicMock()
    res.fetchone.return_value = obj
    return res


def _fake_completion(captured: dict):
    async def fake(*, model, messages, **_kw):
        captured["messages"] = messages
        resp = MagicMock()
        resp.choices = [MagicMock()]
        resp.choices[0].message.content = "Hi,\n\nConfirmed — happy to proceed."
        return resp, model
    return fake


async def test_drafter_passes_full_long_body_to_model() -> None:
    long_body = (
        "Dear team, introducing the legal representative of Dassault Systemes.\n"
        + ("Detailed paragraph about the partnership terms. " * 400)
        + "\nFINAL_ASK: please confirm the NDA by Friday. UNIQUE_TAIL_MARKER"
    )
    assert len(long_body) > 10_000  # well past the old 2000-char cap

    captured: dict = {}
    with patch("acb_llm.context.acompletion_with_fallback",
               _fake_completion(captured)):
        await _drafting._llm_draft_reply(
            {"from": "rep@3ds.com", "from_name": "Rep", "subject": "Partnership",
             "body": long_body},
            about="", signature="", user_email="me@x.com")

    user_msg = captured["messages"][1]["content"]
    # The END of the body reaches the model — no [:2000] pre-truncation.
    assert "UNIQUE_TAIL_MARKER" in user_msg
    assert "FINAL_ASK" in user_msg


async def test_drafter_includes_full_thread_context() -> None:
    thread = (
        "From: Rep\n" + ("Earlier point in the discussion. " * 500)
        + "THREAD_TAIL_MARKER"
    )
    assert len(thread) > 10_000

    captured: dict = {}
    with patch("acb_llm.context.acompletion_with_fallback",
               _fake_completion(captured)):
        await _drafting._llm_draft_reply(
            {"from": "rep@3ds.com", "from_name": "Rep", "subject": "Re: terms",
             "body": "Short latest message.", "thread": thread},
            about="", signature="", user_email="me@x.com")

    user_msg = captured["messages"][1]["content"]
    assert "THREAD_TAIL_MARKER" in user_msg


# ── Auto-draft dedup (inbox-zero handlePreviousDraftDeletion parity) ──────────

async def test_resolve_draft_none_when_no_existing() -> None:
    db = AsyncMock()
    db.execute.side_effect = [_one(None)]
    provider = AsyncMock()
    out = await _drafting._resolve_existing_thread_draft(
        db, provider, "acc", "t1")
    assert out == "none"
    provider.trash_message.assert_not_called()


async def test_resolve_draft_replace_when_unmodified() -> None:
    db = AsyncMock()
    db.execute.side_effect = [
        _one(SimpleNamespace(id="d1", provider_message_id="pd1",
                             body_text="Hi there,\n\nThanks!\n\nBest")),
        _one(SimpleNamespace(draft_text="Hi there,\n\nThanks!\n\nBest")),
        MagicMock(),  # DELETE
    ]
    provider = AsyncMock()
    out = await _drafting._resolve_existing_thread_draft(
        db, provider, "acc", "t1")
    assert out == "replace"  # unmodified AI draft → trashed, fresh one created
    provider.trash_message.assert_awaited_once_with("pd1")


async def test_resolve_draft_keep_when_user_modified() -> None:
    db = AsyncMock()
    db.execute.side_effect = [
        _one(SimpleNamespace(id="d1", provider_message_id="pd1",
                             body_text="My own hand-written reply")),
        _one(SimpleNamespace(draft_text="Hi there,\n\nThanks!\n\nBest")),
    ]
    provider = AsyncMock()
    out = await _drafting._resolve_existing_thread_draft(
        db, provider, "acc", "t1")
    assert out == "keep"  # user edited → preserve, never duplicate
    provider.trash_message.assert_not_called()


async def test_resolve_draft_keep_when_no_original_to_compare() -> None:
    db = AsyncMock()
    db.execute.side_effect = [
        _one(SimpleNamespace(id="d1", provider_message_id="pd1",
                             body_text="anything")),
        _one(None),  # no stored original → cannot prove unmodified → preserve
    ]
    provider = AsyncMock()
    out = await _drafting._resolve_existing_thread_draft(
        db, provider, "acc", "t1")
    assert out == "keep"
    provider.trash_message.assert_not_called()
