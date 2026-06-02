# Project Plan — CommandCenter v2

> **Organisation:** Fracktal Works · **Date:** 2026-06-02 · **Version:** 2.0
> **For AI agents:** Read [`AGENTS.md`](AGENTS.md) first — it has current build status, file index, and glossary.
> This file covers: scope boundaries, milestones, resource allocation, constraints, and open questions.
> **Full detail lives in:** `wbs.md` (tasks + estimates) · `product_requirements.md` (what to build) · `system_architecture.md` (how it works)

---

## What We Are Building

A **headless, self-mutating agent orchestration platform** for running a company. Events (webhooks, cron, ambient) trigger specialist agents that are dynamically loaded from their own GitHub repos, executed inside ephemeral OpenHands sandboxes, and self-heal on failure by opening code-fix PRs. Operators interact via a thin Control Plane browser UI (chat Q&A, HITL approvals, observability). No in-app agent or skill editing — ever.

---

## Scope

### In Scope

- Core engine: FastAPI event router + Dynamic Agent Loader (persistent clone cache) + LangGraph orchestration + Postgres state
- Self-mutation loop: `Self_Mutation_Node` + OpenHands dev sandbox + GitHub PR automation + eval CI gate
- Distributed agent repos (`agent-task-manager`, `agent-sales`, `agent-triage`, `agent-reconciler`, `agent-delivery`, `agent-strategy`)
- Distributed skill repos (`skill-clickup-sync`, `skill-zoho-ingest`, `skill-gmail-capture`, `skill-whatsapp-send`, `skill-meeting-transcribe`, `skill-graph-write`, `skill-action-broker`)
- Ingest: ClickUp, Zoho CRM, Odoo ERP, Gmail, WhatsApp Business, meeting bots (Vexa)
- Pull (cited Q&A), push (notifications), and ambient (event-driven) interaction modes
- Approval-gated writes via Action Broker with per-action authority tiers
- Nightly reconciliation with escalation queue
- Integration Registry (encrypted credential store; no secrets in agent/skill repos)
- Control Plane (Next.js): chat, HITL queue, Langfuse observability embed

### Out of Scope

- In-app editing of agents, skills, or workflows — all authoring is VS Code + Git
- Browser IDE of any kind (Theia, VS Code fork, etc.)
- Visual drag-and-drop workflow canvas
- n8n or any second workflow runtime
- Autonomous agent repo merges without human PR review
- Autonomous writes to source systems before Action Broker + authority tiers are live
- Customer-facing access
- Full RBAC beyond admin / operator / contributor

### Success Criteria (v2.0)

- Webhook fires → agent runs in ephemeral container + telemetry logged in < 30 s (warm < 5 s)
- Skill failure → `Self_Mutation_Node` opens GitHub PR with plausible fix in < 5 min; `max_mutation_attempts = 1` enforced
- Executive asks "status of customer X / project Y" → cited answer in < 10 s
- Zero silent drift over 30 consecutive days
- ≥ 3 agent repos have merged self-authored improvement PRs in production by M6

---

## Milestones

| ID | Name | Target | Status |
|---|---|---|---|
| **M1** | Core Engine live — ClickUp Q&A with citations | 2026-05-25 | ✅ PASSED |
| **M2** | Self-Mutation live — agents fix own code, open PRs | ~2026-07-01 | 🔄 In progress |
| **M3** | Full Agent Ecosystem — Sales + Email + Reconciler | ~2026-08-26 | Not started |
| **M4** | Capture live — meetings + WhatsApp + ambient triggers | ~2026-10-14 | Not started |
| **M5** | Suggest+Apply live — approval-gated writes to ClickUp/Zoho | ~2026-12-09 | Not started |
| **M6** | v2.0 Release — Odoo + Strategy + Intelligence layer | ~2027-02-10 | Not started |

**Critical path:** persistent clone cache (done) → `Self_Mutation_Node` → GitHub PR automation → eval CI gate → M2 → agent-sales + Zoho ingest → entity resolution → Mem0/Graphiti → M3 → meeting bot + ambient triggers → M4 → Action Broker + Suggest+Apply → M5 → Odoo + strategy + goal model → M6.

**Estimated total from today: ~36 calendar weeks to M6 (2 engineers at ~80%). With 20% buffer → ~10 months.**

---

## Constraints (Hard)

| # | Constraint |
|---|---|
| C-01 | `max_mutation_attempts = 1` per failure event — no exceptions |
| C-02 | No credentials in agent or skill repos — Integration Registry only |
| C-03 | Action Broker is the only write path to source systems |
| C-04 | No autonomous writes until Action Broker + authority tiers are live (Phase 4) |
| C-05 | All agent/skill artefacts promoted via PR with eval CI gate |
| C-06 | DinD: Core container must map `/var/run/docker.sock` from host |
| C-07 | Indian DPDP Act 2023 — written employee consent before ingesting email/WhatsApp |

---

## Resource Plan

| Resource | Allocation | Phase focus |
|---|---|---|
| Engineer A | ~80% | Orchestration, self-mutation, Action Broker, Annealer |
| Engineer B | ~80% | Ingestion, entity graph, agent repos |
| Founder | ~2 h/week | Phase gate reviews, policy decisions |
| Ops lead | ~1 h/day (from Phase 2) | Reconciler escalation queue |
| Infrastructure | Hetzner ~€25/mo (2 VMs); Vexa ~€0.05–0.15/meeting; WA 1K conv/mo free | — |

---

## Top Risks

| ID | Risk | Score | Mitigation |
|---|---|---|---|
| R-04 | Unauthorised write to ClickUp/Zoho/Odoo | 12 | Action Broker; authority tiers; kill switch |
| R-01 | Entity resolution failures (duplicate nodes) | 9 | Deterministic rules first; LLM fallback; human review queue |
| R-02 | Agent hallucinations on company data | 9 | Citation enforcement; schema validation; second-pass verify |
| R-05 | WhatsApp Business API verification delay | 9 | Start early; OpenBSP/Whapi fallback |

---

## Quality Gates

- **Per-PR:** Promptfoo golden cases + Inspect AI scenario tests; merge blocked on regression; no `graph.py` or `SKILL.md` merges without a passing golden case
- **Per-phase exit:** Demo against milestone acceptance criteria; reconciler stable ≥ 7 days; cost within budget
- **Continuous:** Langfuse traces reviewed weekly; citation-coverage and per-tier cost tracked; per-skill success rate monitored
- **Quarterly:** Security review, secrets rotation, access audit, DPDP compliance check

---

## Open Questions

1. **Monthly LLM cost ceiling** — confirm budget envelope; drives tier thresholds
2. **Retention policy** — exact windows for raw transcripts, message bodies, derived facts; needs legal sign-off
3. **Autonomous promotion threshold** — what success rate per agent justifies suggest+apply → autonomous?
4. **WhatsApp community read posture** — confirm Meta TOS for agent reading group messages as a participant
5. **Meeting policy** — which meetings does the bot join? Default-in or default-out? Consent UI?
