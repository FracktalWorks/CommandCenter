"""People Center · skills coverage & data quality (WS-28m).

Spec: ``project-docs/specs/people_center_app.md`` §5.10 · D-PC-13, D-PC-14.

    GET /people/quality   → what is wrong with the record, in two panels

Two questions with one surface, because both are "what is wrong with the
record":

* **Coverage** — which skills exist in exactly one person (a bus factor of
  one), which appear in job titles but in nobody's declared skills, which are
  declared and never mentioned by any task.
* **Quality** — rows with no email (no self-service, no assignment), rows
  migration 148 QUARANTINED (`email_conflict` set — a human still has to choose
  which row is the real person), statuses outside the vocabulary (148's CHECK
  is ``NOT VALID`` where legacy data was dirty), managers pointing at alumni,
  people with no manager, and profiles whose AI-relevant fields are empty.

The ``email_conflict`` and outside-vocabulary rows are **listed here by
design**: 148 deliberately quarantined rather than failed the deploy, and this
panel is where that decision gets paid off. A quarantine nobody surfaces is a
data loss with a delay.

**One matcher** (§5.5): "never used on a task" is decided by
:func:`~gateway.routes.people.search.skill_pattern` — the same boundary the
capability ranker uses — so a skill cannot count as *matched* by the ranker and
*unused* by this panel at once. The task scan is scoped by the VIEWER's grant
closure (the dashboard's own ``_scope``, D-PC-20): an unscoped scan would
declare a skill "used" on the strength of a task the viewer may not open, and
the honest alternative — saying the figures cover only the viewer's slice — is
what ``tasks_partial``/``scope_partial`` are for. The hidden delta is never
computed.

⚠️ **This surface lists defects in the RECORD, never in people** (D-PC-14).
Every list is ordered alphabetically — there is no score, no "worst profile",
no leaderboard. And nothing here writes anything (D-PC-13): every row carries
enough to find the record, and fixing it happens on the record's own surface
under that surface's own authorization.
"""

from __future__ import annotations

import re
from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.people.core import _tenant_session, can_read_hr_fields, router
from gateway.routes.people.search import skill_pattern
from gateway.routes.tasks.core import PEOPLE_STATUSES
from pydantic import BaseModel
from sqlalchemy import text

#: Rows shown per list. Totals are counted BEFORE the cap and travel beside the
#: list, so a capped panel says "12 of 87" instead of quietly showing twelve.
MAX_ROWS_PER_LIST = 50

#: How many open-task titles the "never used on a task" scan reads, newest
#: first. Reported via ``tasks_scanned`` + ``tasks_partial`` — a silently
#: truncated scan would present "unused" as a fact when it is a sample.
MAX_TASK_TITLES = 5000

#: Role words that appear in job titles without naming a capability. A title
#: token that survives this filter and matches nobody's declared skill is the
#: §5.10 finding: "the org hires for it, nobody claims it."
TITLE_STOPWORDS: frozenset[str] = frozenset({
    "and", "the", "for", "of", "in", "to", "with",
    "senior", "junior", "lead", "head", "chief", "principal", "staff",
    "intern", "trainee", "executive", "officer", "assistant", "associate",
    "director", "president", "founder", "co-founder", "cofounder",
    "manager", "management", "engineer", "engineering", "developer",
    "designer", "specialist", "coordinator", "analyst", "consultant",
    "admin", "administrator", "supervisor", "technician", "expert",
    "member", "team", "dept", "department", "full", "part", "time",
    "sr", "jr", "vp", "avp", "gm", "ceo", "cto", "coo", "cfo",
})

#: The profile fields the assignment/reporting AI actually reasons over and a
#: person can fill in themselves (migration 172's stated purpose): an empty one
#: degrades every suggestion about that person. Employment facts (seniority,
#: dates) are admin-owned and belong to a different conversation than "please
#: complete your profile".
AI_FIELDS: tuple[str, ...] = ("timezone", "working_hours", "skills")


class PersonRef(BaseModel):
    id: str
    name: str


class SingleHolderSkill(BaseModel):
    skill: str
    person: PersonRef


class TitleTerm(BaseModel):
    term: str
    people: list[str]


class UnusedSkill(BaseModel):
    skill: str
    holders: int


class ConflictRow(BaseModel):
    id: str
    name: str
    email_conflict: str


class BadStatusRow(BaseModel):
    id: str
    name: str
    status: str


class ManagerAlumniRow(BaseModel):
    id: str
    name: str
    manager_name: str


class MissingFieldsRow(BaseModel):
    id: str
    name: str
    missing: list[str]


class Coverage(BaseModel):
    single_holder: list[SingleHolderSkill]
    title_terms: list[TitleTerm]
    unused_skills: list[UnusedSkill]
    tasks_scanned: int
    #: True when the scan hit :data:`MAX_TASK_TITLES` — "unused" is then "not
    #: in the newest N", which is a different claim and must say so.
    tasks_partial: bool
    #: True when the viewer's Projects grants are narrower than the portfolio,
    #: so "never used on a task" means "…that this viewer may see" (D-PC-20).
    scope_partial: bool


class Quality(BaseModel):
    no_email: list[PersonRef]
    email_conflict: list[ConflictRow]
    bad_status: list[BadStatusRow]
    manager_alumni: list[ManagerAlumniRow]
    no_manager: list[PersonRef]
    missing_ai_fields: list[MissingFieldsRow]


class QualityResponse(BaseModel):
    coverage: Coverage
    quality: Quality
    #: Pre-cap totals, keyed by list name — the honest denominator for every
    #: capped panel.
    counts: dict[str, int]
    truncated: bool


def _cap(rows: list[Any]) -> list[Any]:
    return rows[:MAX_ROWS_PER_LIST]


def title_terms(titles: list[tuple[str, str]],
                declared: set[str]) -> list[dict[str, Any]]:
    """Coverage check 2, pure: title tokens minus role words minus declared
    skills. ``titles`` is ``[(person_name, title), …]``; ``declared`` is the
    lowercased set of every declared skill."""
    found: dict[str, list[str]] = {}
    for person_name, title in titles:
        for token in re.split(r"[^\w+#./-]+", (title or "").lower()):
            token = token.strip(".-/")
            if len(token) < 3 or token in TITLE_STOPWORDS:
                continue
            if token.isdigit() or token in declared:
                continue
            people = found.setdefault(token, [])
            if person_name not in people:
                people.append(person_name)
    return [{"term": term, "people": sorted(found[term])}
            for term in sorted(found)]


def unused_skills(skills: dict[str, int], task_blob: str) -> list[dict[str, Any]]:
    """Coverage check 3, pure: declared skills that the ranker's own matcher
    (:func:`skill_pattern`) finds in NO task title. ``skills`` maps the display
    spelling to its holder count."""
    out = []
    for label in sorted(skills, key=str.lower):
        name = label.strip().lower()
        if len(name) < 2:
            continue
        if not re.search(skill_pattern(name), task_blob):
            out.append({"skill": label, "holders": skills[label]})
    return out


async def collect(db: Any, user: UserContext) -> QualityResponse:
    """The whole §5.10 answer, callable — §5.9's landing rollup calls THIS
    function rather than counting again, which is what keeps the two surfaces
    agreeing (the same mechanism as ``workload.rollup`` over serialized rows).
    """
    roster = (await db.execute(text(
        "SELECT id, name, title, status, email, email_conflict, manager_id, "
        "       timezone, working_hours, skills "
        "  FROM gtd_people"))).fetchall()
    # Alphabetical HERE, structurally, not as an ORDER BY a fake would skip:
    # every list below inherits this order, and "the lists are never a
    # ranking" (D-PC-14) is this line rather than a promise.
    roster = sorted(roster, key=lambda r: ((r.name or "").lower(), str(r.id)))
    skill_rows = (await db.execute(text(
        "SELECT person_id, skill FROM gtd_person_skills"))).fetchall()

    status_by_id = {str(r.id): r.status for r in roster}
    name_by_id = {str(r.id): r.name for r in roster}
    working = [r for r in roster if r.status in ("active", "contractor")]
    working_ids = {str(r.id) for r in working}

    # ── Coverage 1 · bus factor of one ──────────────────────────────────────
    holders: dict[str, list[tuple[str, str, str]]] = {}
    declared: set[str] = set()
    holder_counts: dict[str, int] = {}
    for row in skill_rows:
        pid = str(row.person_id)
        if pid not in working_ids:
            continue
        key = (row.skill or "").strip().lower()
        if len(key) < 2:
            continue
        declared.add(key)
        holders.setdefault(key, []).append((row.skill, pid, name_by_id.get(pid, "?")))
    for key, held in holders.items():
        label = held[0][0]
        holder_counts[label] = len({pid for _, pid, _ in held})
    single_holder = [
        SingleHolderSkill(skill=held[0][0],
                          person=PersonRef(id=held[0][1], name=held[0][2]))
        for key, held in sorted(holders.items())
        if len({pid for _, pid, _ in held}) == 1
    ]

    # ── Coverage 2 · hired for, claimed by nobody ───────────────────────────
    terms = [TitleTerm(**t) for t in title_terms(
        [(r.name, r.title) for r in working if r.title], declared)]

    # ── Coverage 3 · declared, never on a task (viewer-scoped, D-PC-20) ─────
    tasks_scanned = 0
    tasks_partial = False
    scope_partial = False
    unused: list[UnusedSkill] = []
    if holder_counts and user.has_permission("feature:projects"):
        titles: list[str] = []
        try:
            from gateway.routes.people.dashboard import _scope, _visibility
            vis = await _visibility(db, user)
            params: dict[str, Any] = {"cap": MAX_TASK_TITLES}
            scope = _scope(vis, params)
            scope_partial = not vis.unrestricted
            titles = [r.title or "" for r in (await db.execute(text(
                "SELECT t.title FROM pm_tasks t "
                " WHERE t.archived_at IS NULL AND " + scope +
                " ORDER BY t.created_at DESC LIMIT :cap"), params)).fetchall()]
        except Exception:
            titles = []
        tasks_scanned = len(titles)
        tasks_partial = tasks_scanned >= MAX_TASK_TITLES
        if tasks_scanned:
            # An empty scan (no visible tasks, a failed query, one deploy
            # behind) proves nothing — declaring every skill "unused" over it
            # would be the confident zero §6.2 refuses to draw.
            blob = "\n".join(titles).lower()
            unused = [UnusedSkill(**u)
                      for u in unused_skills(holder_counts, blob)]

    # ── Quality · the six lists, all from the one roster read ───────────────
    no_email = [PersonRef(id=str(r.id), name=r.name) for r in working
                if not r.email and not r.email_conflict]
    conflicts = [ConflictRow(id=str(r.id), name=r.name,
                             email_conflict=r.email_conflict)
                 for r in roster if r.email_conflict]
    bad_status = [BadStatusRow(id=str(r.id), name=r.name, status=r.status or "")
                  for r in roster if (r.status or "") not in PEOPLE_STATUSES]
    manager_alumni = [
        ManagerAlumniRow(id=str(r.id), name=r.name,
                         manager_name=name_by_id.get(str(r.manager_id), "?"))
        for r in working
        if r.manager_id and status_by_id.get(str(r.manager_id)) == "alumni"]
    no_manager = [PersonRef(id=str(r.id), name=r.name)
                  for r in working if not r.manager_id]
    missing_ai = []
    for r in working:
        missing = [f for f in AI_FIELDS if not getattr(r, f)]
        if missing:
            missing_ai.append(MissingFieldsRow(id=str(r.id), name=r.name,
                                               missing=missing))

    full = {
        "single_holder": single_holder, "title_terms": terms,
        "unused_skills": unused, "no_email": no_email,
        "email_conflict": conflicts, "bad_status": bad_status,
        "manager_alumni": manager_alumni, "no_manager": no_manager,
        "missing_ai_fields": missing_ai,
    }
    counts = {k: len(v) for k, v in full.items()}
    return QualityResponse(
        coverage=Coverage(
            single_holder=_cap(single_holder), title_terms=_cap(terms),
            unused_skills=_cap(unused), tasks_scanned=tasks_scanned,
            tasks_partial=tasks_partial, scope_partial=scope_partial),
        quality=Quality(
            no_email=_cap(no_email), email_conflict=_cap(conflicts),
            bad_status=_cap(bad_status), manager_alumni=_cap(manager_alumni),
            no_manager=_cap(no_manager), missing_ai_fields=_cap(missing_ai)),
        counts=counts,
        truncated=any(n > MAX_ROWS_PER_LIST for n in counts.values()),
    )


@router.get("/quality", response_model=QualityResponse)
async def get_quality(
    user: UserContext = Depends(get_current_user),
) -> QualityResponse:
    """§5.10 — gated like the dashboard and the capability search: it is
    skills, quarantines and org structure for everybody at once, so §4.2's
    oracle rule applies to the whole surface."""
    if not can_read_hr_fields(user):
        raise HTTPException(
            status_code=403,
            detail="The data-quality panel needs admin:members:read.")
    async with _tenant_session() as db:
        return await collect(db, user)
