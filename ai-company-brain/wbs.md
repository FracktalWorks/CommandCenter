# Work Breakdown Structure — AI Company Brain

> Project: AI Company Brain · Org: Fracktal Works · Date: 2026-05-25 · Version: 0.4
> Team: 2 engineers + AI assistance · Iterative, MVP-first, no hard deadline

This WBS is phase-decomposed by *capability slice*, not by traditional V-model phases, because the project is software-only and iterative. Each phase delivers a deployed, working slice.

Effort uses **engineer-weeks (ew)** with PERT triple-point estimates: (O, M, P) and PERT = (O + 4M + P) / 6. "Engineer-week" = one engineer for 5 working days.

---

## Phase 0 — Foundation (Capability: read-only ClickUp mirror + ask questions)

| WBS | Work Package | Activities | (O, M, P) ew | PERT ew |
|---|---|---|---|---|
| 0.1 | Infrastructure baseline | Provision VM, Docker Compose, Postgres+pgvector+AGE, secrets vault, CI | (1, 1.5, 3) | 1.7 |
| 0.2 | Graph schema v0 | DDL for PERSON, TASK, PROJECT, CUSTOMER, DEAL, MESSAGE, MEETING, ACTIONITEM, GOAL | (0.5, 1, 2) | 1.1 |
| 0.3 | ClickUp ingestor | Webhook receiver + REST poller + entity normaliser + canonical-key resolver | (1, 2, 4) | 2.2 |
| 0.4 | Reconciler v0 | Nightly full-pull diff + escalation queue UI (simple Streamlit) | (1, 2, 3) | 2.0 |
| 0.5 | LangGraph + Deep Agents harness skeleton | State machine harness, Deep Agents sub-agent wiring, tiered LLM router, audit log writer | (1, 2, 4) | 2.2 |
| 0.6 | Gateway + auth | FastAPI + Google SSO restricted to fracktal.in domain | (0.5, 1, 2) | 1.1 |
| 0.7 | Pull agent v0 (“ClickUp Q&A”) | Single Deep Agents sub-agent, answers “status of project / person / task” with citations | (1, 2, 3) | 2.0 |
| 0.8 | Guardrails v0 | Schema-validated outputs, citation enforcement, unresolved-entity abort | (0.5, 1, 2) | 1.1 |
| 0.9 | Observability (Langfuse + OTel) | Self-hosted Langfuse (docker-compose, Postgres+ClickHouse); openllmetry OTel SDK; cost meter per tier | (0.5, 1, 1.5) | 1.0 |
| 0.10 | Local inference stack | vLLM serving Qwen3-8B-Instruct (Automatic Prefix Caching); LiteLLM gateway; Anthropic/OpenAI prompt caching config | (0.5, 1, 2) | 1.1 |
| 0.11 | Phase 0 review (mini-PDR) | Demo, retro, write Phase-1 backlog | (0.25, 0.5, 1) | 0.5 |
| **Phase 0 total** | | | | **~16 ew** (~8 calendar weeks with 2 engineers) |

**Phase 0 exit criteria:**
- Executive can ask "where are we on Project X?" and get a cited answer.
- Reconciler flags drift between graph and ClickUp; zero silent divergence over 7 days.
- All LLM calls routed through the tier router; cost dashboard live.

## Phase 0.5 — Skill Workbench MVP (Capability: editable agent + online UI for skill authoring)

Runs immediately after Phase 0 so that all skills from Phase 1 onward are authored in the Workbench. Establishes the editability and version-control story end-to-end.

| WBS | Work Package | Activities | (O, M, P) ew | PERT ew |
|---|---|---|---|---|
| 0.5.1 | Skills monorepo + Anthropic upstream sync | Create `ai-company-brain-skills` repo with `skills/<domain>/<skill_id>/SKILL.md` layout; weekly GitHub Action that pulls `anthropics/skills` and `VoltAgent/awesome-agent-skills` into `upstream/` for adoption review | (0.5, 1, 2) | 1.1 |
| 0.5.2 | OpenHands self-host scoped to skills repo | Deploy OpenHands on a dedicated Hetzner VM; mount the skills repo as workspace; LiteLLM-backed LLM access; GitHub PR API integration | (0.5, 1, 2) | 1.1 |
| 0.5.3 | Control Plane UI shell (Next.js + CopilotKit + AG-UI) | Next.js app with three-pane layout; CopilotKit + AG-UI Protocol for Chat pane wired to LangGraph; LangGraph Agent Inbox for HITL queue; Google SSO restricted to fracktal.in | (1, 1.5, 3) | 1.7 |
| 0.5.4 | Skill Studio pane | Skill catalogue (table + search + tags); Monaco editor for `SKILL.md`; embedded OpenHands iframe; "Try it" runner (stub → wired to E2B in Phase 2.9); Langfuse traces embed; Git diff + open-PR flow | (0.5, 1, 2) | 1.1 |
| 0.5.6 | Workflow Editor pane (n8n embed) | Iframe the self-hosted n8n instance as Pane 4; session-cookie auth passthrough; verify active/inactive toggle, execution log, and workflow canvas work in iframe context; n8n Git sync config so saves commit workflow JSON to `ai-company-brain` repo | (0.1, 0.3, 0.5) | 0.3 |
| 0.5.7 | Pervasive AI chat (CopilotKit `useCopilotReadable`) | Wire `useCopilotReadable` context hooks in each pane: Skill Studio exposes `{current_skill_yaml, last_eval_result, pr_diff}`; Observability exposes `{current_trace_json}`; Workflow Editor exposes `{current_workflow_json, last_execution_log}`; floating chat overlay button in every pane header; single CopilotKit provider wraps the app for shared session history | (0.5, 1, 2) | 1.1 |
| 0.5.5 | Phase 0.5 review (M1.5: Workbench live) | Demo: hand-author one new skill end-to-end in the UI; chat with the agent about it from within the Skill Studio pane; toggle a workflow on/off from Pane 4 | (0.1, 0.25, 0.5) | 0.25 |
| **Phase 0.5 total** | | | | **~6.5 ew** (~3.25 cw) |

**Phase 0.5 exit criteria (M1.5):**
- A maintainer can open the Workbench in a browser, browse the skill catalogue, edit a `SKILL.md`, see Git diff, and open a PR — without touching the local filesystem.
- One skill adopted from `anthropics/skills` upstream and one hand-authored skill are both in production.
- Agent Inbox shows a live HITL queue.
- The Workflow Editor pane (n8n) is accessible; at least one workflow can be toggled active/inactive and the execution log is visible.
- The AI chat overlay is present in every pane; asking "explain this" from within the Skill Studio and from within a Langfuse trace both return contextually relevant responses.

## Phase 1 — Capture Expansion (Zoho + Email)

| WBS | Work Package | (O, M, P) ew | PERT ew |
|---|---|---|---|
| 1.1 | Zoho CRM ingestor (webhooks + REST + MCP server) | (1, 2, 3) | 2.0 |
| 1.2 | Customer/Person entity resolution (deterministic + LLM fallback) | (1, 2, 4) | 2.2 |
| 1.3 | Gmail capture: domain-wide delegation + Pub/Sub | (1, 2, 3) | 2.0 |
| 1.4 | Email triage (Tier-1 classifier → graph link) | (1, 2, 3) | 2.0 |
| 1.5 | Sales Pull agent (deal status, pipeline, customer 360) | (1, 2, 3) | 2.0 |
| 1.6 | Reconciler v1 (multi-source diff) | (0.5, 1, 2) | 1.1 |
| 1.7 | RBAC scaffold (exec / employee roles) | (0.5, 1, 2) | 1.1 |
| 1.8 | Semantic cache + token compression | GPTCache in front of LiteLLM (1h TTL triage decisions); LLMLingua-2 on tool outputs >1k tokens | (0.5, 1, 2) | 1.1 |
| 1.9 | Phase 1 review | (0.25, 0.5, 1) | 0.5 |
| **Phase 1 total** | | | **~14 ew** (~7 cw) |

## Phase 1.9 — Skill Eval Harness (CI Gate)

Runs in parallel with the tail of Phase 1 so that all Phase-2 skills ship with regression evals from day one.

| WBS | Work Package | (O, M, P) ew | PERT ew |
|---|---|---|---|
| 1.9.1 | Promptfoo harness in CI; `evals/promptfoo.yaml` schema per skill | (0.25, 0.5, 1) | 0.5 |
| 1.9.2 | Inspect AI scenario harness; graded scoring; PR comment integration | (0.25, 0.5, 1) | 0.5 |
| 1.9.3 | Seed golden cases for the 10 most-used Phase-0/1 skills | (0.25, 0.5, 1) | 0.5 |
| **Phase 1.9 total** | | | **~1.5 ew** (~0.75 cw) |

## Phase 2 — Meetings + Ambient Triggers + Push

| WBS | Work Package | (O, M, P) ew | PERT ew |
|---|---|---|---|
| 2.1 | Meeting bot integration (Vexa Day 1) + calendar auto-accept | Vexa self-hosted on dedicated VM; WhisperX transcription + Pyannote diarization | (1, 2, 3) | 2.0 |
| 2.2 | Transcript pipeline (WhisperX → graph) | (0.5, 1, 2) | 1.1 |
| 2.3 | Action-item extraction (Tier-2) with assignee resolution | (1, 2, 3) | 2.0 |
| 2.4 | Push channel (WhatsApp send via Meta Cloud API, fallback to email) | (1, 2, 3) | 2.0 |
| 2.5 | Ambient trigger engine (event bus → rule eval → agent dispatch) | (1, 2, 4) | 2.2 |
| 2.6 | Delivery agent (stale-task detection, ping, escalate) | (1, 2, 3) | 2.0 |
| 2.7 | HR/Utilization agent v0 (kanban-stage-staleness dashboard) | (1, 2, 3) | 2.0 |
| 2.8 | Mem0 + Graphiti memory integration | Mem0 episodic memory per user/account; Graphiti bi-temporal entity KG; both on existing Postgres; Deep Agents tools wired | (1, 1.5, 3) | 1.7 |
| 2.9 | Phase 2 review | (0.25, 0.5, 1) | 0.5 |
| **Phase 2 total** | | | **~15.5 ew** (~7.75 cw) |

## Phase 2.9 — Self-Hosted E2B Sandbox

| WBS | Work Package | (O, M, P) ew | PERT ew |
|---|---|---|---|
| 2.9.1 | Provision Hetzner CX31; install E2B + Firecracker; wire SDK to Workbench "Try it" and CI eval runner | (0.5, 1, 1.5) | 1.0 |
| **Phase 2.9 total** | | | **~1 ew** (~0.5 cw) |

## Phase 3 — Write Authority + Approval UX + WhatsApp Ingest

| WBS | Work Package | (O, M, P) ew | PERT ew |
|---|---|---|---|
| 3.1 | Action Broker (queue, approval UI, audit, rollback) | (2, 3, 5) | 3.2 |
| 3.2 | Suggest+Apply for ClickUp task creation from meetings | (1, 2, 3) | 2.0 |
| 3.3 | Suggest+Apply for Zoho follow-up drafts | (1, 2, 3) | 2.0 |
| 3.4 | Authority-tier configuration system (per agent × per action) | (1, 2, 3) | 2.0 |
| 3.5 | WhatsApp Business API provisioning + agent number | (0.5, 1, 2) | 1.1 |
| 3.6 | WhatsApp community ingestion (n8n webhook) | (1, 2, 4) | 2.2 |
| 3.7 | WhatsApp triage agent (classify, link to deals/projects, push to graph) | (1, 2, 3) | 2.0 |
| 3.8 | Phase 3 review | (0.25, 0.5, 1) | 0.5 |
| **Phase 3 total** | | | **~15 ew** (~7.5 cw) |

## Phase 3.5 — RouteLLM Training Pass (~0.5 calendar weeks, runs in background during Phase 4 ramp-up)

| WBS | Work Package | (O, M, P) ew | PERT ew |
|---|---|---|---|
| 3.5.1 | Export labelled call log from Langfuse (cheap vs expensive tier ground truth) | (0.25, 0.5, 1) | 0.5 |
| 3.5.2 | Fine-tune RouteLLM binary classifier on logged traffic | (0.25, 0.5, 1) | 0.5 |
| **Phase 3.5 total** | | | **~1 ew** (~0.5 cw) |

## Phase 4 — Annealing Loop + Skill Registry

| WBS | Work Package | (O, M, P) ew | PERT ew |
|---|---|---|---|
| 4.1 | Skill registry schema + storage (Deep Agents Skills API config) | (0.25, 0.5, 1) | 0.6 |
| 4.2 | Annealer sub-agent (mine audit log for repeated interventions; Deep Agents sub-agent) | (0.5, 1, 2) | 1.1 |
| 4.3 | Skill drafting + maintainer HITL review (Deep Agents HITL built-in; reuses Workbench Skill Studio) | (0.25, 0.5, 1) | 0.6 |
| 4.4 | **Annealer → Workbench PR drafting** (Annealer commits skill drafts to a branch and opens a PR in `ai-company-brain-skills`; the PR auto-appears in the Workbench Agent Inbox for human review) | (0.5, 1, 2) | 1.1 |
| 4.5 | **Promotion pipeline (shadow → canary → full)** (LiteLLM routing config drives 10% shadow runs, then 50% canary, then full rollout; success-rate tracker pulls from Langfuse) | (0.5, 1, 2) | 1.1 |
| 4.6 | Gated rollout machinery (10/50/100% with success metric tracker; UI in Skill Studio) | (0.5, 1, 2) | 1.1 |
| 4.7 | Directive auto-update workflow (PR-based; same Workbench surface) | (0.5, 1, 2) | 1.1 |
| 4.8 | Phase 4 review | (0.25, 0.5, 1) | 0.5 |
| **Phase 4 total** | | | **~7 ew** (~3.5 cw) — +2 ew vs v0.2 for workbench drafting + promotion pipeline; still well below the original 10 ew because Deep Agents harness and Workbench are pre-built |

## Phase 5 — Odoo Integration + Strategy Agent

| WBS | Work Package | (O, M, P) ew | PERT ew |
|---|---|---|---|
| 5.1 | Odoo RPC ingestor (MO, PO, inventory, finance) | (1, 2, 4) | 2.2 |
| 5.2 | Delivery-risk model (MO lateness × deal commitment) | (1, 2, 3) | 2.0 |
| 5.3 | Strategy Pull agent (weekly digest, hiring/firing suggestions) | (2, 3, 4) | 3.0 |
| 5.4 | Goal model + roll-up (Project → Goal) | (1, 2, 3) | 2.0 |
| 5.5 | LightRAG integration (GraphRAG over internal docs, SOPs, product specs) | (0.5, 1, 2) | 1.1 |
| 5.6 | Hardening pass: cost optimisation, latency, retry/idempotency | (1, 2, 3) | 2.0 |
| 5.7 | Phase 5 review + 1.0 release | (0.5, 1, 2) | 1.1 |
| **Phase 5 total** | | | **~13.4 ew** (~7 cw) |

---

## Cross-Phase Continuous Work (not in critical path)

| WBS | Activity | Allocation |
|---|---|---|
| X.1 | Prompt engineering / agent tuning | ~15% of each phase |
| X.2 | Documentation + directive updates | ~10% of each phase |
| X.3 | Security review + secrets hygiene | Quarterly, 1 ew per review |
| X.4 | Cost monitoring + tier-policy tuning | Continuous, ~2 hrs/wk |

## Summary

| Phase | PERT effort | Calendar (2 eng) | Cumulative |
|---|---|---|---|
| 0 | 16 ew | 8 cw | 8 cw |
| 0.5 | 6.5 ew | 3.25 cw | 11.25 cw |
| 1 | 14 ew | 7 cw | 18.25 cw |
| 1.9 | 1.5 ew | 0.75 cw | 19 cw |
| 2 | 15.5 ew | 7.75 cw | 26.75 cw |
| 2.9 | 1 ew | 0.5 cw | 27.25 cw |
| 3 | 15 ew | 7.5 cw | 34.75 cw |
| 3.5 | 1 ew | 0.5 cw | 35.25 cw |
| 4 | 7 ew | 3.5 cw | 38.75 cw |
| 5 | 14 ew | 7 cw | 45.75 cw |

**Total: ~92.5 engineer-weeks ≈ 46 calendar weeks ≈ 11 months** with 2 engineers at ~80% utilization on this project. Buffer of +20% recommended → **~13 months to v1.0**.

MVP (end of Phase 0) lands at ~2 months. **Skill Workbench live (M1.5)** at ~3.25 months. First proactive value (Phase 2) at ~6.5 months.
