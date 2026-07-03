"""Tasks · ai — the clarify proposal (AI proposes, the human decides).

POST /tasks/items/{id}/clarify returns a full structured recommendation for an
inbox item: disposition + a concrete next action + context/energy/time +
auto-matched project + destination + default provider stage + confidence.

Today this is the same deterministic heuristic the UI ships (ported from
workbench .../tasks/lib/clarify.ts) so client and agent share one server-side
implementation. It is deliberately shaped like the future agent call — when
the task-manager agent takes over Clarify cognition, only this module's
``propose()`` body changes; the route contract stays.
"""

from __future__ import annotations

import re
from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends
from gateway.routes.tasks.core import (
    PROJECT_SELECT,
    _get_db,
    _parse_jsonb,
    _uid,
    router,
)
from gateway.routes.tasks.items import _fetch_item
from sqlalchemy import text

# ── Heuristic knowledge (mirrors clarify.ts) ─────────────────────────────────

PROJECT_HINTS = [
    "plan", "organize", "organise", "launch", "set up", "setup", "build",
    "design", "research", "prepare", "roll out", "rollout", "migrate", "hire",
    "onboard", "campaign", "event", "trip", "strategy", "handbook", "write up",
    "fit-out", "process", "framework", "overhaul", "redesign",
]
TWO_MIN_HINTS = ["reply", "confirm", "rsvp", "sign", "pay", "forward", "text",
                 "send the", "quick", "approve", "reschedule"]
REFERENCE_HINTS = ["receipt", "invoice", "statement", "fyi", "file",
                   "for the record", "article", "read:", "link", "doc:",
                   "reference"]
SOMEDAY_HINTS = ["idea:", "someday", "maybe", "one day", "learn ", "explore",
                 "evaluate", "wish", "consider "]
CALENDAR_HINTS = ["today", "tomorrow", "tonight", "monday", "tuesday",
                  "wednesday", "thursday", "friday", "saturday", "sunday",
                  "deadline", "due ", " at ", "o'clock", "appointment",
                  "meeting on", "next week"]
DELEGATE_HINTS = ["ask", "get ", "have ", "follow up with", "chase", "remind"]

_IMPERATIVE = re.compile(
    r"^(call|email|reply|draft|send|buy|pick|book|write|review|check|pay|sign|"
    r"schedule|confirm|follow up|order|renew|research|plan|prepare)")

_STOP_WORDS = frozenset(
    ["the", "and", "for", "with", "our", "out", "get", "set", "new", "you", "your", "this", "that", "from", "into", "about", "need", "want", "make", "have", "has", "ask", "put", "add", "let", "off", "day", "week", "next", "soon", "some", "any"])


def _has(t: str, hints: list[str]) -> bool:
    """Hint match with word boundaries — bare substring matching misfiled
    captures ("profile…" tripped the "file" reference hint). Trailing-space
    hints (e.g. "learn ") are stripped first: the boundary check itself
    prevents prefix matches like "learning". Locked by the GTD golden evals
    (evals/trajectories/test_gtd_quality_trajectory.py)."""
    for h in hints:
        hint = h.strip()
        if hint and re.search(
            rf"(?<![a-z0-9]){re.escape(hint)}(?![a-z0-9])", t
        ):
            return True
    return False


def _infer_context(t: str) -> str:
    if _has(t, ["call", "phone", "ring", "dial"]):
        return "@calls"
    if _has(t, ["buy", "pick up", "pickup", "store", "errand", "drop off",
                "collect", "bank", "post office"]):
        return "@errands"
    if _has(t, ["ask ", "discuss", "1:1", "agenda", "raise with", "bring up",
                "talk to"]):
        return "@agenda"
    return "@computer"


def _draft_next_action(title: str, ctx: str, assignee: str | None = None) -> str:
    t = title.strip()
    lower = t.lower()
    if assignee:
        stripped = re.sub(r"^(ask|get|have)\s+\w+\s+(to\s+)?", "", lower)
        return f"Ask {assignee} to {stripped}".strip()
    if _IMPERATIVE.match(lower):
        return t[0].upper() + t[1:]
    if ctx == "@calls":
        return f"Call about {t}"
    if ctx == "@errands":
        return f"Pick up / handle: {t}"
    if ctx == "@agenda":
        return f"Raise with the team: {t}"
    return f"Action: {t}"


def _tokenize(s: str) -> set[str]:
    return {
        w for w in re.sub(r"[^a-z0-9\s]", " ", s.lower()).split()
        if len(w) > 2 and w not in _STOP_WORDS
    }


def _suggest_project(title: str, notes: str, projects: list[Any]) -> Any | None:
    """Best-fit ACTIVE project by keyword overlap (≥2 meaningful words)."""
    words = _tokenize(title) | _tokenize(notes or "")
    best, best_score = None, 0
    for p in projects:
        if p.status != "ACTIVE":
            continue
        overlap = len(words & (_tokenize(p.outcome) | _tokenize(p.purpose or "")))
        if overlap > best_score:
            best, best_score = p, overlap
    return best if best_score >= 2 else None


def _match_capability(text_: str, people: list[dict]) -> dict | None:
    """Best-fit owner by skills (org-knowledge layer, §6.1): score each person
    by how many of their skills appear in the task text (word-boundary match);
    tie-break by available hours. Conservative — None when nothing matches."""
    t = text_.lower()
    best: dict | None = None
    best_key: tuple[int, int] = (0, -1)
    for p in people:
        score = 0
        for skill in p.get("skills") or []:
            sk = (skill or "").strip().lower()
            if len(sk) < 3:
                continue
            if re.search(rf"\b{re.escape(sk)}\b", t):
                score += 1
        if score == 0:
            continue
        key = (score, p.get("available_hours_per_week") or 0)
        if key > best_key:
            best, best_key = p, key
    return best


def default_status(disposition: str, statuses: list[str]) -> str | None:
    """GTD disposition → a sensible provider stage (§2.2 P7):
    someday-under-a-project → Backlog; actioned/delegated → To-do."""
    if not statuses:
        return None

    def find(pattern: str) -> str | None:
        rx = re.compile(pattern, re.I)
        return next((s for s in statuses if rx.search(s)), None)

    if disposition == "SOMEDAY":
        return find(r"backlog|someday|icebox") or statuses[0]
    if disposition == "PROJECT":
        return find(r"backlog|to.?do|selected") or statuses[0]
    return find(r"to.?do|selected|to do") or (
        statuses[1] if len(statuses) > 1 else statuses[0])


def propose(item: Any, people: list[dict], projects: list[Any],
            account_statuses: dict[str, list[str]]) -> dict[str, Any]:
    """The full structured proposal. Deterministic heuristic today; the
    task-manager agent replaces this body (same shape) later."""
    t = item.title.lower()
    ctx = _infer_context(t)

    core: dict[str, Any]
    if _has(t, SOMEDAY_HINTS):
        core = {"actionable": False, "disposition": "SOMEDAY",
                "next_action": item.title, "confidence": "high",
                "rationale": "Reads like an idea to incubate, not a commitment yet."}
    elif _has(t, REFERENCE_HINTS):
        core = {"actionable": False, "disposition": "REFERENCE",
                "next_action": item.title, "confidence": "high",
                "rationale": "Looks like information to keep, not an action."}
    else:
        assignee = next(
            (p for p in people
             if p.get("name") and p["name"].split()[0].lower() in t),
            None)
        if assignee and _has(t, DELEGATE_HINTS):
            core = {"actionable": True, "disposition": "WAITING",
                    "next_action": _draft_next_action(item.title, ctx,
                                                      assignee["name"]),
                    "suggested_assignee": assignee, "energy": "low",
                    "time_estimate_mins": 5, "confidence": "high",
                    "rationale": f"Someone else's to do — delegate to "
                                 f"{assignee['name']} and track it."}
        elif _has(t, PROJECT_HINTS):
            core = {"actionable": True, "disposition": "PROJECT",
                    "outcome": f"{item.title[0].upper()}{item.title[1:]} — done",
                    "next_action": f"Outline the first step for: {item.title}",
                    "context": "@computer", "energy": "medium",
                    "confidence": "medium",
                    "rationale": "Needs more than one action — track it as a "
                                 "project with a next action."}
        elif _has(t, CALENDAR_HINTS):
            core = {"actionable": True, "disposition": "CALENDAR",
                    "next_action": _draft_next_action(item.title, ctx),
                    "context": ctx, "energy": "low", "confidence": "high",
                    "rationale": "Time-specific — put it on the calendar "
                                 "(hard landscape)."}
        elif _has(t, TWO_MIN_HINTS) and len(item.title) < 60:
            core = {"actionable": True, "disposition": "DO_NOW",
                    "next_action": _draft_next_action(item.title, ctx),
                    "is_two_minute": True, "time_estimate_mins": 2,
                    "energy": "low", "confidence": "high",
                    "rationale": "Quick — under two minutes, so just do it now."}
        else:
            core = {"actionable": True, "disposition": "NEXT",
                    "next_action": _draft_next_action(item.title, ctx),
                    "context": ctx,
                    "energy": "low" if ctx == "@errands" else "medium",
                    "time_estimate_mins": 10 if ctx == "@calls"
                    else 20 if ctx == "@errands" else 25,
                    "confidence": "medium",
                    "rationale": f"Actionable now — a next action for {ctx}."}

    # Project auto-match. A PROJECT-classified capture that clearly belongs
    # to an EXISTING active project files there as a next action instead of
    # spawning a duplicate project (GTD: one project, many actions). Locked
    # by the GTD golden evals.
    matched = None
    if not item.project_id:
        matched = _suggest_project(item.title, item.description or "", projects)
    if matched is not None and core["disposition"] == "PROJECT":
        core = {"actionable": True, "disposition": "NEXT",
                "next_action": _draft_next_action(item.title, ctx),
                "context": ctx, "energy": "medium", "confidence": "medium",
                "rationale": "Part of an existing project — filing it there "
                             "as a next action instead of starting a new one."}
    project = matched or next(
        (p for p in projects if item.project_id and str(p.id) == str(item.project_id)),
        None)

    # Destination follows the matched project's home; delegation → team tool.
    account_id = str(project.account_id) if project is not None and project.account_id else None
    if core["disposition"] == "WAITING" and not account_id and account_statuses:
        account_id = next(iter(account_statuses))
    statuses = account_statuses.get(account_id or "", [])

    if matched is not None:
        core["rationale"] += f" Looks like it belongs to “{matched.outcome}”."

    # Capability-aware owner suggestion (people with skills → §6.1): only for
    # actionable work with no name-matched assignee; the human still decides.
    if (core.get("actionable") and not core.get("suggested_assignee")
            and core["disposition"] in ("NEXT", "PROJECT", "CALENDAR")):
        fit = _match_capability(
            f"{item.title} {item.description or ''}", people)
        if fit is not None:
            hits = [sk for sk in fit.get("skills") or []
                    if len((sk or "").strip()) >= 3 and re.search(
                        rf"\b{re.escape(sk.strip().lower())}\b",
                        f"{item.title} {item.description or ''}".lower())]
            core["suggested_assignee"] = {
                "name": fit["name"], "email": fit.get("email"),
                "provider_user_id": fit.get("provider_user_id"),
            }
            avail = fit.get("available_hours_per_week")
            core["rationale"] += (
                f" {fit['name']} fits ({', '.join(hits[:3])}"
                + (f"; {avail}h free this week" if avail is not None else "")
                + ").")

    return {
        **core,
        "project_id": str(project.id) if project is not None else None,
        "project_inferred": matched is not None,
        "account_id": account_id,
        "status": default_status(core["disposition"], statuses),
    }


@router.post("/items/{item_id}/clarify")
async def clarify_item(
    item_id: str,
    user: UserContext = Depends(get_current_user),
):
    """The AI clarify proposal for one inbox item (agent seam, §2.2)."""
    uid = _uid(user)
    db = await _get_db()
    try:
        item = await _fetch_item(db, item_id, uid)
        projects = (await db.execute(
            text(PROJECT_SELECT + " WHERE p.user_id = :uid"), {"uid": uid},
        )).fetchall()
        accounts = (await db.execute(
            text("SELECT id, schema_cache FROM task_accounts WHERE user_id = :uid"),
            {"uid": uid},
        )).fetchall()
        account_statuses: dict[str, list[str]] = {}
        members: list[dict] = []
        for a in accounts:
            cache = _parse_jsonb(a.schema_cache) or {}
            account_statuses[str(a.id)] = [
                s for s in cache.get("statuses") or [] if isinstance(s, str)]
            for m in cache.get("members") or []:
                if isinstance(m, dict) and m.get("name"):
                    members.append(m)
        # Org-knowledge people (skills + availability, §6.1) power the
        # heuristic; provider members are the fallback when none imported.
        from gateway.routes.tasks.people import fetch_people_for_clarify
        people = await fetch_people_for_clarify(db) or members
        return propose(item, people, projects, account_statuses)
    finally:
        await db.close()


@router.get("/insights")
async def inbox_insights(user: UserContext = Depends(get_current_user)):
    """Whole-inbox signals for the processing surface: counts, aging,
    project clusters, stale waiting-fors. (Agent narration comes later.)"""
    uid = _uid(user)
    db = await _get_db()
    try:
        counts = (await db.execute(text(
            """SELECT disposition, count(*) AS n FROM gtd_items
               WHERE user_id = :uid GROUP BY disposition"""), {"uid": uid},
        )).fetchall()
        oldest = (await db.execute(text(
            """SELECT min(created_at) AS oldest FROM gtd_items
               WHERE user_id = :uid AND disposition = 'INBOX'
                 AND (defer_until IS NULL OR defer_until <= now())"""),
            {"uid": uid})).fetchone()
        stale = (await db.execute(text(
            """SELECT count(*) AS n FROM gtd_waiting w
               JOIN gtd_items i ON i.id = w.item_id
               WHERE i.user_id = :uid AND w.resolved = false
                 AND w.delegated_at < now() - interval '5 days'"""),
            {"uid": uid})).fetchone()
        no_next = (await db.execute(text(
            """SELECT count(*) AS n FROM gtd_projects p
               WHERE p.user_id = :uid AND p.status = 'ACTIVE'
                 AND NOT EXISTS (SELECT 1 FROM gtd_items i
                                 WHERE i.project_id = p.id
                                   AND i.disposition = 'NEXT')"""),
            {"uid": uid})).fetchone()
        return {
            "counts": {r.disposition: r.n for r in counts},
            "oldest_inbox_at": oldest.oldest.isoformat()
            if oldest and oldest.oldest else None,
            "stale_waiting": stale.n if stale else 0,
            "projects_without_next_action": no_next.n if no_next else 0,
        }
    finally:
        await db.close()
