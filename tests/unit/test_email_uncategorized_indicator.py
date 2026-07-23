""""Uncategorized" is a STATE — the absence of any known label — not a label.

These tests pin the guards that keep the indicator from ever becoming a real
category: the single label writer refuses it (an AI-resolved ``{{...}}`` label
or a hand-authored rule could produce it), ingest canonicalisation drops it if
it ever exists provider-side, and the derived KNOWN_LABELS set actually knows
the current conversation-label names (the "Reply"→"Needs Reply" rename missed
CONVERSATION_LABELS_LOWER, so freshly-labelled "Needs Reply" mail counted as
uncategorized in every facet and filter)."""
from __future__ import annotations

from types import SimpleNamespace


class _SpyDB:
    def __init__(self) -> None:
        self.executed: list = []

    async def execute(self, *args, **kwargs):
        self.executed.append(args)
        return SimpleNamespace(rowcount=1)


class _SpyProvider:
    def __init__(self) -> None:
        self.calls: list = []

    async def set_labels(self, pmid, add, remove):
        self.calls.append((pmid, add, remove))


async def test_apply_label_refuses_uncategorized_indicator() -> None:
    from gateway.routes.email.automation import actions

    db, provider = _SpyDB(), _SpyProvider()
    await actions.apply_label(db, provider, "m1", "pm1", "Uncategorized")
    await actions.apply_label(db, provider, "m1", "pm1", "  uncategorized  ")
    assert provider.calls == []   # never reaches the provider…
    assert db.executed == []      # …and never touches the mirror


async def test_apply_label_still_writes_real_labels() -> None:
    from gateway.routes.email.automation import actions

    db, provider = _SpyDB(), _SpyProvider()
    await actions.apply_label(db, provider, "m1", "pm1", "Newsletter")
    assert provider.calls == [("pm1", ["Newsletter"], [])]
    assert len(db.executed) == 1


def test_ingest_drops_uncategorized_indicator() -> None:
    from email_ingestion.persist import _canon_categories

    assert _canon_categories(["Uncategorized", "Reply"]) == ["Needs Reply"]
    assert _canon_categories(["uncategorized"]) == []


def test_needs_reply_is_a_known_label() -> None:
    # KNOWN_LABELS_LOWER drives UNCATEGORIZED_SQL: a name missing here makes
    # mail carrying ONLY that label read as uncategorized. Current names must
    # be present; legacy names stay until the reconciler has replaced them on
    # the provider side.
    from gateway.routes.email import core

    assert "needs reply" in core.KNOWN_LABELS_LOWER
    assert "reply" in core.KNOWN_LABELS_LOWER        # legacy, still provider-side
    assert "uncategorized" not in core.KNOWN_LABELS_LOWER
