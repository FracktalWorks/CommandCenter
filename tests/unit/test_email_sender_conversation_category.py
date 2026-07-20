""""Conversation" is a sender-level rollup, not a label on any email.

It appeared in the Email Cleaner as a pill called "Personal" that the user could
find nowhere else — no message carried it, no rule produced it, and the chip's
tooltip claimed it came "from your rules". Renamed 2026-07-20.

The name matters because *Cold Email* is also one human writing to another. What
separates them is not that a person is involved; it is that a reply came back.
"""
from __future__ import annotations

import inspect
import re
from pathlib import Path

from gateway.routes.email.automation import senders as s
from gateway.routes.email.core import (
    CLEANUP_CATEGORIES,
    CONVERSATION_SENDER_CATEGORY,
    HUMAN_SENDER_CATEGORIES_LOWER,
)

REPO = Path(__file__).resolve().parents[2]
_MIN = s._MIN_RULE_MESSAGES


def _counts(**kw: int) -> dict[str, int]:
    return {k.replace("_", " "): v for k, v in kw.items()}


# ── what it is ──────────────────────────────────────────────────────────────


def test_an_ongoing_exchange_is_categorized_conversation() -> None:
    assert s._rule_category(_counts(reply=_MIN)) == CONVERSATION_SENDER_CATEGORY


def test_it_needs_enough_history_to_count() -> None:
    """One stray reply to a stranger isn't an exchange."""
    assert s._rule_category(_counts(reply=_MIN - 1)) is None


def test_any_cleanup_label_at_all_disqualifies_it() -> None:
    """Not "more conversation than cleanup" — NO cleanup label. A newsletter
    someone once replied to stays a Newsletter."""
    assert s._rule_category(_counts(reply=50, newsletter=1)) != \
        CONVERSATION_SENDER_CATEGORY


def test_a_dominant_cleanup_category_still_wins() -> None:
    assert s._rule_category(_counts(newsletter=_MIN, reply=1)) == "Newsletter"


def test_an_unlabelled_sender_stays_uncategorized() -> None:
    """There is no second classifier to fall back to."""
    assert s._rule_category({}) is None


# ── what it is NOT ──────────────────────────────────────────────────────────


def test_it_is_not_one_of_the_message_labels() -> None:
    """The whole confusion: it looked like a category, so the user went looking
    for it among their categories. Nothing writes it onto an email."""
    assert CONVERSATION_SENDER_CATEGORY not in CLEANUP_CATEGORIES


def test_nothing_writes_it_to_a_message_or_the_provider() -> None:
    src = inspect.getsource(s)
    for line in src.splitlines():
        if CONVERSATION_SENDER_CATEGORY in line and "categories" in line:
            raise AssertionError(
                f"a message-categories write mentions the sender category: {line!r}"
            )


# ── producer and consumer share one constant ────────────────────────────────


def test_the_ranking_boost_matches_the_value_produced() -> None:
    """senders.py produces the string; messages.py scores on it. They live in
    different modules, so a rename reaching only one side would silently drop
    the boost rather than fail — which is why both read one constant."""
    assert CONVERSATION_SENDER_CATEGORY.lower() in HUMAN_SENDER_CATEGORIES_LOWER


def test_the_important_emails_query_binds_the_constant() -> None:
    """Inlined literals are how the two sides drift apart in the first place."""
    src = (
        REPO / "apps/services/gateway/gateway/routes/email/transport/messages.py"
    ).read_text(encoding="utf-8")
    assert "= ANY(:human_cats)" in src
    assert "'personal'" not in src.lower(), (
        "the old sender category is still inlined in the ranking query"
    )


def test_the_vocabulary_lists_agree_across_the_stack() -> None:
    """EMAIL_CATEGORIES is duplicated in types.ts for the UI; a rename on one
    side only would show a chip the filters don't know about."""
    ts = (
        REPO / "workbench/control_plane/src/app/email/lib/types.ts"
    ).read_text(encoding="utf-8")
    m = re.search(r"EMAIL_CATEGORIES = \[(.*?)\]", ts, re.DOTALL)
    assert m, "EMAIL_CATEGORIES not found in types.ts"
    assert set(re.findall(r'"([^"]+)"', m.group(1))) == set(s.EMAIL_CATEGORIES)


# ── the migration ───────────────────────────────────────────────────────────


def test_stored_rows_are_carried_over() -> None:
    """Unlike the settings-default migrations, this one DOES rewrite rows: the
    value is a derived rollup, not a setting anyone chose, and leaving the old
    string would strand those senders under a name no code produces."""
    sql = (REPO / "infra/postgres/83_rename_personal_sender_category.sql").read_text(
        encoding="utf-8")
    assert "UPDATE email_senders" in sql
    assert "SET category = 'Conversation'" in sql
    assert "WHERE category = 'Personal'" in sql
