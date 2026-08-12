"""The Control Plane HTTP surface.

WS-31 CP-1/CP-2 · spec ``project-docs/specs/platform_control_plane.md`` §6.

**Scaffolding, deliberately.** The endpoints below are the ones the rest of the
plan depends on existing — provisioning, seat resolution, seat writes, credit
grant and balance, usage recording. They are wired to real SQL and covered by
real tests. What they are NOT yet is *authenticated*: operator authentication is
CP-8 and customer-admin authentication is WS-30's, and both need the CP-0 auth
work to land underneath them first.

That gap is enforced rather than commented. :func:`require_operator` refuses
every request unless ``CONTROL_PLANE_OPERATOR_TOKEN`` is set, so this service
cannot be exposed by accident — the same fail-closed posture CP-0 established in
the workbench, applied here from the first line rather than retrofitted. Do not
"temporarily" relax it; that is precisely how the workbench came to serve every
route to anyone.

Endpoints are ``def`` rather than ``async def`` so FastAPI runs them in its
threadpool alongside the sync engine (see :mod:`platform_api.db`).
"""
from __future__ import annotations

import os
import secrets
from decimal import Decimal
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text

from platform_api import store
from platform_api.credits import (
    OverdraftPolicy,
    balance_of,
    decide_spend,
)
from platform_api.db import get_engine
from platform_api.seats import CORE_PLAN_SLUG, decide_assignment, seat_counts

app = FastAPI(
    title="CommandCenter Control Plane",
    description=(
        "Organizations, seats, subscriptions and AI metering. Cross-tenant by "
        "design (saas_multitenancy.md §0.9.2) — never exposed to a tenant."
    ),
    version="0.1.0",
)


# ── Auth ────────────────────────────────────────────────────────────────────

def require_operator(
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    """Refuse anything that is not the operator.

    Fails **closed** when unconfigured. Every other posture — allow-when-unset,
    warn-and-continue — is the defect D33.1 recorded in the workbench, where
    "no credentials configured" was read as "run wide open" and a production box
    that lost its auth env served everything to anyone.
    """
    expected = os.environ.get("CONTROL_PLANE_OPERATOR_TOKEN", "").strip()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="CONTROL_PLANE_OPERATOR_TOKEN is not configured",
        )
    presented = ""
    if authorization and authorization.startswith("Bearer "):
        presented = authorization.removeprefix("Bearer ").strip()
    if not presented or not secrets.compare_digest(presented, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


Operator = Annotated[None, Depends(require_operator)]


# ── Schemas ─────────────────────────────────────────────────────────────────

class ProvisionRequest(BaseModel):
    slug: str
    name: str
    #: Captured at SIGNUP, not at first invoice (saas_operations_doctrine.md
    #: §3.1) — chasing a GSTIN after invoices have gone out is a customer
    #: conversation, not a migration.
    gstin: str | None = None
    billing_state: str | None = None
    owner_email: str
    core_seats: int = Field(default=1, ge=1)


class ResolveRequest(BaseModel):
    org_slug: str
    email: str
    display_name: str | None = None


class SeatWriteRequest(BaseModel):
    org_slug: str
    email: str
    plan_slug: str
    source: str = "alacarte"


class CreditGrantRequest(BaseModel):
    org_slug: str
    credits: Decimal
    reason: str = "purchase"
    ref: str | None = None


class UsageRequest(BaseModel):
    org_slug: str
    request_id: str
    billed_credits: Decimal = Decimal(0)
    user_email: str | None = None
    agent: str | None = None
    module_slug: str | None = None
    model: str | None = None
    tier: str | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0


# ── Helpers ─────────────────────────────────────────────────────────────────

def _org_id(conn, slug: str) -> str:
    row = conn.execute(
        text("SELECT id FROM organization WHERE slug = :slug"), {"slug": slug}
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail=f"no organization {slug!r}")
    return str(row[0])


def _audit(conn, org_id: str | None, action: str, detail: dict[str, Any]) -> None:
    conn.execute(
        text(
            "INSERT INTO control_audit (organization_id, actor, action, detail) "
            "VALUES (:org, :actor, :action, CAST(:detail AS jsonb))"
        ),
        {"org": org_id, "actor": "operator", "action": action,
         "detail": __import__("json").dumps(detail)},
    )


# ── Routes ──────────────────────────────────────────────────────────────────

@app.get("/health")
def health() -> dict[str, str]:
    """Liveness. Deliberately unauthenticated and deliberately says nothing."""
    return {"status": "ok"}


@app.post("/orgs/provision")
def provision(req: ProvisionRequest, _: Operator) -> dict[str, Any]:
    """Create an organization, its owner and its Core seats. Idempotent.

    Idempotent on the org slug rather than on a request id, because the natural
    key is what a retrying signup form actually resends. Provisioning is a
    multi-step action that WILL fail halfway; re-running it must converge on one
    organization rather than produce a second (§2.1).
    """
    with get_engine().begin() as conn:
        org_id = store.ensure_organization(
            conn, slug=req.slug, name=req.name,
            gstin=req.gstin, billing_state=req.billing_state,
        )
        identity_id = store.ensure_identity(conn, email=req.owner_email)

        # Only grant on FIRST provision — a retry must not keep buying seats.
        grants, _assigned = store.seat_rows(
            conn, org_id=org_id, plan_slug=CORE_PLAN_SLUG
        )
        if not grants:
            store.grant_seats(
                conn, org_id=org_id, plan_slug=CORE_PLAN_SLUG,
                quantity=req.core_seats, reason="provision",
            )

        conn.execute(
            text(
                """
                INSERT INTO org_membership
                    (organization_id, user_identity_id, role, status, joined_at)
                VALUES (:org, :identity, 'owner', 'active', now())
                ON CONFLICT (organization_id, user_identity_id) DO NOTHING
                """
            ),
            {"org": org_id, "identity": identity_id},
        )
        store.try_assign_seat(
            conn, org_id=org_id, plan_slug=CORE_PLAN_SLUG,
            identity_id=identity_id, source="core",
        )
        _audit(conn, org_id, "org.provision", {"slug": req.slug})

    return {"organization_id": org_id, "slug": req.slug}


@app.post("/registry/resolve")
def resolve(req: ResolveRequest, _: Operator) -> dict[str, Any]:
    """Resolve a person against the registry at sign-in, consuming a Core seat.

    **This is what makes the seat cap real.** A person cannot become a user of
    an organization without the Control Plane allocating them a seat, because
    the deployment asks before admitting them (D32.4/D32.5).

    Returns 409 with a buy-more payload when the organization is full — never an
    auto-upgrade, and never a silent admit.
    """
    with get_engine().begin() as conn:
        org_id = _org_id(conn, req.org_slug)
        identity_id = store.ensure_identity(
            conn, email=req.email, display_name=req.display_name
        )

        held = store.has_live_seat(
            conn, org_id=org_id, plan_slug=CORE_PLAN_SLUG, identity_id=identity_id
        )
        grants, assigned = store.seat_rows(
            conn, org_id=org_id, plan_slug=CORE_PLAN_SLUG
        )
        decision = decide_assignment(
            seat_counts(CORE_PLAN_SLUG, grants, assigned),
            already_assigned=held,
            price_inr=store.plan_price(conn, plan_slug=CORE_PLAN_SLUG),
        )
        if not decision.allowed:
            raise HTTPException(
                status_code=decision.status,
                detail={"reason": decision.reason, "buy_more": decision.buy_more},
            )

        if not held:
            store.try_assign_seat(
                conn, org_id=org_id, plan_slug=CORE_PLAN_SLUG,
                identity_id=identity_id, source="core",
            )

        role = conn.execute(
            text(
                "SELECT role, status FROM org_membership "
                "WHERE organization_id = :org AND user_identity_id = :i"
            ),
            {"org": org_id, "i": identity_id},
        ).first()
        seats = [
            r[0] for r in conn.execute(
                text(
                    "SELECT plan_slug FROM seat_assignment "
                    "WHERE organization_id = :org AND user_identity_id = :i "
                    "AND released_at IS NULL"
                ),
                {"org": org_id, "i": identity_id},
            )
        ]

    return {
        "identity_id": identity_id,
        "organization_id": org_id,
        "role": role[0] if role else "member",
        "status": role[1] if role else "active",
        "seats": seats,
    }


@app.get("/billing/summary")
def billing_summary(org_slug: str, _: Operator) -> dict[str, Any]:
    """Seats and credits for one organization — the console's single read."""
    with get_engine().begin() as conn:
        org_id = _org_id(conn, org_slug)
        plans = [
            r[0] for r in conn.execute(
                text("SELECT slug FROM plan_catalog WHERE active ORDER BY sort_order")
            )
        ]
        seats = []
        for plan in plans:
            grants, assigned = store.seat_rows(conn, org_id=org_id, plan_slug=plan)
            if not grants and not assigned:
                continue  # never bought, never assigned — not worth a row
            c = seat_counts(plan, grants, assigned)
            seats.append({
                "plan_slug": plan,
                "purchased": c.purchased,
                "assigned": c.assigned,
                "available": c.available,
                "oversubscribed": c.oversubscribed,
            })
        balance = balance_of(store.credit_deltas(conn, org_id=org_id))

    return {
        "organization_id": org_id,
        "seats": seats,
        "credit_balance": str(balance),
    }


@app.post("/billing/seats")
def assign_seat(req: SeatWriteRequest, _: Operator) -> dict[str, Any]:
    """Assign a seat on a plan. 409 at the cap, with a buy-more payload."""
    with get_engine().begin() as conn:
        org_id = _org_id(conn, req.org_slug)
        identity_id = store.ensure_identity(conn, email=req.email)
        held = store.has_live_seat(
            conn, org_id=org_id, plan_slug=req.plan_slug, identity_id=identity_id
        )
        grants, assigned = store.seat_rows(
            conn, org_id=org_id, plan_slug=req.plan_slug
        )
        decision = decide_assignment(
            seat_counts(req.plan_slug, grants, assigned),
            already_assigned=held,
            price_inr=store.plan_price(conn, plan_slug=req.plan_slug),
        )
        if not decision.allowed:
            raise HTTPException(
                status_code=decision.status,
                detail={"reason": decision.reason, "buy_more": decision.buy_more},
            )
        store.try_assign_seat(
            conn, org_id=org_id, plan_slug=req.plan_slug,
            identity_id=identity_id, source=req.source,
        )
        _audit(conn, org_id, "seat.assign",
               {"email": req.email, "plan": req.plan_slug})

    return {"assigned": True, "plan_slug": req.plan_slug}


@app.post("/billing/seats/release")
def release_seat(req: SeatWriteRequest, _: Operator) -> dict[str, Any]:
    """Release a seat. Frees capacity immediately (D19.3)."""
    with get_engine().begin() as conn:
        org_id = _org_id(conn, req.org_slug)
        identity_id = store.ensure_identity(conn, email=req.email)
        released = store.release_seat(
            conn, org_id=org_id, plan_slug=req.plan_slug, identity_id=identity_id
        )
        _audit(conn, org_id, "seat.release",
               {"email": req.email, "plan": req.plan_slug, "released": released})

    return {"released": released}


@app.post("/credits/grant")
def grant_credits(req: CreditGrantRequest, _: Operator) -> dict[str, Any]:
    """Add credits. Append-only — a correction is another row, never an edit."""
    with get_engine().begin() as conn:
        org_id = _org_id(conn, req.org_slug)
        store.add_credit(
            conn, org_id=org_id, delta=req.credits,
            reason=req.reason, ref=req.ref,
        )
        balance = balance_of(store.credit_deltas(conn, org_id=org_id))
        _audit(conn, org_id, "credits.grant",
               {"delta": str(req.credits), "reason": req.reason})

    return {"balance": str(balance)}


@app.get("/credits/balance")
def credit_balance(org_slug: str, _: Operator) -> dict[str, Any]:
    with get_engine().begin() as conn:
        org_id = _org_id(conn, org_slug)
        balance = balance_of(store.credit_deltas(conn, org_id=org_id))
        status = conn.execute(
            text("SELECT status FROM organization WHERE id = :i"), {"i": org_id}
        ).scalar_one()

    decision = decide_spend(
        balance, Decimal(0),
        policy=OverdraftPolicy(),
        is_trial=(status == "trial"),
    )
    return {
        "balance": str(balance),
        "in_overdraft": decision.in_overdraft,
        "org_status": status,
    }


@app.post("/usage/record")
def record_usage(req: UsageRequest, _: Operator) -> dict[str, Any]:
    """Record one metered call. Idempotent on ``request_id``.

    Returns ``recorded: false`` for a replay — the caller should treat that as
    success, not as an error to retry, or a reconnect storm turns into a
    retry storm.
    """
    with get_engine().begin() as conn:
        org_id = _org_id(conn, req.org_slug)
        recorded = store.record_usage(
            conn,
            org_id=org_id,
            request_id=req.request_id,
            billed_credits=req.billed_credits,
            user_email=req.user_email,
            agent=req.agent,
            module_slug=req.module_slug,
            model=req.model,
            tier=req.tier,
            prompt_tokens=req.prompt_tokens,
            completion_tokens=req.completion_tokens,
            cached_tokens=req.cached_tokens,
        )
        balance = balance_of(store.credit_deltas(conn, org_id=org_id))

    return {"recorded": recorded, "balance": str(balance)}
