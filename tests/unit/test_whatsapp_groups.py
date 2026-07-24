"""Unit tests for WhatsApp group intelligence — builder, parser, summarize."""

from __future__ import annotations

import json
from unittest.mock import patch

from gateway.routes.whatsapp.automation.groups import (
    build_group_summary_messages,
    parse_summary_response,
    summarize_group,
)

# ── prompt builder ────────────────────────────────────────────────────────────

def test_prompt_pins_transcript_as_data_and_asks_for_json() -> None:
    msgs = build_group_summary_messages(
        group_name="Dealer South", transcript="Ravi: margins?",
        mentioned_hint=False)
    system = msgs[0]["content"]
    assert "DATA authored by other people" in system
    assert "STRICT JSON" in system
    assert "mentions_you" in system
    assert "Dealer South" in msgs[1]["content"]


def test_mention_hint_appended_only_when_flagged() -> None:
    with_hint = build_group_summary_messages(
        group_name="G", transcript="x", mentioned_hint=True)[1]["content"]
    without = build_group_summary_messages(
        group_name="G", transcript="x", mentioned_hint=False)[1]["content"]
    assert "@mentioned" in with_hint
    assert "@mentioned" not in without


# ── response parser ───────────────────────────────────────────────────────────

def test_parses_valid_summary() -> None:
    raw = json.dumps({
        "summary": "Dealers asked about edu-bundle margins; monsoon delays noted.",
        "sentiment": "mixed",
        "mentions_you": True,
        "key_points": ["Chennai dealer wants margin structure", "Shipping delays"],
    })
    out = parse_summary_response(raw)
    assert out is not None
    assert out["sentiment"] == "mixed"
    assert out["mentions_you"] is True
    assert len(out["key_points"]) == 2


def test_parser_tolerates_prose_around_json() -> None:
    raw = 'Here you go:\n{"summary": "ok", "sentiment": "positive"}\ndone'
    out = parse_summary_response(raw)
    assert out is not None and out["summary"] == "ok"


def test_parser_defaults_bad_sentiment_to_neutral() -> None:
    out = parse_summary_response('{"summary": "s", "sentiment": "angry"}')
    assert out["sentiment"] == "neutral"


def test_parser_clamps_key_points_to_five() -> None:
    raw = json.dumps({"summary": "s", "key_points": [f"p{i}" for i in range(9)]})
    out = parse_summary_response(raw)
    assert len(out["key_points"]) == 5


def test_parser_rejects_empty_or_missing_summary() -> None:
    assert parse_summary_response('{"summary": ""}') is None
    assert parse_summary_response('{"sentiment": "positive"}') is None
    assert parse_summary_response("not json") is None
    assert parse_summary_response(None) is None


# ── summarize_group orchestration ─────────────────────────────────────────────

class _Result:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row if not isinstance(self._row, list) else None

    def fetchall(self):
        return self._row if isinstance(self._row, list) else []


class _GroupChat:
    name = "Dealer South"
    kind = "group"
    phone_number = "+919990000"


class _MsgRow:
    def __init__(self, name, body, mentions=None, sent_at=None):
        self.sender = {"name": name, "wa_id": "x"}
        self.body_text = body
        self.mentions = mentions or []
        self.sent_at = sent_at


class _GroupFakeDB:
    def __init__(self, msg_rows, *, is_group=True):
        self._msgs = msg_rows
        self._is_group = is_group
        self.wrote = False

    async def execute(self, statement, params=None):
        sql = str(statement)
        if "FROM wa_chats c JOIN wa_accounts" in sql:
            chat = _GroupChat()
            if not self._is_group:
                chat = type("C", (), {"name": "x", "kind": "dm",
                                      "phone_number": "+91"})()
            return _Result(chat)
        if "FROM wa_messages" in sql:
            return _Result(self._msgs)
        if "INSERT INTO wa_group_summaries" in sql:
            self.wrote = True
            return _Result(None)
        return _Result(None)


def _resp(content):
    choice = type("Ch", (), {"message": type("M", (), {"content": content})()})
    return type("R", (), {"choices": [choice]})()


async def test_summarize_group_success_writes_and_returns() -> None:
    db = _GroupFakeDB([_MsgRow("Ravi", "kitna margin?")])
    payload = json.dumps({"summary": "Asked margins", "sentiment": "neutral",
                          "mentions_you": False, "key_points": ["margins?"]})

    async def _ok(*a, **k):
        return _resp(payload), "tier-balanced"

    with patch("acb_llm.context.acompletion_with_fallback", _ok):
        out = await summarize_group(db, "acc", "chat-1")
    assert out is not None
    assert out["summary"] == "Asked margins"
    assert db.wrote is True


async def test_summarize_group_ored_mention_from_transcript() -> None:
    # The founder's number is @mentioned in the messages → mentions_you True even
    # if the model said False.
    db = _GroupFakeDB([_MsgRow("Ravi", "sir?", mentions=["919990000"])])
    payload = json.dumps({"summary": "s", "sentiment": "neutral",
                          "mentions_you": False, "key_points": []})

    async def _ok(*a, **k):
        return _resp(payload), "x"

    with patch("acb_llm.context.acompletion_with_fallback", _ok):
        out = await summarize_group(db, "acc", "chat-1")
    assert out["mentions_you"] is True


async def test_summarize_group_none_on_llm_failure() -> None:
    db = _GroupFakeDB([_MsgRow("Ravi", "hi")])

    async def _boom(*a, **k):
        raise RuntimeError("down")

    with patch("acb_llm.context.acompletion_with_fallback", _boom):
        out = await summarize_group(db, "acc", "chat-1")
    assert out is None
    assert db.wrote is False               # nothing cached on failure


async def test_summarize_group_none_for_dm() -> None:
    db = _GroupFakeDB([_MsgRow("Ravi", "hi")], is_group=False)
    out = await summarize_group(db, "acc", "chat-1")
    assert out is None                      # only groups get summarized


async def test_summarize_group_none_on_empty_transcript() -> None:
    db = _GroupFakeDB([])                    # no messages
    out = await summarize_group(db, "acc", "chat-1")
    assert out is None


def test_group_routes_registered() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    assert "/whatsapp/groups/{chat_id}/summarize" in paths
    assert "/whatsapp/groups/summaries" in paths
