"""Pure-Python tests for the sales_views helpers (WBS 1.5).

These cover the bits that don't need a live DB session: the closed-stage
predicate, the days-quiet age calculator, and the two render functions
that ultimately become the Context blocks the LLM cites.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import uuid4

import pytest

from orchestrator.sales_views import (
    CustomerSummary,
    DealSummary,
    _days_quiet,
    _hit,
    _is_closed,
    _render_customer,
    _render_deal,
)


# ---- _is_closed ----------------------------------------------------------

@pytest.mark.parametrize(
    ("stage", "expected"),
    [
        ("Closed Won", True),
        ("closed lost", True),
        ("Won", True),
        ("LOST", True),
        ("cancelled", True),
        ("Negotiation", False),
        ("Qualified", False),
        ("", False),
        (None, False),
    ],
)
def test_is_closed(stage: str | None, expected: bool) -> None:
    assert _is_closed(stage) is expected


# ---- _days_quiet ---------------------------------------------------------

def test_days_quiet_naive_treated_as_utc() -> None:
    five_days_ago = (datetime.now(timezone.utc) - timedelta(days=5, hours=1)).replace(tzinfo=None)
    assert _days_quiet(five_days_ago) == 5


def test_days_quiet_handles_tz_aware() -> None:
    twenty = datetime.now(timezone.utc) - timedelta(days=20, hours=2)
    assert _days_quiet(twenty) == 20


def test_days_quiet_none() -> None:
    assert _days_quiet(None) is None


# ---- _hit ---------------------------------------------------------------

def test_hit_builds_canonical_citation_token() -> None:
    cid = uuid4()
    h = _hit("customer", cid, "Acme Inc")
    assert h.kind == "customer"
    assert h.id == cid
    assert h.cite == f"[customer:{cid}]"
    assert h.text == "Acme Inc"


# ---- renderers ----------------------------------------------------------

def test_render_customer_includes_all_optional_fields() -> None:
    s = CustomerSummary(
        customer_id=uuid4(),
        name="Acme Inc",
        deal_count=5,
        open_deal_count=2,
        pipeline_value_inr=Decimal("1234567.00"),
        last_activity_at=datetime(2025, 6, 1, tzinfo=timezone.utc),
        owner_names=["Vijay", "Sneha"],
    )
    blob = _render_customer(s)
    assert "Customer Acme Inc" in blob
    assert "open_deals=2/5" in blob
    assert "pipeline_inr=1234567.00" in blob
    assert "last_activity=2025-06-01" in blob
    assert "owners=Vijay,Sneha" in blob


def test_render_customer_skips_optional_fields_when_none() -> None:
    s = CustomerSummary(
        customer_id=uuid4(),
        name="Bare Co",
        deal_count=0,
        open_deal_count=0,
        pipeline_value_inr=None,
        last_activity_at=None,
        owner_names=[],
    )
    blob = _render_customer(s)
    assert "pipeline_inr" not in blob
    assert "last_activity" not in blob
    assert "owners" not in blob


def test_render_deal_full() -> None:
    s = DealSummary(
        deal_id=uuid4(),
        name="Big Printer Sale",
        stage="Negotiation",
        value_inr=Decimal("500000"),
        customer_name="Acme",
        owner_name="Vijay",
        days_quiet=21,
        last_activity_at=None,
    )
    blob = _render_deal(s)
    assert "Big Printer Sale" in blob
    assert "stage=Negotiation" in blob
    assert "value_inr=500000" in blob
    assert "customer=Acme" in blob
    assert "owner=Vijay" in blob
    assert "days_quiet=21" in blob


def test_render_deal_skips_optionals() -> None:
    s = DealSummary(
        deal_id=uuid4(),
        name="Tiny",
        stage=None,
        value_inr=None,
        customer_name=None,
        owner_name=None,
        days_quiet=None,
        last_activity_at=None,
    )
    blob = _render_deal(s)
    assert blob == "Deal 'Tiny'."
