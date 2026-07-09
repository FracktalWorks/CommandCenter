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


# ── Truncation-narration guard + body hydration (snippet-fallback bug) ────────
# A header-only row (Outlook/Graph sync) stores body_text='' + a ~200-char
# snippet; `body_text or snippet` then handed the drafter a message cut off
# mid-sentence ("…I am ava"), and the model narrated that into the reply
# ("your message seems cut off, could you finish that?"). Fix: hydrate the full
# body before drafting + a prompt rule against commenting on truncation.


async def test_draft_prompt_forbids_narrating_truncation() -> None:
    captured: dict = {}
    with patch("acb_llm.context.acompletion_with_fallback",
               _fake_completion(captured)):
        await _drafting._llm_draft_reply(
            {"from": "p@x.com", "from_name": "Prawin", "subject": "Re: setup",
             "body": "Sounds good. I am ava"},  # looks cut off
            about="", signature="", user_email="me@x.com")
    sys_prompt = captured["messages"][0]["content"].lower()
    # The system prompt must instruct the model NOT to react to a truncated input.
    assert "cut off" in sys_prompt
    assert "mid-sentence" in sys_prompt
    assert "resend" in sys_prompt or "finish that" in sys_prompt


async def test_hydrate_fetches_full_body_when_only_snippet_stored() -> None:
    from gateway.routes.email import core as _core

    # Stored row: empty body_text, a 200-char snippet cut at "I am ava".
    stored = SimpleNamespace(body_text="", body_html=None, snippet="x" * 190 + " I am ava")
    db = AsyncMock()
    # 1st execute = SELECT body/snippet; later execute()s (the UPDATE persist)
    # return a generic result — AsyncMock's default handles them.
    db.execute.side_effect = [_one(stored), MagicMock(), MagicMock()]

    provider = AsyncMock()
    provider.authenticate.return_value = True
    provider.get_message.return_value = SimpleNamespace(
        body_text="Sounds good. I am available Tuesday and Thursday afternoon.",
        body_html=None,
    )
    # credentials_dirty is a SYNC method — override AsyncMock's async default so
    # _persist_rotated_creds sees a plain False, not a truthy coroutine.
    provider.credentials_dirty = MagicMock(return_value=False)

    async def fake_provider_for_message(_db, _mid, _u):
        return provider, "pmid-1", "acc-1", MagicMock()

    with patch.object(_core, "_provider_for_message", fake_provider_for_message):
        body = await _core.hydrate_message_body(db, "m1", "me@x.com")

    # The FULL provider body is returned (not the 200-char snippet) + persisted.
    assert "available Tuesday and Thursday" in body
    assert "I am ava" != body[-8:]  # not truncated mid-word
    # It ran an UPDATE to persist (SELECT + UPDATE = 2 execute calls).
    assert db.execute.await_count >= 2
    provider.get_message.assert_awaited_once()


async def test_hydrate_noop_when_body_already_present() -> None:
    from gateway.routes.email import core as _core

    stored = SimpleNamespace(
        body_text="Full body already here, nothing to fetch.",
        body_html=None, snippet="preview",
    )
    db = AsyncMock()
    db.execute.side_effect = [_one(stored)]
    with patch.object(_core, "_provider_for_message",
                      side_effect=AssertionError("must NOT fetch when body present")):
        body = await _core.hydrate_message_body(db, "m2", "me@x.com")
    assert body == "Full body already here, nothing to fetch."


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


# ── Compose card "Draft with AI" must see the message it's replying to ────────
# The compose card called compose-assist, which never loaded the replied-to
# message body — so the model couldn't apply a template the trailing email
# provided. The fix routes reply/forward through the ONE shared reply-context
# builder and surfaces the replied-to body to the drafter.


async def test_compose_assist_renders_reply_to_body_and_apply_rule() -> None:
    captured: dict = {}
    with patch("acb_llm.context.acompletion_with_fallback",
               _fake_completion(captured)):
        await _drafting._llm_compose_assist(
            about="", signature="", current_body="", instruction="",
            mode="reply", recipient="Ashish <sharma.ashish@manipal.edu>",
            subject="Re: Evaluation", thread="",
            reply_to_body="Use this evaluation template: TEMPLATE_MARKER "
                          "name/score/remarks.",
            user_email="me@x.com")
    user_msg = captured["messages"][1]["content"]
    sys_prompt = captured["messages"][0]["content"].lower()
    # The replied-to email (with its template) reaches the model, and the system
    # prompt tells it to APPLY that email's contents.
    assert "TEMPLATE_MARKER" in user_msg
    assert "apply" in sys_prompt


async def test_compose_assist_reply_empty_body_uses_shared_reply_drafter() -> None:
    ctx = {"from": "sharma.ashish@manipal.edu", "from_name": "Ashish",
           "subject": "Re: Evaluation", "body": "TEMPLATE_BODY", "thread": ""}
    calls: dict = {}

    async def fake_agent_draft(email, *a, **k):
        calls["agent_email"] = email
        return "drafted from the template"

    async def fake_compose(**k):
        calls["compose"] = k
        return "unused"

    with patch.object(_drafting, "_get_db", AsyncMock(return_value=AsyncMock())), \
            patch.object(_drafting, "_assert_account_owner", AsyncMock()), \
            patch.object(_drafting, "_load_assistant_about",
                         AsyncMock(return_value=("about", "sig"))), \
            patch.object(_drafting, "_account_models",
                         AsyncMock(return_value={"draft": "tier-powerful"})), \
            patch.object(_drafting, "_build_reply_context",
                         AsyncMock(return_value=ctx)), \
            patch.object(_drafting, "_agent_draft_reply", fake_agent_draft), \
            patch.object(_drafting, "_llm_compose_assist", fake_compose):
        req = _drafting.ComposeAssistRequest(
            account_id="a", body="", mode="reply", message_id="m1")
        res = await _drafting.compose_assist(req, SimpleNamespace(email="me@x.com"))

    # Draft-from-scratch reply → the shared reply drafter, NOT the lighter compose
    # path — and the replied-to body (the template) reaches it.
    assert res["draft"] == "drafted from the template"
    assert "compose" not in calls
    assert calls["agent_email"]["body"] == "TEMPLATE_BODY"


async def test_compose_assist_improve_passes_reply_to_body() -> None:
    ctx = {"from": "sharma.ashish@manipal.edu", "from_name": "Ashish",
           "subject": "Re: Evaluation", "body": "TEMPLATE_BODY",
           "thread": "earlier context"}
    calls: dict = {}

    async def fake_compose(**k):
        calls.update(k)
        return "improved draft"

    async def fake_agent_draft(*a, **k):
        raise AssertionError("improve mode must not use the reply drafter")

    with patch.object(_drafting, "_get_db", AsyncMock(return_value=AsyncMock())), \
            patch.object(_drafting, "_assert_account_owner", AsyncMock()), \
            patch.object(_drafting, "_load_assistant_about",
                         AsyncMock(return_value=("about", "sig"))), \
            patch.object(_drafting, "_account_models",
                         AsyncMock(return_value={"draft": "tier-powerful"})), \
            patch.object(_drafting, "_build_reply_context",
                         AsyncMock(return_value=ctx)), \
            patch.object(_drafting, "_agent_draft_reply", fake_agent_draft), \
            patch.object(_drafting, "_llm_compose_assist", fake_compose):
        req = _drafting.ComposeAssistRequest(
            account_id="a", body="my rough draft", mode="reply", message_id="m1")
        res = await _drafting.compose_assist(req, SimpleNamespace(email="me@x.com"))

    # Improve-in-place keeps the compose path, now WITH the replied-to body.
    assert res["draft"] == "improved draft"
    assert calls["reply_to_body"] == "TEMPLATE_BODY"
    assert calls["current_body"] == "my rough draft"
