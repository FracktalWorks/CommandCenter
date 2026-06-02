# Level 4 — Company Intelligence (shelved subtree)

This directory holds the **Level-4 company-intelligence** code, moved here intact
during the platform restructure. It is the agentic layer over ClickUp / Zoho / Odoo
and the org-memory / reconciler / action-broker stack from the original
company-brain build.

It is **kept as a uv-workspace member**, so it still builds and tests in the same
`.venv` as the active platform — but it is **reference / reuse material until L4
work begins** (see [`../ai-company-brain/project_plan.md`](../ai-company-brain/project_plan.md) §7, Level 4).

## Contents

```
apps/
  gateway/         FastAPI entry — pull queries, approvals
  orchestrator/    LangGraph orchestration core, triage, resolution, sales views
  ingestion/       ClickUp / Zoho / Gmail / Outlook / WhatsApp workers
  reconciler/      Nightly diff + escalation
  action_broker/   Approval-gated writes back to systems of record
  escalation_ui/   Streamlit escalation queue
packages/
  acb_graph/       Graph access (SQLAlchemy models, repo, entity resolver)
skills/            Company skills: sales, delivery, reconciler, triage
scripts/           zoho_sync, clickup_sync, reconciler, seed_demo, n8n_export
tests/             Company-brain unit + integration tests
workflows/         Legacy n8n exports (superseded by PD-03; kept for reference)
```

## Notes

- Active platform packages (`acb_common`, `acb_schemas`, `acb_llm`, `acb_audit`,
  `acb_auth`, `acb_skills`) stay at the repo root under `packages/`.
- `acb_audit` has a *guarded, lazy* import of `acb_graph`; it does not hard-depend
  on this subtree at import time.
- The n8n workflow exports are retained only as a record; the platform uses its own
  agent-native workflow engine (PD-03 / PD-04).
