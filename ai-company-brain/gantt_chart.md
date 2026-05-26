# Gantt Chart — AI Company Brain

> Start date: 2026-06-01 · Team: 2 engineers · MVP-first, iterative · Version: 0.4 (Workflow Editor pane + pervasive AI chat added to Phase 0.5)
> Calendar units = weeks. All durations are PERT estimates from `wbs.md`.

---

## Gate Status

- **M1 (Phase-0 exit) — PASSED 2026-05-25.** Real cross-system cited Q&A over live Fracktal data.
  - Data on disk: ClickUp 38 projects / 1 743 tasks · Zoho 729 Accounts / 1 181 Contacts / 25 Users / 541 Deals · 730 customers, 1 198 zoho-marked persons.
  - Reconciler v0 produced 200 stale_tasks + 200 quiet_deals as `audit_event(action='escalation')`.
  - Sample `/pull` (200 OK, gateway → pull_agent → retrieval+LLM+guardrails):
    - Q: *"Tell me about the Toyota Gosai Manesar deal — what stage is it in and who owns it?"* → cited `[deal:3e851eb1-936f-4441-a37f-af69f7d96a37]`, stage *Proposal / Quote Sent*. `pull_query` audit `7fc84ee3-3f8e-4005-a092-5a107fa572a9`, 27 hits.
    - Q: *"List Avian Aerospace deals with their stages and owners."* → 2 citations `[deal:151bbec5-…]` + `[deal:e1efb7e0-…]`. Audit `055c87f9-b283-4ae2-8c6c-3a1cc57745c2`, 43 hits.
  - Tests: 16/16 green (`uv run pytest -q`).

- **Phase-0 hardening (post-M1) — 2026-05-26.**
  - Streamlit escalation queue (`apps/escalation_ui`) on `:8501`, surfaced 404 open findings.
  - APScheduler nightly ingestion (`apps/ingestion/ingestion/scheduler.py`): cron 02:30/02:50/03:10 IST.
  - +2 hardening tests (identity merge across ClickUp↔Zoho, citation repair negative case). **Suite: 18/18.**

- **Phase 0.5.1 (Skills monorepo) — DONE 2026-05-26.**
  - `skills/<domain>/<id>/SKILL.md` layout with 2 hand-authored production skills (`sales/quiet_deal_followup`, `delivery/stale_task_nudge`) + promptfoo eval skeletons.
  - `skills/upstream/` placeholder + `.github/workflows/skills-upstream-sync.yml` (weekly cron mirror of `anthropics/skills` and `VoltAgent/awesome-agent-skills` via `peter-evans/create-pull-request@v6`).
  - `packages/acb_skills` loader (pydantic `Skill` + `SkillFrontmatter`, walks tree, excludes `upstream/` and `examples/` by default).
  - +4 loader tests. **Suite: 22/22.**

- **Phase 0.5.2 (OpenHands self-host) — SCAFFOLDED 2026-05-26.**
  - `deploy/openhands/docker-compose.yml` (image `openhands:0.55`, LLM wired to LiteLLM gateway, `skills/` mounted into `/opt/workspace_base`). `docker compose config` validates clean.
  - `deploy/openhands/README.md` with Hetzner + Caddy + `oauth2-proxy` (`@fracktal.in`) ops notes.

- **Phase 0.5.3 (Control Plane UI shell) — DONE 2026-05-26.**
  - Next.js 16 + React 19 + Tailwind v4 at `workbench/control_plane`, port `:3001` (avoids OpenHands `:3000`).
  - Three-pane shell (`/skills`, `/workflows`, `/observability`) with sidebar nav and dashboard home.
  - `npm run build` clean (4 static routes); dev server returns **HTTP 200** on `/`.
  - SSO (NextAuth Google `@fracktal.in`) + CopilotKit chat deferred to 0.5.6.

---

## Mermaid Gantt

```mermaid
gantt
    title AI Company Brain — Phased Delivery
    dateFormat  YYYY-MM-DD
    axisFormat  %b %d

    section Phase 0 - Foundation
    Infra baseline                    :p0a, 2026-06-01, 9d
    Graph schema v0                   :p0b, after p0a, 6d
    ClickUp ingestor                  :p0c, after p0b, 11d
    Reconciler v0                     :p0d, after p0c, 10d
    LangGraph + Deep Agents skeleton  :p0e, 2026-06-15, 11d
    Gateway + auth                    :p0f, after p0e, 6d
    Pull agent v0                     :p0g, after p0d, 10d
    Guardrails v0                     :p0h, after p0g, 6d
    Observability (Langfuse + OTel)   :p0i, after p0h, 5d
    Local inference (vLLM+Qwen3+LiteLLM caching) :p0j, after p0i, 6d
    Phase 0 review (M1: MVP-internal) :milestone, m1, after p0j, 0d

    section Phase 0.5 - Skill Workbench MVP
    Skills monorepo + Anthropic upstream sync :p05a, after m1, 6d
    OpenHands self-host (skills repo workspace) :p05b, after p05a, 6d
    Control Plane UI shell (Next.js + CopilotKit + AG-UI) :p05c, after m1, 10d
    Skill Studio pane (Monaco + OpenHands embed) :p05d, after p05c, 6d
    Workflow Editor pane (n8n iframe + auth passthrough) :p05e, after p05c, 3d
    Pervasive AI chat (useCopilotReadable context wiring) :p05f, after p05d, 5d
    Phase 0.5 review (M1.5: Workbench + Workflow Editor + AI chat live) :milestone, m15, after p05f, 0d

    section Phase 1 - CRM + Email
    Zoho ingestor (MCP + webhooks)    :p1a, after m15, 10d
    Entity resolution                 :p1b, after p1a, 11d
    Gmail capture                     :p1c, after m1, 10d
    Email triage                      :p1d, after p1c, 10d
    Sales pull agent                  :p1e, after p1b, 10d
    Reconciler v1                     :p1f, after p1e, 6d
    RBAC scaffold                     :p1g, after p1f, 6d
    Semantic cache + LLMLingua-2      :p1h, after p1g, 6d
    Phase 1 review (M2: First exec value) :milestone, m2, after p1h, 0d
    section Phase 1.9 - Skill Eval Harness
    Promptfoo harness in CI           :p19a, after p1g, 3d
    Inspect AI scenario harness       :p19b, after p19a, 3d
    Seed golden cases (top-10 skills) :p19c, after p19b, 3d
    section Phase 2 - Meetings + Ambient
    Meeting bot (Vexa Day 1 + WhisperX) :p2a, after m2, 10d
    Transcript pipeline               :p2b, after p2a, 6d
    Action-item extraction            :p2c, after p2b, 10d
    Push channel (WhatsApp send)      :p2d, after m2, 10d
    Ambient trigger engine            :p2e, after p2d, 11d
    Delivery agent                    :p2f, after p2e, 10d
    HR/Utilization agent v0           :p2g, after p2c, 10d
    Mem0 + Graphiti memory layer      :p2h, after p2g, 9d
    Phase 2 review (M3: Proactive)    :milestone, m3, after p2h, 0d

    section Phase 2.9 - Self-hosted E2B Sandbox
    E2B Firecracker + Workbench/CI wiring :p29a, after p2c, 5d

    section Phase 3 - Writes + WhatsApp Ingest
    Action Broker                     :p3a, after m3, 16d
    Suggest+Apply ClickUp tasks       :p3b, after p3a, 10d
    Suggest+Apply Zoho follow-ups     :p3c, after p3a, 10d
    Authority-tier config             :p3d, after p3b, 10d
    WhatsApp Business API setup       :p3e, after m3, 6d
    WhatsApp community ingest         :p3f, after p3e, 11d
    WhatsApp triage agent             :p3g, after p3f, 10d
    Phase 3 review (M4: Suggest+Apply) :milestone, m4, after p3d, 0d

    section Phase 3.5 - RouteLLM Training
    Export labelled call log          :p35a, after m4, 3d
    RouteLLM classifier training      :p35b, after p35a, 3d

    section Phase 4 - Annealing Loop (Deep Agents + Workbench)
    Skill registry config             :p4a, after m4, 3d
    Annealer sub-agent                :p4b, after p4a, 6d
    Annealer → Workbench PR drafting  :p4c, after p4b, 6d
    Promotion pipeline (shadow/canary/full) :p4d, after p4c, 6d
    HITL review UI (in Skill Studio)  :p4e, after p4d, 3d
    Gated rollout + success tracking  :p4f, after p4e, 6d
    Directive auto-update             :p4g, after p4f, 6d
    Phase 4 review (M5: Self-improving) :milestone, m5, after p4g, 0d

    section Phase 5 - Odoo + Strategy + v1.0
    Odoo ingestor                     :p5a, after m5, 11d
    Delivery-risk model               :p5b, after p5a, 10d
    Strategy agent                    :p5c, after p5b, 15d
    Goal model + roll-up              :p5d, after p5c, 10d
    LightRAG (internal doc retrieval) :p5e, after m5, 6d
    Hardening pass                    :p5f, after p5d, 10d
    v1.0 Release                      :milestone, m6, after p5f, 0d
```

## Milestones

| ID | Name | Target | Gating criteria |
|---|---|---|---|
| **M1** | MVP — Internal ClickUp Q&A | ~2026-08-05 | Exec can ask ClickUp questions; reconciler proves no drift over 7 days |
| **M1.5** | Skill Workbench live | ~2026-09-01 | Maintainer can author/edit/PR a skill end-to-end in browser; Workflow Editor pane shows active workflows; AI chat overlay works contextually in every pane; one upstream-adopted + one hand-authored skill in production |
| **M2** | First exec value (Sales + Email visible) | ~2026-10-14 | Customer 360 query works; emails classified into graph |
| **M3** | Proactive (push + ambient) | ~2026-12-02 | Stale-task pings reach owners; meetings auto-summarised |
| **M4** | Suggest+Apply live (writes to ClickUp + Zoho) | ~2027-01-26 | Approval queue used daily; zero unintended writes in 14 days |
| **M5** | Annealing loop active (Annealer drafts PRs into Workbench) | ~2027-03-02 | First annealed skill in production via Workbench PR; success metric tracked |
| **M6** | v1.0 Release (Strategy + Odoo + LightRAG) | ~2027-04-26 | Full scope; ops runbook complete; cost ≤ target |

## Critical Path

```
Infra → Graph schema → ClickUp ingestor → Reconciler v0 → Pull agent v0 → Guardrails → M1
    → Skill Workbench (skills repo → OpenHands → Control Plane UI → Skill Studio → pervasive chat) → M1.5
    → Zoho ingestor → Entity resolution → Sales pull → Reconciler v1 → RBAC → M2
    → Meeting bot → Transcripts → Action extraction → HR agent → M3
    → Action Broker → Suggest+Apply → Authority config → M4
    → Skill registry → Annealer → Annealer→Workbench PR → Promotion pipeline → M5
    → Odoo ingestor → Delivery-risk → Strategy → Goal roll-up → Hardening → M6
```

Estimated critical path = **~48 weeks** (≈ 12 months). With recommended 20% buffer → **~13 months end-to-end** to v1.0. The Workbench (Phase 0.5) and its downstream eval/sandbox supporting work (Phase 1.9, 2.9) add ~3 weeks to the critical path but become essential infrastructure for every subsequent phase.

## Dependencies

| Dependency | Type | Notes |
|---|---|---|
| Reconciler ← ClickUp ingestor | FS | Need ingest before you can diff |
| Pull agent ← Graph schema + ClickUp ingestor | FS | |
| Sales agent ← Zoho ingestor + entity resolution | FS | Resolution unblocks customer 360 |
| Meeting bot ← Vexa account + VM | External | 1–2 day setup; Chromium-heavy — dedicated 4 vCPU VM from Day 1 |
| WhatsApp ingest ← Meta Business verification | External | **2–6 weeks** — start in parallel with Phase 2 |
| Action Broker ← Guardrails v1 | FS | No writes before guardrails proven |
| Annealer ← 90 days of audit log | SS | Cannot mine patterns from empty log; therefore Phase 4 cannot start before Phase 3 has been live ~90 days |
| Strategy agent ← Odoo ingestor + Goal model | FS | Needs full company data |
| Phase 1+ skill authoring ← Skill Workbench (M1.5) | FS | All skills from M1.5 onwards are authored in the Workbench |
| Skill PR merge ← Promptfoo + Inspect AI evals (Phase 1.9) | FS | Eval gate active from M2 onwards |
| Workbench "Try it" ← self-hosted E2B (Phase 2.9) | FS | Stub runner until E2B is live |
| Annealer→Workbench PR (Phase 4) ← Workbench (M1.5) | FS | Annealer reuses the same PR review surface as humans |
| Vexa migration ← Recall.ai-based meeting flow working | FS | De-risks transcript pipeline first |

## Resource Allocation

| Phase | Engineer A focus | Engineer B focus |
|---|---|---|
| 0 | Infra, gateway, observability | Ingestor, graph, agent |
| 1 | Zoho + entity resolution | Email + sales agent |
| 2 | Meeting bot + transcripts | Ambient triggers + delivery agent |
| 3 | Action Broker (heavy) | WhatsApp track |
| 4 | Annealer agent | Skill registry + UI |
| 5 | Odoo + Vexa | Strategy + goals |

Both engineers contribute to every phase review and hardening tasks.

## Phase Gates (Lightweight)

Adapted from systems-engineering phase gates for a software-only project:

- **M1 (≈ SRR equivalent)** — Architecture validated against real data; risks updated.
- **M2 (≈ PDR equivalent)** — Multi-source graph operational; entity resolution accuracy ≥ 95%.
- **M3 (≈ first beta)** — Real users (executives) using daily.
- **M4 (≈ CDR equivalent)** — Writes proven safe; rollback paths verified.
- **M5 (≈ TRR equivalent)** — System demonstrably improves itself.
- **M6 (≈ release)** — Ops runbook complete; on-call rota; SLOs defined and met.

## What to expect to slip

Based on the risk register (see `risk_register.md`):

1. **Entity resolution** (Phase 1) — historically 1.5–2× initial estimates.
2. **Action Broker** (Phase 3) — UX iteration is unbounded; budget +1 week.
3. **WhatsApp Meta verification** — external dependency; can block Phase 3 finale.
4. **Annealer agent** (Phase 4) — novel work; budget +2 weeks.

Buffer is sized to absorb these.
