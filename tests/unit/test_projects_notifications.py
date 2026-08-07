"""WS-27j — notifications and @mentions.

Spec: `ai-company-brain/specs/project_management_app.md` §11.2 item 2.

The complaint this closes is one sentence: *"assignment is silent."* So the
claims worth testing are the ones that decide whether a person hears about
something, and the three that decide whether they should NOT:

* **never the actor** — a bell that pings you about your own click is a bell
  people mute, and a muted bell notifies nobody about anything;
* **never an agent** — agents are handed work by the dispatch sink, and a row
  addressed to one would sit unread forever inflating a badge nobody can clear;
* **never somebody who cannot open it** — the notification carries the task's
  title, so delivering one outside the grant closure leaks that title and lands
  the recipient on a 404.

The third is the security property, and it is the one that needed new
machinery: `resolve_visibility` reads a `UserContext`, and the recipient of a
mention has no request in flight. `resolve_visibility_for` answers for a third
party out of the same tables `/auth/me` reads, handing them to the REAL
`build_access` so a wildcard grant resolves identically on both paths.

**Why a local double rather than `_projects_fakes`.** That mirror reads
statement text to decide which rows a clause addresses, and these routes emit
shapes it was never built for — a UNION over two tables, a join-plus-count for
the badge, `id = ANY(CAST(:ids AS uuid[]))`. Teaching it those to serve one
suite is how a shared fake becomes a second, worse Postgres, which its own
docstring warns against. The genuinely interesting decisions here are pure and
are tested directly.

Hermetic: no Postgres, no TestClient.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from acb_auth import UserContext, UserRole, build_access
from gateway.routes.projects import activities as pm_activities
from gateway.routes.projects import core as pm_core
from gateway.routes.projects import notifications as pm_notify
from gateway.routes.projects import tasks as pm_tasks
from gateway.routes.projects.notifications import (
    NOTIFICATION_KINDS,
    excerpt_of,
    mention_targets,
    notifiable,
)

from tests.unit._projects_fakes import page

REPO = Path(__file__).resolve().parents[2]
MIGRATION = REPO / "infra" / "postgres" / "152_projects_notifications.sql"


def run(coro):
    return asyncio.run(coro)


def bare(text_: str) -> str:
    """SQL with ``--`` comments stripped.

    Every assertion about what the migration DOES runs against this. Its header
    explains the constraints by name, and a check its own prose can satisfy is
    a check that fails open — the trap this repo has now walked into twice.
    """
    return "\n".join(re.sub(r"--.*$", "", line) for line in text_.splitlines())


# ── The pure half ───────────────────────────────────────────────────────────

def test_a_mention_is_an_address_not_a_name():
    """Migration 148 dropped `UNIQUE(name)` because two real people share one.
    So `@Priya` has no answer, and guessing would notify the wrong person about
    work that is not theirs."""
    assert mention_targets("hey @priya@fracktal.in can you look") == [
        "priya@fracktal.in",
    ]
    assert mention_targets("hey @Priya can you look") == []


def test_mentions_are_lowercased_and_deduped_in_first_seen_order():
    body = "@Ravi@fracktal.in and @priya@fracktal.in — also @RAVI@fracktal.in"
    assert mention_targets(body) == ["ravi@fracktal.in", "priya@fracktal.in"]


def test_an_empty_comment_mentions_nobody():
    assert mention_targets(None) == []
    assert mention_targets("") == []


def test_the_actor_is_never_notified():
    """Rule 1, and the one that decides whether the bell gets muted."""
    assert notifiable(
        ["me@fracktal.in", "you@fracktal.in"], exclude="me@fracktal.in",
    ) == ["you@fracktal.in"]


def test_the_actor_is_excluded_case_insensitively():
    """R10. `actor()` returns the address as the token carried it, which is not
    guaranteed to match the lowercased assignee row."""
    assert notifiable(["ME@Fracktal.IN"], exclude="me@fracktal.in") == []


def test_an_agent_is_never_notified():
    """Rule 2. Agents are dispatched by the WS-27f sink, which starts a run —
    a row addressed to one is an inbox nobody ever opens."""
    assert notifiable(
        ["agent:builder", "you@fracktal.in"], exclude="me@fracktal.in",
    ) == ["you@fracktal.in"]


def test_blanks_and_duplicates_are_dropped():
    assert notifiable(
        ["  ", None, "You@fracktal.in", "you@fracktal.in"], exclude="",
    ) == ["you@fracktal.in"]


def test_an_excerpt_is_one_line():
    """The bell renders one row per line; a comment whose first line is blank
    would otherwise show as an empty notification."""
    assert excerpt_of("first\n\nsecond") == "first second"


def test_an_excerpt_is_ellipsised_not_truncated_silently():
    long = "x" * 400
    got = excerpt_of(long)
    assert len(got) == pm_notify.EXCERPT_CHARS
    assert got.endswith("…")


def test_a_blank_comment_has_no_excerpt():
    assert excerpt_of("   \n  ") is None


def test_notify_refuses_a_kind_the_database_would_refuse():
    with pytest.raises(ValueError):
        run(pm_notify.notify(
            db=None, recipients=["a@b.co"], kind="poked",
            task_id="t", actor_id="me@fracktal.in",
        ))


# ── The double ──────────────────────────────────────────────────────────────

class _Result:
    def __init__(self, rows: list[Any], rowcount: int = 0):
        self._rows = rows
        self.rowcount = rowcount

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)

    def scalar(self):
        return self._rows[0] if self._rows else None


class FakeDB:
    """Answers by statement fingerprint and records every statement.

    ``visible_to`` is the set of addresses for whom the task-visibility probe
    finds a row — i.e. who can open the task. That is the knob every rule-3
    test turns.
    """

    def __init__(self, *, visible_to: set[str] | None = None,
                 permissions: dict[str, list[tuple[str, str, bool]]] | None = None,
                 groups: dict[str, list[str]] | None = None,
                 audience: list[str] | None = None):
        self.visible_to = visible_to if visible_to is not None else set()
        self.permissions = permissions or {}
        self.groups = groups or {}
        self.audience = audience or []
        self.statements: list[str] = []
        self.params: list[dict] = []
        self.inserted: list[dict] = []

    async def execute(self, sql: Any, params: dict | None = None) -> _Result:
        statement = " ".join(str(sql).split())
        args = dict(params or {})
        self.statements.append(statement)
        self.params.append(args)

        if "INSERT INTO pm_notifications" in statement:
            self.inserted.append(args)
            return _Result([SimpleNamespace(id="n1")])
        if "org_role_permission" in statement:
            rows = self.permissions.get(args.get("email", ""), [])
            return _Result([
                SimpleNamespace(permission=p, effect=e, from_role=r)
                for p, e, r in rows
            ])
        if "org_group_member" in statement:
            return _Result([
                SimpleNamespace(subject=s)
                for s in self.groups.get(args.get("email", ""), [])
            ])
        if "FROM pm_task_assignees" in statement and "UNION" in statement:
            return _Result([SimpleNamespace(who=w) for w in self.audience])
        if "SELECT 1 FROM pm_tasks" in statement:
            # The rule-3 probe. `vis_email` is absent for an unrestricted
            # caller, whose clause is the literal TRUE.
            who = args.get("vis_email")
            seen = who is None or who in self.visible_to
            return _Result([SimpleNamespace(x=1)] if seen else [])
        if "UPDATE pm_notifications" in statement:
            return _Result([], rowcount=2)
        return _Result([])

    async def commit(self) -> None:
        return None

    async def close(self) -> None:
        return None

    def issued(self, fragment: str) -> bool:
        return any(fragment in s for s in self.statements)


def _user(email: str, *grants: str) -> UserContext:
    return UserContext(
        email=email, role=UserRole.EMPLOYEE, access=build_access(list(grants)),
    )


ACTOR = _user("me@fracktal.in", "feature:projects")


def bind(monkeypatch, db: FakeDB, *modules) -> None:
    async def _get_db():
        return db

    for module in modules or (pm_notify,):
        monkeypatch.setattr(module, "_get_db", _get_db, raising=False)


# ── Rule 3: nobody hears about a task they cannot open ──────────────────────

def test_a_mention_of_somebody_who_cannot_see_the_task_writes_nothing(monkeypatch):
    db = FakeDB(visible_to=set())
    result = run(pm_notify.notify(
        db, recipients=["outsider@fracktal.in"], kind="mention",
        task_id="t1", actor_id="me@fracktal.in",
    ))
    assert db.inserted == []
    assert result["notified"] == []
    # Reported, not swallowed: a mention that reached nobody would otherwise
    # leave the author believing they pulled a colleague in.
    assert result["skipped"] == ["outsider@fracktal.in"]


def test_a_mention_of_somebody_who_can_see_the_task_is_written(monkeypatch):
    db = FakeDB(visible_to={"priya@fracktal.in"})
    result = run(pm_notify.notify(
        db, recipients=["priya@fracktal.in"], kind="mention",
        task_id="t1", actor_id="me@fracktal.in", excerpt="hello",
    ))
    assert result == {"notified": ["priya@fracktal.in"], "skipped": []}
    assert len(db.inserted) == 1
    row = db.inserted[0]
    assert row["recipient"] == "priya@fracktal.in"
    assert row["kind"] == "mention"
    assert row["actor"] == "me@fracktal.in"


def test_deliverability_is_the_RECIPIENTS_visibility_not_the_actors(monkeypatch):
    """The whole reason `resolve_visibility_for` exists. Checking the actor's
    access would let anyone who can see a task mention anyone at all into it."""
    db = FakeDB(visible_to={"insider@fracktal.in"})
    result = run(pm_notify.notify(
        db, recipients=["insider@fracktal.in", "outsider@fracktal.in"],
        kind="mention", task_id="t1", actor_id="me@fracktal.in",
    ))
    assert result["notified"] == ["insider@fracktal.in"]
    assert result["skipped"] == ["outsider@fracktal.in"]
    assert [r["recipient"] for r in db.inserted] == ["insider@fracktal.in"]


def test_the_visibility_probe_is_scoped_to_the_root_project(monkeypatch):
    """Grants hang off the project tree, and a task's authority is its ROOT —
    probing `project_id` would miss a grant made on an ancestor."""
    db = FakeDB(visible_to={"priya@fracktal.in"})
    run(pm_notify.deliverable(db, ["priya@fracktal.in"], "t1"))
    assert db.issued("root_project_id")


# ── resolve_visibility_for — the third-party answer ─────────────────────────

def test_an_org_read_holder_is_unrestricted_even_by_wildcard():
    """The owner holds `*`. Re-deriving the match in SQL is how two answers to
    "may they see this" start disagreeing, so the REAL matcher decides."""
    db = FakeDB(permissions={"owner@fracktal.in": [("*", "allow", True)]})
    vis = run(pm_core.resolve_visibility_for(db, "owner@fracktal.in"))
    assert vis.unrestricted is True
    assert vis.project_clause("t.root_project_id") == "TRUE"


def test_a_deny_override_beats_the_role_grant():
    """Allow/deny precedence is `EffectiveAccess`'s, not a re-implementation."""
    db = FakeDB(permissions={"ex@fracktal.in": [
        ("data:org:read", "allow", True),
        ("data:org:read", "deny", False),
    ]})
    vis = run(pm_core.resolve_visibility_for(db, "ex@fracktal.in"))
    assert vis.unrestricted is False


def test_a_restricted_person_carries_their_groups():
    db = FakeDB(
        permissions={"ravi@fracktal.in": [("feature:projects", "allow", True)]},
        groups={"ravi@fracktal.in": ["group:ops"]},
    )
    vis = run(pm_core.resolve_visibility_for(db, "ravi@fracktal.in"))
    assert vis.unrestricted is False
    assert vis.email == "ravi@fracktal.in"
    assert vis.groups == ("group:ops",)


def test_a_directory_only_colleague_resolves_to_nothing_rather_than_erroring():
    """§2's two-store split: somebody with no `app_user` row can be assigned
    work and mentioned. They simply have nothing to open it with."""
    db = FakeDB()
    vis = run(pm_core.resolve_visibility_for(db, "contractor@example.com"))
    assert vis.unrestricted is False
    assert vis.groups == ()


def test_an_empty_address_asks_the_database_nothing():
    db = FakeDB()
    vis = run(pm_core.resolve_visibility_for(db, "  "))
    assert vis.unrestricted is False
    assert db.statements == []


def test_the_lookup_is_case_insensitive_on_both_sides():
    """R10 — the query lowercases the column, so the parameter must match."""
    db = FakeDB()
    run(pm_core.resolve_visibility_for(db, " Ravi@Fracktal.IN "))
    assert db.params[0]["email"] == "ravi@fracktal.in"


# ── Reading ─────────────────────────────────────────────────────────────────

def test_the_list_is_scoped_to_the_caller_and_takes_no_recipient_parameter():
    """R3. A `?recipient=` would be an inbox readable by guessing an address."""
    import inspect

    params = set(inspect.signature(pm_notify.list_notifications).parameters)
    assert "recipient" not in params


def test_the_list_filters_by_the_readers_visibility(monkeypatch):
    """The audience is fixed when the event happens, but a person who has since
    lost the project stops seeing the row: a notification is a pointer to a
    task, and a pointer that outlives the permission is a title leak."""
    db = FakeDB()
    bind(monkeypatch, db, pm_notify, pm_core)
    run(pm_notify.list_notifications(user=ACTOR, page=page()))
    listed = next(s for s in db.statements if "FROM pm_notifications n" in s
                  and "ORDER BY" in s)
    assert "pm_project_grants" in listed
    assert "n.recipient = :me" in listed


def test_the_badge_count_cannot_promise_more_than_the_list_shows(monkeypatch):
    """Counted through the SAME clause. A count over the raw table would show a
    badge that never clears, because the rows behind it are unreachable."""
    db = FakeDB()
    bind(monkeypatch, db, pm_notify, pm_core)
    run(pm_notify.list_notifications(user=ACTOR, page=page()))
    counted = next(s for s in db.statements if "count(*)" in s)
    assert "pm_project_grants" in counted
    assert "read_at IS NULL" in counted


def test_unread_only_narrows_the_list(monkeypatch):
    db = FakeDB()
    bind(monkeypatch, db, pm_notify, pm_core)
    run(pm_notify.list_notifications(unread_only=True, user=ACTOR, page=page()))
    listed = next(s for s in db.statements if "ORDER BY n.created_at" in s)
    assert "n.read_at IS NULL" in listed


def test_marking_read_never_moves_an_existing_timestamp(monkeypatch):
    """`read_at IS NULL` in the WHERE is not an optimisation: without it every
    page refresh that cleared the bell would rewrite when you first saw it."""
    db = FakeDB()
    bind(monkeypatch, db, pm_notify, pm_core)
    run(pm_notify.mark_read(pm_notify.ReadIn(all=True), user=ACTOR))
    updated = next(s for s in db.statements if "UPDATE pm_notifications" in s)
    assert "read_at IS NULL" in updated


def test_marking_read_is_scoped_to_your_own_rows(monkeypatch):
    db = FakeDB()
    bind(monkeypatch, db, pm_notify, pm_core)
    run(pm_notify.mark_read(
        pm_notify.ReadIn(ids=["11111111-1111-1111-1111-111111111111"]),
        user=ACTOR,
    ))
    updated = next(s for s in db.statements if "UPDATE pm_notifications" in s)
    assert "recipient = :me" in updated


def test_marking_nothing_touches_the_database(monkeypatch):
    db = FakeDB()
    bind(monkeypatch, db, pm_notify, pm_core)
    assert run(pm_notify.mark_read(pm_notify.ReadIn(), user=ACTOR)) == {"marked": 0}
    assert db.statements == []


# ── Wiring: the write sites that produce notifications ─────────────────────

def test_assigning_somebody_notifies_them(monkeypatch):
    db = FakeDB(visible_to={"priya@fracktal.in"})
    bind(monkeypatch, db, pm_tasks, pm_notify, pm_core)
    monkeypatch.setattr(pm_tasks, "load_visible_task",
                        _async(SimpleNamespace(id="t1")))
    monkeypatch.setattr(pm_tasks, "resolve_visibility",
                        _async(pm_core.Visibility(True, "", ())))
    monkeypatch.setattr(pm_tasks, "record_activity", _async(None))
    monkeypatch.setattr(pm_tasks, "emit", _async(None))
    run(pm_tasks.set_assignees(
        "t1", pm_tasks.AssigneesIn(assignees=["priya@fracktal.in"]), ACTOR,
    ))
    assert [r["kind"] for r in db.inserted] == ["assigned"]
    assert db.inserted[0]["recipient"] == "priya@fracktal.in"


def test_the_notification_is_written_inside_the_assignment_transaction(monkeypatch):
    """Not emitted on the bus afterwards. `emit` swallows failures by
    construction so a broken workflow can never fail a task edit — right for
    agent dispatch, wrong here. An assignment that committed while its
    notification did not is the silent assignment this ticket closes."""
    db = FakeDB(visible_to={"priya@fracktal.in"})
    bind(monkeypatch, db, pm_tasks, pm_notify, pm_core)
    monkeypatch.setattr(pm_tasks, "load_visible_task",
                        _async(SimpleNamespace(id="t1")))
    monkeypatch.setattr(pm_tasks, "resolve_visibility",
                        _async(pm_core.Visibility(True, "", ())))
    monkeypatch.setattr(pm_tasks, "record_activity", _async(None))

    order: list[str] = []
    orig_commit = db.commit

    async def _commit():
        order.append("commit")
        return await orig_commit()

    async def _emit(*_a, **_k):
        order.append("emit")

    db.commit = _commit
    monkeypatch.setattr(pm_tasks, "emit", _emit)
    run(pm_tasks.set_assignees(
        "t1", pm_tasks.AssigneesIn(assignees=["priya@fracktal.in"]), ACTOR,
    ))
    assert db.inserted, "no notification was written"
    assert order == ["commit", "emit"]


def test_assigning_yourself_notifies_nobody(monkeypatch):
    db = FakeDB(visible_to={"me@fracktal.in"})
    bind(monkeypatch, db, pm_tasks, pm_notify, pm_core)
    monkeypatch.setattr(pm_tasks, "load_visible_task",
                        _async(SimpleNamespace(id="t1")))
    monkeypatch.setattr(pm_tasks, "resolve_visibility",
                        _async(pm_core.Visibility(True, "", ())))
    monkeypatch.setattr(pm_tasks, "record_activity", _async(None))
    monkeypatch.setattr(pm_tasks, "emit", _async(None))
    run(pm_tasks.set_assignees(
        "t1", pm_tasks.AssigneesIn(assignees=["me@fracktal.in"]), ACTOR,
    ))
    assert db.inserted == []


def test_a_mention_outranks_the_comment_notification(monkeypatch):
    """Somebody who is both mentioned and an assignee gets ONE row, and it is
    the mention — "you were named" is a stronger claim on attention than "the
    task you hold got a comment"."""
    db = FakeDB(
        visible_to={"priya@fracktal.in"},
        audience=["priya@fracktal.in"],
    )
    bind(monkeypatch, db, pm_activities, pm_notify, pm_core)
    monkeypatch.setattr(pm_activities, "load_visible_task",
                        _async(SimpleNamespace(id="t1")))
    monkeypatch.setattr(pm_activities, "resolve_visibility",
                        _async(pm_core.Visibility(True, "", ())))
    monkeypatch.setattr(pm_activities, "record_activity",
                        _async(SimpleNamespace(id="a1", type="comment")))
    monkeypatch.setattr(pm_activities, "row_to_dict", lambda row, model: {})
    monkeypatch.setattr(pm_activities, "emit", _async(None))
    run(pm_activities.add_comment(
        "t1", pm_activities.CommentIn(body="ping @priya@fracktal.in"), ACTOR,
    ))
    assert [r["kind"] for r in db.inserted] == ["mention"]


def test_a_plain_comment_reaches_the_tasks_assignees(monkeypatch):
    db = FakeDB(
        visible_to={"priya@fracktal.in"},
        audience=["priya@fracktal.in", "me@fracktal.in"],
    )
    bind(monkeypatch, db, pm_activities, pm_notify, pm_core)
    monkeypatch.setattr(pm_activities, "load_visible_task",
                        _async(SimpleNamespace(id="t1")))
    monkeypatch.setattr(pm_activities, "resolve_visibility",
                        _async(pm_core.Visibility(True, "", ())))
    monkeypatch.setattr(pm_activities, "record_activity",
                        _async(SimpleNamespace(id="a1", type="comment")))
    monkeypatch.setattr(pm_activities, "row_to_dict", lambda row, model: {})
    monkeypatch.setattr(pm_activities, "emit", _async(None))
    run(pm_activities.add_comment(
        "t1", pm_activities.CommentIn(body="no names here"), ACTOR,
    ))
    # The commenter is in the audience and is still excluded.
    assert [r["recipient"] for r in db.inserted] == ["priya@fracktal.in"]
    assert db.inserted[0]["kind"] == "comment"
    assert db.inserted[0]["excerpt"] == "no names here"


def _async(value):
    async def _fn(*_a, **_k):
        return value
    return _fn


# ── Migration 152 ───────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def sql() -> str:
    return bare(MIGRATION.read_text(encoding="utf-8"))


def test_the_table_and_its_indexes_are_guarded(sql: str):
    assert "CREATE TABLE IF NOT EXISTS pm_notifications" in sql
    for match in re.finditer(r"CREATE\s+(?:UNIQUE\s+)?INDEX\s+(\w+)?", sql):
        assert match.group(1) == "IF", sql[match.start():match.start() + 80]


def test_an_agent_cannot_be_a_recipient(sql: str):
    """Rule 2 at the schema, not only in Python. A row that reached the table
    another way would still be refused."""
    assert re.search(r"recipient\s+NOT\s+LIKE\s+'agent:%'", sql)


def test_the_recipient_is_stored_lowercased(sql: str):
    """The badge query looks up by exact match; a mixed-case row would be
    invisible to its own owner."""
    assert re.search(r"recipient\s*=\s*lower\s*\(\s*recipient\s*\)", sql)


def test_a_deleted_task_takes_its_notifications_with_it(sql: str):
    """Otherwise the badge counts links to a 404."""
    block = sql.split("CREATE TABLE IF NOT EXISTS pm_notifications", 1)[1]
    block = block.split(");", 1)[0]
    assert re.search(
        r"task_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+pm_tasks\s*\(id\)"
        r"\s+ON\s+DELETE\s+CASCADE",
        block, re.I,
    )


def test_the_badge_index_is_partial(sql: str):
    """The unread tail, not every notification the org has ever produced."""
    assert re.search(
        r"idx_pm_notifications_unread.*?WHERE\s+read_at\s+IS\s+NULL",
        sql, re.S,
    )


def test_the_kind_vocabulary_matches_the_module(sql: str):
    match = re.search(r"kind\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(kind\s+IN\s*\((.*?)\)\)",
                      sql, re.S)
    assert match
    assert set(re.findall(r"'([a-z_]+)'", match.group(1))) == set(NOTIFICATION_KINDS)
