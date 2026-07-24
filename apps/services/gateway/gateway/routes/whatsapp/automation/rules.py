"""Automation · standing rules — the auto-reply decision engine.

Given a message's intent and the policy of the category its chat belongs to,
decide what the system should do: answer from a system source (order status),
send a canned holding reply (office hours / new-customer greeting), prepare an AI
draft for the founder, or nothing. This is the autonomy ladder made executable —
and it enforces the hard guardrails the spec pins:

* NEVER auto-send to a guardrailed category (VIP, Family & personal) — the most
  the system may do there is prepare a draft the founder sends.
* read-only answers (order status from Odoo) may run unattended;
* anything that commits money / dates / reputation stays a draft.

``decide_action`` is a pure function so the whole ladder is unit-testable without
a database or an LLM. The preview endpoint runs it over recent needs-reply chats
so the founder can SEE what automation would do before enabling any of it — the
Rules screen's "honest stats" ethos.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends
from gateway.routes.whatsapp.core import _get_db, router
from pydantic import BaseModel
from sqlalchemy import text

# Categories the founder's reputation rides on — never auto-send, only draft.
GUARDRAIL_NO_AUTOSEND = frozenset({"VIP", "Family & personal"})

# Intents that carry a business ask worth a draft when the policy is 'on_intent'.
_BUSINESS_INTENTS = frozenset({
    "payment", "order_status", "quote_request", "service_issue", "scheduling",
})
# Intents that are noise — never trigger any automated reply or draft.
_MUTE_INTENTS = frozenset({"social", "spam"})

# Actions on the ladder, least → most autonomous the system is willing to take.
NONE = "none"
DRAFT = "draft"
HOLDING_REPLY = "holding_reply"
ANSWER_FROM_SYSTEM = "answer_from_system"


@dataclass
class AutoAction:
    action: str                 # one of the constants above
    reason: str
    requires_approval: bool     # True → stage a draft/HITL; False → may run alone
    via_template: bool = False  # True → outside the 24h window, needs a template
    system_source: str | None = None  # e.g. 'odoo_order_status' for the answer


def decide_action(
    *,
    intent: str | None,
    category_name: str | None,
    auto_reply_policy: str,
    draft_policy: str,
    window_open: bool,
    within_office_hours: bool,
) -> AutoAction:
    """Decide the automated action for one inbound message. Pure.

    The order matters: guardrails first (a VIP is a VIP whatever the intent),
    then mute, then the auto-reply ladder, then the draft ladder, then nothing.
    """
    guardrailed = (category_name or "") in GUARDRAIL_NO_AUTOSEND

    # 1. Guardrail: reputation-bearing categories never auto-send. The ceiling is
    #    a draft, and only when the category asks for one.
    if guardrailed:
        if draft_policy in ("always", "on_intent"):
            return AutoAction(
                DRAFT, f"{category_name}: draft only, never auto-send",
                requires_approval=True)
        return AutoAction(NONE, f"{category_name}: AI hands off",
                          requires_approval=False)

    # 2. Mute: social/spam get nothing, whatever the policy.
    if intent in _MUTE_INTENTS:
        return AutoAction(NONE, f"{intent} is noise", requires_approval=False)

    # 3. Auto-reply ladder.
    if auto_reply_policy == "answer_from_system" and intent in (
        "order_status", "payment",
    ):
        # A read-only answer (live Odoo status / ledger) may run unattended.
        src = "odoo_order_status" if intent == "order_status" else "odoo_ledger"
        return AutoAction(
            ANSWER_FROM_SYSTEM, f"read-only answer for {intent}",
            requires_approval=False, via_template=not window_open,
            system_source=src)

    if auto_reply_policy == "holding":
        # Outside office hours, or a fresh business ask, gets a canned holding
        # reply — safe, content-free, so it may run unattended.
        if not within_office_hours:
            return AutoAction(
                HOLDING_REPLY, "outside office hours",
                requires_approval=False, via_template=not window_open)
        if intent in ("quote_request", "order_status", "payment", "service_issue"):
            return AutoAction(
                HOLDING_REPLY, f"holding reply for {intent}",
                requires_approval=False, via_template=not window_open)

    # 4. Draft ladder — anything committing money/dates/reputation stays a draft.
    if draft_policy == "always":
        return AutoAction(DRAFT, "category drafts always",
                          requires_approval=True)
    if draft_policy == "on_intent" and intent in _BUSINESS_INTENTS:
        return AutoAction(DRAFT, f"draft on {intent}", requires_approval=True)

    # 5. Nothing to do.
    return AutoAction(NONE, "no rule matched", requires_approval=False)


# ── read-only preview endpoint ────────────────────────────────────────────────

class PreviewItem(BaseModel):
    chat_id: str
    name: str
    intent: str | None = None
    category: str | None = None
    action: str
    reason: str
    requires_approval: bool
    via_template: bool = False


class RulePreviewModel(BaseModel):
    items: list[PreviewItem] = []
    # Counts by action, so the Rules screen can say "12 would auto-answer, 4 drafts".
    summary: dict[str, int] = {}


@router.get("/rules/preview", response_model=RulePreviewModel)
async def rules_preview(
    account_id: str,
    within_office_hours: bool = True,
    limit: int = 25,
    user: UserContext = Depends(get_current_user),
):
    """Dry-run the auto-reply engine over recent needs-reply chats — what WOULD
    happen, no sends. Lets the founder see the automation before enabling it."""
    db = await _get_db()
    try:
        params: dict[str, Any] = {
            "uid": user.email or "anonymous", "aid": account_id, "lim": limit,
        }
        rows = (await db.execute(
            text("""SELECT c.id, c.name, c.wa_chat_id, c.category,
                           c.service_window_expires_at,
                           lm.intent AS intent,
                           cat.auto_reply_policy, cat.draft_policy
                    FROM wa_chat_status s
                    JOIN wa_chats c ON c.id = s.chat_id
                    JOIN wa_accounts a ON a.id = c.account_id
                    LEFT JOIN wa_categories cat
                      ON cat.account_id = c.account_id AND cat.name = c.category
                    LEFT JOIN LATERAL (
                        SELECT intent FROM wa_messages m
                        WHERE m.chat_id = c.id AND m.direction = 'in'
                        ORDER BY m.sent_at DESC NULLS LAST LIMIT 1
                    ) lm ON TRUE
                    WHERE s.status = 'NEEDS_REPLY' AND a.user_id = :uid
                      AND c.account_id = :aid
                    ORDER BY s.last_message_at DESC NULLS LAST
                    LIMIT :lim"""),
            params,
        )).fetchall()

        items: list[PreviewItem] = []
        summary: dict[str, int] = {}
        for r in rows:
            window_open = bool(
                r.service_window_expires_at
                and r.service_window_expires_at.timestamp() > 0
            )
            decision = decide_action(
                intent=r.intent,
                category_name=r.category,
                auto_reply_policy=r.auto_reply_policy or "never",
                draft_policy=r.draft_policy or "on_intent",
                window_open=window_open,
                within_office_hours=within_office_hours,
            )
            items.append(PreviewItem(
                chat_id=str(r.id), name=r.name or r.wa_chat_id,
                intent=r.intent, category=r.category,
                action=decision.action, reason=decision.reason,
                requires_approval=decision.requires_approval,
                via_template=decision.via_template,
            ))
            summary[decision.action] = summary.get(decision.action, 0) + 1

        return RulePreviewModel(items=items, summary=summary)
    finally:
        await db.close()
