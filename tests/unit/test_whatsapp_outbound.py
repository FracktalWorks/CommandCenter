"""Unit tests for the approval-gated WhatsApp broadcast + broker handler wiring.

The load-bearing safety invariant: a broadcast can NEVER auto-send — it must be
proposed with an authority the Action Broker maps to NEEDS_APPROVAL.
"""

from __future__ import annotations

from action_broker import broker
from action_broker.broker import AuthorityTier, Disposition, decide_disposition


def test_broadcast_authority_is_never_auto_apply() -> None:
    # The invariant the broadcast route relies on: SUGGEST + destructive holds
    # for a human. If this ever became AUTO_APPLY, broadcasts would fire silently.
    assert decide_disposition(AuthorityTier.SUGGEST, destructive=True) == (
        Disposition.NEEDS_APPROVAL)


def test_register_handlers_wires_the_broadcast_handler() -> None:
    from gateway.routes.whatsapp.automation.outbound import (
        WA_BROADCAST,
        register_whatsapp_handlers,
    )
    broker.clear_action_handlers()
    try:
        register_whatsapp_handlers()
        # The handler is registered under the broadcast action name, so an
        # approved proposal has something to execute (not silently refused).
        assert WA_BROADCAST in broker._HANDLERS
    finally:
        broker.clear_action_handlers()


def test_broadcast_route_registered() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    assert "/whatsapp/broadcast" in paths


def test_broadcast_request_shape() -> None:
    # A broadcast needs text and at least one targeting mode; the route enforces
    # it, but the model should accept both explicit chats and a category.
    from gateway.routes.whatsapp.automation.outbound import BroadcastRequest
    r = BroadcastRequest(account_id="a", text="hi", category="Dealer groups")
    assert r.category == "Dealer groups"
    r2 = BroadcastRequest(account_id="a", text="hi", chat_ids=["c1", "c2"])
    assert r2.chat_ids == ["c1", "c2"]
