"""Phase-0 retrieval: query string -> ranked entity context blocks.

Strategy: simple per-entity ILIKE search across project / task / person / deal,
then pretty-print as a context block tagged with `[entity:uuid]` so the LLM
can cite back the exact UUIDs (which the citation guardrail will then check).

Vector + graph traversal arrive in Phase 1 / Phase 2; this is intentionally dumb.
"""
from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy.orm import Session

from acb_graph import repo
from acb_graph.models import Deal, Person, Project, Task


@dataclass(slots=True, frozen=True)
class ContextHit:
    """One entity surfaced to the LLM. ``cite`` is the literal token to copy."""
    kind: str          # "project" | "task" | "person" | "deal"
    id: UUID
    text: str          # human-readable one-liner
    cite: str          # e.g. "[project:<uuid>]"


def _hit(kind: str, id: UUID, text: str) -> ContextHit:
    return ContextHit(kind=kind, id=id, text=text, cite=f"[{kind}:{id}]")


def _project_line(p: Project) -> str:
    customer = f" for {p.customer.name}" if p.customer else ""
    status = f", status={p.status}" if p.status else ""
    return f"Project '{p.name}'{customer}{status}."


def _task_line(t: Task) -> str:
    owner = f" owner={t.owner.canonical_name}" if t.owner else ""
    proj = f" project='{t.project.name}'" if t.project else ""
    stage = f" stage={t.stage}" if t.stage else ""
    age = f" days_in_stage={t.days_in_stage}" if t.days_in_stage is not None else ""
    return f"Task '{t.title}'{owner}{proj}{stage}{age}."


def _person_line(p: Person) -> str:
    role = f", {p.role}" if p.role else ""
    email = f" <{p.email}>" if p.email else ""
    return f"Person {p.canonical_name}{role}{email}."


def _deal_line(d: Deal) -> str:
    stage = f", stage={d.stage}" if d.stage else ""
    val = f", value_inr={d.value_inr}" if d.value_inr is not None else ""
    return f"Deal '{d.name}'{stage}{val}."


def _tokens(query: str) -> list[str]:
    """Cheap keyword extractor: drop punctuation + stopwords, keep words >=3 chars."""
    import re

    stop = {
        "the", "and", "for", "with", "what", "whats", "when", "where", "who",
        "why", "how", "are", "is", "of", "on", "in", "at", "to", "a", "an",
        "we", "do", "does", "did", "status", "project", "task", "tell", "me",
        "about", "any", "this", "that", "have", "has", "been", "tell",
    }
    words = re.findall(r"[a-zA-Z][a-zA-Z0-9_-]{2,}", query.lower())
    out: list[str] = []
    seen: set[str] = set()
    for w in words:
        if w in stop or w in seen:
            continue
        seen.add(w)
        out.append(w)
    return out or [query.strip().lower()]


def retrieve(
    session: Session,
    query: str,
    *,
    per_kind: int = 15,
    max_hits: int = 60,
) -> list[ContextHit]:
    """Run the basic ILIKE search across all entity types for ``query``.

    The query is tokenised and each significant keyword is searched
    independently; results are unioned, de-duplicated, then ranked by
    token-overlap with the query before being capped at ``max_hits``.
    """
    hits: list[ContextHit] = []
    tokens = _tokens(query)
    token_set = set(tokens)

    for tok in tokens:
        for c in repo.find_customers_by_text(session, tok, limit=per_kind):
            hits.append(_hit("customer", c.id, f"Customer {c.name}."))
            for d in repo.deals_for_customer(session, c.id, limit=per_kind):
                hits.append(_hit("deal", d.id, _deal_line(d)))

        for p in repo.find_projects_by_text(session, tok, limit=per_kind):
            hits.append(_hit("project", p.id, _project_line(p)))
            for t in repo.tasks_for_project(session, p.id, limit=per_kind):
                hits.append(_hit("task", t.id, _task_line(t)))

        for t in repo.find_tasks_by_text(session, tok, limit=per_kind):
            hits.append(_hit("task", t.id, _task_line(t)))

        for person in repo.find_people_by_text(session, tok, limit=per_kind):
            hits.append(_hit("person", person.id, _person_line(person)))

        for d in repo.find_deals_by_text(session, tok, limit=per_kind):
            hits.append(_hit("deal", d.id, _deal_line(d)))

    # de-dup on (kind, id), preserving first-seen order
    seen: set[tuple[str, UUID]] = set()
    unique: list[ContextHit] = []
    for h in hits:
        key = (h.kind, h.id)
        if key in seen:
            continue
        seen.add(key)
        unique.append(h)

    # Rank: count how many query tokens appear in each hit's text. Stable for ties.
    def _score(h: ContextHit) -> int:
        text_l = h.text.lower()
        return -sum(1 for t in token_set if t in text_l)  # negative for desc sort

    unique.sort(key=_score)
    return unique[:max_hits]


def format_context(hits: list[ContextHit]) -> str:
    """Render hits as a numbered list the LLM can paste citations from."""
    if not hits:
        return ""
    lines = [f"{i+1}. {h.cite}  {h.text}" for i, h in enumerate(hits)]
    return "\n".join(lines)


__all__ = ["ContextHit", "retrieve", "format_context"]