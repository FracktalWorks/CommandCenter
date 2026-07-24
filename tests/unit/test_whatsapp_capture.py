"""Unit tests for WhatsApp → GTD task capture (title derivation + wiring)."""

from __future__ import annotations


def test_title_from_body_is_bounded_and_attributed() -> None:
    from gateway.routes.whatsapp.transport.capture import derive_title
    t = derive_title("Please confirm the Falcon build volume", "Rajesh", "Meher")
    assert t.startswith("WhatsApp · Rajesh:")
    assert "Falcon build volume" in t


def test_long_body_is_truncated_with_ellipsis() -> None:
    from gateway.routes.whatsapp.transport.capture import derive_title
    t = derive_title("x" * 200, "Rajesh", "Meher")
    assert t.endswith("…")
    assert len(t) <= 200


def test_empty_body_falls_back_to_reply_title() -> None:
    from gateway.routes.whatsapp.transport.capture import derive_title
    assert derive_title("", "", "Dealer South") == "WhatsApp · reply to Dealer South"
    assert derive_title("  ", "", "") == "WhatsApp · reply to someone"


def test_whitespace_is_collapsed() -> None:
    from gateway.routes.whatsapp.transport.capture import derive_title
    t = derive_title("line one\n\n   line two", "Sam", "")
    assert "line one line two" in t


def test_capture_route_registered() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    assert "/whatsapp/capture-task" in paths
