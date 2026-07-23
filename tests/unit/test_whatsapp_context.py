"""Unit tests for the WhatsApp chat-context resolver (entity-ref parser + wiring)."""

from __future__ import annotations


def test_parses_known_system_entity_ref() -> None:
    from gateway.routes.whatsapp.transport.context import parse_entity_ref
    ref = parse_entity_ref("zoho:contact:4471")
    assert ref is not None
    assert ref.system == "zoho"
    assert ref.kind == "contact"
    assert ref.id == "4471"


def test_case_insensitive_system() -> None:
    from gateway.routes.whatsapp.transport.context import parse_entity_ref
    ref = parse_entity_ref("ODOO:partner:88")
    assert ref is not None and ref.system == "odoo"


def test_unknown_system_is_treated_as_unlinked() -> None:
    from gateway.routes.whatsapp.transport.context import parse_entity_ref
    assert parse_entity_ref("salesforce:contact:1") is None


def test_malformed_or_empty_ref_is_none() -> None:
    from gateway.routes.whatsapp.transport.context import parse_entity_ref
    assert parse_entity_ref(None) is None
    assert parse_entity_ref("") is None
    assert parse_entity_ref("zoho:contact") is None      # missing id
    assert parse_entity_ref("zoho::4471") is None         # empty kind


def test_context_route_registered() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    assert "/whatsapp/chats/{chat_id}/context" in paths
