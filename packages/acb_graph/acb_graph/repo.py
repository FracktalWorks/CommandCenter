"""Tiny repository / query helpers. Keep DB access funnelled through here.

These are deliberately thin — just enough for the Phase-0 Pull agent. Bigger
query patterns will arrive with the LangGraph + Deep Agents harness in 0.5.
"""
from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from acb_graph.models import Customer, Deal, Person, Project, Task


# ---------- Upserts (idempotent on external id) -----------------------------

def upsert_person(
    session: Session,
    *,
    clickup_id: str | None = None,
    zoho_id: str | None = None,
    **fields: Any,
) -> Person:
    """Insert a Person or update fields by external id (clickup_id or zoho_id)."""
    if clickup_id:
        stmt = (
            pg_insert(Person)
            .values(clickup_id=clickup_id, zoho_id=zoho_id, **fields)
            .on_conflict_do_update(
                index_elements=[Person.clickup_id],
                set_={k: v for k, v in {"zoho_id": zoho_id, **fields}.items() if k != "id" and v is not None},
            )
            .returning(Person)
        )
        return session.execute(stmt).scalar_one()
    if zoho_id:
        # Reconcile against an existing row that shares the same email (e.g. already
        # ingested from ClickUp). If we find one, attach the zoho_id to it instead
        # of inserting a duplicate that would violate person_email_key.
        email = fields.get("email")
        if email:
            existing = session.execute(
                select(Person).where(Person.email == email)
            ).scalar_one_or_none()
            if existing is not None:
                if not existing.zoho_id:
                    existing.zoho_id = zoho_id
                for k, v in fields.items():
                    if v is not None and k != "id":
                        setattr(existing, k, v)
                session.flush()
                return existing
        stmt = (
            pg_insert(Person)
            .values(zoho_id=zoho_id, **fields)
            .on_conflict_do_update(
                index_elements=[Person.zoho_id],
                set_={k: v for k, v in fields.items() if k != "id" and v is not None},
            )
            .returning(Person)
        )
        return session.execute(stmt).scalar_one()
    obj = Person(**fields)
    session.add(obj)
    session.flush()
    return obj


def upsert_customer(session: Session, *, zoho_id: str | None = None, **fields: Any) -> Customer:
    if not zoho_id:
        obj = Customer(**fields)
        session.add(obj)
        session.flush()
        return obj
    stmt = (
        pg_insert(Customer)
        .values(zoho_id=zoho_id, **fields)
        .on_conflict_do_update(
            index_elements=[Customer.zoho_id],
            set_={k: v for k, v in fields.items() if k != "id"},
        )
        .returning(Customer)
    )
    return session.execute(stmt).scalar_one()


def upsert_project(session: Session, *, clickup_id: str | None = None, **fields: Any) -> Project:
    if not clickup_id:
        obj = Project(**fields)
        session.add(obj)
        session.flush()
        return obj
    stmt = (
        pg_insert(Project)
        .values(clickup_id=clickup_id, **fields)
        .on_conflict_do_update(
            index_elements=[Project.clickup_id],
            set_={k: v for k, v in fields.items() if k != "id"},
        )
        .returning(Project)
    )
    return session.execute(stmt).scalar_one()


def upsert_task(session: Session, *, clickup_id: str | None = None, **fields: Any) -> Task:
    if not clickup_id:
        obj = Task(**fields)
        session.add(obj)
        session.flush()
        return obj
    stmt = (
        pg_insert(Task)
        .values(clickup_id=clickup_id, **fields)
        .on_conflict_do_update(
            index_elements=[Task.clickup_id],
            set_={k: v for k, v in fields.items() if k != "id"},
        )
        .returning(Task)
    )
    return session.execute(stmt).scalar_one()


def upsert_deal(session: Session, *, zoho_id: str | None = None, **fields: Any) -> Deal:
    if not zoho_id:
        obj = Deal(**fields)
        session.add(obj)
        session.flush()
        return obj
    stmt = (
        pg_insert(Deal)
        .values(zoho_id=zoho_id, **fields)
        .on_conflict_do_update(
            index_elements=[Deal.zoho_id],
            set_={k: v for k, v in fields.items() if k != "id"},
        )
        .returning(Deal)
    )
    return session.execute(stmt).scalar_one()


# ---------- Read helpers used by the Pull agent retrieval step --------------

def find_projects_by_text(session: Session, q: str, *, limit: int = 5) -> list[Project]:
    pat = f"%{q.lower()}%"
    stmt = (
        select(Project)
        .where(func.lower(Project.name).like(pat))
        .order_by(Project.updated_at.desc())
        .limit(limit)
    )
    return list(session.execute(stmt).scalars())


def find_tasks_by_text(session: Session, q: str, *, limit: int = 10) -> list[Task]:
    pat = f"%{q.lower()}%"
    stmt = (
        select(Task)
        .where(func.lower(Task.title).like(pat))
        .order_by(Task.updated_at.desc())
        .limit(limit)
    )
    return list(session.execute(stmt).scalars())


def find_people_by_text(session: Session, q: str, *, limit: int = 5) -> list[Person]:
    pat = f"%{q.lower()}%"
    stmt = (
        select(Person)
        .where(
            or_(
                func.lower(Person.canonical_name).like(pat),
                func.lower(Person.email).like(pat),
            )
        )
        .order_by(Person.updated_at.desc())
        .limit(limit)
    )
    return list(session.execute(stmt).scalars())


def find_deals_by_text(session: Session, q: str, *, limit: int = 5) -> list[Deal]:
    pat = f"%{q.lower()}%"
    stmt = (
        select(Deal)
        .where(func.lower(Deal.name).like(pat))
        .order_by(Deal.updated_at.desc())
        .limit(limit)
    )
    return list(session.execute(stmt).scalars())


def find_customers_by_text(session: Session, q: str, *, limit: int = 5) -> list[Customer]:
    pat = f"%{q.lower()}%"
    stmt = (
        select(Customer)
        .where(func.lower(Customer.name).like(pat))
        .order_by(Customer.updated_at.desc())
        .limit(limit)
    )
    return list(session.execute(stmt).scalars())


def deals_for_customer(session: Session, customer_id: UUID, *, limit: int = 25) -> list[Deal]:
    stmt = (
        select(Deal)
        .where(Deal.customer_id == customer_id)
        .order_by(Deal.last_activity_at.desc().nullslast(), Deal.updated_at.desc())
        .limit(limit)
    )
    return list(session.execute(stmt).scalars())


def tasks_for_project(session: Session, project_id: UUID, *, limit: int = 50) -> list[Task]:
    stmt = (
        select(Task)
        .where(Task.project_id == project_id)
        .order_by(Task.updated_at.desc())
        .limit(limit)
    )
    return list(session.execute(stmt).scalars())


def stale_tasks(
    session: Session,
    *,
    min_days_in_stage: int = 14,
    exclude_stages: tuple[str, ...] = ("complete", "closed", "done", "cancelled"),
    limit: int = 200,
) -> list[Task]:
    """Tasks sitting in a non-terminal stage longer than ``min_days_in_stage`` days."""
    from sqlalchemy import not_

    stmt = (
        select(Task)
        .where(Task.days_in_stage.is_not(None))
        .where(Task.days_in_stage >= min_days_in_stage)
        .where(
            or_(
                Task.stage.is_(None),
                not_(func.lower(Task.stage).in_(exclude_stages)),
            )
        )
        .order_by(Task.days_in_stage.desc())
        .limit(limit)
    )
    return list(session.execute(stmt).scalars())


def quiet_deals(
    session: Session,
    *,
    min_days_quiet: int = 14,
    exclude_stages: tuple[str, ...] = ("closed won", "closed lost"),
    limit: int = 200,
) -> list[Deal]:
    """Open deals whose last_activity_at is older than ``min_days_quiet`` days."""
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import not_

    cutoff = datetime.now(timezone.utc) - timedelta(days=min_days_quiet)
    stmt = (
        select(Deal)
        .where(Deal.last_activity_at.is_not(None))
        .where(Deal.last_activity_at < cutoff)
        .where(
            or_(
                Deal.stage.is_(None),
                not_(func.lower(Deal.stage).in_(exclude_stages)),
            )
        )
        .order_by(Deal.last_activity_at.asc())
        .limit(limit)
    )
    return list(session.execute(stmt).scalars())


__all__ = [
    "upsert_person",
    "upsert_customer",
    "upsert_project",
    "upsert_task",
    "upsert_deal",
    "find_projects_by_text",
    "find_tasks_by_text",
    "find_people_by_text",
    "find_deals_by_text",
    "find_customers_by_text",
    "tasks_for_project",
    "deals_for_customer",
    "stale_tasks",
    "quiet_deals",
]