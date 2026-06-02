"""Integration tests for the new Phase-0 modules: Zoho normaliser, reconciler, and citation repair."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from acb_graph import get_session, repo
from acb_llm.guardrails import repair_citations
from ingestion.sources.zoho.normaliser import (
    normalise_accounts,
    normalise_contacts,
    normalise_deals,
    normalise_users,
)


# ---------- Zoho normaliser ------------------------------------------------

def test_zoho_normaliser_inserts_and_upserts_idempotently() -> None:
    accounts = [
        {"id": "ZA-1", "Account_Name": "Test Acme Robotics"},
        {"id": "ZA-2", "Account_Name": "Test Beta Industries"},
    ]
    users = [
        {
            "id": "U1",
            "first_name": "Sam",
            "last_name": "Tester",
            "email": "sam.tester+zohotest@example.com",
            "role": {"name": "Sales"},
        }
    ]
    contacts = [
        {
            "id": "ZC-1",
            "First_Name": "Test",
            "Last_Name": "Contact",
            "Email": "zoho.contact.test1@example.com",
            "Title": "PM",
        }
    ]
    deals = [
        {
            "id": "ZD-1",
            "Deal_Name": "Test Acme Phase-0 Deal",
            "Stage": "Proposal / Quote Sent",
            "Amount": "123456.78",
            "Modified_Time": "2024-01-15T10:00:00+00:00",
            "Last_Activity_Time": "2024-01-15T10:00:00+00:00",
            "Account_Name": {"id": "ZA-1", "name": "Test Acme Robotics"},
            "Owner": {"id": "U1", "name": "Sam Tester", "email": "sam.tester+zohotest@example.com"},
        }
    ]

    with get_session() as s:
        assert normalise_accounts(s, accounts) == 2
        assert normalise_users(s, users) == 1
        assert normalise_contacts(s, contacts) == 1
        assert normalise_deals(s, deals) == 1

    # Idempotent rerun should not duplicate or error.
    with get_session() as s:
        assert normalise_accounts(s, accounts) == 2
        assert normalise_deals(s, deals) == 1

    with get_session() as s:
        deal_rows = repo.find_deals_by_text(s, "Acme Phase-0", limit=5)
        assert any(d.zoho_id == "ZD-1" for d in deal_rows)
        for d in deal_rows:
            if d.zoho_id == "ZD-1":
                assert d.customer is not None and d.customer.zoho_id == "ZA-1"
                assert d.owner is not None
                assert d.value_inr is not None


# ---------- Reconciler -----------------------------------------------------

def test_reconciler_flags_recent_quiet_test_deal() -> None:
    """Seed a quiet test deal then assert the reconciler picks it up."""
    from scripts import reconciler

    cust_zoho = "RECON-TEST-CUST"
    deal_zoho = "RECON-TEST-DEAL"
    with get_session() as s:
        cust = repo.upsert_customer(s, zoho_id=cust_zoho, name="Reconciler Test Customer")
        repo.upsert_deal(
            s,
            zoho_id=deal_zoho,
            name="Reconciler Test Quiet Deal",
            customer_id=cust.id,
            stage="Negotiation",
            last_activity_at=datetime.now(timezone.utc) - timedelta(days=45),
        )

    counts = reconciler.run(task_days=14, deal_days=14)
    assert counts["quiet_deals"] >= 1


# ---------- Citation repair ------------------------------------------------

def test_repair_citations_snaps_truncated_uuid() -> None:
    truncated = "Project status is good [project:6ed5b515-4796-452c-8651-ecf2d07b394]."
    valid = [("project", "6ed5b515-4796-452c-8651-ecf2d07b3940")]
    fixed = repair_citations(truncated, valid)
    assert "[project:6ed5b515-4796-452c-8651-ecf2d07b3940]" in fixed


def test_repair_citations_leaves_exact_match_alone() -> None:
    good = "All set [task:6ed5b515-4796-452c-8651-ecf2d07b3940]."
    valid = [("task", "6ed5b515-4796-452c-8651-ecf2d07b3940")]
    assert repair_citations(good, valid) == good


def test_repair_citations_does_not_snap_when_far() -> None:
    bad = "Random [deal:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee]."
    valid = [("deal", "6ed5b515-4796-452c-8651-ecf2d07b3940")]
    assert repair_citations(bad, valid) == bad

# ---------- Hardening: upsert_person email reconciliation ------------------

def test_upsert_person_email_reconciles_clickup_then_zoho() -> None:
    """Same email seeded from ClickUp first, then Zoho second -> single row, both IDs filled."""
    import uuid

    suffix = uuid.uuid4().hex[:8]
    email = f"merge.test+{suffix}@example.com"
    clickup_id = f"CU-MERGE-{suffix}"
    zoho_id = f"ZU-MERGE-{suffix}"

    with get_session() as s:
        p1 = repo.upsert_person(
            s,
            clickup_id=clickup_id,
            canonical_name="Merge Test User",
            email=email,
        )
        assert p1.clickup_id == clickup_id
        assert p1.zoho_id is None

    with get_session() as s:
        p2 = repo.upsert_person(
            s,
            zoho_id=zoho_id,
            canonical_name="Merge Test User",
            email=email,
            role="Engineer",
        )
        # Must reconcile onto the existing row, not create a duplicate.
        assert p2.id == p1.id
        assert p2.clickup_id == clickup_id
        assert p2.zoho_id == zoho_id
        assert p2.role == "Engineer"

    # Idempotent re-run with the same zoho_id should not change anything.
    with get_session() as s:
        p3 = repo.upsert_person(
            s,
            zoho_id=zoho_id,
            canonical_name="Merge Test User",
            email=email,
        )
        assert p3.id == p1.id


# ---------- Hardening: hard-cut citation cannot be repaired ----------------

def test_repair_citations_cannot_fix_missing_closing_bracket() -> None:
    """A token that lost its closing ']' is not a citation at all -> repair leaves it.

    require_citations will then correctly refuse to surface the output.
    """
    from acb_llm.guardrails import CITATION_RE, repair_citations, require_citations

    bad = "We have one deal [deal:6ed5b515-4796-452c-8651-ecf2d07b3940"  # no closing ]
    valid = [("deal", "6ed5b515-4796-452c-8651-ecf2d07b3940")]
    repaired = repair_citations(bad, valid)
    assert "]" not in repaired  # nothing to repair against
    assert not CITATION_RE.search(repaired)
    with pytest.raises(Exception):
        require_citations(repaired)
