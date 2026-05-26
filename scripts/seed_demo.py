"""Seed the dev DB with a handful of demo entities so the Pull agent has
something to ground on before real ClickUp ingestion lands (WBS 0.3).

Run:  uv run python -m scripts.seed_demo
Idempotent: re-running upserts on stable clickup_id values.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from acb_graph import get_session, repo


def main() -> None:
    now = datetime.now(timezone.utc)
    with get_session() as s:
        cust = repo.upsert_customer(s, zoho_id="cust-demo-acme", name="Acme Robotics Pvt Ltd")

        alice = repo.upsert_person(
            s,
            clickup_id="user-demo-alice",
            canonical_name="Alice Iyer",
            email="alice@fracktal.in",
            role="Engineering Lead",
        )
        bob = repo.upsert_person(
            s,
            clickup_id="user-demo-bob",
            canonical_name="Bob Menon",
            email="bob@fracktal.in",
            role="Mechanical Engineer",
        )

        julian = repo.upsert_project(
            s,
            clickup_id="proj-demo-julian",
            name="Project Julian — Acme robotic arm v2",
            customer_id=cust.id,
            status="in_progress",
        )
        atlas = repo.upsert_project(
            s,
            clickup_id="proj-demo-atlas",
            name="Project Atlas — internal CI/CD revamp",
            status="on_hold",
        )

        repo.upsert_task(
            s,
            clickup_id="task-demo-julian-1",
            title="Finalise wrist-joint torque spec for Julian",
            owner_id=alice.id,
            project_id=julian.id,
            stage="review",
            stage_entered_at=now - timedelta(days=4),
            days_in_stage=4,
        )
        repo.upsert_task(
            s,
            clickup_id="task-demo-julian-2",
            title="Order servo motors from supplier for Julian build",
            owner_id=bob.id,
            project_id=julian.id,
            stage="blocked",
            stage_entered_at=now - timedelta(days=11),
            days_in_stage=11,
        )
        repo.upsert_task(
            s,
            clickup_id="task-demo-atlas-1",
            title="Migrate Atlas CI pipeline from Jenkins to GitHub Actions",
            owner_id=alice.id,
            project_id=atlas.id,
            stage="todo",
            stage_entered_at=now - timedelta(days=21),
            days_in_stage=21,
        )

    print("seeded: 1 customer, 2 people, 2 projects, 3 tasks")


if __name__ == "__main__":
    main()