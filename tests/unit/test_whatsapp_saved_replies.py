"""Unit tests for WhatsApp saved replies (W8) — the pure shortcut normalizer +
route registration. CRUD SQL is exercised against real Postgres in the smoke."""

from __future__ import annotations

import pytest
from gateway.routes.whatsapp.transport.saved_replies import normalize_shortcut


@pytest.mark.parametrize("raw,expected", [
    ("/price", "/price"),
    ("price", "/price"),                 # leading slash added
    ("  Price List  ", "/pricelist"),    # trimmed, lowercased, punctuation dropped
    ("/GST-No.", "/gstno"),              # non [a-z0-9_] stripped
    ("addr_1", "/addr_1"),               # underscore + digits kept
    ("//weird", "/weird"),               # only one leading slash
])
def test_normalizes_shortcuts(raw, expected) -> None:
    assert normalize_shortcut(raw) == expected


@pytest.mark.parametrize("raw", [None, "", "   ", "/", "///", "!!!", "  -- "])
def test_empty_or_punctuation_only_is_none(raw) -> None:
    assert normalize_shortcut(raw) is None


def test_shortcut_is_length_bounded() -> None:
    out = normalize_shortcut("/" + "a" * 200)
    assert out is not None
    assert len(out) <= 33                # leading '/' + 32 chars


def test_saved_replies_routes_registered() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    assert "/whatsapp/saved-replies" in paths
    assert "/whatsapp/saved-replies/{reply_id}" in paths
