"""Unit tests for the centralized guards in `_upsert_rule_pattern` — the single
write choke point for learned classification patterns. It must refuse to:
  1. sender-pin a conversation-status rule (To Reply / Awaiting / FYI / Actioned);
  2. pin the mailbox's OWN address to any rule.
Both anti-patterns were seen live ("vjvarada@… → To Reply") from the (formerly
unguarded) label-sync learner; the guard here is the backstop for every path."""
from __future__ import annotations

from types import SimpleNamespace

from gateway.routes import email as m

_upsert = m.automation.rules._upsert_rule_pattern


class _Result:
    def __init__(self, row: object | None) -> None:
        self._row = row

    def fetchone(self) -> object | None:
        return self._row


class _FakeDB:
    """Minimal async DB stub that answers the two metadata SELECTs and records
    whether an INSERT (i.e. an actual pattern write) happened."""

    def __init__(self, rule_row: object | None, acct_row: object | None) -> None:
        self.rule_row = rule_row
        self.acct_row = acct_row
        self.inserted = False

    async def execute(self, clause: object, params: dict | None = None) -> _Result:
        sql = str(clause)
        if "FROM email_rules" in sql:
            return _Result(self.rule_row)
        if "FROM email_accounts" in sql:
            return _Result(self.acct_row)
        if sql.lstrip().upper().startswith("INSERT"):
            self.inserted = True
        return _Result(None)


async def test_conversation_rule_is_never_pinned_by_name() -> None:
    # system_type NULL → recognized by name fallback ("To Reply" → TO_REPLY).
    db = _FakeDB(SimpleNamespace(name="To Reply", system_type=None),
                 SimpleNamespace(email_address="me@fracktal.in"))
    await _upsert(db, "acc-1", "rule-reply", "souradeep@iisc.ac.in", False,
                  "LABEL_ADDED", "why", None, None, pattern_type="FROM")
    assert db.inserted is False


async def test_conversation_rule_is_never_pinned_by_system_type() -> None:
    db = _FakeDB(SimpleNamespace(name="Custom", system_type="AWAITING_REPLY"),
                 SimpleNamespace(email_address="me@fracktal.in"))
    await _upsert(db, "acc-1", "rule-x", "someone@x.com", True,
                  "LABEL_REMOVED", "why", None, None, pattern_type="FROM")
    assert db.inserted is False


async def test_own_address_is_never_pinned() -> None:
    # A non-conversation rule, but the value IS the mailbox's own address.
    db = _FakeDB(SimpleNamespace(name="Newsletter", system_type=None),
                 SimpleNamespace(email_address="vjvarada@fracktal.in"))
    await _upsert(db, "acc-1", "rule-news", "vjvarada@fracktal.in", False,
                  "LABEL_ADDED", "why", None, None, pattern_type="FROM")
    assert db.inserted is False


async def test_normal_cleanup_pattern_is_written() -> None:
    # External sender + a sender-stable cleanup rule → the pattern is persisted.
    db = _FakeDB(SimpleNamespace(name="Newsletter", system_type=None),
                 SimpleNamespace(email_address="me@fracktal.in"))
    await _upsert(db, "acc-1", "rule-news", "digest@substack.com", False,
                  "AI", "why", None, None, pattern_type="FROM")
    assert db.inserted is True
