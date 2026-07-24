"""Unit tests for WhatsApp Pulse — the pure aggregation helpers + route wiring.
The SQL projection is exercised against real Postgres in the migration smoke."""

from __future__ import annotations

from gateway.routes.whatsapp.pulse import (
    median,
    percentile,
    summarize_response_times,
)


def test_median_odd_and_even() -> None:
    assert median([5, 1, 3]) == 3            # sorted → [1,3,5]
    assert median([1, 2, 3, 4]) == 2.5       # mean of the two middles
    assert median([7]) == 7


def test_median_empty_is_none() -> None:
    assert median([]) is None
    assert median([None, None]) is None      # type: ignore[list-item]


def test_percentile_bounds_and_middle() -> None:
    data = list(range(1, 101))               # 1..100
    assert percentile(data, 0) == 1
    assert percentile(data, 100) == 100
    assert percentile(data, 50) in (50, 51)  # nearest-rank near the middle
    assert percentile(data, 90) in (90, 91)


def test_percentile_empty_is_none() -> None:
    assert percentile([], 90) is None


def test_summarize_response_times_folds() -> None:
    out = summarize_response_times([10.0, 20.0, 30.0, 40.0, 1000.0])
    assert out["replied"] == 5
    assert out["median_minutes"] == 30.0     # robust to the 1000 outlier
    assert out["p90_minutes"] == 1000.0      # tail visible in p90


def test_summarize_response_times_drops_negatives_and_none() -> None:
    out = summarize_response_times([-5.0, None, 10.0, 20.0])  # type: ignore[list-item]
    assert out["replied"] == 2               # only the two valid samples
    assert out["median_minutes"] == 15.0


def test_summarize_empty_is_zero_replied_none_stats() -> None:
    out = summarize_response_times([])
    assert out["replied"] == 0
    assert out["median_minutes"] is None
    assert out["p90_minutes"] is None


def test_pulse_route_registered() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    assert "/whatsapp/pulse" in paths
