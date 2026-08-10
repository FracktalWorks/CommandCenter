"""WS-27ae (the export third) against a REAL Postgres — R8.

The hermetic suite mirrors this endpoint's SQL by reading statement text, so it
agrees with whatever it is handed. What only a database can answer:

* does ``SELECT count(*) FROM pm_tasks t WHERE …`` return the **same set size**
  the row query then returns? The whole never-truncated contract rests on those
  two statements composing the identical predicate, and a fake will happily
  answer both from the same Python list no matter what the SQL says.
* does ``count(*) AS files FROM pm_task_attachments WHERE task_id =
  ANY(CAST(:ids AS uuid[]))`` bind a list of Python ``str`` at a ``uuid[]``?
  (WS-27k and WS-27r were both real asyncpg CAST defects that shipped green.)
* does ``SELECT id, name FROM pm_task_statuses WHERE id = ANY(CAST(:ids AS
  uuid[]))`` do the same, and hand back names the CSV can print?
* does ``?status_category=done`` actually narrow to the DONE tasks? ⚠️ The
  hermetic fake read that clause as "hide closed work" until this ticket —
  every behavioural test in the tree filtered on ``todo``, where the two
  answers coincide, so the mirror returned the OPEN tasks and agreed with
  itself. The live run is the only reason that was found.
* does the grant closure actually scope an export with no ``project_id`` — the
  one shape where a missing visibility clause downloads the company?
* and the bytes: a title carrying a comma, a quote, a newline and a leading
  ``=`` through the real writer, re-parsed by ``csv.reader``.

Run:
    su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/ccpg \\
        -l /var/tmp/ccpg.log -o '-k /var/tmp -p 55432' start"
    uv run python tests/live/live_ws27ae.py

⚠️ ``seed()`` TRUNCATEs ``pm_projects CASCADE``. Scratch databases only.
"""
import asyncio
import csv
import io
import os
import pathlib
import sys

os.environ["DATABASE_URL"] = (
    "postgresql+asyncpg://postgres@/cc?host=/var/tmp&port=55432"
)
# Derived from THIS file, never hard-coded: run from a git worktree, an
# absolute path silently imports the MAIN checkout's gateway and the script
# then reports on code that is not the code under test (live_ws27aa's finding).
sys.path.insert(0, str(
    pathlib.Path(__file__).resolve().parents[2] / "apps" / "services" / "gateway"
))

from acb_auth import UserContext, UserRole, build_access
from acb_common.db import bind_tenant, release_tenant
from gateway.db import get_db
from gateway.routes.projects import export as pm_export
from sqlalchemy import text

OWNER = "priya@fracktal.in"
OUTSIDER = "colleague@fracktal.in"

OPS = "11111111-0000-4000-8000-000000000001"
FIN = "11111111-0000-4000-8000-000000000002"
TODO = "22222222-0000-4000-8000-000000000001"
DONE = "22222222-0000-4000-8000-000000000002"
FIN_TODO = "22222222-0000-4000-8000-000000000003"
NASTY_TASK = "33333333-0000-4000-8000-00000000000e"

#: Comma + quote + newline + a leading `=`, in one title. The acceptance case.
NASTY = '=SUM(A1),"drop"\nline two'

failures: list[str] = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got {got!r}, want {want!r}")
    if not ok:
        failures.append(label)


def user(email: str, *, features: str = "*"):
    return UserContext(
        email=email, role=UserRole.EMPLOYEE, access=build_access([features]),
    )


async def seed() -> str:
    db = await get_db()
    try:
        await db.execute(text("TRUNCATE pm_projects CASCADE"))
        await db.execute(
            text("DELETE FROM app_user WHERE email = ANY(:e)"),
            {"e": [OWNER, OUTSIDER]},
        )
        await db.execute(
            text("DELETE FROM organization WHERE slug = 'ws27ae'")
        )
        org = str((await db.execute(text(
            "INSERT INTO organization (slug, display_name) "
            "VALUES ('ws27ae', 'WS-27ae') RETURNING id"))).fetchone().id)
        # Both principals are in the SAME tenant: this ticket's boundary is
        # the grant closure (who inside the company), not the tenant. The
        # cross-tenant proof is WS-27aa's and is not re-litigated here.
        for email in (OWNER, OUTSIDER):
            await db.execute(text(
                "INSERT INTO app_user (email, display_name, role, status, "
                "organization_id) VALUES (:e, :e, 'employee', 'active', "
                "CAST(:o AS uuid))"), {"e": email, "o": org})
        for pid, name in ((OPS, "Ops"), (FIN, "Finance")):
            await db.execute(text(
                "INSERT INTO pm_projects (id, name, source, created_by, "
                "organization_id) VALUES (CAST(:p AS uuid), :n, 'manual', :me, "
                "CAST(:o AS uuid))"),
                {"p": pid, "n": name, "me": OWNER, "o": org})
        # OWNER can see Ops only; Finance belongs to somebody else. Without the
        # second project the unscoped export proves nothing.
        await db.execute(text(
            "INSERT INTO pm_project_grants (project_id, subject, created_by) "
            "VALUES (CAST(:p AS uuid), :s, :s)"), {"p": OPS, "s": OWNER})
        await db.execute(text(
            "INSERT INTO pm_project_grants (project_id, subject, created_by) "
            "VALUES (CAST(:p AS uuid), :s, :s)"), {"p": FIN, "s": OUTSIDER})
        for sid, pid, name, cat, dflt, pos in (
            (TODO, OPS, "To do", "todo", True, 10),
            (DONE, OPS, "Shipped", "done", False, 40),
            (FIN_TODO, FIN, "To do", "todo", True, 10),
        ):
            await db.execute(text(
                "INSERT INTO pm_task_statuses (id, project_id, name, position, "
                "category, is_default) VALUES (CAST(:s AS uuid), "
                "CAST(:p AS uuid), :n, :pos, :c, :d)"),
                {"s": sid, "p": pid, "n": name, "pos": pos, "c": cat, "d": dflt})

        # Two open, two closed, in Ops; one in Finance the owner cannot see.
        rows = [
            (OPS, TODO, "Ship the release", 1, ["bug"]),
            (OPS, TODO, "Write the notes", 2, []),
            (OPS, DONE, "Shipped last week", 3, ["ops"]),
            (OPS, DONE, "Shipped last month", 4, []),
            (FIN, FIN_TODO, "Reconcile the ledger", 1, []),
        ]
        for pid, sid, title, number, tags in rows:
            await db.execute(text(
                "INSERT INTO pm_tasks (id, project_id, root_project_id, "
                "status_id, title, task_number, tags, created_by) VALUES "
                "(gen_random_uuid(), CAST(:p AS uuid), CAST(:p AS uuid), "
                "CAST(:s AS uuid), :ti, :n, CAST(:tg AS text[]), :me)"),
                {"p": pid, "s": sid, "ti": title, "n": number, "tg": tags,
                 "me": OWNER})
        # The hostile title, plus two attachment rows on it.
        await db.execute(text(
            "INSERT INTO pm_tasks (id, project_id, root_project_id, status_id, "
            "title, task_number, created_by) VALUES (CAST(:t AS uuid), "
            "CAST(:p AS uuid), CAST(:p AS uuid), CAST(:s AS uuid), :ti, 5, :me)"),
            {"t": NASTY_TASK, "p": OPS, "s": TODO, "ti": NASTY, "me": OWNER})
        # `pm_task_attachments.attachment_id` carries no FK (the blob store is
        # a separate concern), so two link rows are enough to count.
        for _ in range(2):
            await db.execute(text(
                "INSERT INTO pm_task_attachments (task_id, attachment_id, "
                "added_by) VALUES (CAST(:t AS uuid), gen_random_uuid(), :me)"),
                {"t": NASTY_TASK, "me": OWNER})
        await db.execute(text(
            "INSERT INTO pm_task_assignees (task_id, assignee, assigned_by) "
            "VALUES (CAST(:t AS uuid), :who, :who)"),
            {"t": NASTY_TASK, "who": OWNER})
        await db.commit()
        return org
    finally:
        await db.close()


async def export(**kwargs) -> tuple[list[list[str]], dict]:
    """Run the endpoint for real and parse the bytes it produced."""
    who = kwargs.pop("user", user(OWNER))
    response = await pm_export.export_tasks_csv(user=who, **kwargs)
    body = response.body.decode("utf-8")
    assert body.startswith(pm_export.BOM), "the UTF-8 BOM is missing"
    return list(csv.reader(io.StringIO(body[len(pm_export.BOM):]))), dict(
        response.headers
    )


async def main():
    org = await seed()
    # The request path binds the tenant ONCE, centrally, from the authenticated
    # session's `app_user` row (`acb_auth.deps` → `bind_tenant`) — so the route
    # itself opens `tenant_session()` with no argument. Reproduced here rather
    # than passing a tenant into the endpoint, because an endpoint that TOOK
    # one would be the R11 violation this ticket had to avoid.
    token = bind_tenant(org)
    try:
        return await checks()
    finally:
        release_tenant(token)


async def checks():
    # ── The whole project, sorted, with the number and title columns ───────
    rows, headers = await export(
        project_id=OPS, sort="task_number", direction="asc",
    )
    check("the header row is the unconditional pair", rows[0], ["#", "Title"])
    check("every Ops task is exported", len(rows) - 1, 5)
    check("it is a CSV", headers["content-type"], "text/csv; charset=utf-8")
    check("it downloads as a file",
          headers["content-disposition"].startswith("attachment; filename="),
          True)
    check("the row count is stated", headers["x-export-rows"], "5")

    # ── The filter, and the one the hermetic fake got wrong ────────────────
    rows, _ = await export(project_id=OPS, status_category="done",
                           sort="task_number", direction="asc")
    check("?status_category=done exports the DONE tasks",
          [r[1] for r in rows[1:]],
          ["Shipped last week", "Shipped last month"])
    rows, _ = await export(project_id=OPS, status_category="todo",
                           sort="task_number", direction="asc")
    check("?status_category=todo exports the OPEN tasks",
          [r[1] for r in rows[1:]],
          ["Ship the release", "Write the notes", f"'{NASTY}"])
    rows, _ = await export(project_id=OPS, q="release")
    check("a text filter reaches the export", [r[1] for r in rows[1:]],
          ["Ship the release"])
    rows, _ = await export(project_id=OPS, tags="bug")
    check("a tag filter reaches the export", [r[1] for r in rows[1:]],
          ["Ship the release"])
    rows, _ = await export(project_id=OPS, assignee=OWNER)
    check("an assignee filter reaches the export",
          [r[1] for r in rows[1:]], [f"'{NASTY}"])

    # ── The columns ────────────────────────────────────────────────────────
    rows, _ = await export(
        project_id=OPS, shown_fields="tags,status,assignees,attachments",
        sort="task_number", direction="asc",
    )
    check("the columns are the view's, in the vocabulary's order",
          rows[0], ["#", "Title", "Status", "Assignees", "Tags", "Files"])
    by_title = {r[1]: r for r in rows[1:]}
    check("the status column carries the lane's real name",
          by_title["Ship the release"][2], "To do")
    check("the tags column carries the array",
          by_title["Ship the release"][4], "bug")
    check("the attachment count is real",
          by_title[f"'{NASTY}"][5], "2")
    check("a task with no attachments has an empty cell",
          by_title["Ship the release"][5], "")
    check("the assignee roll-up survives onto the export",
          by_title[f"'{NASTY}"][3], OWNER)

    # ── The bytes ──────────────────────────────────────────────────────────
    rows, _ = await export(project_id=OPS, status_id=TODO, q="SUM")
    check("the hostile title round-trips through a real CSV parse",
          [r[1] for r in rows[1:]], [f"'{NASTY}"])

    # ── Visibility, with no project named ──────────────────────────────────
    rows, _ = await export(user=user(OUTSIDER, features="feature:projects"))
    check("an unscoped export carries only the caller's own grants",
          [r[1] for r in rows[1:]], ["Reconcile the ledger"])
    try:
        await export(project_id=OPS, user=user(OUTSIDER, features="feature:projects"))
        check("a project the caller cannot see is refused", "no error", "404")
    except Exception as exc:
        check("a project the caller cannot see is refused",
              getattr(exc, "status_code", type(exc)), 404)

    # ── The cap is a refusal, on a real count ──────────────────────────────
    real_cap = pm_export.MAX_EXPORT_ROWS
    pm_export.MAX_EXPORT_ROWS = 2
    try:
        try:
            await export(project_id=OPS)
            check("past the cap is refused", "no error", "422")
        except Exception as exc:
            check("past the cap is refused",
                  getattr(exc, "status_code", type(exc)), 422)
            check("the refusal names the real count",
                  "5 tasks match" in str(getattr(exc, "detail", "")), True)
        rows, _ = await export(project_id=OPS, q="release")
        check("narrowing under the cap exports in full", len(rows) - 1, 1)
    finally:
        pm_export.MAX_EXPORT_ROWS = real_cap

    # ── The count and the row query must compose the SAME predicate ────────
    # The never-truncated contract IS this equality. A fake answers both from
    # one Python list and cannot see them diverge.
    for label, kwargs in (
        ("no filter", {}),
        ("status_category", {"status_category": "done"}),
        ("q", {"q": "the"}),
        ("overdue", {"overdue": True}),
        ("unassigned", {"unassigned": True}),
        ("tags", {"tags": "bug,ops"}),
        ("importance_gte", {"importance_gte": 1}),
    ):
        rows, headers = await export(project_id=OPS, **kwargs)
        check(f"count == rows exported ({label})",
              headers["x-export-rows"], str(len(rows) - 1))

    print()
    if failures:
        print(f"{len(failures)} FAILED: {failures}")
        return 1
    print("all checks passed")
    return 0


# Guarded so the seeding and the endpoint call can be reused by a driver that
# needs the REAL bytes (the browser fixture records them) without this script's
# whole run — and its `sys.exit` — happening on import.
if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
