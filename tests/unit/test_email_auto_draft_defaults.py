"""Auto-drafting defaults are split by the AGE of the thread, not by the act.

    "this should only apply when I am processing past emails ... the regular
     rules apply as is for new mails that come in"          — user, 2026-07-20

A draft on mail that just arrived is the feature — it is waiting when the user
opens the message. A draft on a months-old thread is spend on a conversation
that already ended, and a backfill can produce hundreds in one run. So:

  * ``RuleProcessPastRequest.draft_replies`` — the backfill. **OFF** (opt-in per
    run via the "Also draft replies" checkbox; pinned by
    test_email_process_past_drafting.py)
  * ``email_assistant_settings.draft_replies`` — adds DRAFT_EMAIL to the Reply
    rule, so LIVE rule runs draft. **ON**
  * ``email_assistant_settings.follow_up_auto_draft`` — nudges awaiting threads
    by age, and its scan was dead from the day it shipped until #84, so the
    first working run releases a whole window at once. **OFF**

The API default is only half the story either way: the DB columns were created
``NOT NULL DEFAULT true``, and the column default is what an INSERT that omits
them actually gets. ``derive_writing_style`` does exactly that — it inserts
``(account_id, writing_style)`` only — so a background writing-style capture can
create a settings row for an account that never opened AI Settings. The column
default and the API default must therefore agree, or that account silently gets
whichever one the code path happened to use.
"""
from __future__ import annotations

import re
from pathlib import Path

from gateway.routes.email.automation.assistant import AssistantSettingsModel

REPO = Path(__file__).resolve().parents[2]
_MIGRATIONS = REPO / "infra/postgres"
_ASSISTANT = (
    REPO / "apps/services/gateway/gateway/routes/email/automation/assistant.py"
).read_text(encoding="utf-8")


def _migration(name: str) -> str:
    return (_MIGRATIONS / name).read_text(encoding="utf-8")


def _column_default(col: str) -> str:
    """The default `col` ends up with after every migration is applied, in order.
    Read from the files rather than asserted per-file, so a later migration
    flipping it back cannot leave an earlier assertion passing and wrong."""
    value = "true"  # as created (migrations 26 and 29)
    for path in sorted(_MIGRATIONS.glob("*.sql"),
                       key=lambda p: int(p.name.split("_")[0])
                       if p.name.split("_")[0].isdigit() else 0):
        for m in re.finditer(
            rf"ALTER COLUMN {col} SET DEFAULT (true|false)",
            path.read_text(encoding="utf-8"),
        ):
            value = m.group(1)
    return value


# ── live drafting: ON ───────────────────────────────────────────────────────


def test_live_reply_drafting_is_on_by_default() -> None:
    """New mail still gets a draft. #87 briefly defaulted this off; migration 82
    put it back after the user scoped the no-drafting rule to backfills only."""
    assert AssistantSettingsModel(account_id="acc-1").draft_replies is True


def test_the_live_column_default_ends_up_on() -> None:
    assert _column_default("draft_replies") == "true"


# ── follow-up nudges: OFF ───────────────────────────────────────────────────


def test_follow_up_auto_draft_is_off_by_default() -> None:
    """Nudges threads by AGE, so it is the hundreds-at-once case, not the
    just-arrived one — and its scan was dead until #84, so the first working run
    on a long-configured account releases the whole window."""
    assert AssistantSettingsModel(account_id="acc-1").follow_up_auto_draft is False


def test_the_follow_up_column_default_ends_up_off() -> None:
    assert _column_default("follow_up_auto_draft") == "false"


# ── the GET fallback must agree with the model ──────────────────────────────
# This is the default a user actually SEES: for an account with no settings row
# the toggle renders from this value. Disagreeing with the model would show a
# switch in a state nothing had applied.


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
        expected = str(getattr(AssistantSettingsModel(account_id="a"), field))
        assert _get_fallback(field) == expected, (
            f"/assistant/settings returns {field}={_get_fallback(field)} for an "
            f"account with no settings row, but the model defaults {expected}"
        )


# ── no migration rewrites a user's stored choice ────────────────────────────


def test_the_default_migrations_do_not_rewrite_existing_settings() -> None:
    """A stored value is a deliberate choice. Changing what NEW accounts inherit
    is the fix; silently flipping a switch a user set is not."""
    for name in ("81_auto_draft_defaults_off.sql",
                 "82_live_drafting_default_back_on.sql"):
        # Comments are stripped first so the word "UPDATE" in the rationale
        # can't trip the check — a guard that fails on its own explanation just
        # gets the explanation deleted.
        body = "\n".join(
            ln for ln in _migration(name).splitlines()
            if not ln.lstrip().startswith("--")
        )
        assert "UPDATE" not in body.upper(), (
            f"{name} rewrites existing rows — it must only change the DEFAULT"
        )


def test_the_partial_insert_that_makes_column_defaults_matter_still_exists() -> None:
    """``derive_writing_style`` inserts only (account_id, writing_style), so it
    creates a settings row from column defaults. If this ever stops being true
    the migrations are still correct — but the reasoning above would be stale,
    so fail and make someone re-read it."""
    assert "(account_id, writing_style, updated_at)" in _ASSISTANT, (
        "the partial settings INSERT changed shape — re-check which paths can "
        "create a settings row from column defaults"
    )
