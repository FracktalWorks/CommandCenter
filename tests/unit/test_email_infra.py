"""Regression tests for email backend infrastructure fixes (code-review pass)."""
from __future__ import annotations

from acb_common import db as shared_db
from gateway.routes import email as m


def test_session_factory_is_cached_single_engine() -> None:
    # The engine (and its connection pool) must be created once and reused —
    # a fresh engine per _get_db() call leaks connections.
    f1 = m.core._get_session_factory()
    f2 = m.core._get_session_factory()
    assert f1 is f2
    assert shared_db._ENGINE is not None


def test_email_uses_the_shared_engine() -> None:
    # BO-10: this package must not own an engine. It reads the shared seam, so
    # the caching assertion above is a statement about the ONE process pool.
    assert m.core._get_session_factory is shared_db.get_session_factory
    assert not hasattr(m.core, "_ENGINE")
