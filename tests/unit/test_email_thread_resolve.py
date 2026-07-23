"""The /reply-zero/resolve endpoint's three honest outcomes.

Done = the loop is closed (labels collapse to Done, captured tasks close).
Reopen = re-derive owing/awaiting from the latest message.
Dismiss = "never mind this thread": files it as FYI — nothing claimed
completed, captured tasks left OPEN. Added for the dashboard, where the only
closer used to be Mark done, so clearing a dead year-old thread meant lying
about having handled it.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from gateway.routes.email.automation import replyzero as rz


def _db(rowcount: int = 1):
    db = AsyncMock()
    res = MagicMock()
    res.rowcount = rowcount
    res.fetchone.return_value = SimpleNamespace(
        folder="inbox", id="m1", received_at=None)
    db.execute.return_value = res
    return db


async def _call(req):
    db = _db()
    background = MagicMock()
    with patch.object(rz, "_get_db", AsyncMock(return_value=db)), \
            patch.object(rz, "_assert_account_owner", AsyncMock()):
        out = await rz.resolve_thread(
            req, background, user=SimpleNamespace(email="u@x.com"))
    return out, db, background


async def test_dismiss_files_as_fyi_not_done() -> None:
    req = rz.ThreadResolveRequest(
        account_id="acc", thread_id="t1", dismiss=True)
    out, db, background = await _call(req)
    assert out["ok"] is True
    sql = " ".join(str(c[0][0]) for c in db.execute.call_args_list)
    assert "status = 'FYI'" in sql
    assert "'DONE'" not in sql, "dismiss must never claim completion"
    # …and the label reconcile keeps FYI, not Done.
    assert background.add_task.call_args[0][3] == "FYI"


async def test_dismiss_never_closes_captured_tasks() -> None:
    req = rz.ThreadResolveRequest(
        account_id="acc", thread_id="t1", dismiss=True)
    with patch(
        "gateway.routes.tasks.email_link.propagate_thread_done_to_tasks",
        AsyncMock(),
    ) as prop:
        await _call(req)
    prop.assert_not_awaited()


async def test_done_still_closes_and_keeps_done_label() -> None:
    req = rz.ThreadResolveRequest(account_id="acc", thread_id="t1", done=True)
    out, db, background = await _call(req)
    sql = " ".join(str(c[0][0]) for c in db.execute.call_args_list)
    assert "'DONE'" in sql
    assert background.add_task.call_args[0][3] == "Done"
