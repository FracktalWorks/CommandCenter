"""Opening a category in the Email Cleaner must scope everything under it.

A sender belongs to several categories at once — a colleague sends Calendar
invites AND Notifications — and the sender list already lists them under every
one of them, which is right. What did not follow the filter was everything
*inside* the row:

* **The drill-down ignored it.** Expanding a sender fetched their 25 most recent
  messages regardless of the open tab, so opening "Notification" on a colleague
  listed their Awaiting Reply, Done and FYI mail too. The drill-down silently
  contradicted the filter that produced it.
* **The count ignored it.** The row's headline number was the sender's whole
  volume, so under "Notification" a person with 69 messages of which 7 were
  notifications read as 69 notifications.
* **The chips could omit it.** Only two chips fit and they are ordered by
  volume, so filtering to a sender's third-busiest category showed a row with no
  chip for the category you had filtered by.

The same class of defect as the Analytics range selector: a number shown under a
filter it does not respect.
"""
from __future__ import annotations

from typing import Any

from gateway.routes.email.automation import senders as s
from gateway.routes.email.transport import search as se

# ── per-category counts ─────────────────────────────────────────────────────


def test_a_sender_reports_a_count_per_category() -> None:
    """So the row can answer the narrower question the open tab is asking."""
    counts = {"notification": 7, "calendar": 3}
    ranked = s._cleanup_categories_ranked(counts)
    assert ranked == ["Notification", "Calendar"], (
        "categories must come back in canonical display case, most-used first"
    )


def test_conversation_labels_are_not_cleanup_categories() -> None:
    """Awaiting Reply / Done / FYI are per-THREAD conversation states, not
    things the cleaner can act on, so they never become facets. This is why a
    colleague with a dozen Awaiting Reply messages correctly shows one chip."""
    ranked = s._cleanup_categories_ranked(
        {"awaiting reply": 40, "done": 12, "fyi": 9, "notification": 2})
    assert ranked == ["Notification"]


def test_an_unlabelled_sender_has_no_categories() -> None:
    assert s._cleanup_categories_ranked({}) == []
    assert s._cleanup_categories_ranked({"notification": 0}) == []


# ── the tag filter the drill-down rides on ──────────────────────────────────


def _tag_sql(*tags: str) -> tuple[str, dict[str, Any]]:
    where: list[str] = []
    params: dict[str, Any] = {}
    se._tag_filters(where, params, None, list(tags))
    return " AND ".join(where), params


def test_a_category_filter_ignores_case_and_stray_space() -> None:
    """The rule engine stores a rule's label VERBATIM, so an exact
    `= ANY(categories)` returned nothing the moment a rule's name differed by
    case or a trailing space — and the drill-down would report "no Notification
    messages" for a sender the list above says has seven.

    The cleaner's own tally already had to fix exactly this; normalising in both
    places is deliberate, not redundant.
    """
    sql, params = _tag_sql("  Notification ")
    assert params["tag_0"] == "notification"
    assert "LOWER(TRIM(c))" in sql and "LOWER(TRIM(l))" in sql


def test_a_tag_matches_either_a_label_or_a_category() -> None:
    """A rule-engine category and a user's own mailbox label are searchable the
    same way — the user does not distinguish them, so neither does this."""
    sql, _ = _tag_sql("Newsletter")
    assert "em.labels" in sql and "em.categories" in sql


def test_stacked_tags_narrow_rather_than_widen() -> None:
    """Each pill is a further restriction; ORing them would make adding a filter
    return MORE mail, which is not what a row of chips reads as."""
    sql, params = _tag_sql("Newsletter", "Receipt")
    assert params == {"tag_0": "newsletter", "tag_1": "receipt"}
    assert sql.count("EXISTS") == 4  # two predicates, each label OR category
    assert " AND " in sql


def test_blank_tags_are_dropped() -> None:
    """An empty pill must not become a predicate that matches nothing."""
    sql, params = _tag_sql("", "   ")
    assert sql == "" and params == {}
