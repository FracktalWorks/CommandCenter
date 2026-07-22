"""The rule/automation drafting paths must have the same context as the manual
ones (review §2.4). Three drifts these pin, on the source:

  * the rule-action drafter (``_apply_rule_actions``) built its own reply-context
    dict that carried neither ``sender_scope`` nor the To/Cc lines, so the
    direction note + greet-by-name were silent on the highest-volume path — it
    must route through the ONE shared ``_build_reply_context`` builder instead;
  * ``compose_assist``'s reply-from-scratch must store the AI draft
    (``_store_ai_draft``) so composer edits teach ``_learn_from_sent`` — the
    manual /draft-reply path already did, "Draft with AI" did not;
  * the follow-up nudge drafter read ``body_text or snippet`` — a header-only
    Outlook row handed it a ~200-char snippet — so it must hydrate first
    (``hydrate_message_body``), the last surviving snippet-bug path.
"""
from __future__ import annotations

import inspect

from gateway.routes.email.automation import drafting, replyzero, runner


def test_rule_action_drafter_uses_the_shared_reply_context_builder() -> None:
    src = inspect.getsource(runner._apply_rule_actions)
    assert "_build_reply_context" in src, (
        "the rule-path drafter must build context via the shared builder so it "
        "gets sender_scope + To/Cc parity, not a hand-assembled subset")


def test_compose_assist_stores_the_ai_draft_for_edit_learning() -> None:
    src = inspect.getsource(drafting.compose_assist)
    assert "_store_ai_draft" in src, (
        "compose-assist reply-from-scratch must remember the draft so edits "
        "before send can teach _learn_from_sent")


def test_follow_up_nudge_hydrates_the_body_before_drafting() -> None:
    src = inspect.getsource(replyzero._maybe_send_follow_up_reminders)
    assert "hydrate_message_body" in src, (
        "the follow-up nudge must hydrate the full body, not draft off a "
        "~200-char Outlook snippet")
