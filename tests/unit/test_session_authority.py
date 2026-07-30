"""A shared run acts at the intersection of its participants' access.

Spec: ai-company-brain/specs/groups_sessions_authority.md §3
      (answers org_access_control.md §10.2 collision 3)

The properties that carry the rule, asserted against a live database where
the participant tables exist:

1. **Solo is byte-identical to today.** A session with one participant — or
   no participant rows at all (every pre-133 session) — resolves to exactly
   the actor's own access. The rule activates only when a second distinct
   member exists.
2. **Presence caps, for everyone.** A member denied an integration sits in
   the room → the room's authority loses it, including for the member who
   holds it. Viewers included — they read the transcript, which is where the
   output goes.
3. **Group subjects expand at read time**, so leaving a group changes the
   very next resolution with no fan-out write.
4. **A suspended participant zeroes the room** (`intersect()` propagates
   ``is_active``): the room is capped until they are removed — a visible
   act — never quietly restored.
5. **The run gate refuses for the room, not just the typer** —
   ``assert_can_run_agent_in_session`` 403s when the intersection cannot run
   the agent, naming the rule.
"""
from __future__ import annotations

import uuid

import pytest


def _db_ready() -> bool:
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
    reason="no reachable Postgres with migration 133 — live authority tests skipped",
)

_PREFIX = "pytest-authority"
_ALICE = f"{_PREFIX}-alice@fracktal.in"
_BOB = f"{_PREFIX}-bob@fracktal.in"
_GROUP = f"{_PREFIX}-group"


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


def _purge() -> None:
    _exec("DELETE FROM chat_session WHERE id LIKE :p", p=f"{_PREFIX}%")
    _exec("DELETE FROM org_group WHERE slug = :g", g=_GROUP)
    _exec(
        "DELETE FROM user_permission_override WHERE user_id IN "
        "(SELECT id FROM app_user WHERE email LIKE :p)", p=f"{_PREFIX}%",
    )
    _exec("DELETE FROM app_user WHERE email LIKE :p", p=f"{_PREFIX}%")


def _seed_member(email: str, *, status: str = "active",
                 deny: str | None = None) -> None:
    """An active member holding the system `member` role (agents:run:* etc.),
    optionally with one deny override."""
    _exec(
        "INSERT INTO app_user (email, display_name, role, status, organization_id) "
        "SELECT :e, :e, 'employee', :st, id FROM organization LIMIT 1 "
        "ON CONFLICT (email) DO UPDATE SET status = :st", e=email, st=status,
    )
    _exec(
        "INSERT INTO user_role (user_id, role_id, assigned_by) "
        "SELECT u.id, r.id, 'pytest' FROM app_user u, org_role r "
        "WHERE u.email = :e AND r.slug = 'member' ON CONFLICT DO NOTHING",
        e=email,
    )
    if deny:
        _exec(
            "INSERT INTO user_permission_override "
            "(user_id, permission, effect, reason, set_by) "
            "SELECT id, :perm, 'deny', 'pytest', 'pytest' FROM app_user "
            "WHERE email = :e "
            "ON CONFLICT (user_id, permission) DO UPDATE SET effect = 'deny'",
            e=email, perm=deny,
        )


def _seed_session(*participants: tuple[str, str]) -> str:
    sid = f"{_PREFIX}-{uuid.uuid4().hex[:8]}"
    _exec(
        "INSERT INTO chat_session (id, user_id) VALUES (:i, :owner)",
        i=sid, owner=participants[0][0] if participants else _ALICE,
    )
    for subject, role in participants:
        _exec(
            "INSERT INTO chat_session_participant (session_id, subject, role) "
            "VALUES (:i, :s, :r) ON CONFLICT DO NOTHING",
            i=sid, s=subject, r=role,
        )
    return sid


@pytest.fixture
def clean(monkeypatch):
    """Purge seed data, disable the 60s access cache, and reset the module's
    async engine — it binds to the event loop of the test that first created
    it, and pytest-asyncio gives every test a fresh loop, so a reused engine
    fails with 'Event loop is closed' and resolve_access degrades to
    no-access, which would make every assertion here pass or fail for the
    wrong reason."""
    import acb_auth.access as access_mod

    _purge()
    access_mod.invalidate()
    monkeypatch.setattr(access_mod, "CACHE_TTL_SECONDS", 0.0)
    monkeypatch.setattr(access_mod, "_ENGINE", None)
    monkeypatch.setattr(access_mod, "_SESSION_FACTORY", None)
    yield
    _purge()
    access_mod.invalidate()


# ---------------------------------------------------------------------------
# 1. Solo is byte-identical
# ---------------------------------------------------------------------------

@_needs_db
@pytest.mark.asyncio
async def test_solo_session_is_the_actors_own_access(clean) -> None:
    from acb_auth import resolve_access, resolve_session_access

    _seed_member(_ALICE)
    sid = _seed_session((_ALICE, "owner"))

    folded, members = await resolve_session_access(sid, _ALICE)
    solo = await resolve_access(_ALICE, use_cache=False)
    assert members == [_ALICE]
    assert folded.has("integrations:use:zoho-crm") == solo.has(
        "integrations:use:zoho-crm",
    )
    assert folded.can_run_agent("email-assistant")


@_needs_db
@pytest.mark.asyncio
async def test_pre_133_session_without_rows_is_solo(clean) -> None:
    """Every session recorded before the participants table existed must keep
    resolving to the actor alone."""
    from acb_auth import resolve_session_access

    _seed_member(_ALICE)
    sid = _seed_session()  # session row only, no participant rows

    folded, members = await resolve_session_access(sid, _ALICE)
    assert members == [_ALICE]
    assert folded.is_active


# ---------------------------------------------------------------------------
# 2. Presence caps, for everyone — viewers included
# ---------------------------------------------------------------------------

@_needs_db
@pytest.mark.asyncio
@pytest.mark.parametrize("bob_role", ["member", "viewer"])
async def test_a_denied_participant_caps_the_room(clean, bob_role) -> None:
    from acb_auth import resolve_session_access

    _seed_member(_ALICE)
    _seed_member(_BOB, deny="integrations:use:zoho-crm")
    sid = _seed_session((_ALICE, "owner"), (_BOB, bob_role))

    folded, members = await resolve_session_access(sid, _ALICE)
    assert set(members) == {_ALICE, _BOB}
    # Alice holds Zoho; the ROOM does not, because Bob reads the transcript.
    assert not folded.has("integrations:use:zoho-crm")
    # What both hold survives the intersection.
    assert folded.has("integrations:use:clickup")


# ---------------------------------------------------------------------------
# 3. Groups expand at read time
# ---------------------------------------------------------------------------

@_needs_db
@pytest.mark.asyncio
async def test_group_subjects_expand_and_leaving_takes_effect(clean) -> None:
    from acb_auth import resolve_session_access

    _seed_member(_ALICE)
    _seed_member(_BOB, deny="integrations:use:zoho-crm")
    _exec(
        "INSERT INTO org_group (organization_id, slug, display_name) "
        "SELECT id, :g, :g FROM organization LIMIT 1 ON CONFLICT DO NOTHING",
        g=_GROUP,
    )
    _exec(
        "INSERT INTO org_group_member (group_id, user_id) "
        "SELECT g.id, u.id FROM org_group g, app_user u "
        "WHERE g.slug = :g AND u.email = :e ON CONFLICT DO NOTHING",
        g=_GROUP, e=_BOB,
    )
    sid = _seed_session((_ALICE, "owner"), (f"group:{_GROUP}", "member"))

    folded, members = await resolve_session_access(sid, _ALICE)
    assert _BOB in members
    assert not folded.has("integrations:use:zoho-crm")

    # Bob leaves the group — the very next resolution no longer caps.
    _exec(
        "DELETE FROM org_group_member WHERE user_id = "
        "(SELECT id FROM app_user WHERE email = :e)", e=_BOB,
    )
    import acb_auth.access as access_mod
    access_mod.invalidate()
    folded2, members2 = await resolve_session_access(sid, _ALICE)
    assert _BOB not in members2
    assert folded2.has("integrations:use:zoho-crm")


# ---------------------------------------------------------------------------
# 4. A suspended participant zeroes the room
# ---------------------------------------------------------------------------

@_needs_db
@pytest.mark.asyncio
async def test_a_suspended_participant_zeroes_the_room(clean) -> None:
    from acb_auth import resolve_session_access

    _seed_member(_ALICE)
    _seed_member(_BOB, status="suspended")
    sid = _seed_session((_ALICE, "owner"), (_BOB, "member"))

    folded, members = await resolve_session_access(sid, _ALICE)
    assert set(members) == {_ALICE, _BOB}
    assert not folded.is_active
    assert not folded.has("integrations:use:clickup")


# ---------------------------------------------------------------------------
# 5. The run gate refuses for the room
# ---------------------------------------------------------------------------

@_needs_db
@pytest.mark.asyncio
async def test_run_gate_refuses_when_the_room_cannot_run_the_agent(clean) -> None:
    from acb_auth import assert_can_run_agent_in_session
    from acb_auth.deps import UserContext
    from acb_auth.roles import UserRole
    from fastapi import HTTPException

    _seed_member(_ALICE)
    _seed_member(_BOB, deny="agents:run:email-assistant")
    sid = _seed_session((_ALICE, "owner"), (_BOB, "member"))

    from acb_auth import resolve_access
    alice = UserContext(
        email=_ALICE, role=UserRole.EMPLOYEE,
        access=await resolve_access(_ALICE, use_cache=False),
    )

    # Alice alone may run it…
    with pytest.raises(HTTPException) as exc:
        await assert_can_run_agent_in_session(alice, "email-assistant", sid)
    assert exc.value.status_code == 403
    assert "intersection" in exc.value.detail

    # …and in a solo session she still can.
    solo_sid = _seed_session((_ALICE, "owner"))
    await assert_can_run_agent_in_session(alice, "email-assistant", solo_sid)
