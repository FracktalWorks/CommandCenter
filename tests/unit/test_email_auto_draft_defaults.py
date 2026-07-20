"""Auto-drafting is opt-in everywhere, including at the column level.

Every draft is a call on the drafting model (tier-powerful), written before
anyone has decided the email is worth answering. Three separate switches control
it, and all three must start OFF or the user discovers the spend after the fact:

  * ``RuleProcessPastRequest.draft_replies`` — the backfill (pinned by
    test_email_process_past_drafting.py)
  * ``email_assistant_settings.draft_replies`` — adds DRAFT_EMAIL to the Reply
    rule, so LIVE rule runs draft
  * ``email_assistant_settings.follow_up_auto_draft`` — drafts a nudge on
    awaiting threads

The API defaults were already only half the story: the DB columns were created
``NOT NULL DEFAULT true``, and the column default is what an INSERT that omits
them actually gets. ``derive_writing_style`` does exactly that — it inserts
``(account_id, writing_style)`` only — so an account could acquire auto-drafting
from a background writing-style capture, having never opened AI Settings.
"""
from __future__ import annotations

import re
from pathlib import Path

from gateway.routes.email.automation.assistant import AssistantSettingsModel

REPO = Path(__file__).resolve().parents[2]
_MIGRATION = REPO / "infra/postgres/81_auto_draft_defaults_off.sql"
_ASSISTANT = (
    REPO / "apps/services/gateway/gateway/routes/email/automation/assistant.py"
).read_text(encoding="utf-8")


# ── the API model ───────────────────────────────────────────────────────────


def test_live_reply_drafting_is_off_by_default() -> None:
    s = AssistantSettingsModel(account_id="acc-1")
    assert s.draft_replies is False


def test_follow_up_auto_draft_is_off_by_default() -> None:
    """Sharper edge than the others: the follow-up scan was dead from the day it
    shipped until #84, so the first working run on a long-configured account
    releases the whole window at once. On by default, that arrives as drafts."""
    s = AssistantSettingsModel(account_id="acc-1")
    assert s.follow_up_auto_draft is False


# ── the GET fallback ────────────────────────────────────────────────────────
# This is the default that a user actually SEES — for any account with no
# settings row, the toggle renders from this value. It disagreeing with the
# model would show the switch ON while nothing had ever enabled it.


def _get_fallback(field: str) -> str:
    """The literal the /assistant/settings GET falls back to for `field`."""
    m = re.search(
        rf'"{field}": \(\s*(?:bool\(.*?\)\s*)?if .*?else (True|False)\s*\)',
        _ASSISTANT, re.DOTALL,
    )
    assert m, f"could not find the GET fallback for {field}"
    return m.group(1)


def test_the_get_fallback_matches_the_model() -> None:
    for field in ("draft_replies", "follow_up_auto_draft"):
        assert _get_fallback(field) == "False", (
            f"/assistant/settings returns {field}=True for an account with no "
            "settings row — the UI would show auto-drafting on"
        )


# ── the column default ──────────────────────────────────────────────────────


def test_the_column_defaults_are_flipped_off() -> None:
    """The real default. Migrations 26 and 29 created both columns
    ``NOT NULL DEFAULT true``, which beats any API-side default on an INSERT
    that omits the column."""
    sql = _MIGRATION.read_text(encoding="utf-8")
    for col in ("draft_replies", "follow_up_auto_draft"):
        assert re.search(
            rf"ALTER COLUMN {col} SET DEFAULT false", sql
        ), f"migration 81 no longer defaults {col} off"


def test_the_migration_does_not_rewrite_existing_settings() -> None:
    """A stored value may be a deliberate choice. Changing what new accounts
    inherit is the fix; silently flipping a toggle a user set is not."""
    # Comments are stripped first so the word "UPDATE" in the rationale can't
    # trip the check — a guard that fails on its own explanation just gets the
    # explanation deleted.
    body = "\n".join(
        ln for ln in _MIGRATION.read_text(encoding="utf-8").splitlines()
        if not ln.lstrip().startswith("--")
    )
    assert "UPDATE" not in body.upper(), (
        "migration 81 rewrites existing rows — it must only change the DEFAULT"
    )


def test_the_partial_insert_that_made_this_matter_still_exists() -> None:
    """``derive_writing_style`` inserts only (account_id, writing_style), so it
    creates a settings row from column defaults. If this ever stops being true
    the migration is still correct — but the comment explaining WHY would be
    stale, so fail and make someone re-read it."""
    assert "(account_id, writing_style, updated_at)" in _ASSISTANT, (
        "the partial settings INSERT changed shape — re-check which paths can "
        "create a settings row from column defaults"
    )
