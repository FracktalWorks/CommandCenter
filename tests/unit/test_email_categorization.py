"""Unit tests for sender auto-categorization (`_categorize_senders_job`).

A sender's category is PROJECTED from the rule engine's per-message labels
(email_messages.categories) — the same categorization the rest of the app shows.
The old cold-start LLM fallback (persisted as provisional 'inferred' guesses) was
removed: it ran on a thin signal, never self-corrected and misled the cleaner, so
the job now only projects rules and retires any leftover 'inferred' rows.
DB + LLM mocked.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from gateway.routes import email as m


def _srow(email, *, name="N", subjects=None, volume=10, unread=5,
          has_unsub=False, cur_category=None, cur_source=None):
    return SimpleNamespace(
        email=email, name=name, subjects=subjects or [], volume=volume,
        unread=unread, has_unsub=has_unsub, cur_category=cur_category,
        cur_source=cur_source)


def _trow(email, label, n):
    return SimpleNamespace(email=email, label=label, n=n)


class _Result:
    def __init__(self, rows=None, one=None):
        self._rows, self._one = rows or [], one

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._one


class _FakeDB:
    """Answers each of the job's distinct queries by SQL shape and records the
    sender upserts + commit/close lifecycle."""

    def __init__(self, senders, tally=None, account_email="me@acme.com"):
        self.senders, self.tally = senders, tally or []
        self.account_email = account_email
        self.inserts: list[dict] = []
        self.deleted_inferred = False
        self.commits = 0
        self.closed = False

    async def execute(self, clause, params=None):
        sql = str(clause)
        if "LEFT JOIN email_senders" in sql and "ORDER BY COUNT(*) DESC" in sql:
            return _Result(rows=self.senders)
        if "SELECT email_address FROM email_accounts" in sql:
            return _Result(one=SimpleNamespace(email_address=self.account_email))
        if "unnest(em.categories)" in sql:
            return _Result(rows=self.tally)
        upper = sql.lstrip().upper()
        if upper.startswith("INSERT INTO EMAIL_SENDERS"):
            self.inserts.append(params or {})
        if upper.startswith("DELETE FROM EMAIL_SENDERS") and "'INFERRED'" in upper:
            self.deleted_inferred = True
        return _Result()

    async def commit(self):
        self.commits += 1

    async def close(self):
        self.closed = True


def _run(db, *, llm):
    return patch.multiple(
        m.automation.senders,
        _get_db=AsyncMock(return_value=db),
        _llm_categorize_senders=llm,
    ), patch.object(
        m.automation.identity, "resolve_org_domains",
        AsyncMock(return_value=frozenset())
    ), patch.object(
        m.automation.assistant, "_account_models",
        AsyncMock(return_value={"rule": "tier-fast"})
    )


async def test_projects_rule_category_without_an_llm_call() -> None:
    # The rules labelled 4 of this sender's messages "Marketing" → project it
    # straight from the rule engine; no LLM, and the source is 'rule'.
    db = _FakeDB([_srow("promos@shop.com")],
                 tally=[_trow("promos@shop.com", "marketing", 4)])
    llm = AsyncMock()
    p1, p2, p3 = _run(db, llm=llm)
    with p1, p2, p3:
        await m._categorize_senders_job("acc-1", 25)
    llm.assert_not_awaited()
    assert len(db.inserts) == 1
    assert db.inserts[0]["cat"] == "Marketing"
    assert db.inserts[0]["src"] == "rule"
    assert db.commits >= 1


async def test_reply_active_sender_projects_personal() -> None:
    db = _FakeDB([_srow("colleague@x.com")],
                 tally=[_trow("colleague@x.com", "reply", 3)])
    llm = AsyncMock()
    p1, p2, p3 = _run(db, llm=llm)
    with p1, p2, p3:
        await m._categorize_senders_job("acc-1", 25)
    llm.assert_not_awaited()
    assert db.inserts[0]["cat"] == "Personal"
    assert db.inserts[0]["src"] == "rule"


async def test_cold_start_no_llm_and_no_inferred_guess() -> None:
    # No rule labels yet + uncategorized → NOTHING is written. The provisional
    # cold-start was removed, so no 'inferred' guess is created and the LLM
    # classifier is never called (even if patched to return a category).
    db = _FakeDB([_srow("news@a.com", cur_category=None)], tally=[])
    llm = AsyncMock(return_value={"news@a.com": "Newsletter"})
    p1, p2, p3 = _run(db, llm=llm)
    with p1, p2, p3:
        await m._categorize_senders_job("acc-1", 25)
    llm.assert_not_awaited()
    assert db.inserts == []


async def test_leftover_inferred_guesses_are_retired() -> None:
    # A sender still carrying a provisional 'inferred' guess with no rule coverage:
    # the LLM is not re-run, no new category is written, and the stale inferred row
    # is deleted so it stops surfacing in the cleaner.
    db = _FakeDB([_srow("news@a.com", cur_category="Marketing",
                        cur_source="inferred")], tally=[])
    llm = AsyncMock()
    p1, p2, p3 = _run(db, llm=llm)
    with p1, p2, p3:
        await m._categorize_senders_job("acc-1", 25)
    llm.assert_not_awaited()
    assert db.inserts == []
    assert db.deleted_inferred is True


async def test_excludes_the_account_owner_as_a_sender() -> None:
    # The account's own address must never be categorized (else it surfaces as
    # "you email yourself"); teammates/externals are kept. Verified via the rule
    # projection now that there's no LLM candidate list.
    db = _FakeDB(
        [_srow("me@acme.com"), _srow("news@a.com")],
        tally=[_trow("me@acme.com", "marketing", 5),
               _trow("news@a.com", "marketing", 5)],
    )
    llm = AsyncMock()
    p1, p2, p3 = _run(db, llm=llm)
    with p1, p2, p3:
        await m._categorize_senders_job("acc-1", 25)
    llm.assert_not_awaited()
    assert {i["email"] for i in db.inserts} == {"news@a.com"}   # self dropped


async def test_user_override_is_never_touched() -> None:
    db = _FakeDB([_srow("pinned@x.com", cur_category="Support",
                        cur_source="user")],
                 tally=[_trow("pinned@x.com", "marketing", 9)])
    llm = AsyncMock()
    p1, p2, p3 = _run(db, llm=llm)
    with p1, p2, p3:
        await m._categorize_senders_job("acc-1", 25)
    llm.assert_not_awaited()
    assert db.inserts == []          # 'user' rows are excluded from candidates


async def test_no_llm_cost_when_nothing_to_categorize() -> None:
    db = _FakeDB([], tally=[])
    llm = AsyncMock()
    p1, p2, p3 = _run(db, llm=llm)
    with p1, p2, p3:
        await m._categorize_senders_job("acc-1", 25)
    llm.assert_not_awaited()
    assert db.commits == 0


async def test_failure_during_job_is_swallowed_and_cleans_up() -> None:
    db = _FakeDB([_srow("x@a.com")], tally=[])
    llm = AsyncMock(side_effect=RuntimeError("llm down"))
    p1, p2, p3 = _run(db, llm=llm)
    with p1, p2, p3:
        await m._categorize_senders_job("acc-1", 25)  # must not raise
    assert db.closed is True
