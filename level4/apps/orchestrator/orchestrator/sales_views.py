"""Curated read models for the Sales Pull agent (WBS 1.5).

These functions assemble structured, citation-friendly context blocks for
sales-specific questions ("how is Acme doing?", "what's stuck?", "which deals
went quiet?"). They sit on top of `acb_graph.repo` so the agent never touches
SQLAlchemy directly.

Output shape mirrors `orchestrator.retrieval.ContextHit` so the existing
citation guardrail can validate the LLM's response unchanged.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from acb_graph import repo
from acb_graph.models import Customer, Deal, Person, Project

from orchestrator.retrieval import ContextHit


def _hit(kind: str, entity_id: UUID, text: str) -> ContextHit:
    """Local mirror of `retrieval._hit` — duplicated to avoid importing a
    private helper across modules."""
    return ContextHit(kind=kind, id=entity_id, text=text, cite=f"[{kind}:{entity_id}]")


# ---- Sales-focused dataclasses --------------------------------------------

@dataclass(slots=True)
class CustomerSummary:
    """One-screen view of a customer for the Sales agent."""

    customer_id: UUID
    name: str
    deal_count: int
    open_deal_count: int
    pipeline_value_inr: Decimal | None
    last_activity_at: datetime | None
    owner_names: list[str]


@dataclass(slots=True)
class DealSummary:
    """One-screen view of a deal."""

    deal_id: UUID
    name: str
    stage: str | None
    value_inr: Decimal | None
    customer_name: str | None
    owner_name: str | None
    days_quiet: int | None
    last_activity_at: datetime | None


# ---- Customer 360 ---------------------------------------------------------

def customer_360(session: Session, customer: Customer) -> CustomerSummary:
    """Aggregate one customer's deal stats. Closed Won/Lost are excluded
    from the *open* counts but still counted in ``deal_count``."""
    deals = repo.deals_for_customer(session, customer.id, limit=500)
    open_deals = [d for d in deals if not _is_closed(d.stage)]
    pipeline = (
        sum((d.value_inr or Decimal(0) for d in open_deals), Decimal(0))
        if open_deals
        else None
    )
    last = max(
        (d.last_activity_at for d in deals if d.last_activity_at is not None),
        default=None,
    )
    owner_ids = {d.owner_id for d in deals if d.owner_id is not None}
    owners: list[str] = []
    if owner_ids:
        for p in session.execute(
            select(Person).where(Person.id.in_(owner_ids))
        ).scalars():
            owners.append(p.canonical_name)
    return CustomerSummary(
        customer_id=customer.id,
        name=customer.name,
        deal_count=len(deals),
        open_deal_count=len(open_deals),
        pipeline_value_inr=pipeline,
        last_activity_at=last,
        owner_names=sorted(owners),
    )


def _is_closed(stage: str | None) -> bool:
    if not stage:
        return False
    s = stage.lower()
    return s.startswith("closed") or s in {"won", "lost", "cancelled"}


def _days_quiet(dt: datetime | None) -> int | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - dt).days


# ---- Deal listings --------------------------------------------------------

def open_deals_for_customer(
    session: Session, customer_id: UUID, *, limit: int = 25
) -> list[DealSummary]:
    """Return open (non-closed) deals for one customer, freshest activity first."""
    out: list[DealSummary] = []
    for d in repo.deals_for_customer(session, customer_id, limit=limit):
        if _is_closed(d.stage):
            continue
        out.append(_deal_summary(d))
    return out


def quiet_deals_summary(
    session: Session, *, min_days_quiet: int = 14, limit: int = 25
) -> list[DealSummary]:
    """Deals that haven't moved in N days — the reconciler's view, formatted
    for the Sales agent."""
    return [_deal_summary(d) for d in repo.quiet_deals(session, min_days_quiet=min_days_quiet, limit=limit)]


def top_pipeline_deals(session: Session, *, limit: int = 10) -> list[DealSummary]:
    """Highest-value open deals — the agent's answer to "what's worth focusing on"."""
    stmt = (
        select(Deal)
        .where(Deal.value_inr.is_not(None))
        .order_by(Deal.value_inr.desc())
        .limit(limit * 3)  # over-fetch then filter closed in Python
    )
    out: list[DealSummary] = []
    for d in session.execute(stmt).scalars():
        if _is_closed(d.stage):
            continue
        out.append(_deal_summary(d))
        if len(out) >= limit:
            break
    return out


def _deal_summary(d: Deal) -> DealSummary:
    return DealSummary(
        deal_id=d.id,
        name=d.name,
        stage=d.stage,
        value_inr=d.value_inr,
        customer_name=d.customer.name if d.customer else None,
        owner_name=d.owner.canonical_name if d.owner else None,
        days_quiet=_days_quiet(d.last_activity_at),
        last_activity_at=d.last_activity_at,
    )


# ---- Sales context assembly for the LLM -----------------------------------

def sales_context(session: Session, query: str, *, max_hits: int = 40) -> list[ContextHit]:
    """Build a sales-flavoured context: matching customers + open deals +
    quiet deals, all rendered as :class:`ContextHit` with `[entity:uuid]`
    citation tokens so the existing guardrail validates the LLM output.
    """
    hits: list[ContextHit] = []
    # Term-driven match (customer / deal by name).
    for c in repo.find_customers_by_text(session, query, limit=8):
        summary = customer_360(session, c)
        hits.append(
            _hit(
                "customer",
                c.id,
                _render_customer(summary),
            )
        )
        for d in open_deals_for_customer(session, c.id, limit=10):
            hits.append(_hit("deal", d.deal_id, _render_deal(d)))

    for d in repo.find_deals_by_text(session, query, limit=8):
        hits.append(_hit("deal", d.id, _render_deal(_deal_summary(d))))

    # If the query smells like "quiet" / "stuck" / "stale" / "follow-up",
    # add the quiet-deal summary even without an explicit name match.
    ql = query.lower()
    if any(t in ql for t in ("quiet", "stale", "stuck", "follow", "follow up", "stalled")):
        for d in quiet_deals_summary(session, limit=10):
            hits.append(_hit("deal", d.deal_id, _render_deal(d)))

    # de-dup preserving order
    seen: set[tuple[str, UUID]] = set()
    unique: list[ContextHit] = []
    for h in hits:
        key = (h.kind, h.id)
        if key in seen:
            continue
        seen.add(key)
        unique.append(h)
    return unique[:max_hits]


def _render_customer(s: CustomerSummary) -> str:
    owner = f" owners={','.join(s.owner_names)}" if s.owner_names else ""
    pv = f", pipeline_inr={s.pipeline_value_inr}" if s.pipeline_value_inr is not None else ""
    last = f", last_activity={s.last_activity_at.date().isoformat()}" if s.last_activity_at else ""
    return (
        f"Customer {s.name}: open_deals={s.open_deal_count}/{s.deal_count}"
        f"{pv}{last}{owner}."
    )


def _render_deal(s: DealSummary) -> str:
    stage = f", stage={s.stage}" if s.stage else ""
    val = f", value_inr={s.value_inr}" if s.value_inr is not None else ""
    cust = f", customer={s.customer_name}" if s.customer_name else ""
    owner = f", owner={s.owner_name}" if s.owner_name else ""
    quiet = f", days_quiet={s.days_quiet}" if s.days_quiet is not None else ""
    return f"Deal '{s.name}'{stage}{val}{cust}{owner}{quiet}."


__all__ = [
    "CustomerSummary",
    "DealSummary",
    "customer_360",
    "open_deals_for_customer",
    "quiet_deals_summary",
    "top_pipeline_deals",
    "sales_context",
]
