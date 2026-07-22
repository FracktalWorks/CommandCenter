"""The manual sync path must not lose refresh tokens or wipe the sync cursor.

trigger_sync (manual) and _sync_account (scheduler) are two sync cores that had
drifted. Two concrete defects on the manual path (review §3.2):

  * it persisted a rotated OAuth refresh token only at the END of the sync, so
    any failure in between LOST the new token (Microsoft rotates it on refresh)
    and the account needed a manual reconnect — the scheduler persists it
    immediately after auth;
  * it wrote ``last_history_id = :history_id`` unconditionally, so an Outlook
    sync (which runs full-snapshot with new_history_id = None) WIPED the cursor
    to NULL — the scheduler COALESCEs to keep the old one.

These pin both, on the source, since trigger_sync is a full route handler.
"""
from __future__ import annotations

import inspect

from gateway.routes.email.transport import sync as s


def _src() -> str:
    return inspect.getsource(s.trigger_sync)


def test_rotated_creds_are_persisted_immediately_after_auth() -> None:
    src = _src()
    # The post-auth persist must come BEFORE the sync_messages call, not only in
    # the end-of-sync block.
    auth = src.index("authenticate()")
    first_persist = src.index("credentials_encrypted = :creds")
    sync_call = src.index("provider.sync_messages")
    assert auth < first_persist < sync_call, (
        "rotated creds must be persisted right after auth, before the sync body")


def test_history_cursor_is_coalesced_not_overwritten() -> None:
    src = _src()
    # Outlook's new_history_id is None; a bare assignment would NULL the cursor.
    assert "last_history_id = COALESCE(" in src
    assert "last_history_id = :history_id," not in src
