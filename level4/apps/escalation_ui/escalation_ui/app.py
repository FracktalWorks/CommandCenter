"""Streamlit escalation queue.

Reads recent `audit_event(action='escalation')` rows produced by the reconciler.
For each finding, shows the latest *state* (latest audit_event for the same
target whose action is in {ack, snooze, resolved, escalation}) and lets the
operator write a new audit event to advance that state.

Run:
    uv run streamlit run apps/escalation_ui/escalation_ui/app.py
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pandas as pd
import streamlit as st
from sqlalchemy import desc, select

from acb_audit import AuditEvent as AuditDataclass, record
from acb_graph import get_session
from acb_graph.models import AuditEvent

ACTIONABLE = {"escalation", "ack", "snooze", "resolved"}
ACTOR = "user:escalation_ui"


def _load_open_findings(lookback_days: int = 30) -> list[dict[str, Any]]:
    """Return the latest event per target, keeping only those still 'open'.

    Open = latest action is `escalation` (never touched) or `snooze` whose
    snooze window has expired.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    with get_session() as s:
        rows = list(
            s.execute(
                select(AuditEvent)
                .where(AuditEvent.action.in_(ACTIONABLE))
                .where(AuditEvent.at >= cutoff)
                .order_by(desc(AuditEvent.at))
            ).scalars()
        )

    latest: dict[str, AuditEvent] = {}
    for ev in rows:
        latest.setdefault(ev.target, ev)

    open_items: list[dict[str, Any]] = []
    now = datetime.now(timezone.utc)
    for target, ev in latest.items():
        if ev.action == "resolved" or ev.action == "ack":
            continue
        if ev.action == "snooze":
            until = ev.payload.get("snooze_until")
            try:
                if until and datetime.fromisoformat(until) > now:
                    continue
            except ValueError:
                pass
        # escalation (or expired snooze) — show it.
        payload = ev.payload or {}
        open_items.append(
            {
                "target": target,
                "kind": payload.get("kind", "?"),
                "title": payload.get("title") or payload.get("name") or target,
                "stage": payload.get("stage"),
                "owner": payload.get("owner"),
                "customer": payload.get("customer"),
                "project": payload.get("project"),
                "days": payload.get("days_in_stage") or payload.get("days_quiet"),
                "cite": payload.get("cite"),
                "at": ev.at,
                "raw": payload,
            }
        )
    open_items.sort(key=lambda r: (r["days"] or 0), reverse=True)
    return open_items


def _record(action: str, target: str, payload: dict[str, Any]) -> None:
    record(
        AuditDataclass(
            actor=ACTOR,
            action=action,
            target=target,
            payload=payload,
        )
    )


def _render_row(item: dict[str, Any]) -> None:
    cols = st.columns([3, 1, 1, 1, 1, 1])
    with cols[0]:
        st.markdown(f"**{item['title']}**  \n`{item['target']}`")
        meta = " · ".join(
            str(x)
            for x in [
                item.get("kind"),
                item.get("stage"),
                item.get("customer"),
                item.get("project"),
                item.get("owner"),
            ]
            if x
        )
        st.caption(meta or "—")
    with cols[1]:
        st.metric("days", item.get("days") or "—")
    with cols[2]:
        st.caption(item["at"].strftime("%Y-%m-%d %H:%M"))
    with cols[3]:
        if st.button("Ack", key=f"ack-{item['target']}"):
            _record("ack", item["target"], {"cite": item["cite"]})
            st.toast(f"Acked {item['target']}")
            st.rerun()
    with cols[4]:
        if st.button("Snooze 7d", key=f"snz-{item['target']}"):
            until = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()
            _record(
                "snooze",
                item["target"],
                {"cite": item["cite"], "snooze_until": until},
            )
            st.toast(f"Snoozed {item['target']} until {until[:10]}")
            st.rerun()
    with cols[5]:
        if st.button("Resolve", key=f"res-{item['target']}"):
            _record("resolved", item["target"], {"cite": item["cite"]})
            st.toast(f"Resolved {item['target']}")
            st.rerun()


def main() -> None:
    st.set_page_config(page_title="Escalation Queue", layout="wide")
    st.title("Escalation Queue")
    st.caption(
        "Reconciler findings still waiting on a human. Ack acknowledges without "
        "changing the underlying record; Snooze hides for 7 days; Resolve closes the item."
    )

    with st.sidebar:
        st.header("Filters")
        kinds = st.multiselect(
            "Kind",
            options=["stale_task", "quiet_deal"],
            default=["stale_task", "quiet_deal"],
        )
        lookback = st.slider("Lookback (days)", 1, 90, 30)
        if st.button("Refresh"):
            st.rerun()

    items = [i for i in _load_open_findings(lookback_days=lookback) if i["kind"] in kinds]
    st.subheader(f"{len(items)} open findings")

    if not items:
        st.success("Nothing open. Either reconciler hasn't run or you're caught up.")
        return

    # Summary table
    df = pd.DataFrame(
        [
            {
                "kind": i["kind"],
                "title": i["title"],
                "stage": i["stage"],
                "days": i["days"],
                "owner": i["owner"],
                "customer": i["customer"],
            }
            for i in items
        ]
    )
    st.dataframe(df, use_container_width=True, height=240)

    st.divider()
    st.subheader("Actions")
    # Per-row controls (cap to 100 to keep page snappy)
    for item in items[:100]:
        _render_row(item)
        st.divider()


if __name__ == "__main__":
    main()