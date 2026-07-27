"""Custom Apps — pinned-in-sidebar + usage-on-cards.

`_to_summary` (gateway/routes/apps/lifecycle.py) gained optional `pinned`/
`usage` params that `list_apps` fills from two aggregate queries (app_pins,
a GROUP BY over app_audit) — batched, not one query per app. These lock the
merge itself: a pure function, no DB needed.
"""
from __future__ import annotations

import types

from acb_auth import UserContext, UserRole
from gateway.routes.apps.lifecycle import _to_summary

OWNER = UserContext(email="owner@fracktal.in", role=UserRole.EMPLOYEE)


def _row(**overrides) -> types.SimpleNamespace:
    base = dict(
        slug="filament-tracker",
        name="Filament Tracker",
        icon="🧵",
        description="Track spools",
        status="draft",
        visibility="private",
        live_version=None,
        owner_email="owner@fracktal.in",
        updated_at=None,
    )
    base.update(overrides)
    return types.SimpleNamespace(**base)


def test_defaults_are_unpinned_and_zero_usage():
    summary = _to_summary(_row(), OWNER, [])
    assert summary.pinned is False
    assert summary.month_cost_usd == 0.0
    assert summary.month_calls == 0


def test_pinned_flag_passes_through():
    summary = _to_summary(_row(), OWNER, [], pinned=True)
    assert summary.pinned is True


def test_usage_tuple_splits_into_cost_and_calls():
    summary = _to_summary(_row(), OWNER, [], usage=(4.5, 12))
    assert summary.month_cost_usd == 4.5
    assert summary.month_calls == 12


def test_usage_none_is_same_as_omitted():
    summary = _to_summary(_row(), OWNER, [], usage=None)
    assert summary.month_cost_usd == 0.0
    assert summary.month_calls == 0
