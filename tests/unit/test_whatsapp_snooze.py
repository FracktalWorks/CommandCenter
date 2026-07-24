"""Unit tests for WhatsApp chat snooze (W6) — the pure wake-time validator +
route registration. The SQL overlay (queue filter, wake-on-new-inbound) is
exercised against real Postgres in the migration smoke test."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from gateway.routes.whatsapp.transport.snooze import parse_snooze_until

_NOW = datetime(2026, 7, 24, 12, 0, tzinfo=UTC)


def test_accepts_future_iso_with_z() -> None:
    out = parse_snooze_until("2026-07-24T15:00:00Z", _NOW)
    assert out == datetime(2026, 7, 24, 15, 0, tzinfo=UTC)


def test_accepts_offset_and_normalizes_to_utc() -> None:
    # 21:00 IST (+05:30) == 15:30 UTC, still after _NOW.
    out = parse_snooze_until("2026-07-24T21:00:00+05:30", _NOW)
    assert out == datetime(2026, 7, 24, 15, 30, tzinfo=UTC)


def test_naive_timestamp_is_assumed_utc() -> None:
    out = parse_snooze_until("2026-07-24T18:00:00", _NOW)
    assert out.tzinfo is not None
    assert out == datetime(2026, 7, 24, 18, 0, tzinfo=UTC)


@pytest.mark.parametrize("bad", ["", "   ", None, "not-a-date", "2026-13-40T99:99"])
def test_rejects_missing_or_unparseable(bad) -> None:
    with pytest.raises(ValueError):
        parse_snooze_until(bad, _NOW)


def test_rejects_past_time() -> None:
    with pytest.raises(ValueError, match="future"):
        parse_snooze_until("2026-07-24T11:59:00Z", _NOW)


def test_rejects_time_at_now() -> None:
    with pytest.raises(ValueError, match="future"):
        parse_snooze_until(_NOW.isoformat(), _NOW)


def test_rejects_absurdly_far_future() -> None:
    far = (_NOW + timedelta(days=500)).isoformat()
    with pytest.raises(ValueError, match="too far"):
        parse_snooze_until(far, _NOW)


def test_snooze_routes_registered() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    assert "/whatsapp/chats/{chat_id}/snooze" in paths
    assert "/whatsapp/chats/{chat_id}/unsnooze" in paths
