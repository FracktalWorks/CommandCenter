# Work Breakdown Structure — CommandCenter v2 (Distributed, Self-Mutating Agent Network)

> Project: CommandCenter v2 · Org: Fracktal Works · Date: 2026-06-02 · Version: 2.0
> Team: 2 engineers + AI assistance · Iterative, MVP-first, no hard deadline

This WBS is phase-decomposed by *capability slice*. Each phase delivers a deployed, working slice.

Effort uses **engineer-weeks (ew)** with PERT triple-point estimates: (O, M, P) and PERT = (O + 4M + P) / 6.

---

## Phase 0 — Core Engine Foundation (Capability: dynamic event routing + first agent running)

| WBS | Work Package | Activities | (O, M, P) ew | PERT ew |
|---|---|---|---|---|
| 0.1 | Infrastructure baseline | Provision VM, Docker Compose, Postgres+pgvector+AGE, Redis Streams, secrets vault, CI | (1, 1.5, 3) | 1.7 |
| 0.2 | Graph schema v0 | DDL for PERSON, TASK, PROJECT, CUSTOMER, DEAL, MESSAGE, MEETING, ACTIONITEM, GOAL | (0.5, 1, 2) | 1.1 |
| 0.3 | ClickUp ingestor | Webhook receiver + REST poller + entity normaliser + canonical-key resolver | (1, 2, 4) | 2.2 |
| 0.4 | Agent repo scaffold (template) | GitHub repo template for `agent-<name>` with `config.json`, `graph.py`, `instructions.md`, `tests/`, `evals/`; CI workflow that runs pytest + Promptfoo evals on every PR | (0.5, 1, 2) | 1.1 |
| 0.5 | Skill repo scaffold (template) | GitHub repo template for `skill-<name>` as a pip-installable Python package; entry function interface contract; CI workflow | (0.25, 0.5, 1) | 0.5 |
| 0.6 | Dynamic Agent Loader | FastAPI route controller: git clone agent + skill repos into transient volume; `sys.path.append` + `importlib.import_module('graph')`; lifecycle cleanup | (1, 2, 3) | 2.0 |
| 0.7 | LangGraph harness + PostgresSaver | State machine executor; `PostgresSaver` for durable state; audit log writer | (1, 2, 4) | 2.2 |
| 0.8 | Gateway + auth | FastAPI + Google SSO restricted to fracktal.in domain | (0.5, 1, 2) | 1.1 |
| 0.9 | First agent: `agent-task-manager` + `skill-clickup-sync` | Single agent answering "status of project / person / task" with citations; deployed as decoupled repos; validates end-to-end clone → import → execute flow | (1, 2, 3) | 2.0 |
| 0.10 | Guardrails v0 | Schema-validated outputs, citation enforcement, unresolved-entity abort | (0.5, 1, 2) | 1.1 |
| 0.11 | Observability (Langfuse + OTel) | Self-hosted Langfuse (docker-compose, Postgres+ClickHouse); openllmetry OTel SDK; cost meter per tier | (0.5, 1, 1.5) | 1.0 |
| 0.12 | Local inference stack | vLLM serving Qwen3-8B-Instruct (APC); LiteLLM gateway; Anthropic/OpenAI prompt caching config | (0.5, 1, 2) | 1.1 |
| 0.13 | Phase 0 review (mini-PDR) | Demo end-to-end clone → execute flow; retro; write Phase-1 backlog | (0.25, 0.5, 1) | 0.5 |
| **Phase 0 total** | | | | **~17.6 ew** (~9 calendar weeks with 2 engineers) |

**Phase 0 exit criteria:**
- Executive can ask "where are we on Project X?" and receive a cited answer.
- `agent-task-manager` + `skill-clickup-sync` are two separate GitHub repos; Core clones both at runtime, executes, and destroys containers.
- Reconciler flags drift between graph and ClickUp; zero silent divergence over 7 days.
- All LLM calls routed through the tier router; cost dashboard live in Langfuse.

---

## Phase 1 — Self-Mutation Loop (Capability: agents fix their own code and open PRs)

| WBS | Work Package | Activities | (O, M, P) ew | PERT ew |
|---|---|---|---|---|
| 1.1 | `Self_Mutation_Node` (LangGraph node) | Node that: checks `mutation_attempts_this_run < 1`; provisions OpenHands dev sandbox via SDK; injects failure telemetry from Langfuse; enforces max_mutation_attempts=1 | (1, 2, 3) | 2.0 |
| 1.2 | OpenHands dev sandbox integration | DinD via `/var/run/docker.sock`; OpenHands SDK container lifecycle (provision, inject, destroy); workspace = cloned agent repo | (1, 2, 3) | 2.0 |
| 1.3 | GitHub PR automation | GitHub API: create branch → commit fix → open PR with failure telemetry summary + diff + test results; PR template; no self-merge permission | (0.5, 1, 2) | 1.1 |
| 1.4 | Eval CI gate on agent/skill PRs | Promptfoo (golden cases) + Inspect AI (scenario tests) run on every PR in any `agent-*` or `skill-*` repo; PR comment with results; merge blocked on fail | (0.5, 1, 2) | 1.1 |
| 1.5 | Mutation audit logging | Log mutation PRs to Postgres (agent, error_type, pr_url, timestamp, outcome); expose in Control Plane HITL queue | (0.25, 0.5, 1) | 0.5 |
| 1.6 | Phase 1 review (M1: Self-Mutation live) | Demo: force a skill error → confirm Self_Mutation_Node opens PR → confirm max_mutation_attempts respected; review audit log | (0.1, 0.25, 0.5) | 0.25 |
| **Phase 1 total** | | | | **~7 ew** (~3.5 calendar weeks with 2 engineers) |

**Phase 1 exit criteria (M1 — Self-Mutation live):**
- A deliberate error injected into `skill-clickup-sync` causes `Self_Mutation_Node` to open a GitHub PR with a plausible fix within 5 minutes.
- A second deliberate error in the same run does NOT open a second PR (max_mutation_attempts enforced).
- Human merges the PR → CI evals pass → Core uses updated skill on next event.
- Mutation PRs visible in Control Plane HITL queue.

---

## Phase 2 — Agent & Skill Ecosystem (Capability: full domain coverage with specialist agents)

| WBS | Work Package | Activities | (O, M, P) ew | PERT ew |
|---|---|---|---|---|
| 2.1 | `agent-reconciler` + `skill-graph-write` | Nightly diff agent as independent repo; reconciler escalation queue wired to Control Plane | (1, 1.5, 3) | 1.7 |
| 2.2 | `agent-sales` + `skill-zoho-ingest` | Zoho CRM webhooks + REST + MCP; deal status, pipeline, customer 360 | (1, 2, 3) | 2.0 |
| 2.3 | `agent-triage` + `skill-gmail-capture` | Gmail Pub/Sub; email triage classifier; link to deals/projects | (1, 2, 3) | 2.0 |
| 2.4 | Customer/Person entity resolution | Deterministic + LLM fallback; cross-source canonical key deduplication | (1, 2, 4) | 2.2 |
| 2.5 | `skill-action-broker` | Approval queue write + audit logging; RBAC scaffold (exec / employee roles) | (0.5, 1, 2) | 1.1 |
| 2.6 | Semantic cache + token compression | GPTCache in front of LiteLLM (1h TTL); LLMLingua-2 on tool outputs >1k tokens | (0.5, 1, 2) | 1.1 |
| 2.7 | Mem0 + Graphiti memory integration | Episodic memory per user/account; bi-temporal entity KG; both on existing Postgres | (1, 1.5, 3) | 1.7 |
| 2.8 | Phase 2 review | (0.25, 0.5, 1) | 0.5 |
| **Phase 2 total** | | | | **~12.3 ew** (~6 calendar weeks with 2 engineers) |

---

## Phase 3 — Capture Expansion (Capability: WhatsApp + meetings + ambient triggers + push)

| WBS | Work Package | Activities | (O, M, P) ew | PERT ew |
|---|---|---|---|---|
| 3.1 | Meeting bot (`skill-meeting-transcribe`) | Vexa self-hosted on dedicated VM; `skill-meeting-transcribe` wraps WhisperX + Pyannote; calendar auto-accept | (1, 2, 3) | 2.0 |
| 3.2 | Transcript pipeline → graph | Diarised transcript → entity graph; action-item extraction (Tier-2) | (1, 2, 3) | 2.0 |
| 3.3 | `skill-whatsapp-send` + WhatsApp ingest agent | WhatsApp Business API provisioning; `agent-triage` extension for WA community; Meta webhook | (1, 2, 4) | 2.2 |
| 3.4 | Ambient trigger engine | Event bus → rule evaluator → agent dispatch | (1, 2, 4) | 2.2 |
| 3.5 | `agent-delivery` (push + stale-task detection) | Stale-task detection, ping, escalate; WhatsApp/email push channel | (1, 2, 3) | 2.0 |
| 3.6 | Phase 3 review | (0.25, 0.5, 1) | 0.5 |
| **Phase 3 total** | | | | **~11 ew** (~5.5 calendar weeks with 2 engineers) |

---

## Phase 4 — Write Authority + Approval UX

| WBS | Work Package | Activities | (O, M, P) ew | PERT ew |
|---|---|---|---|---|
| 4.1 | Action Broker full build | Approval queue, approval UI (Control Plane), audit log, rollback, per-action authority tier config system | (2, 3, 5) | 3.2 |
| 4.2 | Suggest+Apply: ClickUp task creation from meetings | From `agent-triage` → action-item → ClickUp task; confirm draft → write | (1, 2, 3) | 2.0 |
| 4.3 | Suggest+Apply: Zoho follow-up drafts | From `agent-sales` → stale deal → Gmail draft; suggest → approve → send | (1, 2, 3) | 2.0 |
| 4.4 | Phase 4 review | (0.25, 0.5, 1) | 0.5 |
| **Phase 4 total** | | | | **~7.7 ew** (~4 calendar weeks with 2 engineers) |

---

## Phase 5 — Intelligence Layer + Hardening

| WBS | Work Package | Activities | (O, M, P) ew | PERT ew |
|---|---|---|---|---|
| 5.1 | `agent-strategy` | Weekly digest + hiring/firing signals; LightRAG over internal docs/SOPs | (2, 3, 4) | 3.0 |
| 5.2 | Odoo RPC ingestor | MO, PO, inventory, finance (read-only); delivery-risk model | (1, 2, 4) | 2.2 |
| 5.3 | RouteLLM training pass | Export labelled call log from Langfuse; fine-tune RouteLLM binary classifier | (0.5, 1, 2) | 1.1 |
| 5.4 | Self-mutation quality review | Review all self-authored PRs to date; catalogue error patterns; seed golden evals from resolved mutations | (0.5, 1, 2) | 1.1 |
| 5.5 | Hardening pass | Cost optimisation, latency, retry/idempotency, security audit | (1, 2, 3) | 2.0 |
| 5.6 | v2.0 release review | Demo full lifecycle; retro; publish runbook | (0.5, 1, 2) | 1.1 |
| **Phase 5 total** | | | | **~10.5 ew** (~5.5 calendar weeks with 2 engineers) |

---

## Cross-Phase Continuous Work (not in critical path)

| WBS | Activity | Allocation |
|---|---|---|
| X.1 | VS Code + Git: authoring new agent/skill repos | Ongoing — engineers work in VS Code, commit to respective repos, open PRs |
| X.2 | PR review for self-mutation PRs | ~2 hrs/wk when agents are in active self-mutation |
| X.3 | Prompt engineering / agent instruction tuning | ~15% of each phase |
| X.4 | Documentation + instructions.md updates | ~10% of each phase |
| X.5 | Security review + secrets hygiene | Quarterly, 1 ew per review |
| X.6 | Cost monitoring + LiteLLM tier-policy tuning | Continuous, ~2 hrs/wk |

---

## Summary

| Phase | Capability | PERT ew | Calendar (2 eng) | Cumulative |
|---|---|---|---|---|
| 0 | Core Engine: dynamic clone + first agent | 17.6 ew | 9 cw | 9 cw |
| 1 | Self-Mutation Loop + GitHub PR automation | 7 ew | 3.5 cw | 12.5 cw |
| 2 | Agent & Skill repos: sales, triage, reconciler | 12.3 ew | 6 cw | 18.5 cw |
| 3 | Capture: WhatsApp + meetings + ambient + push | 11 ew | 5.5 cw | 24 cw |
| 4 | Write authority + Action Broker + Approval UX | 7.7 ew | 4 cw | 28 cw |
| 5 | Strategy + Odoo + RouteLLM + hardening + v2.0 | 10.5 ew | 5.5 cw | 33.5 cw |

**Total: ~66 engineer-weeks ≈ 33 calendar weeks ≈ ~8 months** with 2 engineers at ~80% utilization. Buffer of +20% recommended → **~10 months to v2.0**.

MVP (end of Phase 0) lands at ~2 months. **Self-Mutation live (M1)** at ~3 months. First domain-wide agent coverage (Phase 2) at ~4.5 months.

> **Note on authoring:** No WBS phase exists for "Skill Workbench" or "in-app editor" — agents and skills are authored in VS Code + Git. The Control Plane (Next.js workbench) covers chat, observability, and HITL approvals only. This is a deliberate reduction in scope vs v0.4 and removes ~6.5 ew of UI build effort while improving authoring quality (VS Code + GitHub Copilot > Monaco + iframe).

