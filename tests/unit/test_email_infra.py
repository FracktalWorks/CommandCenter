"""Regression tests for email backend infrastructure fixes (code-review pass)."""
from __future__ import annotations

from gateway.routes import email as m


def test_session_factory_is_cached_single_engine() -> None:
    # The engine (and its connection pool) must be created once and reused —
    # a fresh engine per _get_db() call leaks connections.
    f1 = m.core._get_session_factory()
    f2 = m.core._get_session_factory()
    assert f1 is f2
    assert m.core._ENGINE is not None
