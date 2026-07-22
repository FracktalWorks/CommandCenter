"""classify_matches is the ONE place match -> conversation-resolve happens.

The #110 invariant (a conversation has one classification, re-evaluated per
message) was enforced at only some call sites, so run-message / the backfill
could splinter a conversation. It now lives in engine.classify_matches, which
every processing path calls. These pin its contract: it matches (single/multi),
resolves unless told not to, and propagates a classifier outage.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from gateway.routes.email.automation import engine as e

_EMAIL = {"from": "x@y.com", "subject": "Hi", "body": "hi", "to": ""}
_ROW = object()


def _patch(single=None, multi=None, single_exc=None):
    async def fake_single(*a, **k):
        if single_exc:
            raise single_exc
        return single
    async def fake_multi(*a, **k):
        return multi if multi is not None else []
    return (patch.object(e, "_match_email_to_rule", fake_single),
            patch.object(e, "_match_email_to_rules_multi", fake_multi))


async def test_resolve_off_returns_raw_matches_and_never_resolves() -> None:
    # Dry-run/preview policy: match only, no thread-status model call.
    m = {"rule": {"id": "r1"}, "reason": "x"}
    s, mu = _patch(single=m)
    resolver = AsyncMock()
    with s, mu, patch(
        "gateway.routes.email.automation.replyzero."
        "resolve_conversation_status_matches", resolver,
    ):
        out = await e.classify_matches(
            AsyncMock(), "acc", _ROW, _EMAIL, resolve=False)
    assert out == [m]
    resolver.assert_not_awaited()  # resolve was NOT called


async def test_resolve_on_runs_the_conversation_resolver() -> None:
    m = {"rule": {"id": "r1"}, "reason": "x"}
    resolved = [{"rule": {"id": "r2"}, "reason": "thread"}]
    s, mu = _patch(single=m)
    resolver = AsyncMock(return_value=resolved)
    with s, mu, patch(
        "gateway.routes.email.automation.replyzero."
        "resolve_conversation_status_matches", resolver,
    ):
        out = await e.classify_matches(
            AsyncMock(), "acc", _ROW, _EMAIL, resolve=True)
    assert out == resolved
    resolver.assert_awaited_once()


async def test_multi_rule_uses_the_multi_matcher() -> None:
    multi = [{"rule": {"id": "a"}}, {"rule": {"id": "b"}}]
    s, mu = _patch(multi=multi)
    with s, mu, patch(
        "gateway.routes.email.automation.replyzero."
        "resolve_conversation_status_matches",
        AsyncMock(side_effect=lambda *a, **k: a[3]),  # echo the matches
    ):
        out = await e.classify_matches(
            AsyncMock(), "acc", _ROW, _EMAIL, multi_rule=True, resolve=True)
    assert out == multi


async def test_classifier_outage_propagates() -> None:
    # LLMUnavailable from the match must reach the caller (so it skips the
    # watermark) — not be swallowed into a false no-match.
    s, mu = _patch(single_exc=e.LLMUnavailable("gateway down"))
    with s, mu:
        with pytest.raises(e.LLMUnavailable):
            await e.classify_matches(AsyncMock(), "acc", _ROW, _EMAIL)


async def test_no_match_resolves_to_empty_not_none() -> None:
    s, mu = _patch(single=None)
    with s, mu, patch(
        "gateway.routes.email.automation.replyzero."
        "resolve_conversation_status_matches",
        AsyncMock(return_value=None),  # resolver may return None
    ):
        out = await e.classify_matches(AsyncMock(), "acc", _ROW, _EMAIL)
    assert out == []  # normalised to a list for the callers
