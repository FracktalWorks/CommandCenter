"""The sign-in request queue — capture the knock, and let the owner answer it.

Spec: ``ai-company-brain/specs/colleague_onboarding.md`` §6 (WS-24 / N6a).

Before N6a an authenticated stranger produced one artefact — a journald
warning nobody read back — so the owner's only way to learn that a colleague
was locked out was for that colleague to say so. This file is the fence around
the fix, and it is deliberately DB-free: the only test in the tree that
exercised ``access.py``'s unprovisioned branch is
``test_owner_bootstrap.py::test_unprovisioned_signin_is_cached``, which is
``@_needs_db`` and unrunnable by an agent (``work_plan.md`` §6 forbids pointing
it at prod). N6a adds a **write** to that branch, so the fence has to be built
here, not assumed.

What is locked, in the order the spec's done-whens state it:

1. dw8 — **characterisation of the existing invite**, written before the
   ``_provision_member`` extraction and unchanged by it. ``POST /admin/members``
   was completely untested; refactoring an unfenced route on the auth path
   blind is how a provisioning bug ships.
2. dw2 — the unprovisioned branch upserts a request, best-effort: a failing
   write changes neither the refusal nor the log line.
3. dw3 — **the write fires only on the sign-in path.** ``resolve_access`` is
   not sign-in-only; ``routes/rooms.py`` fans it out over room participants'
   emails and ``access.py`` folds it over session subjects. Neither is a knock.
4. dw4 — an email with an ``app_user`` row in ANY status is never recorded.
5. dw5 — write volume is bounded by the 60s resolution cache.
6. dw6/7/9 — the three admin routes, their per-route auth floor, and the
   approve path that provisions AND activates in one action.
7. dw11 — an ``invited`` row is labelled "never signed in", not rendered live.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, ClassVar

import pytest
from acb_auth import UserContext, UserRole, build_access
from fastapi import HTTPException

ORG = "00000000-0000-0000-0000-00000000000a"

REPO_ROOT = Path(__file__).resolve().parents[2]

FULL_ADMIN = UserContext(
    email="admin@fracktal.in",
    role=UserRole.EXECUTIVE,
    access=build_access(
        ["admin:members:read", "admin:members:invite", "admin:members:manage"],
        roles=["admin"],
    ),
)


# ── Fakes ───────────────────────────────────────────────────────────────────

class _Scalars:
    """``.scalars()`` yields the first column, the way SQLAlchemy does."""

    def __init__(self, rows: list[dict[str, Any]]):
        self._rows = rows

    def all(self) -> list[Any]:
        return [next(iter(r.values())) for r in self._rows]


class _Rows:
    """Result shim covering the access patterns the admin routes use."""

    def __init__(self, rows: list[dict[str, Any]], rowcount: int = 0):
        self._rows = rows
        self.rowcount = rowcount

    def mappings(self) -> _Rows:
        return self

    def first(self) -> dict[str, Any] | None:
        return self._rows[0] if self._rows else None

    def all(self) -> list[dict[str, Any]]:
        return self._rows

    def fetchall(self) -> list[Any]:
        return [tuple(r.values()) for r in self._rows]

    def scalars(self) -> _Scalars:
        return _Scalars(self._rows)

    def scalar(self) -> Any:
        if not self._rows:
            return None
        return next(iter(self._rows[0].values()))


class _FakeDB:
    """In-memory ``app_user`` / ``org_role`` / ``user_role`` / ``access_request``.

    Same convention as ``test_admin_groups.py``: the route functions are called
    directly with the DB seam monkeypatched on the SUT submodule, so nothing
    here touches Postgres. SQL is matched on normalised substrings — the exact
    strings the routes render — so a query-shape change fails loudly here
    rather than silently in production.
    """

    ROLE_RANKS: ClassVar[dict[str, int]] = {
        "owner": 0, "admin": 10, "manager": 20, "member": 30,
    }

    def __init__(self) -> None:
        self.users: dict[str, dict[str, Any]] = {}          # id → row
        self.user_roles: dict[str, list[str]] = {}          # uid → [slug]
        self.requests: dict[str, dict[str, Any]] = {}       # lower(email) → row
        self.committed = 0
        self.invalidated: list[str] = []
        self.audit: list[tuple[str, str]] = []
        self.statements: list[str] = []

    # helpers -----------------------------------------------------------
    def seed_user(self, uid: str, email: str, *, status: str = "active",
                  name: str = "", joined_at: str | None = None) -> None:
        self.users[uid] = {
            "id": uid, "email": email, "display_name": name,
            "avatar_url": "", "status": status, "legacy_role": "employee",
            "invited_by": "", "invited_at": None, "joined_at": joined_at,
            "last_login_at": None, "last_active_at": None, "created_at": None,
        }

    def seed_request(self, email: str, *, status: str = "pending",
                     attempts: int = 1) -> None:
        self.requests[email.lower()] = {
            "id": f"r-{len(self.requests) + 1}", "email": email,
            "display_name": "", "first_seen_at": None, "last_seen_at": None,
            "attempt_count": attempts, "status": status,
            "decided_by": "", "decided_at": None,
        }

    def user_by_email(self, email: str) -> dict[str, Any] | None:
        return next(
            (u for u in self.users.values()
             if u["email"].lower() == email.lower()), None,
        )

    # SQLAlchemy-session surface ---------------------------------------
    async def __aenter__(self) -> _FakeDB:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def commit(self) -> None:
        self.committed += 1

    async def execute(  # noqa: C901 — one branch per statement, by design
        self, sql: Any, params: dict | None = None
    ) -> _Rows:
        s = " ".join(str(sql).split())
        p = params or {}
        self.statements.append(s)

        if "FROM organization WHERE slug" in s:
            return _Rows([{"id": ORG}])

        if "MIN(r.rank)" in s:
            me = self.user_by_email(p["email"])
            slugs = self.user_roles.get(me["id"], []) if me else []
            ranks = [self.ROLE_RANKS[x] for x in slugs if x in self.ROLE_RANKS]
            return _Rows([{"rank": min(ranks) if ranks else None}])

        if "FROM org_role WHERE organization_id" in s and "ANY(:slugs)" in s:
            return _Rows([
                {"id": f"role-{slug}", "slug": slug,
                 "rank": self.ROLE_RANKS[slug]}
                for slug in p["slugs"] if slug in self.ROLE_RANKS
            ])

        if "INSERT INTO app_user" in s:
            existing = self.user_by_email(p["email"])
            if existing is None:
                uid = f"u-{len(self.users) + 1}"
                self.seed_user(uid, p["email"], status=p.get("status", "invited"),
                               name=p.get("name", ""))
                self.users[uid]["invited_by"] = p.get("by", "")
                if p.get("status") == "active":
                    self.users[uid]["joined_at"] = "now()"
                return _Rows([], rowcount=1)
            # ON CONFLICT (email) DO UPDATE — mirror the SQL's CASE arms.
            if p.get("name"):
                existing["display_name"] = p["name"]
            wanted = p.get("status", "invited")
            if existing["status"] in ("removed", "invited"):
                existing["status"] = wanted
                if wanted == "active" and not existing["joined_at"]:
                    existing["joined_at"] = "now()"
            return _Rows([], rowcount=1)

        if "FROM app_user WHERE lower(email)" in s:
            row = self.user_by_email(p["email"])
            return _Rows([dict(row)] if row else [])

        if "DELETE FROM user_role WHERE user_id" in s:
            self.user_roles[p["uid"]] = []
            return _Rows([], rowcount=1)

        if "INSERT INTO user_role" in s:
            slug = str(p["rid"]).removeprefix("role-")
            self.user_roles.setdefault(p["uid"], []).append(slug)
            return _Rows([], rowcount=1)

        if "SELECT r.slug FROM user_role ur" in s:
            slugs = self.user_roles.get(p["uid"], [])
            return _Rows([
                {"slug": x}
                for x in sorted(slugs, key=lambda y: self.ROLE_RANKS.get(y, 999))
            ])

        if "UPDATE access_request SET" in s:
            row = self.requests.get(str(p["email"]).lower())
            if row is None:
                return _Rows([], rowcount=0)
            row["status"] = p["status"]
            row["decided_by"] = p["by"]
            row["decided_at"] = "now()"
            return _Rows([], rowcount=1)

        if "FROM access_request" in s:
            if "lower(email) = :email" in s:
                row = self.requests.get(str(p["email"]).lower())
                return _Rows([dict(row)] if row else [])
            rows = [
                dict(r) for r in self.requests.values() if r["status"] == "pending"
            ]
            return _Rows(rows)

        raise AssertionError(f"unhandled SQL in fake: {s}")


@pytest.fixture()
def db(monkeypatch: pytest.MonkeyPatch) -> _FakeDB:
    """A shared fake session bound to both admin submodules under test."""
    from gateway.routes.admin import access_requests, members

    fake = _FakeDB()

    async def _get_db() -> _FakeDB:
        return fake

    for module in (members, access_requests):
        monkeypatch.setattr(module, "get_db", _get_db)
        monkeypatch.setattr(
            module, "invalidate_for",
            lambda *e: fake.invalidated.extend(x for x in e if x),
        )
        monkeypatch.setattr(
            module, "record_admin_change",
            lambda actor, action, target, **kw: fake.audit.append((action, target)),
        )

    # The admin doing the inviting must outrank what they assign.
    fake.seed_user("u-admin", "admin@fracktal.in")
    fake.user_roles["u-admin"] = ["admin"]
    return fake


# ════════════════════════════════════════════════════════════════════════════
# 1. dw8 — characterisation of the EXISTING invite, written before the
#    `_provision_member` extraction. These assertions describe behaviour that
#    predates this ticket and must survive it byte-for-byte.
# ════════════════════════════════════════════════════════════════════════════

async def test_invite_creates_an_invited_row_with_the_default_member_role(
    db: _FakeDB,
) -> None:
    from gateway.routes.admin.members import InviteRequest, invite_member

    entry = await invite_member(
        InviteRequest(email="  Priya@Fracktal.IN  ", display_name="Priya"),
        admin=FULL_ADMIN,
    )

    assert entry.email == "priya@fracktal.in"       # normalised, lowercased
    assert entry.status == "invited"
    assert entry.roles == ["member"]                # `req.roles or ["member"]`
    assert entry.invited_by == "admin@fracktal.in"

    row = db.user_by_email("priya@fracktal.in")
    assert row is not None and row["status"] == "invited"
    # Invite does NOT stamp joined_at — that is what makes `invited` mean
    # "provisioned, never signed in".
    assert row["joined_at"] is None
    assert db.committed == 1


async def test_invite_of_a_removed_member_returns_them_to_invited(
    db: _FakeDB,
) -> None:
    """The one status the ON CONFLICT arm rewrites."""
    from gateway.routes.admin.members import InviteRequest, invite_member

    db.seed_user("u-9", "gone@fracktal.in", status="removed")
    await invite_member(
        InviteRequest(email="gone@fracktal.in"), admin=FULL_ADMIN,
    )
    assert db.users["u-9"]["status"] == "invited"


async def test_invite_never_downgrades_an_active_member(db: _FakeDB) -> None:
    """Re-inviting somebody already in must not take their access away."""
    from gateway.routes.admin.members import InviteRequest, invite_member

    db.seed_user("u-8", "live@fracktal.in", status="active")
    entry = await invite_member(
        InviteRequest(email="live@fracktal.in", roles=["manager"]),
        admin=FULL_ADMIN,
    )
    assert db.users["u-8"]["status"] == "active"
    assert entry.roles == ["manager"]


async def test_invite_rejects_an_address_that_is_not_one(db: _FakeDB) -> None:
    from gateway.routes.admin.members import InviteRequest, invite_member

    for bad in ("not-an-address", "", "x" * 250 + "@fracktal.in"):
        with pytest.raises(HTTPException) as exc:
            await invite_member(InviteRequest(email=bad), admin=FULL_ADMIN)
        assert exc.value.status_code == 400


async def test_invite_refuses_a_role_that_outranks_the_caller(db: _FakeDB) -> None:
    """Invariant 2 — an admin cannot mint an owner through the invite path."""
    from gateway.routes.admin.members import InviteRequest, invite_member

    with pytest.raises(HTTPException) as exc:
        await invite_member(
            InviteRequest(email="new@fracktal.in", roles=["owner"]),
            admin=FULL_ADMIN,
        )
    assert exc.value.status_code == 403
    assert db.user_by_email("new@fracktal.in") is None


async def test_invite_drops_the_resolver_cache_and_records_the_audit_action(
    db: _FakeDB,
) -> None:
    """A new member whose refusal is still cached would be locked out for 60s."""
    from gateway.routes.admin.members import InviteRequest, invite_member

    await invite_member(
        InviteRequest(email="new@fracktal.in"), admin=FULL_ADMIN,
    )
    assert "new@fracktal.in" in db.invalidated
    assert ("org.member_invited", "user:new@fracktal.in") in db.audit


# ════════════════════════════════════════════════════════════════════════════
# 2. dw2/dw3/dw4/dw5 — the write on the unprovisioned branch
# ════════════════════════════════════════════════════════════════════════════

class _FakeSession:
    """Minimal async session for :func:`acb_auth.access.resolve_access`."""

    def __init__(self, owner: _AccessWorld):
        self._owner = owner

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def commit(self) -> None:
        self._owner.commits += 1

    async def execute(self, sql: Any, params: dict | None = None) -> _Rows:
        s = " ".join(str(sql).split())
        p = params or {}
        if "INSERT INTO access_request" in s:
            self._owner.writes.append(p["email"])
            if self._owner.write_raises:
                raise RuntimeError("access_request write exploded")
            return _Rows([], rowcount=1)
        if "FROM app_user u" in s or "FROM app_user WHERE" in s:
            row = self._owner.rows.get(p["email"])
            return _Rows([row] if row else [])
        raise AssertionError(f"unhandled SQL in access fake: {s}")


class _AccessWorld:
    """The world ``resolve_access`` sees: known members, and what it wrote."""

    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}
        self.writes: list[str] = []
        self.commits = 0
        self.write_raises = False

    def seed_member(self, email: str, *, status: str = "active") -> None:
        self.rows[email.lower()] = {
            "user_id": "u-1", "organization_id": ORG, "status": status,
            "legacy_role": "employee", "roles": ["member"],
            "role_permissions": ["feature:chat"], "overrides": [],
        }

    def factory(self) -> Any:
        return lambda: _FakeSession(self)


@pytest.fixture()
def world(monkeypatch: pytest.MonkeyPatch) -> _AccessWorld:
    import acb_auth.access as access_mod

    w = _AccessWorld()
    monkeypatch.setattr(access_mod, "_get_session_factory", w.factory)
    monkeypatch.setattr(access_mod, "_tables_missing", False)
    access_mod.invalidate()
    yield w
    access_mod.invalidate()


async def test_an_unprovisioned_signin_is_recorded_as_a_request(
    world: _AccessWorld,
) -> None:
    """dw2 — the knock is persisted instead of discarded."""
    from acb_auth.access import resolve_access

    access = await resolve_access("stranger@fracktal.in", record_request=True)

    assert not access.is_active
    assert world.writes == ["stranger@fracktal.in"]
    assert world.commits == 1


async def test_a_failing_request_write_leaves_the_refusal_untouched(
    world: _AccessWorld,
) -> None:
    """dw2 — best-effort. The queue is a convenience; the refusal is the
    security answer, and a broken table must never change it or raise."""
    from acb_auth.access import resolve_access

    world.write_raises = True
    access = await resolve_access("stranger@fracktal.in", record_request=True)

    assert not access.is_active
    assert access.granted == frozenset()
    assert world.writes == ["stranger@fracktal.in"]   # attempted, and swallowed


async def test_resolve_access_records_nothing_unless_asked(
    world: _AccessWorld,
) -> None:
    """dw3 — the default is silence. Every caller that is not a sign-in gets
    exactly today's behaviour without opting out of anything."""
    from acb_auth.access import resolve_access

    access = await resolve_access("stranger@fracktal.in")

    assert not access.is_active
    assert world.writes == []


async def test_a_room_participant_fanout_over_unknown_emails_writes_nothing(
    world: _AccessWorld,
) -> None:
    """dw3, the P1 — ``routes/rooms.py:215`` shape.

    ``resolve_access`` is fanned out over *room participants'* emails to work
    out what a shared run's authority is capped by. A participant with no
    ``app_user`` row is not somebody knocking at the front door, and filing
    them as one would put people in the owner's queue who never tried to sign
    in — precisely the harm the separate-table decision exists to prevent.
    """
    from acb_auth.access import resolve_access

    emails = ["a@fracktal.in", "b@fracktal.in", "c@fracktal.in"]
    resolved = {e: await resolve_access(e) for e in emails}

    assert all(not a.is_active for a in resolved.values())
    assert world.writes == []


async def test_the_session_authority_fold_writes_nothing(
    world: _AccessWorld, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """dw3 — ``access.py``'s own participant fold is the second non-knock."""
    import acb_auth.access as access_mod

    world.seed_member("actor@fracktal.in")

    async def _fake_resolve_session(session_id, actor_email):
        # Exercise the real fold's inner call shape: the actor plus two
        # subjects nobody ever provisioned.
        folded = await access_mod.resolve_access(actor_email)
        for email in ("ghost1@fracktal.in", "ghost2@fracktal.in"):
            folded = folded.intersect(await access_mod.resolve_access(email))
        return folded

    access = await _fake_resolve_session("sess-1", "actor@fracktal.in")
    assert not access.is_active
    assert world.writes == []


async def test_the_signin_path_is_the_only_caller_that_opts_in() -> None:
    """dw3, pinned at the source: exactly one call site passes the flag.

    A future caller that copy-pastes ``record_request=True`` onto a fan-out
    would re-open the P1 silently, so this reads the tree rather than trusting
    a convention.
    """
    hits: list[str] = []
    for path in sorted(REPO_ROOT.glob("**/*.py")):
        parts = set(path.parts)
        if parts & {".venv", "node_modules", "__pycache__", "site-packages"}:
            continue
        if path.name == Path(__file__).name:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if "record_request=True" in text:
            hits.append(str(path.relative_to(REPO_ROOT)).replace("\\", "/"))

    assert hits == ["packages/acb_auth/acb_auth/deps.py"], hits


async def test_a_suspended_member_never_generates_a_request(
    world: _AccessWorld,
) -> None:
    """dw4 — an email with an ``app_user`` row in ANY status is not a stranger."""
    from acb_auth.access import resolve_access

    for status in ("active", "invited", "suspended", "removed"):
        world.rows.clear()
        world.writes.clear()
        world.seed_member("known@fracktal.in", status=status)

        access = await resolve_access(
            "known@fracktal.in", record_request=True, use_cache=False,
        )

        assert access.is_active is (status == "active")
        assert world.writes == [], f"{status} member filed as a request"


async def test_a_second_knock_inside_the_cache_ttl_writes_once(
    world: _AccessWorld,
) -> None:
    """dw5 — volume is bounded by the existing 60s resolution cache, not by
    the request rate. A locked-out colleague reloading the page must not turn
    into a write per request."""
    from acb_auth.access import resolve_access

    for _ in range(5):
        await resolve_access("stranger@fracktal.in", record_request=True)

    assert world.writes == ["stranger@fracktal.in"]


async def test_the_refusal_is_still_logged_when_a_request_is_recorded(
    world: _AccessWorld, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """dw2 — the queue is additive; the journald line stays exactly as it was."""
    import acb_auth.access as access_mod

    seen: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(
        access_mod._log, "warning",
        lambda event, **kw: seen.append((event, kw)),
    )

    await access_mod.resolve_access("stranger@fracktal.in", record_request=True)

    assert [e for e, _ in seen] == ["access_unprovisioned_signin"]
    assert seen[0][1]["email"] == "stranger@fracktal.in"


# ════════════════════════════════════════════════════════════════════════════
# 3. dw6/dw7/dw9 — the admin surface
# ════════════════════════════════════════════════════════════════════════════

async def test_pending_requests_are_listed_newest_knock_first(db: _FakeDB) -> None:
    """dw6."""
    from gateway.routes.admin.access_requests import list_access_requests

    db.seed_request("old@fracktal.in", attempts=2)
    db.seed_request("new@fracktal.in", attempts=53)
    db.seed_request("decided@fracktal.in", status="approved")

    out = await list_access_requests(admin=FULL_ADMIN)

    assert {r.email for r in out} == {"old@fracktal.in", "new@fracktal.in"}
    assert next(r for r in out if r.email == "new@fracktal.in").attempt_count == 53


async def test_approving_provisions_the_member_ACTIVE_not_invited(
    db: _FakeDB,
) -> None:
    """dw7 — the whole point. An approval IS the decision to let somebody in,
    and they are already standing at the door; leaving them ``invited`` would
    re-create §2's two-click trap inside the fix for it."""
    from gateway.routes.admin.access_requests import (
        ApproveRequest,
        approve_access_request,
    )

    db.seed_request("ishaan@fracktal.in", attempts=53)

    out = await approve_access_request(
        "ishaan@fracktal.in", ApproveRequest(), admin=FULL_ADMIN,
    )

    assert out.status == "active"
    assert out.roles == ["member"]                       # `members.py:165` default
    row = db.user_by_email("ishaan@fracktal.in")
    assert row is not None and row["status"] == "active"
    assert row["joined_at"] is not None                  # activation stamps it
    assert db.requests["ishaan@fracktal.in"]["status"] == "approved"
    assert db.requests["ishaan@fracktal.in"]["decided_by"] == "admin@fracktal.in"
    # The cached refusal must not outlive the approval.
    assert "ishaan@fracktal.in" in db.invalidated


async def test_approving_honours_an_explicit_role_choice(db: _FakeDB) -> None:
    from gateway.routes.admin.access_requests import (
        ApproveRequest,
        approve_access_request,
    )

    db.seed_request("lead@fracktal.in")
    out = await approve_access_request(
        "lead@fracktal.in", ApproveRequest(roles=["manager"]), admin=FULL_ADMIN,
    )
    assert out.roles == ["manager"]


async def test_approving_cannot_assign_a_role_above_the_caller(db: _FakeDB) -> None:
    """Invariant 2 reaches the new route because it shares the invite's helper."""
    from gateway.routes.admin.access_requests import (
        ApproveRequest,
        approve_access_request,
    )

    db.seed_request("climber@fracktal.in")
    with pytest.raises(HTTPException) as exc:
        await approve_access_request(
            "climber@fracktal.in", ApproveRequest(roles=["owner"]),
            admin=FULL_ADMIN,
        )
    assert exc.value.status_code == 403
    assert db.user_by_email("climber@fracktal.in") is None
    assert db.requests["climber@fracktal.in"]["status"] == "pending"


async def test_approving_twice_is_not_an_error_and_creates_one_member(
    db: _FakeDB,
) -> None:
    """dw7 — idempotent. Two admins clicking the same row is a normal race."""
    from gateway.routes.admin.access_requests import (
        ApproveRequest,
        approve_access_request,
    )

    db.seed_request("twice@fracktal.in")
    first = await approve_access_request(
        "twice@fracktal.in", ApproveRequest(), admin=FULL_ADMIN,
    )
    second = await approve_access_request(
        "twice@fracktal.in", ApproveRequest(), admin=FULL_ADMIN,
    )

    assert first.status == second.status == "active"
    assert len([u for u in db.users.values()
                if u["email"] == "twice@fracktal.in"]) == 1


async def test_approving_never_un_suspends_somebody(db: _FakeDB) -> None:
    """A suspension is an ``admin:members:manage`` decision; approve is gated on
    the weaker ``admin:members:invite``. Provisioning must not become a way to
    reverse the stronger act."""
    from gateway.routes.admin.access_requests import (
        ApproveRequest,
        approve_access_request,
    )

    db.seed_user("u-s", "suspended@fracktal.in", status="suspended")
    db.seed_request("suspended@fracktal.in")

    out = await approve_access_request(
        "suspended@fracktal.in", ApproveRequest(), admin=FULL_ADMIN,
    )
    assert out.status == "suspended"
    assert db.users["u-s"]["status"] == "suspended"


async def test_approving_an_unknown_request_404s(db: _FakeDB) -> None:
    from gateway.routes.admin.access_requests import (
        ApproveRequest,
        approve_access_request,
    )

    with pytest.raises(HTTPException) as exc:
        await approve_access_request(
            "ghost@fracktal.in", ApproveRequest(), admin=FULL_ADMIN,
        )
    assert exc.value.status_code == 404


async def test_denying_marks_the_request_and_provisions_nobody(
    db: _FakeDB,
) -> None:
    """dw9."""
    from gateway.routes.admin.access_requests import deny_access_request

    db.seed_request("nope@fracktal.in")
    out = await deny_access_request("nope@fracktal.in", admin=FULL_ADMIN)

    assert out["status"] == "denied"
    assert db.requests["nope@fracktal.in"]["decided_by"] == "admin@fracktal.in"
    assert db.user_by_email("nope@fracktal.in") is None


async def test_a_denied_address_that_keeps_knocking_never_returns_to_pending(
    db: _FakeDB, world: _AccessWorld,
) -> None:
    """dw9 — the upsert bumps ``last_seen_at``/``attempt_count`` and leaves
    ``status`` alone, so a denial is not undone by persistence."""
    from acb_auth.access import _ACCESS_REQUEST_UPSERT_SQL

    normalised = " ".join(_ACCESS_REQUEST_UPSERT_SQL.split())
    conflict = normalised.split("DO UPDATE", 1)[1]
    assert "last_seen_at" in conflict
    assert "attempt_count" in conflict
    assert "status" not in conflict, (
        "the upsert's DO UPDATE arm touches status — a denied address would "
        "return to pending on its next sign-in"
    )


# ── Wiring: the /admin floor is per-route, not a package property ────────────

def test_every_new_request_route_declares_the_admin_floor() -> None:
    """dw6 — ``_common.py:31`` creates the router with **no** ``dependencies=``.

    Every existing route carries ``Depends(require_admin_user)`` in its own
    signature; a route added here that omits it inherits no floor at all and is
    reachable by any authenticated member. That is the easiest hole to ship in
    this package, so it is pinned rather than reviewed.
    """
    import inspect

    from gateway.routes.admin._common import require_admin_user, router

    found = 0
    for route in router.routes:
        path = getattr(route, "path", "")
        if not path.startswith("/admin/members/requests"):
            continue
        found += 1
        params = inspect.signature(route.endpoint).parameters.values()
        assert any(
            getattr(p.default, "dependency", None) is require_admin_user
            for p in params
        ), f"{sorted(route.methods)} {path} declares no require_admin_user floor"
    assert found == 3, f"expected 3 request routes, found {found}"


def test_the_two_request_writes_carry_the_invite_permission() -> None:
    """dw6/dw7 — no new permission slug: a slug nobody has been granted is
    nobody's grant until an admin creates it (the N4 lesson). Approve and deny
    reuse ``admin:members:invite``, which the roles seed already gives out."""
    from gateway.routes.admin._common import router

    writes = {
        route.path: route
        for route in router.routes
        if route.path.startswith("/admin/members/requests/")
    }
    assert len(writes) == 2
    for path, route in writes.items():
        deps = [
            getattr(d.dependency, "__qualname__", "")
            for d in getattr(route, "dependencies", [])
        ]
        assert any("require_permission" in q for q in deps), (
            f"{path} carries no require_permission gate"
        )


def test_the_requests_list_route_is_not_shadowed_by_the_member_routes() -> None:
    """``/admin/members/requests`` and ``/admin/members/{email}/access`` live on
    the same router; a future single-segment ``GET /members/{email}`` added
    above it would swallow the list."""
    from gateway.routes.admin._common import router

    for route in router.routes:
        if route.path == "/admin/members/requests":
            return
        if "GET" in (getattr(route, "methods", set()) or set()):
            assert not re.fullmatch(r"/admin/members/\{[^/]+\}", route.path), (
                f"{route.path} is registered before /admin/members/requests "
                f"and would shadow it"
            )
    raise AssertionError("GET /admin/members/requests is not registered")


# ── dw11: the Members list stops rendering `invited` as though it were live ──

def test_the_members_list_labels_an_invited_row_as_never_signed_in() -> None:
    """dw11 (carried over from the retracted N6b). ``invited`` renders today as
    a bare status word, which reads as a state of membership rather than the
    dead end it is — that ambiguity is what let the owner believe the job was
    done on 2026-08-04."""
    page = (
        REPO_ROOT
        / "workbench/control_plane/src/app/settings/members/page.tsx"
    ).read_text(encoding="utf-8")

    assert "never signed in" in page
