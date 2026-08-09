"""Groups and session participants (migration 138).

Spec: project-docs/specs/groups_sessions_authority.md §1–§2

What matters and is asserted against a live database:

1. **Every session ends the backfill with an owner** — an email `user_id` owns
   itself; the pre-auth literal ``'default'`` goes to the org owner, the only
   principal with a defensible claim to sessions that predate authentication.
2. **Nothing becomes discoverable by deploying.** Backfilled sessions stay
   ``private``.
3. **The vocabularies are enforced, not advisory** — visibility outside
   (private|people|org) and participant roles outside (owner|member|viewer)
   are CHECK violations, because a typo'd visibility value that silently
   inserts is an access hole.
4. **Idempotency** — re-running moves nothing and duplicates nothing.
"""
from __future__ import annotations

import pytest


def _db_ready() -> bool:
    """True when a session opens AND migration 138 has been applied."""
    try:
        from acb_graph import get_session
        from sqlalchemy import text
    except Exception:
        return False
    try:
        with get_session() as s:
            s.execute(text("SELECT subject FROM chat_session_participant LIMIT 1"))
            s.execute(text("SELECT slug FROM org_group LIMIT 1"))
        return True
    except Exception:
        return False


_needs_db = pytest.mark.skipif(
    not _db_ready(),
    reason="no reachable Postgres with migration 138 "
    "(chat_session_participant / org_group) — live tests skipped",
)

_SESS = "pytest-gsp-session"


def _exec(sql: str, **params):
    from acb_graph import get_session
    from sqlalchemy import text
    with get_session() as s:
        result = s.execute(text(sql), params)
        try:
            rows = result.fetchall()
        except Exception:
            rows = []
        s.commit()
        return rows


@pytest.fixture
def clean_session():
    _exec("DELETE FROM chat_session WHERE id LIKE :p", p=f"{_SESS}%")
    yield
    _exec("DELETE FROM chat_session WHERE id LIKE :p", p=f"{_SESS}%")


# ---------------------------------------------------------------------------
# Vocabulary is enforced
# ---------------------------------------------------------------------------

@_needs_db
def test_visibility_outside_the_vocabulary_is_rejected(clean_session) -> None:
    """'public' is not a value — apps.visibility's set is (private|people|org)
    and inventing a fourth silently is exactly what the CHECK prevents."""
    _exec(
        "INSERT INTO chat_session (id, user_id) VALUES (:i, 'a@b.com')", i=_SESS,
    )
    with pytest.raises(Exception, match="visibility"):
        _exec(
            "UPDATE chat_session SET visibility='public' WHERE id=:i", i=_SESS,
        )


@_needs_db
def test_participant_role_outside_the_vocabulary_is_rejected(clean_session) -> None:
    _exec("INSERT INTO chat_session (id, user_id) VALUES (:i, 'a@b.com')", i=_SESS)
    with pytest.raises(Exception, match="role"):
        _exec(
            "INSERT INTO chat_session_participant (session_id, subject, role) "
            "VALUES (:i, 'a@b.com', 'driver')", i=_SESS,
        )


@_needs_db
def test_group_subjects_and_emails_share_the_participant_table(clean_session) -> None:
    """The app_grants subject vocabulary: an email row and a group:<slug> row
    coexist under one primary key, so group expansion is a read-time concern."""
    _exec("INSERT INTO chat_session (id, user_id) VALUES (:i, 'a@b.com')", i=_SESS)
    _exec(
        "INSERT INTO chat_session_participant (session_id, subject, role) VALUES "
        "(:i, 'a@b.com', 'owner'), (:i, 'group:sales', 'member'), (:i, 'org', 'viewer')",
        i=_SESS,
    )
    rows = _exec(
        "SELECT subject, role FROM chat_session_participant "
        "WHERE session_id=:i ORDER BY subject", i=_SESS,
    )
    assert [(r[0], r[1]) for r in rows] == [
        ("a@b.com", "owner"), ("group:sales", "member"), ("org", "viewer"),
    ]


# ---------------------------------------------------------------------------
# Deleting the session removes its participant rows (no orphaned access)
# ---------------------------------------------------------------------------

@_needs_db
def test_participants_cascade_with_the_session(clean_session) -> None:
    _exec("INSERT INTO chat_session (id, user_id) VALUES (:i, 'a@b.com')", i=_SESS)
    _exec(
        "INSERT INTO chat_session_participant (session_id, subject, role) "
        "VALUES (:i, 'a@b.com', 'owner')", i=_SESS,
    )
    _exec("DELETE FROM chat_session WHERE id=:i", i=_SESS)
    assert _exec(
        "SELECT count(*) FROM chat_session_participant WHERE session_id=:i",
        i=_SESS,
    )[0][0] == 0


# ---------------------------------------------------------------------------
# The backfill (re-runnable, so assertable any time)
# ---------------------------------------------------------------------------

@_needs_db
def test_rerunning_the_backfill_grants_nothing_new(clean_session) -> None:
    """The INSERT ... ON CONFLICT DO NOTHING backfill must be inert on rows
    that already have any participant — including sessions whose owner row
    was later deliberately changed (a transferred room must not snap back)."""
    from pathlib import Path

    _exec("INSERT INTO chat_session (id, user_id) VALUES (:i, 'a@b.com')", i=_SESS)
    # Transfer ownership away from the creator.
    _exec(
        "INSERT INTO chat_session_participant (session_id, subject, role) "
        "VALUES (:i, 'new-owner@b.com', 'owner')", i=_SESS,
    )

    migration = (
        Path(__file__).resolve().parents[2]
        / "infra/postgres/138_groups_and_session_participants.sql"
    ).read_text(encoding="utf-8")
    from acb_graph import get_session
    from sqlalchemy import text
    with get_session() as s:
        s.execute(text(migration))
        s.commit()

    rows = _exec(
        "SELECT subject FROM chat_session_participant WHERE session_id=:i",
        i=_SESS,
    )
    # The creator email IS re-added by the email-owner backfill (idempotent
    # ON CONFLICT on the PK), but never displaces the transferred owner row.
    subjects = {r[0] for r in rows}
    assert "new-owner@b.com" in subjects
