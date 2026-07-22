"""Unit tests for the inbox digest generator.

The DB session is mocked, so the SQL and bound params are inspected rather than
executed. Focus: the two honesty fixes — the "awaiting your reply" count reads
the Reply Zero status table (not an all-time inbox heuristic), and the category
filter normalises the user's selections to canonical cleanup categories.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from gateway.routes import email as m


def _fake_db(captured: list[tuple[str, dict]]):
    async def fake_execute(stmt, params=None):
        sql = str(stmt)
        captured.append((sql, params or {}))
        r = MagicMock()
        if "FROM email_accounts" in sql:
            r.fetchone.return_value = SimpleNamespace(self="me@fracktal.in")
        elif "COUNT(*) AS total" in sql:
            r.fetchone.return_value = SimpleNamespace(
                total=10, unread=3, inbox=8, attachments=2)
        elif "email_thread_status" in sql:
            r.scalar.return_value = 4
        else:
            r.fetchall.return_value = []
            r.fetchone.return_value = None
            r.scalar.return_value = 0
        return r

    db = AsyncMock()
    db.execute.side_effect = fake_execute
    return db


async def test_needs_reply_reads_thread_status_not_inbox_heuristic() -> None:
    captured: list[tuple[str, dict]] = []
    out = await m.digest._generate_digest(_fake_db(captured), "acc-1", 7)
    sql = " ".join(s for s, _ in captured)
    # Reads the Reply Zero status table for NEEDS_REPLY …
    assert "email_thread_status" in sql
    assert "NEEDS_REPLY" in sql
    # … and NOT the old all-time "latest message in inbox" heuristic.
    assert "WITH latest AS" not in sql
    assert out["totals"]["needs_reply"] == 4


async def test_category_filter_normalises_and_drops_non_categories() -> None:
    """The configured rule names normalise through the canonicaliser and filter
    the COMPOSED analytics aggregate's rows — since 2.7 the filter is a
    projection over the one shared computation, not a second SQL variant."""
    from unittest.mock import patch

    from gateway.routes.email.automation import analytics as an

    captured: list[tuple[str, dict]] = []
    db = _fake_db(captured)
    rows = [
        {"category": "Cold Email", "count": 3, "prev_count": 0},
        {"category": "Newsletter", "count": 5, "prev_count": 1},
        {"category": "Receipt", "count": 2, "prev_count": 0},
        {"category": "Reply", "count": 1, "prev_count": 0},
    ]
    with patch.object(an, "_categories", AsyncMock(return_value=rows)):
        out = await m.digest._generate_digest(
            db, "acc-1", 7,
            # rule-name variants: plural alias, wrong casing/whitespace, and a
            # name that isn't a category at all.
            ["Cold Emails", " newsletter ", "My weekly roundup"],
        )
    # Only the normalised, de-junked selections survive; the thread-status row
    # ("Reply") and unselected categories are projected out.
    assert [r["category"] for r in out["by_category"]] == [
        "Cold Email", "Newsletter"]


# ── 2.7: projection + honesty ────────────────────────────────────────────────

def _fake_db_with_totals(captured: list[tuple[str, dict]]):
    """Like _fake_db but returns real inbox totals for the new aggregate query."""
    async def fake_execute(stmt, params=None):
        sql = str(stmt)
        captured.append((sql, params or {}))
        r = MagicMock()
        if "FROM email_accounts" in sql:
            r.fetchone.return_value = SimpleNamespace(self="me@fracktal.in")
        elif "COUNT(*) AS inbox" in sql:
            r.fetchone.return_value = SimpleNamespace(
                inbox=8, unread=3, attachments=2)
        elif "email_thread_status" in sql:
            r.scalar.return_value = 4
        else:
            r.fetchall.return_value = []
            r.fetchone.return_value = None
            r.scalar.return_value = 0
        return r

    db = AsyncMock()
    db.execute.side_effect = fake_execute
    return db


async def test_every_aggregate_excludes_the_accounts_own_mail() -> None:
    # The digest email itself lands in the inbox from the account; counting it
    # (or self-notes / BCC-to-self) would inflate the next digest. Every windowed
    # aggregate excludes self and binds :self.
    captured: list[tuple[str, dict]] = []
    await m.digest._generate_digest(_fake_db_with_totals(captured), "acc-1", 7)
    # The WINDOWED inbox aggregates bind :days (the digest window). The backlog-
    # aging / commitments queries read thread status + tasks, not recent inbox
    # mail, so they aren't windowed and don't carry the self-exclusion.
    windowed = [(s, p) for s, p in captured
                if "email_messages em" in s and "days" in p]
    assert windowed, "expected the windowed inbox aggregates"
    for sql, params in windowed:
        assert "from_address->>'email') <> :self" in sql, sql[:120]
        assert params.get("self") == "me@fracktal.in"


async def test_generate_digest_returns_totals_and_both_bodies() -> None:
    out = await m.digest._generate_digest(
        _fake_db_with_totals([]), "acc-1", 1)
    assert out["totals"] == {
        "inbox": 8, "unread": 3, "attachments": 2, "needs_reply": 4}
    # Both a Markdown and an HTML body are produced for the email.
    assert "Inbox digest" in out["markdown"]
    assert out["html"].startswith("<div") and "8</b> new in inbox" in out["html"]


def test_empty_digest_is_detected() -> None:
    empty = {"totals": {"inbox": 0, "unread": 0, "attachments": 0,
                        "needs_reply": 0},
             "by_category": [], "top_senders": []}
    assert m.digest._digest_is_empty(empty) is True
    # Any new mail OR anything awaiting a reply makes it non-empty.
    assert m.digest._digest_is_empty({**empty,
        "totals": {**empty["totals"], "inbox": 1}}) is False
    assert m.digest._digest_is_empty({**empty,
        "totals": {**empty["totals"], "needs_reply": 1}}) is False


def test_digest_html_escapes_sender_and_category_text() -> None:
    html = m.digest._render_digest_html(
        "day", {"inbox": 1, "unread": 0, "attachments": 0}, 0,
        [{"category": "A & <b>", "count": 1}],
        [{"name": "<script>", "email": "x@y.com", "count": 2}])
    assert "<script>" not in html
    assert "&lt;script&gt;" in html
    assert "A &amp; &lt;b&gt;" in html


# ── 3.11: the daily brief — backlog aging + commitments due ───────────────────


def _one_shot_db(rows: list):
    """A DB whose single execute returns `rows` from fetchall."""
    db = AsyncMock()
    db.execute.return_value = MagicMock(
        fetchall=MagicMock(return_value=rows))
    return db


async def test_backlog_aging_reads_needs_reply_oldest_first() -> None:
    rows = [SimpleNamespace(thread_id="t1", subject="Invoice?", age_days=5)]
    db = _one_shot_db(rows)
    out = await m.digest._digest_backlog_aging(db, "acc-1")
    sql = str(db.execute.call_args[0][0])
    assert "status = 'NEEDS_REPLY'" in sql
    assert "ORDER BY ts.last_message_at ASC" in sql   # oldest first
    assert out == [{"subject": "Invoice?", "age_days": 5}]


async def test_commitments_are_best_effort_when_tasks_absent() -> None:
    # gtd_items may not exist in a given deploy; a digest must never fail on it.
    db = AsyncMock()
    db.execute.side_effect = RuntimeError("relation gtd_items does not exist")
    assert await m.digest._digest_commitments(db, "acc-1") == []
    # …and best-effort means the SESSION survives: a failed query aborts the
    # transaction, so without a rollback every later query in the request dies
    # with InFailedSQLTransaction (how /digest/send 500'd in prod while the
    # preview looked fine — the preview simply had no queries after this one).
    db.rollback.assert_awaited_once()


async def test_commitments_query_scopes_to_open_due_tasks_on_this_account() -> None:
    rows = [SimpleNamespace(title="Send quote", due_label="Jul 25", overdue=True)]
    db = _one_shot_db(rows)
    out = await m.digest._digest_commitments(db, "acc-1")
    sql = str(db.execute.call_args[0][0])
    assert "disposition NOT IN ('DONE', 'TRASH')" in sql
    # The json-text side compares to ea.id::text, NOT to :aid — binding the
    # same parameter against both a uuid column and json text makes Postgres
    # deduce uuid for it and fail ("operator does not exist: text = uuid").
    assert "origin->>'account_id' = ea.id::text" in sql
    assert sql.count(":aid") == 1
    assert out == [{"title": "Send quote", "due": "Jul 25", "overdue": True}]


def test_a_quiet_inbox_with_commitments_still_sends() -> None:
    # The point of a daily brief: even a day with no new mail is worth sending if
    # I owe something. Commitments (or an aging backlog) keep it non-empty.
    base = {"totals": {"inbox": 0, "unread": 0, "attachments": 0,
                       "needs_reply": 0},
            "by_category": [], "top_senders": [], "backlog": []}
    assert m.digest._digest_is_empty(base) is True
    assert m.digest._digest_is_empty(
        {**base, "commitments": [{"title": "x", "due": "Jul 25",
                                  "overdue": False}]}) is False
    assert m.digest._digest_is_empty(
        {**base, "backlog": [{"subject": "y", "age_days": 3}]}) is False


def test_brief_sections_render_in_both_bodies() -> None:
    backlog = [{"subject": "Contract review", "age_days": 4}]
    commitments = [{"title": "Send the deck", "due": "Jul 25", "overdue": True}]
    md = m.digest._render_digest_markdown(
        "day", {"inbox": 1, "unread": 0, "attachments": 0}, 2,
        [], [], backlog, commitments)
    assert "Commitments due" in md and "Send the deck" in md
    assert "Awaiting your reply" in md and "Contract review" in md
    html = m.digest._render_digest_html(
        "day", {"inbox": 1, "unread": 0, "attachments": 0}, 2,
        [], [], backlog, commitments)
    assert "Commitments due" in html and "overdue" in html
    assert "Contract review" in html
