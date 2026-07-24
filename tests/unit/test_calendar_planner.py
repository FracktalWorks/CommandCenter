"""Unit tests for the calendar day-planner geometry — the deterministic core
that packs blocks without overlaps and honours the user's day window.

These lock in the invariants the "LLM judges, Python does geometry" design
depends on, plus the correctness fixes from the calendar review:
  * _free_intervals never returns free time in the past (incl. the on-mark,
    mid-minute case) and never overlaps a busy block;
  * _place_one packs earliest-fit, splits the free interval it uses (so a
    second placement can't overlap the first), honours a buffer, and prefers a
    matching-energy window;
  * _day_window respects a stored 0 (midnight day-start, zero capacity) instead
    of clobbering it with the default.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from gateway.routes.tasks.calendar import (
    _day_window,
    _free_intervals,
    _place_one,
)


def _dt(h, m=0, s=0):
    return datetime(2026, 7, 23, h, m, s, tzinfo=UTC)


# ── _free_intervals ──────────────────────────────────────────────────────────

def test_free_intervals_empty_day_is_one_span():
    win_s, win_e = _dt(9), _dt(17)
    out = _free_intervals(win_s, win_e, [], now=_dt(6))  # now before window
    assert out == [[win_s, win_e]]


def test_free_intervals_splits_around_busy_and_never_overlaps():
    win_s, win_e = _dt(9), _dt(17)
    busy = [(_dt(11), _dt(12)), (_dt(14), _dt(15, 30))]
    out = _free_intervals(win_s, win_e, busy, now=_dt(6))
    assert out == [[_dt(9), _dt(11)], [_dt(12), _dt(14)], [_dt(15, 30), _dt(17)]]
    # No free interval intersects any busy block.
    for fs, fe in out:
        for bs, be in busy:
            assert fe <= bs or fs >= be


def test_free_intervals_start_ceils_to_next_quarter():
    win_s, win_e = _dt(9), _dt(17)
    out = _free_intervals(win_s, win_e, [], now=_dt(10, 7))
    assert out[0][0] == _dt(10, 15)


def test_free_intervals_on_mark_but_midminute_is_not_in_the_past():
    # The C2 fix: 10:00:30 sits on a 15-min mark but mid-minute — it must ceil
    # to 10:15, never fall back to 10:00 (which is before `now`).
    now = _dt(10, 0, 30)
    out = _free_intervals(_dt(9), _dt(17), [], now=now)
    assert out[0][0] == _dt(10, 15)
    assert out[0][0] >= now.replace(second=0, microsecond=0)


def test_free_intervals_full_day_returns_empty():
    out = _free_intervals(_dt(9), _dt(17), [(_dt(9), _dt(17))], now=_dt(6))
    assert out == []


# ── _place_one ───────────────────────────────────────────────────────────────

def test_place_one_takes_earliest_fit():
    free = [[_dt(9), _dt(17)]]
    got = _place_one(free, 60, None, [], 0)
    assert got == (_dt(9), _dt(10))


def test_place_one_mutates_free_so_next_block_cannot_overlap():
    free = [[_dt(9), _dt(17)]]
    a = _place_one(free, 60, None, [], 0)
    b = _place_one(free, 60, None, [], 0)
    assert a == (_dt(9), _dt(10))
    assert b == (_dt(10), _dt(11))          # packed right after A
    assert a[1] <= b[0]                       # no overlap


def test_place_one_honours_buffer_between_blocks():
    free = [[_dt(9), _dt(17)]]
    _place_one(free, 60, None, [], buffer_mins=15)
    b = _place_one(free, 60, None, [], buffer_mins=15)
    assert b == (_dt(10, 15), _dt(11, 15))    # 15-min gap after the first block


def test_place_one_returns_none_when_nothing_fits():
    free = [[_dt(9), _dt(9, 20)]]              # only 20 min free
    assert _place_one(free, 60, None, [], 0) is None


def test_place_one_prefers_matching_energy_window_even_if_later():
    free = [[_dt(9), _dt(17)]]
    windows = [(_dt(13), _dt(15), "deep")]
    got = _place_one(free, 60, "deep", windows, 0)
    assert got == (_dt(13), _dt(14))          # jumped to the matching window


# ── _day_window (C1: a stored 0 must survive) ────────────────────────────────

def test_day_window_respects_midnight_start_and_zero_capacity():
    row = SimpleNamespace(
        timezone="UTC", day_start_hour=0, day_end_hour=6,
        daily_capacity_mins=0, buffer_mins=0, energy_windows=None)
    win_s, win_e, _ews, capacity, buffer = _day_window(
        row, datetime(2026, 7, 23).date(), ZoneInfo("UTC"))
    assert win_s.hour == 0        # not silently bumped to 7
    assert win_e.hour == 6
    assert capacity == 0          # not silently bumped to 360
    assert buffer == 0


def test_day_window_falls_back_when_prefs_missing():
    row = SimpleNamespace(
        timezone="UTC", day_start_hour=None, day_end_hour=None,
        daily_capacity_mins=None, buffer_mins=None, energy_windows=None)
    win_s, win_e, _ews, capacity, _buf = _day_window(
        row, datetime(2026, 7, 23).date(), ZoneInfo("UTC"))
    assert win_s.hour == 7 and win_e.hour == 22 and capacity == 360
