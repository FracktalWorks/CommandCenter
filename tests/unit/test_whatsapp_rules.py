"""Unit tests for the WhatsApp auto-reply decision engine (the autonomy ladder)."""

from __future__ import annotations

from gateway.routes.whatsapp.automation.rules import (
    ANSWER_FROM_SYSTEM,
    DRAFT,
    HOLDING_REPLY,
    NONE,
    decide_action,
)


def _decide(**kw):
    base = dict(
        intent="payment", category_name="Pending payment",
        auto_reply_policy="never", draft_policy="always",
        window_open=True, within_office_hours=True,
    )
    base.update(kw)
    return decide_action(**base)


# ── guardrails ────────────────────────────────────────────────────────────────

def test_vip_never_auto_sends_only_drafts() -> None:
    d = _decide(category_name="VIP", auto_reply_policy="answer_from_system",
                draft_policy="always", intent="order_status")
    assert d.action == DRAFT           # not answer_from_system, despite the policy
    assert d.requires_approval is True


def test_family_hands_off_entirely() -> None:
    d = _decide(category_name="Family & personal", draft_policy="never",
                intent="scheduling")
    assert d.action == NONE
    assert "hands off" in d.reason


def test_family_with_draft_policy_still_never_auto_sends() -> None:
    # Even if someone set Family draft_policy to 'always', it may only draft.
    d = _decide(category_name="Family & personal", draft_policy="always",
                intent="payment")
    assert d.action == DRAFT
    assert d.requires_approval is True


# ── mute ──────────────────────────────────────────────────────────────────────

def test_social_and_spam_are_muted() -> None:
    assert _decide(category_name="New customer", intent="social").action == NONE
    assert _decide(category_name="New customer", intent="spam").action == NONE


# ── answer-from-system (read-only, may run alone) ─────────────────────────────

def test_order_status_answers_from_system_unattended() -> None:
    d = _decide(category_name="New customer",
                auto_reply_policy="answer_from_system", intent="order_status")
    assert d.action == ANSWER_FROM_SYSTEM
    assert d.requires_approval is False
    assert d.system_source == "odoo_order_status"


def test_answer_outside_window_needs_a_template() -> None:
    d = _decide(category_name="New customer",
                auto_reply_policy="answer_from_system", intent="order_status",
                window_open=False)
    assert d.action == ANSWER_FROM_SYSTEM
    assert d.via_template is True


# ── holding replies ───────────────────────────────────────────────────────────

def test_outside_office_hours_sends_holding_reply() -> None:
    d = _decide(category_name="New customer", auto_reply_policy="holding",
                intent=None, within_office_hours=False)
    assert d.action == HOLDING_REPLY
    assert d.requires_approval is False


def test_new_customer_quote_gets_holding_reply_in_hours() -> None:
    d = _decide(category_name="New customer", auto_reply_policy="holding",
                intent="quote_request", within_office_hours=True)
    assert d.action == HOLDING_REPLY


# ── draft ladder ──────────────────────────────────────────────────────────────

def test_always_draft_category_prepares_a_draft() -> None:
    d = _decide(category_name="Pending payment", auto_reply_policy="never",
                draft_policy="always", intent="payment")
    assert d.action == DRAFT
    assert d.requires_approval is True


def test_on_intent_drafts_only_for_business_intents() -> None:
    biz = _decide(category_name="Customers", auto_reply_policy="never",
                  draft_policy="on_intent", intent="service_issue")
    assert biz.action == DRAFT
    non = _decide(category_name="Customers", auto_reply_policy="never",
                  draft_policy="on_intent", intent=None)
    assert non.action == NONE


def test_never_draft_never_auto_reply_does_nothing() -> None:
    d = _decide(category_name="Customers", auto_reply_policy="never",
                draft_policy="never", intent="payment")
    assert d.action == NONE


def test_preview_route_registered() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    assert "/whatsapp/rules/preview" in paths
