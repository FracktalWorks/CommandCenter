"""Projects · mapping — proposing a Center for each ClickUp Space.

Spec: ``project-docs/specs/project_management_app.md`` §7.1 · **D-PM-10**
(owner-answered 2026-08-06) · ticket WS-27b done-whens 1-3.

The owner's rule, and the reason this module is separate from the importer it
serves: **an agent may PROPOSE a mapping and must never APPLY one.** A wrong
auto-map grants one Center visibility of another department's work, which is the
single error class this app must not make silently. So the proposal lives here,
returns its evidence, and writes nothing; ``import_clickup.py`` applies only what
the owner confirmed.

Three signals, cheapest and most reliable first:

1. **Assignee overlap** — the share of a Space's task assignees who are members
   of each ``org_group``. Deterministic, no LLM, and the strongest signal the
   platform already holds: who does the work is what a department *is*.
2. **Name match** — the Space name against Center names, slugs and aliases.
3. **Content classification** — a sampled set of task titles classified through
   ``acb_llm``'s tiered routing. **EVAL-LOCKED** (same posture as
   ``routes/tasks/ai.py::propose``): changing this prompt changes a
   recommendation the owner acts on.

Signals are combined by weighted vote, and every one that fired is returned as
evidence. A confidence with no evidence behind it is a number the owner cannot
check, which is worse than no suggestion at all.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from acb_common import get_logger
from sqlalchemy import text

_log = get_logger("gateway.projects.mapping")

#: The six Center slugs, 1:1 with their `org_group` slugs
#: (``department_centers.md`` §1). Read from the groups table at runtime rather
#: than hard-coded, so a Center added later is proposable without a code change;
#: this tuple is only the fallback when the table cannot be read.
FALLBACK_CENTERS: tuple[str, ...] = (
    "sales", "marketing", "finance", "operations", "people", "company",
)

#: Extra words that mean a Center. Deliberately small: a long alias list is a
#: second naming vocabulary to maintain, and the LLM signal exists to catch the
#: cases these miss.
ALIASES: dict[str, tuple[str, ...]] = {
    "sales": ("sales", "revenue", "biz dev", "bizdev", "crm", "pipeline"),
    "marketing": ("marketing", "growth", "brand", "content", "campaign"),
    "finance": ("finance", "accounts", "accounting", "billing", "payroll"),
    "operations": ("operations", "ops", "production", "manufacturing",
                   "supply", "logistics", "service", "support"),
    "people": ("people", "hr", "human resources", "hiring", "recruit",
               "talent", "onboarding"),
    "company": ("company", "exec", "executive", "strategy", "board", "admin"),
}

#: Weights. Assignee overlap dominates because it is measured rather than
#: guessed; the LLM is a tie-breaker, not an authority.
WEIGHT_ASSIGNEE = 0.60
WEIGHT_NAME = 0.30
WEIGHT_LLM = 0.10

#: How many task titles the classifier sees. Enough to characterise a Space,
#: bounded so a 10 000-task Space costs the same as a 50-task one.
LLM_SAMPLE = 40

#: Below this, no Center is suggested at all. A weak guess presented as a
#: suggestion is worse than a blank: the owner would be reviewing our noise
#: instead of deciding.
MIN_CONFIDENCE = 0.25


@dataclass
class Suggestion:
    """One Space's proposed Center, with everything behind it."""

    center: str | None
    confidence: float
    evidence: list[str] = field(default_factory=list)
    scores: dict[str, float] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "center": self.center,
            "confidence": round(self.confidence, 3),
            "evidence": self.evidence,
            "scores": {k: round(v, 3) for k, v in sorted(self.scores.items())},
        }


# ── Signal 1 — assignee overlap ─────────────────────────────────────────────

_GROUP_MEMBERS_SQL = """
SELECT g.slug AS slug, lower(au.email) AS email
FROM org_group g
JOIN org_group_member m ON m.group_id = g.id
JOIN app_user au ON au.id = m.user_id
WHERE au.status = 'active'
"""


async def load_group_members(db: Any) -> dict[str, set[str]]:
    """``{group_slug: {member emails}}`` for every group.

    Read once per plan rather than per Space: the membership cannot change
    between two Spaces of the same request, and one query beats N.
    """
    try:
        rows = (await db.execute(text(_GROUP_MEMBERS_SQL), {})).fetchall()
    except Exception as exc:  # pragma: no cover — the access tables are not ours
        _log.warning("projects.mapping.groups_unreadable", error=str(exc))
        return {}
    out: dict[str, set[str]] = {}
    for row in rows:
        slug = str(getattr(row, "slug", "") or "")
        email = str(getattr(row, "email", "") or "").lower()
        if slug and email:
            out.setdefault(slug, set()).add(email)
    return out


def score_by_assignees(
    assignees: set[str], group_members: dict[str, set[str]],
) -> dict[str, float]:
    """Per-Center score from who actually works in the Space.

    Normalised by the Space's assignee count, not the group's: the question is
    "what share of this Space's people are in that Center", so a large group
    does not out-score a small one merely by existing.
    """
    if not assignees:
        return {}
    folded = {a.lower() for a in assignees if a}
    return {
        slug: len(folded & members) / len(folded)
        for slug, members in group_members.items()
        if folded & members
    }


# ── Signal 2 — name match ───────────────────────────────────────────────────

def score_by_name(space_name: str, centers: tuple[str, ...]) -> dict[str, float]:
    """Per-Center score from the Space's own name.

    A whole-word hit scores 1.0 and a substring 0.6, because "Ops review" should
    beat "Developer options" for `operations` — the second is a substring
    accident and the first is the word.
    """
    name = (space_name or "").strip().lower()
    if not name:
        return {}
    words = set(name.replace("/", " ").replace("-", " ").replace("_", " ").split())
    scores: dict[str, float] = {}
    for slug in centers:
        best = 0.0
        for alias in (slug, *ALIASES.get(slug, ())):
            if alias in words or (" " in alias and alias in name):
                best = max(best, 1.0)
            elif alias in name:
                best = max(best, 0.6)
        if best:
            scores[slug] = best
    return scores


# ── Signal 3 — content classification (EVAL-LOCKED) ─────────────────────────

_CLASSIFY_SYSTEM = (
    "You map a project workspace to exactly one company department. "
    "Answer with a single JSON object and nothing else: "
    '{"department": "<slug or null>", "why": "<eight words or fewer>"}. '
    "Use null when the titles do not clearly belong to one department."
)


async def score_by_content(
    space_name: str, titles: list[str], centers: tuple[str, ...],
) -> tuple[dict[str, float], str | None]:
    """Ask the model which department a sample of task titles belongs to.

    ⚠️ **EVAL-LOCKED** — this prompt shapes a recommendation the owner acts on.

    Degrades to ``({}, None)`` on **any** failure: no key, no budget, a refusal,
    a malformed answer. The plan must still be useful with the two deterministic
    signals alone, because an owner cannot confirm a mapping that never
    arrived — and this is the one signal that depends on a third party being up.
    """
    sample = [t.strip() for t in titles if (t or "").strip()][:LLM_SAMPLE]
    if not sample:
        return {}, None
    try:
        from acb_llm import LLMTier, complete

        raw = await complete(
            # TIER_1 — the cheap tier. Classifying a bag of task titles into one
            # of six labels is not reasoning work, and this runs once per Space.
            tier=LLMTier.TIER_1,
            messages=[
                {"role": "system", "content": _CLASSIFY_SYSTEM},
                {
                    "role": "user",
                    "content": (
                        f"Departments: {', '.join(centers)}\n"
                        f"Workspace name: {space_name}\n"
                        f"Task titles:\n- " + "\n- ".join(sample)
                    ),
                },
            ],
            temperature=0.0,
            max_tokens=120,
            enable_litellm_cache=True,
        )
        parsed = json.loads(_first_json_object(raw))
        slug = parsed.get("department")
        if not slug or slug not in centers:
            return {}, None
        why = str(parsed.get("why") or "").strip()[:80]
        return {slug: 1.0}, why or None
    except Exception as exc:
        _log.info("projects.mapping.classify_unavailable", error=str(exc))
        return {}, None


def _first_json_object(raw: str) -> str:
    """The first ``{...}`` in a model reply.

    Models wrap JSON in prose and fences however firmly they are told not to;
    refusing the whole signal over a code fence would make the classifier flaky
    for a reason that has nothing to do with its answer.
    """
    text_value = (raw or "").strip()
    start, end = text_value.find("{"), text_value.rfind("}")
    if start < 0 or end <= start:
        return "{}"
    return text_value[start : end + 1]


# ── Combination ─────────────────────────────────────────────────────────────

async def suggest_center(
    *,
    space_name: str,
    assignees: set[str],
    titles: list[str],
    group_members: dict[str, set[str]],
    centers: tuple[str, ...],
    use_llm: bool = True,
) -> Suggestion:
    """Combine the three signals into one proposal, carrying its evidence."""
    by_assignee = score_by_assignees(assignees, group_members)
    by_name = score_by_name(space_name, centers)
    by_llm, why = (
        await score_by_content(space_name, titles, centers) if use_llm else ({}, None)
    )

    combined: dict[str, float] = {}
    for slug in set(by_assignee) | set(by_name) | set(by_llm):
        combined[slug] = (
            WEIGHT_ASSIGNEE * by_assignee.get(slug, 0.0)
            + WEIGHT_NAME * by_name.get(slug, 0.0)
            + WEIGHT_LLM * by_llm.get(slug, 0.0)
        )
    if not combined:
        return Suggestion(center=None, confidence=0.0, evidence=[], scores={})

    winner = max(combined, key=lambda s: combined[s])
    confidence = combined[winner]

    evidence: list[str] = []
    if winner in by_assignee:
        share = round(by_assignee[winner] * 100)
        evidence.append(f"{share}% of assignees are in the {winner} group")
    if winner in by_name:
        evidence.append(f"the Space name matches '{winner}'")
    if winner in by_llm:
        evidence.append(f"task titles read as {winner}" + (f" ({why})" if why else ""))

    if confidence < MIN_CONFIDENCE:
        # Keep the scores: the owner may still want to see a near-miss, and
        # hiding them would make a blank suggestion indistinguishable from a
        # signal failure.
        return Suggestion(
            center=None, confidence=confidence, evidence=evidence, scores=combined,
        )
    return Suggestion(
        center=winner, confidence=confidence, evidence=evidence, scores=combined,
    )


async def load_centers(db: Any) -> tuple[str, ...]:
    """The Center slugs that exist, from ``org_group``.

    Read rather than hard-coded so a Center added later is proposable with no
    code change here; :data:`FALLBACK_CENTERS` covers the case where the table
    cannot be read at all.
    """
    try:
        rows = (await db.execute(
            text("SELECT slug FROM org_group ORDER BY slug"), {},
        )).fetchall()
        slugs = tuple(
            str(getattr(r, "slug", "") or "") for r in rows if getattr(r, "slug", None)
        )
        return slugs or FALLBACK_CENTERS
    except Exception:  # pragma: no cover — defensive, per the docstring
        return FALLBACK_CENTERS
