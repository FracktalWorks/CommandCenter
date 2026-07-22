"""What the Analytics screen is allowed to claim.

The screen this replaces displayed a range selector reading "Inbox activity for
the last 30 days" above figures that had no date predicate at all. Measured on
the live account the day it was replaced:

    header said        actual 30-day figure
    Total    6,803     1,431
    Unread   4,517       739

— everything back to a stray 2019 message in Trash, presented as a month. Only
the volume chart and the rule counters moved when the selector moved; Total,
Unread, Read-rate, Top senders and By-folder were frozen all-time numbers under
a heading that said otherwise.

That is the defect these tests exist to prevent recurring, and it is a class of
defect rather than one bug: a windowed caption over an unwindowed query. So the
tests below assert the date predicate is PRESENT on everything that claims the
window, and equally that it is ABSENT from the reply backlog — which is a
standing level, deliberately all-time, and labelled "right now" for that reason.

The rest lock the honesty of the automation figures. A dry-run preview writes a
PENDING row; counting one as work done, or as a silent acceptance, would let the
assistant's scorecard improve by being ignored.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from gateway.routes.email.automation import analytics as a

_PARAMS = {"uid": "u@example.com", "days": 30}
_SCOPE = "m.account_id IN (SELECT id FROM email_accounts WHERE user_id = :uid)"
_WIN = "m.received_at >= now() - make_interval(days => :days)"


def _db(rows: list | None = None, row: object | None = None,
        scalar: int = 0) -> AsyncMock:
    """A db whose every query returns the same canned result, recording SQL."""
    db = AsyncMock()
    db.execute.return_value = MagicMock(
        fetchall=MagicMock(return_value=rows or []),
        fetchone=MagicMock(return_value=row),
        scalar=MagicMock(return_value=scalar),
    )
    return db


def _all_sql(db: AsyncMock) -> str:
    return "\n".join(str(c[0][0]) for c in db.execute.call_args_list)


# Every attribute any query in the module reads, on one row, so a single canned
# result can stand in for all of them.
_ANY_ROW = SimpleNamespace(
    received=0, received_prev=0, sent=0, sent_prev=0, unread=0,
    inbound=0, replied=0, median_h=None, p90_h=None,
    inbound_prev=0, replied_prev=0, median_h_prev=None,
    total=0, classified=0, decided=0, rejected=0, repairable=0, permanent=0,
)

# The three queries allowed to ignore the range selector, and why. Anything else
# that stops carrying :days is reporting an all-time number under a windowed
# heading — the exact defect this screen was rewritten to remove.
_UNWINDOWED_BY_DESIGN = (
    "email_thread_status ts",   # the backlog: a level, not a flow
    "COUNT(ts.thread_id)",      # Reply Zero coverage: all-time by definition
    "email_rule_patterns p",    # the review queue: a level, not a flow
    "er.status = 'FAILED'",     # the repair queue: a level, not a flow
)


# ── the caption must be true ───────────────────────────────────────────────


async def test_every_flow_figure_on_the_page_carries_the_window() -> None:
    """Runs the real endpoint and inspects every statement it issues.

    Asserting per-helper would miss the actual failure mode: two of the helpers
    receive their window as an argument, so a caller that forgot to pass it
    would leave the helper's own source looking perfectly windowed while the
    page displayed all-time numbers. Only the assembled query text can tell.
    """
    db = _db(rows=[], row=_ANY_ROW, scalar=0)
    with patch.object(a, "_get_db", AsyncMock(return_value=db)):
        await a.analytics_overview(
            account_id=None, days=30,
            user=SimpleNamespace(email="u@example.com"))

    issued = [str(c[0][0]) for c in db.execute.call_args_list]
    assert len(issued) >= 7, "the endpoint stopped issuing its queries"
    for sql in issued:
        if any(marker in sql for marker in _UNWINDOWED_BY_DESIGN):
            continue
        assert ":days" in sql, (
            "this query reports a flow but never restricts by :days — it is "
            "how the old screen showed 6,803 under a heading saying 1,431:\n"
            f"{sql}"
        )


async def test_the_reply_backlog_is_deliberately_not_windowed() -> None:
    """A backlog is a level, not a flow. The thread nobody answered in March is
    the single most useful row on the screen, and a 30-day filter hides it."""
    db = _db(rows=[], row=_ANY_ROW)
    await a._backlog(db, dict(_PARAMS), None)
    sql = str(db.execute.call_args_list[0][0][0])
    assert "make_interval" not in sql, (
        "filtering the backlog by the range selector would hide precisely the "
        "old threads it exists to surface"
    )


# ── responsiveness ──────────────────────────────────────────────────────────


async def test_response_time_is_measured_per_thread() -> None:
    """Five messages in one conversation are one thing to answer. Measuring per
    message lets a single chatty thread dominate the median."""
    db = _db(row=SimpleNamespace(
        inbound=0, replied=0, median_h=None, p90_h=None,
        inbound_prev=0, replied_prev=0, median_h_prev=None))
    await a._responsiveness(db, _SCOPE, dict(_PARAMS))
    sql = _all_sql(db)
    assert "GROUP BY m.account_id, m.thread_id" in sql


async def test_a_thread_enters_the_window_when_it_ARRIVED() -> None:
    """Anchoring on the arrival of the first inbound message is what makes
    reply-rate mean "of the mail that came in, how much did I answer".

    Anchoring on the reply instead would let a quiet week score well purely by
    clearing old debt, and would make the rate exceed 100% whenever the user
    caught up on a backlog.
    """
    db = _db(row=SimpleNamespace(
        inbound=0, replied=0, median_h=None, p90_h=None,
        inbound_prev=0, replied_prev=0, median_h_prev=None))
    await a._responsiveness(db, _SCOPE, dict(_PARAMS))
    sql = _all_sql(db)
    assert "i.at >= now() - make_interval(days => :days)" in sql
    # The reply itself is unconstrained: a thread answered late still counts.
    assert "o.at > i.at" in sql


async def test_unanswered_threads_are_reported_not_hidden() -> None:
    """Timings can only be computed over threads that DID get a reply. Reporting
    that median alone is how a response-time dashboard flatters its owner — the
    unreplied count has to travel alongside it."""
    db = _db(row=SimpleNamespace(
        inbound=10, replied=4, median_h=2.0, p90_h=9.0,
        inbound_prev=0, replied_prev=0, median_h_prev=None))
    out = await a._responsiveness(db, _SCOPE, dict(_PARAMS))
    assert out["unreplied_threads"] == 6
    assert out["reply_rate"] == 0.4


async def test_no_replies_at_all_reads_as_unknown_not_zero() -> None:
    """A null median means "nothing was answered", which is the opposite of the
    "0 hours" a numeric default would render as."""
    db = _db(row=SimpleNamespace(
        inbound=5, replied=0, median_h=None, p90_h=None,
        inbound_prev=0, replied_prev=0, median_h_prev=None))
    out = await a._responsiveness(db, _SCOPE, dict(_PARAMS))
    assert out["median_hours"] is None
    assert out["reply_rate"] == 0.0


# ── backlog ─────────────────────────────────────────────────────────────────


async def test_backlog_ages_are_bucketed_not_averaged() -> None:
    """"Median 12 days" describes both a healthy backlog and one with six
    threads rotting since March. The distribution is the actionable shape."""
    db = _db(rows=[
        SimpleNamespace(status="NEEDS_REPLY", bucket="30d+", threads=20,
                        oldest_days=353.0),
        SimpleNamespace(status="NEEDS_REPLY", bucket="1-4w", threads=8,
                        oldest_days=20.0),
    ], row=SimpleNamespace(total=0, classified=0))
    out = await a._backlog(db, dict(_PARAMS), None)
    side = out["needs_reply"]
    assert side["threads"] == 28
    assert side["oldest_days"] == 353
    assert {b["label"]: b["count"] for b in side["buckets"]}["30d+"] == 20
    # Every bucket is present even at zero, so the bar never changes shape.
    assert len(side["buckets"]) == len(a._AGE_BUCKETS) + 1


async def test_an_empty_backlog_still_reports_both_sides() -> None:
    db = _db(rows=[], row=SimpleNamespace(total=0, classified=0))
    out = await a._backlog(db, dict(_PARAMS), None)
    assert out["needs_reply"]["threads"] == 0
    assert out["awaiting"]["threads"] == 0
    assert out["needs_reply"]["oldest_days"] is None


async def test_coverage_travels_with_the_backlog() -> None:
    """"3 need a reply" means one thing at full coverage and nothing at all if
    only a twelfth of threads were ever classified — which is the state this
    mailbox was actually in once, at 295 of 3,487."""
    db = _db(rows=[], row=SimpleNamespace(total=3487, classified=295))
    out = await a._backlog(db, dict(_PARAMS), None)
    assert out["coverage"]["rate"] == round(295 / 3487, 4)


# ── senders you never answer ────────────────────────────────────────────────


async def test_noise_excludes_mail_already_thrown_away() -> None:
    """Trash and Junk would inflate every sender with mail the user has already
    dealt with. Shares one constant with the Email Cleaner so a sender's volume
    means the same number on both screens."""
    db = _db(rows=[])
    await a._noisy_senders(db, _SCOPE, dict(_PARAMS), _WIN)
    sql = _all_sql(db)
    assert a.DISPOSED_FOLDERS in sql


async def test_noise_never_lists_the_user_themselves() -> None:
    """Without this the whole Sent folder makes the user their own top sender."""
    db = _db(rows=[])
    await a._noisy_senders(db, _SCOPE, dict(_PARAMS), _WIN)
    assert "NOT IN (SELECT LOWER(email_address)" in _all_sql(db).replace(
        "\n", " ").replace("  ", " ")


async def test_one_reply_ever_disqualifies_a_sender() -> None:
    """"Never replied" is measured across the whole mailbox, not the window. A
    reply two years ago still means this is a real correspondent, and offering
    to silence them would be wrong."""
    db = _db(rows=[])
    await a._noisy_senders(db, _SCOPE, dict(_PARAMS), _WIN)
    sql = _all_sql(db)
    assert "HAVING COUNT(*) FILTER (WHERE r.thread_id IS NOT NULL) = 0" in sql
    # The `replied` CTE itself must not be windowed.
    cte = sql[sql.index("WITH replied"):sql.index("SELECT LOWER(")]
    assert ":days" not in cte


async def test_a_senders_cost_is_annualised() -> None:
    """Silencing a sender is a decision about the future. "37 last month"
    understates it in a way "about 450 a year" does not."""
    db = _db(rows=[SimpleNamespace(
        email="n@x.com", name="N", messages=30, unread=28,
        unsubscribe_link=None, last_seen=None)])
    out = await a._noisy_senders(db, _SCOPE, {"uid": "u", "days": 30}, _WIN)
    assert out[0]["projected_yearly"] == 365
    assert out[0]["read"] == 2
    assert out[0]["has_unsubscribe"] is False


# ── the assistant's own scorecard ───────────────────────────────────────────


async def test_a_dry_run_is_not_work_done() -> None:
    """PENDING is what a preview writes. Crediting a preview with work it
    explicitly did not do would overstate the assistant on the one screen meant
    to measure it."""
    db = _db(rows=[], scalar=0,
             row=SimpleNamespace(decided=0, rejected=0, repairable=0, permanent=0))
    await a._automation(db, dict(_PARAMS), None)
    assert "er.status = 'APPLIED'" in _all_sql(db)


async def test_handled_counts_emails_not_rule_hits() -> None:
    """One message touched by three rules is ONE email the user did not have to
    handle. Summing the per-rule breakdown would report it as three."""
    db = _db(rows=[], scalar=7,
             row=SimpleNamespace(decided=0, rejected=0, repairable=0, permanent=0))
    _stats, _actions, handled = await a._automation(db, dict(_PARAMS), None)
    assert handled == 7
    assert "COUNT(DISTINCT er.message_id)" in _all_sql(db)


async def test_ignoring_a_proposal_is_not_accepting_it() -> None:
    """Rejection rate is over APPLIED + REJECTED only. Counting undecided
    PENDING rows as acceptances would make the assistant look better the longer
    the user left its suggestions alone."""
    db = _db(rows=[], scalar=0,
             row=SimpleNamespace(decided=10, rejected=2,
                                 repairable=0, permanent=0))
    out = await a._automation_trust(db, dict(_PARAMS), "er.account_id = :aid")
    assert out["rejection_rate"] == 0.2
    sql = _all_sql(db)
    assert "IN ('APPLIED', 'REJECTED')" in sql


async def test_failed_actions_split_into_repairable_and_permanent() -> None:
    """A failed rule run is a repair QUEUE — a level, not a windowed flow. It is
    split into what the Repair button can replay (message present, a rule to
    re-run) and what no replay can fix (message moved/deleted), because the old
    single windowed count routinely showed a number with 'nothing to repair'
    behind it while genuinely repairable rows outside the window were invisible."""
    db = _db(rows=[], scalar=0,
             row=SimpleNamespace(decided=100, rejected=0,
                                 repairable=7, permanent=92))
    out = await a._automation_trust(db, dict(_PARAMS), "er.account_id = :aid")
    assert out["repairable"] == 7
    assert out["permanent_failures"] == 92
    assert "failed_actions" not in out
    sql = _all_sql(db)
    assert "status = 'FAILED'" in sql
    # repairable mirrors retry_failed_executions: not disposed, message present.
    assert "('trash', 'junk', 'spam', 'drafts', 'draft')" in sql
    # the failure count is a level — unwindowed (no :days on that query).
    fail_sql = [str(c[0][0]) for c in db.execute.call_args_list
                if "status = 'FAILED'" in str(c[0][0])][0]
    assert ":days" not in fail_sql


async def test_the_unreviewed_queue_counts_only_what_review_can_clear() -> None:
    """Excludes are never gated on approval — an exclude only ever PREVENTS a
    label. Counting them would invent a backlog with no button to clear it."""
    db = _db(rows=[], scalar=21,
             row=SimpleNamespace(decided=0, rejected=0, repairable=0, permanent=0))
    out = await a._automation_trust(db, dict(_PARAMS), "er.account_id = :aid")
    assert out["unreviewed_patterns"] == 21
    assert "NOT p.exclude" in _all_sql(db)


async def test_the_queue_is_not_windowed() -> None:
    """A pattern learned four months ago and never looked at is the whole reason
    to show this number."""
    db = _db(rows=[], scalar=0,
             row=SimpleNamespace(decided=0, rejected=0, repairable=0, permanent=0))
    await a._automation_trust(db, dict(_PARAMS), "er.account_id = :aid")
    pattern_sql = str(db.execute.call_args_list[-1][0][0])
    assert "email_rule_patterns" in pattern_sql
    assert ":days" not in pattern_sql


async def test_a_missing_rules_log_degrades_to_zero_not_a_500() -> None:
    """Analytics is a read-only screen; one optional table being empty or absent
    must not take the whole page down."""
    db = AsyncMock()
    db.execute.side_effect = RuntimeError("no such table")
    stats, actions, handled = await a._automation(db, dict(_PARAMS), None)
    assert (stats["processed"], actions, handled) == (0, [], 0)
    assert stats["trust"]["unreviewed_patterns"] == 0
