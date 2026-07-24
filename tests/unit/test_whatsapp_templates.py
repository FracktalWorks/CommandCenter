"""Unit tests for the WhatsApp template library helpers + route wiring."""

from __future__ import annotations

import pytest
from fastapi import HTTPException


def test_default_templates_cover_the_standing_rules() -> None:
    from gateway.routes.whatsapp.transport.templates import default_templates
    names = {t["name"] for t in default_templates()}
    # The rules the plan names (payment chase, follow-up nudge) must have a home.
    assert "payment_reminder" in names
    assert "follow_up_nudge" in names
    for t in default_templates():
        # Every placeholder in the body must be described in variables, so the
        # picker can prompt for each — {{1}}..{{N}} ↔ N variables.
        placeholders = t["body"].count("{{")
        assert placeholders == len(t["variables"]), t["name"]


def test_validate_rejects_bad_status_category_and_empty_name() -> None:
    from gateway.routes.whatsapp.transport.templates import (
        CreateTemplateRequest,
        _validate,
    )
    with pytest.raises(HTTPException):
        _validate(CreateTemplateRequest(name=""))
    with pytest.raises(HTTPException):
        _validate(CreateTemplateRequest(name="x", meta_status="maybe"))
    with pytest.raises(HTTPException):
        _validate(CreateTemplateRequest(name="x", category="SPAM"))
    # A valid one does not raise.
    _validate(CreateTemplateRequest(name="ok", meta_status="approved",
                                    category="UTILITY"))


def test_template_routes_registered() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    for expected in (
        "/whatsapp/templates",
        "/whatsapp/accounts/{account_id}/templates",
        "/whatsapp/accounts/{account_id}/templates/bootstrap",
    ):
        assert expected in paths, f"missing {expected}"
