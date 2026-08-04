"""In-memory doubles for the ``gateway.routes.admin`` package.

Extracted from ``test_signin_requests.py`` when a second file
(``test_admin_member_offboarding.py``) needed the same ``app_user`` /
``user_role`` / ``access_request`` world. There is one org-admin fake, not one
per test file: two copies of a DB mirror drift, and the copy that drifts is the
one that stops failing.

Not named ``test_*``, so pytest imports it without collecting it.

Same convention as ``test_admin_groups.py``: the route functions are called
directly with the DB seam monkeypatched onto the SUT submodule, so nothing here
touches Postgres.
"""
from __future__ import annotations

from typing import Any, ClassVar

ORG = "00000000-0000-0000-0000-00000000000a"


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

    SQL is matched on normalised substrings — the exact strings the routes
    render — so a query-shape change fails loudly here rather than silently in
    production.

    ⚠️ **This is a MIRROR, not Postgres, and a mirror can only agree with
    itself.** The ``INSERT INTO app_user`` branch below re-implements the
    ``ON CONFLICT DO UPDATE`` arms in Python, the ``joined_at`` ``CASE`` in the
    status ``UPDATE`` likewise, and ``ORDER BY`` is ignored entirely. So every
    claim that lives *inside* a SQL statement — which statuses provisioning
    rewrites, what order the queue is served in — is asserted **structurally
    against the statement string** instead, in the "the SQL itself" section of
    ``test_signin_requests.py``. A behavioural case here proves the route calls
    the right statement with the right parameters; it cannot prove the
    statement says what we think.

    That gap is not hypothetical: widening the guard at
    ``_common._PROVISION_MEMBER_SQL`` to ``app_user.status <> 'active'``
    (which lets approve reinstate an off-boarded member on the weaker
    ``admin:members:invite``) left every behavioural case green, because the
    mirror below kept the old rule. Keep the two in step — and when they
    disagree, the structural assertion is the one that is right.

    A guard written in **Python inside a route** — ``assert_not_self_lockout``,
    ``assert_owner_survives`` — is the opposite case: the SUT runs for real and
    the fake only has to record what was written, so a behavioural assertion
    here is a genuine check on it. The discriminator to keep in mind there is
    that both of those raise **409**, so a test must assert the detail text or
    what was and was not written, never the bare status code.
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
            # ON CONFLICT (email) DO UPDATE — mirror of _PROVISION_MEMBER_SQL's
            # CASE arms. Keep in step with it; the structural test is the fence.
            if p.get("name"):
                existing["display_name"] = p["name"]
            wanted = p.get("status", "invited")
            prior = existing["status"]
            if prior == "invited" or (prior == "removed" and wanted != "active"):
                existing["status"] = wanted
                if prior == "invited" and wanted == "active" \
                        and not existing["joined_at"]:
                    existing["joined_at"] = "now()"
            return _Rows([], rowcount=1)

        if "FROM app_user WHERE lower(email)" in s:
            row = self.user_by_email(p["email"])
            return _Rows([dict(row)] if row else [])

        if "UPDATE app_user SET status = :status" in s:
            # members.update_member — the lifecycle PATCH. Mirror of the
            # statement's `joined_at` CASE: activation stamps it once and no
            # other transition touches it.
            row = self.users[p["uid"]]
            row["status"] = p["status"]
            if p["status"] == "active" and not row["joined_at"]:
                row["joined_at"] = "now()"
            return _Rows([], rowcount=1)

        if "UPDATE app_user SET display_name = :name" in s:
            self.users[p["uid"]]["display_name"] = p["name"]
            return _Rows([], rowcount=1)

        if "UPDATE app_user SET status = 'removed'" in s:
            # members.remove_member — the off-boarding half of the P1 scenario.
            self.users[p["uid"]]["status"] = "removed"
            return _Rows([], rowcount=1)

        if "DELETE FROM user_role WHERE user_id" in s:
            self.user_roles[p["uid"]] = []
            return _Rows([], rowcount=1)

        if "INSERT INTO user_role" in s:
            slug = str(p["rid"]).removeprefix("role-")
            self.user_roles.setdefault(p["uid"], []).append(slug)
            return _Rows([], rowcount=1)

        if "r.slug = 'owner'" in s:
            # owner_count(): how many ACTIVE members would still hold `owner`.
            excluded = p.get("uid")
            return _Rows([{"count": sum(
                1 for uid, slugs in self.user_roles.items()
                if "owner" in slugs and uid != excluded
                and (self.users.get(uid) or {}).get("status") == "active"
            )}])

        if "SELECT r.slug FROM user_role ur" in s:
            slugs = self.user_roles.get(p["uid"], [])
            return _Rows([
                {"slug": x}
                for x in sorted(slugs, key=lambda y: self.ROLE_RANKS.get(y, 999))
            ])

        if "UPDATE access_request SET" in s:
            row = self.requests.get(str(p["email"]).lower())
            # Mirrors `_DECIDE_SQL`'s `AND status = ANY(:allowed)` — the
            # write's own copy of the filter the read already checked, which
            # is what makes two concurrent decisions resolve to one. No rows
            # updated ⇒ the RETURNING clause yields nothing.
            if row is None or row["status"] not in p["allowed"]:
                return _Rows([], rowcount=0)
            row["status"] = p["status"]
            row["decided_by"] = p["by"]
            row["decided_at"] = "now()"
            return _Rows([{"id": row["id"]}], rowcount=1)

        if "FROM access_request" in s:
            if "lower(email) = :email" in s:
                row = self.requests.get(str(p["email"]).lower())
                return _Rows([dict(row)] if row else [])
            rows = [
                dict(r) for r in self.requests.values() if r["status"] == "pending"
            ]
            return _Rows(rows)

        raise AssertionError(f"unhandled SQL in fake: {s}")


def bind_admin_db(monkeypatch: Any, fake: _FakeDB, modules: tuple[Any, ...]) -> None:
    """Point each admin submodule's DB / cache / audit seams at ``fake``.

    Per-module and not per-package because the routes import the seams by name
    (``from _common import get_db``), so patching ``_common`` alone would not
    reach them.
    """
    async def _get_db() -> _FakeDB:
        return fake

    for module in modules:
        monkeypatch.setattr(module, "get_db", _get_db)
        monkeypatch.setattr(
            module, "invalidate_for",
            lambda *e: fake.invalidated.extend(x for x in e if x),
        )
        monkeypatch.setattr(
            module, "record_admin_change",
            lambda actor, action, target, **kw: fake.audit.append((action, target)),
        )
