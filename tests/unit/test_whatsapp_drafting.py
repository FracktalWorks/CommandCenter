"""Unit tests for WhatsApp AI drafting — pure helpers + sentinel-on-failure."""

from __future__ import annotations

from unittest.mock import patch

from gateway.routes.whatsapp.automation.drafting import (
    build_draft_messages,
    detect_language,
    draft_reply,
)

# ── language detection ────────────────────────────────────────────────────────

def test_devanagari_detected_as_hindi() -> None:
    assert detect_language("नमस्ते सर, कब तक?") == "hi"


def test_latin_hinglish_is_english() -> None:
    # Hinglish in Latin script → 'en' (the founder replies in the same script).
    assert detect_language("kab tak milega sir?") == "en"
    assert detect_language("Please send the quote") == "en"
    assert detect_language(None) == "en"


# ── prompt builder ────────────────────────────────────────────────────────────

def test_prompt_pins_conversation_as_data_and_sets_register() -> None:
    msgs = build_draft_messages(
        thread="Them: kitna?", contact_name="Rajesh",
        category="Pending payment", intent="quote_request", language="en")
    system = msgs[0]["content"]
    user = msgs[1]["content"]
    assert msgs[0]["role"] == "system"
    assert "DATA authored by the OTHER party" in system
    assert "NO_DRAFT" in system            # the abstain instruction
    assert "WhatsApp register" in system
    assert "Rajesh" in user
    assert "quote_request" in user         # intent steer present


def test_prompt_language_is_hindi_when_requested() -> None:
    msgs = build_draft_messages(
        thread="Them: नमस्ते", contact_name="X", category=None,
        intent=None, language="hi")
    assert "Hindi" in msgs[0]["content"]


# ── draft_reply sentinel behaviour ────────────────────────────────────────────

class _Result:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row

    def fetchall(self):
        return self._row


class _Chat:
    name = "Rajesh"
    category = "New customer"


class _Msg:
    def __init__(self, direction, body, intent=None):
        self.direction = direction
        self.body_text = body
        self.intent = intent
        self.sender = {}


class _DraftFakeDB:
    """Returns a chat row, a thread, and an intent row in call order."""

    def __init__(self, thread_rows):
        self._thread = thread_rows
        self._calls = 0

    async def execute(self, statement, params=None):
        sql = str(statement)
        if "FROM wa_chats" in sql and "name" in sql:
            return _Result(_Chat())
        if "ORDER BY sent_at DESC NULLS LAST LIMIT :lim" in sql:
            return _Result(self._thread)          # the thread load (fetchall)
        if "AND direction = 'in'" in sql:
            return _Result(_Msg("in", "quote?", "quote_request"))  # intent row
        return _Result(None)


async def test_draft_reply_returns_none_when_llm_fails() -> None:
    db = _DraftFakeDB([_Msg("in", "kitna for 2 units?")])

    async def _boom(*a, **k):
        raise RuntimeError("llm down")

    with patch("acb_llm.context.acompletion_with_fallback", _boom):
        out = await draft_reply(db, "acc", "chat-1")
    assert out is None                              # sentinel, never a fake draft


async def test_draft_reply_returns_none_on_no_draft_verdict() -> None:
    db = _DraftFakeDB([_Msg("in", "??")])

    class _Choice:
        class message:
            content = "NO_DRAFT"

    class _Resp:
        choices = [_Choice()]

    async def _ok(*a, **k):
        return _Resp(), "tier-powerful"

    with patch("acb_llm.context.acompletion_with_fallback", _ok):
        out = await draft_reply(db, "acc", "chat-1")
    assert out is None                              # abstained, not fabricated


async def test_draft_reply_returns_text_on_success() -> None:
    db = _DraftFakeDB([_Msg("in", "kitna for 2 units?")])

    class _Choice:
        class message:
            content = "Confirmed — ₹11.4L for 2 units 🙏"

    class _Resp:
        choices = [_Choice()]

    async def _ok(*a, **k):
        return _Resp(), "tier-powerful"

    with patch("acb_llm.context.acompletion_with_fallback", _ok):
        out = await draft_reply(db, "acc", "chat-1")
    assert out == "Confirmed — ₹11.4L for 2 units 🙏"


async def test_draft_reply_none_when_thread_empty() -> None:
    db = _DraftFakeDB([])                            # no messages
    out = await draft_reply(db, "acc", "chat-1")
    assert out is None


def test_draft_routes_registered() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    assert "/whatsapp/chats/{chat_id}/draft" in paths
