"""``provider_session`` — the one place the instantiate → authenticate →
persist-rotated-creds dance lives (email item 2.11).

The behaviours that matter and used to be hand-rolled (and forgotten) at every
call site:
  * a rotated OAuth token is persisted on a CLEAN exit,
  * but NOT when the body raised (a half-failed request must not write a token
    onto a session about to roll back),
  * ``require_auth=True`` turns an auth failure into HTTP 401,
  * ``require_auth=False`` yields ``authed=False`` so best-effort callers branch,
  * message- vs account-scoped loaders surface the right extra datum.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from gateway.routes.email import core as m


def _provider(*, authed: bool, dirty: bool):
    p = MagicMock()
    p.authenticate = AsyncMock(return_value=authed)
    p.credentials_dirty = MagicMock(return_value=dirty)
    p.export_credentials = MagicMock(return_value={"token": "new"})
    return p


def _store():
    s = MagicMock()
    s.encrypt = MagicMock(return_value="ciphertext")
    return s


def _persist_happened(db: AsyncMock) -> bool:
    return any(
        "UPDATE email_accounts" in str(call.args[0])
        for call in db.execute.await_args_list
    )


async def test_persists_rotated_creds_on_clean_exit() -> None:
    db = MagicMock()
    db.execute = AsyncMock()
    provider, store = _provider(authed=True, dirty=True), _store()
    with patch.object(m, "_provider_for_account",
                      AsyncMock(return_value=(provider, store, "me@x.com"))):
        async with m.provider_session(
            db, "me@x.com", account_id="acc1",
        ) as sess:
            assert sess.authed is True
            assert sess.owner_email == "me@x.com"
    assert _persist_happened(db)  # rotated token written in the finally


async def test_no_persist_when_body_raises() -> None:
    db = MagicMock()
    db.execute = AsyncMock()
    provider, store = _provider(authed=True, dirty=True), _store()
    with patch.object(m, "_provider_for_account",
                      AsyncMock(return_value=(provider, store, "me@x.com"))):
        with pytest.raises(RuntimeError):
            async with m.provider_session(db, "me@x.com", account_id="acc1"):
                raise RuntimeError("send blew up")
    # A token rotated mid-request must NOT be committed onto a rolling-back txn.
    assert not _persist_happened(db)


async def test_require_auth_raises_401_on_auth_failure() -> None:
    db = MagicMock()
    db.execute = AsyncMock()
    provider, store = _provider(authed=False, dirty=False), _store()
    with patch.object(m, "_provider_for_account",
                      AsyncMock(return_value=(provider, store, "me@x.com"))):
        with pytest.raises(HTTPException) as ei:
            async with m.provider_session(db, "me@x.com", account_id="acc1"):
                pass
    assert ei.value.status_code == 401


async def test_optional_auth_yields_unauthed_and_no_persist() -> None:
    db = MagicMock()
    db.execute = AsyncMock()
    provider, store = _provider(authed=False, dirty=False), _store()
    with patch.object(m, "_provider_for_account",
                      AsyncMock(return_value=(provider, store, "me@x.com"))):
        async with m.provider_session(
            db, "me@x.com", account_id="acc1", require_auth=False,
        ) as sess:
            assert sess.authed is False  # caller decides what to do
    assert not _persist_happened(db)


async def test_message_scoped_surfaces_provider_message_id() -> None:
    db = MagicMock()
    db.execute = AsyncMock()
    provider, store = _provider(authed=True, dirty=False), _store()
    with patch.object(
        m, "_provider_for_message",
        AsyncMock(return_value=(provider, "PMID-9", "acc1", store)),
    ):
        async with m.provider_session(
            db, "me@x.com", message_id="msg1",
        ) as sess:
            assert sess.provider_message_id == "PMID-9"
            assert sess.account_id == "acc1"
    # authed but not dirty → nothing to persist
    assert not _persist_happened(db)


async def test_requires_account_or_message() -> None:
    db = MagicMock()
    with pytest.raises(ValueError):
        async with m.provider_session(db, "me@x.com"):
            pass
