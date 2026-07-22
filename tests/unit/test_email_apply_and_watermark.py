"""The shared apply+watermark tail (email item 2.2).

``_apply_matches`` and ``_stamp_processed_watermark`` are the ONE place the
runner, the single-message re-run, and process-past now run matches and stamp
the processed watermark — collapsing four hand-rolled copies. These lock the
behaviour those copies each carried so it can't drift back apart:
  * the watermark is stamped only when the run could act (not dry-run, provider
    present) — the permanent watermark must never burn mail the run didn't touch,
  * every match goes through _apply_and_log_match with the sole_match guard,
  * a no-match logs one SKIPPED row (unless the caller has a guaranteed match),
  * the cold-email blocker fires only for a real policy on a live run.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from gateway.routes.email.automation import runner as r

_R = SimpleNamespace(
    id="m1", provider_message_id="PMID", thread_id="t1", subject="Hi",
)
_FRM = {"email": "sender@x.com"}
_EMAIL = {"subject": "Hi", "from": "sender@x.com", "body": "b"}


def _sql_of(call) -> str:
    return str(call.args[0])


def _executed(db: AsyncMock) -> list[str]:
    return [_sql_of(c) for c in db.execute.await_args_list]


# ── _stamp_processed_watermark ──────────────────────────────────────────────

async def test_watermark_written_on_a_live_run() -> None:
    db = AsyncMock()
    await r._stamp_processed_watermark(db, "m1", provider=object())
    assert any("rules_processed_at = now()" in s for s in _executed(db))


async def test_watermark_skipped_on_dry_run() -> None:
    db = AsyncMock()
    await r._stamp_processed_watermark(db, "m1", provider=object(), dry_run=True)
    db.execute.assert_not_awaited()


async def test_watermark_skipped_when_no_provider() -> None:
    db = AsyncMock()
    await r._stamp_processed_watermark(db, "m1", provider=None)
    db.execute.assert_not_awaited()


# ── _apply_matches ──────────────────────────────────────────────────────────

async def _run_apply(matches, **kw):
    db = AsyncMock()
    with patch.object(r, "_apply_and_log_match", AsyncMock()) as alm, \
            patch.object(r, "_maybe_block_cold", AsyncMock()) as cold:
        await r._apply_matches(
            db, object(), _R, _FRM, _EMAIL, matches,
            apply=kw.get("apply", True), dry_run=kw.get("dry_run", False),
            about="", signature="", account_user="u", account_id="acc",
            log_no_match=kw.get("log_no_match", True),
            cold_blocker=kw.get("cold_blocker"),
        )
    return db, alm, cold


async def test_each_match_is_applied_with_sole_flag() -> None:
    _db, alm, _cold = await _run_apply([{"rule": {}}, {"rule": {}}])
    assert alm.await_count == 2
    # sole_match is False when there are two matches.
    assert alm.await_args.kwargs["sole_match"] is False


async def test_no_match_logs_one_skipped_row() -> None:
    db, alm, _cold = await _run_apply([])
    alm.assert_not_awaited()
    skipped = [s for s in _executed(db) if "SKIPPED" in s]
    assert len(skipped) == 1
    assert "No rule matched this email." in skipped[0]


async def test_no_match_stays_silent_when_log_no_match_off() -> None:
    db, _alm, _cold = await _run_apply([], log_no_match=False)
    assert not any("SKIPPED" in s for s in _executed(db))


async def test_no_match_on_dry_run_logs_nothing() -> None:
    db, _alm, _cold = await _run_apply([], dry_run=True)
    assert not any("SKIPPED" in s for s in _executed(db))


async def test_cold_blocker_fires_for_a_real_policy() -> None:
    _db, _alm, cold = await _run_apply([], cold_blocker="AUTO_ARCHIVE")
    cold.assert_awaited_once()


async def test_cold_blocker_silent_when_off_or_absent() -> None:
    _db, _alm, cold_off = await _run_apply([], cold_blocker="OFF")
    cold_off.assert_not_awaited()
    _db2, _alm2, cold_none = await _run_apply([])  # default None
    cold_none.assert_not_awaited()
