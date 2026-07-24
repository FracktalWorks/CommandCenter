"""Unit tests for WhatsApp categories-as-policy (default set + validation + wiring)."""

from __future__ import annotations

import pytest
from fastapi import HTTPException


def test_default_categories_shape_and_trust_line() -> None:
    from gateway.routes.whatsapp.automation.categories import default_categories
    cats = {c["name"]: c for c in default_categories()}
    # The categories the queue + spec name all exist.
    for name in ("VIP", "Pending payment", "Dealer groups",
                 "Family & personal", "Noise"):
        assert name in cats
    # The trust line: AI hands off Family by default (draft_policy 'never').
    assert cats["Family & personal"]["draft_policy"] == "never"
    assert cats["Family & personal"]["auto_reply_policy"] == "never"
    # Noise never notifies.
    assert cats["Noise"]["notify_policy"] == "never"
    # VIP is instant + always-drafted + escalates.
    assert cats["VIP"]["notify_policy"] == "instant"
    assert cats["VIP"]["draft_policy"] == "always"
    assert cats["VIP"]["escalate_after_mins"] == 120


def test_every_default_policy_value_is_valid() -> None:
    from gateway.routes.whatsapp.automation.categories import (
        _AUTO_REPLY,
        _DRAFT,
        _NOTIFY,
        default_categories,
    )
    for c in default_categories():
        assert c["notify_policy"] in _NOTIFY
        assert c["auto_reply_policy"] in _AUTO_REPLY
        assert c["draft_policy"] in _DRAFT


def test_validate_rejects_bad_policy_values() -> None:
    from gateway.routes.whatsapp.automation.categories import _validate_policies
    with pytest.raises(HTTPException):
        _validate_policies("loud", None, None)
    with pytest.raises(HTTPException):
        _validate_policies(None, "sometimes", None)
    with pytest.raises(HTTPException):
        _validate_policies(None, None, "maybe")
    # All-None (a no-op patch) and valid values pass.
    _validate_policies(None, None, None)
    _validate_policies("instant", "answer_from_system", "always")


def test_category_routes_registered() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    for expected in (
        "/whatsapp/categories",
        "/whatsapp/accounts/{account_id}/categories/bootstrap",
        "/whatsapp/categories/{category_id}",
    ):
        assert expected in paths, f"missing {expected}"
