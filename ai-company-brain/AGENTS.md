# AGENTS.md — Planning Folder Navigation Guide

> **For AI agents:** Read this file first. It tells you what this project is, what has been built, and which file to read for each concern.
> **Organisation:** Fracktal Works · **Project:** CommandCenter · **Last updated:** 2026-06-02

---

## What CommandCenter Is

CommandCenter is a **headless, self-mutating agent orchestration platform** for running a company.

When a company event fires (webhook from ClickUp/Zoho/Odoo, cron schedule, or ambient signal), it:
1. Resolves the target specialist agent via a persistent local clone of that agent's GitHub repo.
2. Runs `git pull --ff-only` (< 0.5 s) to pick up any merged changes.
3. Injects credentials from the Integration Registry into LangGraph state.
4. Executes the agent task inside an ephemeral OpenHands sandbox.
5. On failure: applies a tested code fix to the live clone immediately, opens a GitHub PR as audit record.

Operators interact via a thin **Control Plane** (Next.js browser UI) with chat Q&A, HITL approvals, and observability. There is no in-app agent/skill editor — all authoring happens in VS Code + Git.

---

## What Has Already Been Built (as of 2026-06-02)

| Component | Status | Location |
|---|---|---|
| Core FastAPI gateway | ✅ Done | `level4/apps/gateway/` |
| Ingestion workers (ClickUp, Zoho) | ✅ Done | `level4/apps/ingestion/` |
| Entity graph (Postgres + pgvector) | ✅ Done | `infra/postgres/01_schema.sql` |
| Reconciler agent | ✅ Done | `level4/apps/reconciler/` |
| Orchestrator (LangGraph + PostgresSaver) | ✅ Done | `apps/orchestrator/` |
| Persistent clone cache + bot git identity | ✅ Done | `packages/acb_skills/acb_skills/loader.py` |
| Self-mutation node (mutation.py, executor.py) | ✅ Done | `apps/orchestrator/orchestrator/mutation.py` |
| Control Plane shell (Next.js, chat, SSO) | ✅ Done | `workbench/control_plane/` |
| LiteLLM gateway + tiered routing | ✅ Done | `infra/litellm/config.yaml` |
| Langfuse observability | ✅ Done | `infra/docker-compose.yml` |
| Skills monorepo + loader | ✅ Done | `skills/`, `packages/acb_skills/` |
| OpenHands self-host deploy | ✅ Done | `deploy/openhands/` |
| Self-mutation GitHub PR automation | 🔲 Next | Phase 1 (WBS 1.3) |
| Eval CI gate on agent/skill PRs | 🔲 Next | Phase 1 (WBS 1.4) |
| `agent-sales` + `skill-zoho-ingest` | 🔲 Phase 2 | Phase 2 (WBS 2.2) |
| `agent-triage` + `skill-gmail-capture` | 🔲 Phase 2 | Phase 2 (WBS 2.3) |
| Meeting bot (Vexa + WhisperX) | 🔲 Phase 3 | Phase 3 (WBS 3.1) |
| WhatsApp ingest + push | 🔲 Phase 3 | Phase 3 (WBS 3.3) |
| Action Broker (approval-gated writes) | 🔲 Phase 4 | Phase 4 (WBS 4.1) |
| Odoo ingestor + strategy agent | 🔲 Phase 5 | Phase 5 (WBS 5.1/5.2) |

**M1 milestone (Core Engine live) — PASSED 2026-05-25.**
Real cross-system cited Q&A over live Fracktal data confirmed. 22/22 tests green.

---

## File Index — What to Read for Each Concern

| Concern | File |
|---|---|
| **What the product must do (requirements)** | [`product_requirements.md`](product_requirements.md) |
| **How/when it will be built (phases, timeline)** | [`project_plan.md`](project_plan.md) |
| **Detailed engineering tasks with estimates** | [`wbs.md`](wbs.md) |
| **System design: containers, data model, ADRs** | [`system_architecture.md`](system_architecture.md) |

---

## Non-Negotiable Constraints (AI Agents Must Respect These)

| # | Constraint |
|---|---|
| 1 | **No in-app agent/skill editing.** The Control Plane is for chat, HITL, and observability only. All authoring is VS Code + Git. |
| 2 | **No credentials in agent or skill repos.** `config.json` declares integration names; Core Integration Registry holds the actual secrets. |
| 3 | **Self-mutation max_mutation_attempts = 1.** One PR per failure event, no exceptions. |
| 4 | **No autonomous writes** to ClickUp/Zoho/Odoo until Action Broker + authority tiers are live (Phase 4). |
| 5 | **Git is the single source of truth** for all agent artefacts. All changes flow through PRs with eval gates. |
| 6 | **No n8n or second workflow runtime.** Orchestration is LangGraph only. |
| 7 | **No Theia / browser IDE.** That scope was explicitly cut. |
| 8 | **Source systems are authoritative.** CommandCenter is a read-mostly mirror with approval-gated writes. |

---

## Key Terms Glossary

| Term | Meaning |
|---|---|
| **Core Engine** | The CommandCenter FastAPI server + LangGraph executor + Dynamic Agent Loader. Lives in `CommandCenter-Core`. |
| **Dynamic Agent Loader** | Python module that `git pull`s the target agent repo and `importlib`-imports `graph.py` at runtime. See `packages/acb_skills/acb_skills/loader.py`. |
| **Agent repo** | A GitHub repo named `agent-<name>` containing `config.json`, `graph.py`, `instructions.md`. No credentials, no skill implementations. |
| **Skill repo** | A GitHub repo named `skill-<name>`, a pip-installable Python package with one well-typed entry function. |
| **Integration Registry** | Core's encrypted Postgres store of all integration credentials. Admin-managed via Control Plane. |
| **IntegrationContext** | A typed dict injected into LangGraph `state["integrations"]` at run-start. Skills read credentials from here — never from env vars. |
| **Self_Mutation_Node** | LangGraph node that provisions an OpenHands dev sandbox, reads failure telemetry, applies a code fix to the live clone, and opens a GitHub PR. |
| **Hot-patch model** | Fix is applied to the live persistent clone immediately (recovery in minutes). The PR is the audit record + rollback trigger (close = auto rollback). |
| **Control Plane** | Next.js browser UI at `workbench/control_plane/`. Provides chat, HITL approval queue, Langfuse embed. Not an editor. |
| **Action Broker** | The only write path to source systems (ClickUp/Zoho/Odoo). Enforces per-action authority tiers. Lives at `apps/action_broker/`. |
| **Reconciler** | Nightly agent that diffs entity graph vs source systems and escalates drift. Lives at `apps/reconciler/` and `level4/apps/reconciler/`. |
| **HITL** | Human-in-the-loop. Approval requests delivered via Control Plane or email/WhatsApp when operator is not at the UI. |
| **authority tier** | read / suggest / suggest+apply / autonomous — the allowed scope of an agent's action on a specific resource type. |
| **Annealer** | Phase 5 sub-agent that mines successful run patterns, proposes new reusable skills as PRs, and manages shadow → canary → full rollout. |

---

## Current Phase: Phase 1 — Self-Mutation Loop

Phase 0 (Core Engine) is complete. The team is now in **Phase 1: Self-Mutation Loop**.

**Remaining Phase 1 work (from WBS):**
- WBS 1.1 `Self_Mutation_Node` LangGraph node: check `mutation_attempts < 1`, provision OpenHands dev sandbox, inject failure telemetry — `mutation.py` skeleton exists; full node wiring needed.
- WBS 1.2 OpenHands dev sandbox integration: DinD via `/var/run/docker.sock`; container lifecycle.
- WBS 1.3 GitHub PR automation: GitHub API create branch → commit fix → open PR with telemetry body; no self-merge permission.
- WBS 1.4 Eval CI gate: Promptfoo + Inspect AI on every `agent-*` / `skill-*` PR; merge blocked on regression.
- WBS 1.5 Mutation audit log: log to Postgres; surface in Control Plane HITL queue.

**Phase 1 exit milestone (M2 — Self-Mutation live):** A deliberate error in `skill-clickup-sync` causes `Self_Mutation_Node` to open a GitHub PR with a plausible fix within 5 minutes; `max_mutation_attempts = 1` enforced; human merges → CI passes → live.
