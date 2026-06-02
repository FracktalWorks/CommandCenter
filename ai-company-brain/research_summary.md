# Research Summary — AI Company Brain (now Jannet.AI **Level 4** reference)

> ⚠️ **Re-sequenced (2026-05-31).** This research underpins **Level 4 (Company Intelligence)**. Note two platform-level supersessions: the **IDE shell** is now a forked **Theia** (not the Next.js four-pane workbench), and **workflows** run on our **own agent-native engine + React Flow canvas** (n8n is dropped). See [`project_plan.md`](project_plan.md) PD-01…PD-06.

> Compiled: 2026-05-25 · Updated: 2026-05-25 (v0.3 — Skill Workbench / editability addition) · Project slug: `ai-company-brain`
> Scope: state-of-the-art for an internal, self-improving multi-agent "company OS" mirroring ClickUp/Zoho/Odoo, ingesting email/WhatsApp/meetings, serving ~20 employees.

---

## 1. Agent Orchestration Frameworks

The 2025–2026 landscape has converged on four serious contenders. None is a silver bullet; the right pick is determined by *who writes the workflow* and *how much state you need to keep*.

| Framework | Strength | Weakness | Fit for AI Company Brain |
|---|---|---|---|
| **LangGraph** (LangChain) | Explicit state machines, durable checkpoints, HITL primitives, best observability via Langfuse/OTel | Verbose; Python-first | **Strong.** Best for the *orchestration core*. |
| **Deep Agents v0.6.3** (langchain-ai/deepagents, MIT) | Batteries-included on LangGraph: sub-agents, HITL, Skills, context management, MCP support | Newer project (v0.6.x) | **Adopted.** Reduces Phase-4 Annealer build from 10 ew → 5 ew; specialist agents become Deep Agents sub-agents. |
| **CrewAI** | Role-based agents, low ceremony | Less state control | Superseded by Deep Agents + LangGraph for this use case. |
| **AutoGen v0.4** (Microsoft) | Conversational multi-agent | Production rough | Skip for v1. |
| **Pydantic AI / Mastra** | Type-safe, clean APIs | Smaller ecosystem | Credible but would lose Deep Agents HITL/Skills. Skip. |
| **OpenHands** | Sandboxed code execution | Designed for coding agents | Use as dev tool, not runtime. |

**Recommendation:** LangGraph + Deep Agents v0.6.3. Deep Agents provides the skills/HITL/sub-agent story that LangGraph alone lacks. Specialist agents become Deep Agents sub-agents with built-in context management and MCP tool support[^61].

## 2. Self-Improving / Annealing Architecture: Hermes Pattern

[Hermes Agent](https://github.com/nousresearch/hermes-agent) by Nous Research (released Feb 2026, MIT licensed, v0.8.0 by April 2026) is the most relevant reference for the "annealable" requirement[^3][^4]. Its key idea:

- **Skill creation loop**: when the agent succeeds at a novel task, it crystallises the procedure into a reusable *skill* (executable + description).
- **Persistent cross-session memory** as the substrate for skill discovery.
- **Learning-first, not framework-first**: the architecture is built around the improvement loop, not bolted on.

This maps directly onto your DOE Framework (Directive · Orchestration · Execution). Hermes' "skill" ≈ your `execution/` scripts, and its skill-creation prompt ≈ your "update the directive when you learn something" instruction. We will **borrow Hermes' skill schema and learning-loop pattern**, but keep the DOE Framework's separation of directives vs. execution scripts.

**Key references:**
- Nous Research GitHub: `nousresearch/hermes-agent`[^3]
- Documentation: `hermes-agent.nousresearch.com/docs`[^5]
- LinkedIn architectural overview[^4]

## 3. Memory: Knowledge Graph vs RAG vs Hybrid

The 2025–2026 consensus has shifted decisively: **pure RAG is insufficient for agent memory**[^6]. The leading patterns:

| Approach | When to use |
|---|---|
| **Vector RAG** | Unstructured doc Q&A (meeting transcripts, emails) |
| **Knowledge Graph** | Entities + relationships (People · Projects · Deals · Tasks) — required for "who is working on what" queries |
| **GraphRAG (hybrid)** | Production-grade. Graph for entity/relationship reasoning, vectors for fuzzy recall |

**Tooling shortlist (updated v0.2):**
- **Mem0** (`mem0.ai`, Apache-2.0) — episodic/per-user memory, 67% LOCOMO score, p95 search 200ms, ~55k GitHub stars[^71]. Adopted for Phase 2.
- **Graphiti** (`getzep/graphiti`, Apache-2.0) — bi-temporal entity relationship KG, 71.2% LOCOMO (highest of all frameworks)[^72]. Adopted for Phase 2 alongside Mem0.
- **LightRAG** (`HKUDS/LightRAG`, MIT) — top-ranked self-hosted GraphRAG for VPS-scale (tested on 47GB RAM, no GPU)[^76]. Adopted for Phase 5 internal-doc retrieval.
- **Postgres + pgvector + Apache AGE** — unchanged as the entity graph substrate; Mem0 and Graphiti sit on top of it, no new DB.

**Entity Resolution is the hidden hard problem.** Per the Graph Praxis analysis[^8], when the graph has six nodes for one customer, every downstream insight is wrong. Mitigation:
- Use ClickUp/Zoho/Odoo IDs as **canonical keys** (since they are the source of truth).
- Run nightly entity-resolution job using deterministic rules first (email, phone, domain), LLM fallback only for ambiguous cases.
- Log every merge for audit.

## 4. Meeting Capture

You want an agent that **joins meetings when invited** with its own calendar identity. Two paths:

**Path A — Self-host (adopted, Day 1):**
- **Vexa** ([github.com/Vexa-ai/vexa](https://github.com/Vexa-ai/vexa)) — Apache-2.0, self-hosted on dedicated 4 vCPU Hetzner VM; ~€0.05–0.15/meeting compute cost; supports Google Meet / Teams / Zoom; explicitly positions itself as the OSS Recall.ai replacement in 2026[^26][^27]. Adopted from Day 1.
- **WhisperX** (Whisper-large-v3 + Pyannote 3.1) — self-hosted STT + speaker diarization. Diarization accuracy 80–90%; best-in-class open-source.

**Path B — Managed SaaS (removed from plan):**
- **Recall.ai** — removed. Was original v1 choice (~$0.50/hr); replaced by Vexa from Day 1 to keep data in-house and eliminate per-hour cost.

**Architecture pattern:** Chromium-in-a-container (Playwright/Vexa) joins as a participant, captures audio, pipes to WhisperX + Pyannote. Dedicated VM isolates Chromium memory from the main orchestration VM.

## 5. WhatsApp Integration

Your setup — a WhatsApp Community spanning teams — needs the **WhatsApp Business Platform Cloud API** (Meta's official path)[^14][^15].

**Important constraints:**
- The Business API number is **separate** from any personal WhatsApp. You will provision a fresh number for the agent.
- The Cloud API works on **per-conversation** pricing in the WhatsApp Business pricing model; group/community messages are read-only via webhook for the bot in most cases.
- For *reading* community messages, the agent's number must be a participant of each group/community.
- **OpenBSP** ([Reddit thread](https://www.reddit.com/r/WhatsappBusinessAPI/comments/1snaxlu/opensource_whatsapp_business_platform/)) is a self-hostable WhatsApp Business Platform that connects directly to Meta's Cloud API — worth evaluating[^16].
- **Chatwoot** offers WhatsApp Embedded Signup for OAuth-style onboarding[^17].
- **n8n** has first-class WhatsApp Business Cloud and webhook nodes[^18].

**Recommendation:** Meta Cloud API + n8n webhook ingestion → publish to internal message bus → ingestion agent normalises into the graph. Use OpenBSP as a fallback if you outgrow direct Meta integration.

## 6. Email Capture (Internal Only)

Since scope is internal employees only, use Google Workspace or Microsoft 365 admin-level capture rather than per-user IMAP:
- **Google Workspace**: Gmail API with domain-wide delegation; subscribe to push notifications via Pub/Sub.
- **Microsoft 365**: Graph API subscriptions with delegated permissions.

This avoids any per-user OAuth dance and respects domain admin policy. Consent must still be communicated to employees in writing.

## 7. ClickUp / Zoho / Odoo Integration

Since these are the **source of truth**, the brain is a *read-mostly mirror with approval-gated writes*.

**ClickUp:**
- REST API + webhooks for real-time deltas[^19].
- Kanban-stage events are exposed (your utilization signal lives here).
- "Time since last status change" per task = your *task-staleness metric* — directly answers your utilization question without time tracking.

**Zoho CRM:**
- REST API v8 + webhooks; n8n has first-class Zoho node[^20].
- Deal stage, last activity timestamp, owner — your sales-velocity signal.

**Odoo ERP:**
- XML-RPC and JSON-RPC; n8n integration is community-maintained but functional[^21].
- Source of truth for purchase orders, manufacturing orders, inventory.

**Sync architecture (anti-drift):**
- Event-driven primary path (webhooks → message bus → graph update).
- Nightly reconciliation job: full pull, diff against graph, escalate any divergence to a human review queue. **This was your explicit requirement and is non-negotiable.**

## 8. Guardrails & Anti-Hallucination

The 2026 enterprise guardrails playbook[^22][^23][^24][^25]:

1. **Structured outputs** — every agent reply that mutates state must produce a typed JSON object validated against a schema. Reject malformed outputs at the framework boundary.
2. **Citation enforcement** — facts in responses must cite a graph node ID or a source URL/message ID. Unsourced claims are flagged.
3. **Database-driven guardrails** — entity references (`@vijay`, `@DragonProject`) must resolve to a real ID in the graph; unresolved references abort the action.
4. **CrewAI Hallucination Guardrail** pattern — second LLM pass that verifies the response is grounded in the retrieved context[^25].
5. **Action authority tiers** — read / suggest / suggest+apply / autonomous — configured per agent per action type. Default to "suggest+apply" per your requirement; promote to autonomous only after a measured success rate.
6. **Human review queue** for any low-confidence write (confidence threshold per agent).

## 9. Ambient Agent Pattern

Ambient agents act on real-time events without prompts[^26][^27][^28]. The reference pattern:

```
Event source → Trigger evaluator (cheap LLM/rules) → Decision agent (smart LLM)
   → Action selector (read/suggest/apply/autonomous) → Audit log
```

**Examples we will implement:**
- Deal goes quiet in Zoho for >14 days → suggest follow-up.
- ClickUp task hasn't moved stage in >N days (configurable per stage) → ping owner, escalate after second threshold.
- Customer email contains "complaint" / "refund" / sentiment-negative → flag and notify.
- Meeting transcript contains action item assigned to a person → draft ClickUp task, suggest+apply.

## 10. Cost Architecture: Tiered LLM Routing

Per your explicit requirement, classification vs reasoning must be split:

| Tier | Use | Model class | Approx cost/1M tok |
|---|---|---|---|
| 0 — Rules | Deterministic filters (sender domain, keyword, status change) | n/a | ~0 |
| 1 — Classifier | "Is this email about a sales deal?" | small model (GPT-4o-mini / Claude Haiku / Llama-3 8B locally) | $0.15–0.50 |
| 2 — Extractor | "Pull entities, action items, deadlines" | mid model (Claude Sonnet / GPT-4o) | $3–15 |
| 3 — Reasoner | "Synthesise weekly digest, recommend hires" | frontier (Opus / GPT-5-class) | $15–75 |

Every message passes Tier 0 → 1 first; only ~10–20% reach Tier 2; <5% reach Tier 3. This is the standard pattern in production agent stacks[^22].

## 11. Fracktal Works Context

Fracktal Works[^29][^30] is a Bengaluru-based 3D printer OEM (founded 2013), Twin Dragon IDEX 400 being a current flagship at ~₹7.4L, with engineering services and custom software arms. Implications for the brain:
- **Mixed business model** (product OEM + services + custom software) means the agents must distinguish *product deals* (long pipeline, post-sale support) from *services jobs* (short pipeline, fast cash) — model these as distinct deal types in the graph.
- **Manufacturing operations** (Odoo MO/PO data) provide a structured signal for delivery risk.
- **Small team (~20)** means utilization signal will be high-noise; rely on ClickUp stage-staleness rather than count-of-tasks alone.

---

## 12. Editability, Version Control & Skill Workbench (v0.3 addition)

The agent must be **fully editable** and its core artefacts **version-controlled on GitHub**, with an online UI for iterative skill development. Confirmed findings from the May 2026 ecosystem review:

### 12.1 Skill format — Anthropic `SKILL.md` has won the format war

Anthropic's Agent Skills (`SKILL.md` with YAML frontmatter + Markdown body + sibling `scripts/` folder) is the de-facto standard as of late 2025[^80][^81]. Adoption signals:
- `anthropics/skills` is the canonical reference repo[^81].
- `VoltAgent/awesome-agent-skills` curates **1000+ ready-to-adapt community skills** compatible with Claude Code, Codex, Gemini CLI, and Cursor[^82].
- **Deep Agents (our chosen harness) reads `SKILL.md` natively** with no adapter[^83] — confirms ADR-013.
- GitHub Copilot has begun adopting the same format for "Skill packs."

**Implication:** we adopt Anthropic `SKILL.md` verbatim and extend the frontmatter with governance fields (`authority`, `cost_tier`, `rollout_stage`, `success_rate_30d`, `provenance`). Weekly GitHub Action pulls upstream into an `upstream/` folder for adoption review.

### 12.2 Skill Workbench backend — OpenHands is the right reuse

The user wants an online IDE where they can edit a skill, run it in a sandbox, see traces, and promote it. Building this from scratch is multi-month work.

**OpenHands** ([openhands.dev](https://openhands.dev/), Apache-2.0)[^84] is the top-ranked OSS coding agent on SWE-bench. It already provides: sandboxed editor + terminal + filesystem + LLM-assisted code drafting + GitHub PR integration + remote browser access. Deploying it self-hosted, scoped to the skills repo, gives us the entire Skill Studio backend essentially for free.

Alternatives considered:
- **VS Code in browser (code-server)** — just an editor, no agent help, no sandbox.
- **Custom IDE** — multi-month effort with no payoff.
- **Daytona** — better for dev environments than for agent-driven skill editing.

**Decision:** OpenHands as the Skill Studio backend (ADR-014).

### 12.3 Control Plane UI — CopilotKit + AG-UI + Agent Inbox + n8n embed + pervasive chat

For the chat surface, HITL queue, workflow editor, and pervasive AI assistance:
- **CopilotKit** ([copilotkit.ai](https://www.copilotkit.ai/), MIT)[^85] is the most mature OSS for in-app agentic UI in 2026. They are the company behind the **AG-UI Protocol**[^86] (agent–user interaction, bi-directional) which is becoming a de-facto standard for connecting frontends to any agent backend.
- **LangChain Agent Inbox** ([agent-inbox-langgraph-example](https://github.com/langchain-ai/agent-inbox-langgraph-example))[^87] is the canonical pattern for HITL approval queues over LangGraph — perfect for surfacing Annealer-drafted skill PRs to humans.
- **n8n** (BSL, already self-hosted for ingestion) is embedded as Pane 4 (Workflow Editor) via iframe. n8n’s own UI provides the full drag-and-drop workflow canvas, active/inactive toggle, and execution log — no custom workflow UI needed.
- **CopilotKit `useCopilotReadable`** injects each pane’s current context into a floating chat overlay so the AI assistant is aware of the open skill YAML, Langfuse trace, or n8n workflow JSON depending on which pane is active.

**Decision:** Four-pane Next.js Control Plane: (1) Chat/Agent Inbox, (2) Skill Studio, (3) Observability, (4) Workflow Editor. Pervasive AI chat overlay in every pane via `useCopilotReadable`. Chat pane usable standalone (ADR-014, ADR-018, ADR-019).

### 12.4 Sandbox runtime — self-hosted E2B

Skills run arbitrary Python. We need a fast-spinup isolated sandbox for "Try it" runs in the Workbench and for CI eval runs — ideally the *same* runtime so behaviour is identical.

**E2B** ([e2b.dev](https://e2b.dev/), open-source Firecracker microVMs)[^88] is the production standard (~94% of Fortune 100 reported using it). It is self-hostable with a documented Firecracker setup. **Daytona**[^89] uses gVisor instead of Firecracker and is a fine second choice. Docker-in-Docker is rejected as insecure for this use case.

**Decision:** Self-host E2B on a dedicated Hetzner CX31 (~€10/mo). Same SDK called by the Workbench (interactive) and the CI eval runner (batched) (ADR-016).

### 12.5 Skill regression evals — Promptfoo + Inspect AI

The 2026 SOTA for agent-eval-as-CI-gate consolidates around:
- **Promptfoo**[^90] — fast golden-case input/output assertions; runs on every commit; PR-comment integration. Top recommendation for "easiest beginner-friendly choice when you mainly want to compare outputs, spot regressions, and share results."
- **Inspect AI** (UK AI Safety Institute, MIT)[^91] — richer multi-turn scenario tests with graded scoring; runs on PR open. Used by frontier labs for production agent eval.

Both run in the E2B sandbox so behaviour is consistent with production. Merge is gated on both suites passing for the changed skills (ADR-017).

### 12.6 Git as the source of truth

Two GitHub repos under the Fracktal org:
1. `ai-company-brain` — infra, scripts, sub-agent prompts, LiteLLM router config, n8n workflow JSON, Langfuse dataset definitions, Promptfoo eval cases.
2. `ai-company-brain-skills` — skill registry only, Anthropic `SKILL.md` format, monorepo of `skills/<domain>/<skill_id>/`.

**No live edits to running prompts.** Every change is a PR; CI runs evals; merge auto-deploys via webhook → Skill Registry pulls + stages at 10% shadow. Rollback = `git revert`. Annealer-drafted skills are PRs like any other; they appear in the Workbench Agent Inbox for human review (ADR-015).

### 12.7 Recommended summary stack for the Workbench

| Layer | Tool | License | Role |
|---|---|---|---|
| Skill format | Anthropic `SKILL.md` | Spec | The artefact |
| Skill registry | `ai-company-brain-skills` on GitHub | n/a | Versioned storage |
| Upstreams | `anthropics/skills`, `VoltAgent/awesome-agent-skills` | MIT | Weekly upstream sync |
| Studio backend | **OpenHands** (self-hosted) | Apache-2.0 | Sandboxed IDE + LLM-assisted drafting (Pane 2) |
| Chat / HITL | **CopilotKit + AG-UI** + LangChain Agent Inbox | MIT | Chat pane (Pane 1) + approval queue; usable standalone |
| **Workflow Editor** | **n8n embed (iframe of self-hosted instance)** | BSL | **Pane 4: visual workflow canvas, active/inactive toggle, execution log. n8n already in stack — zero new infra** |
| **Pervasive AI chat** | **CopilotKit `useCopilotReadable`** | MIT | **Floating AI chat overlay in every pane; automatically seeded with pane context (open skill YAML / trace / workflow JSON)** |
| Sandbox | **E2B** (self-hosted, Firecracker) | Apache-2.0 | "Try it" + CI eval execution |
| Evals | **Promptfoo + Inspect AI** | MIT | CI-gated regression |
| Observability | Langfuse (embed) | MIT | Per-skill traces in the Studio (Pane 3) |
| Runtime harness | Deep Agents (already in stack) | MIT | Reads `SKILL.md` natively |

Total new components: 4 (OpenHands, E2B, CopilotKit/AG-UI shell, Promptfoo+Inspect harness). Workflow Editor (n8n) and pervasive chat (`useCopilotReadable`) are additions to the CopilotKit integration shell — no new infrastructure. All MIT/Apache-2.0/BSL, all self-hostable. Total new effort: ~9 ew across Phases 0.5, 1.9, 2.9 plus +2 ew expansion in Phase 4.

---

## References

[^1]: DataCamp. *CrewAI vs LangGraph vs AutoGen: Choosing the Right Framework*. [datacamp.com/tutorial/crewai-vs-langgraph-vs-autogen](https://www.datacamp.com/tutorial/crewai-vs-langgraph-vs-autogen) (Accessed 2026-05-25).
[^2]: Stackademic. *AutoGen vs LangGraph vs CrewAI vs OpenDevin: Open Source Agent Framework Battle 2025*. [blog.stackademic.com](https://blog.stackademic.com/autogen-vs-langgraph-vs-crewai-vs-opendevin-open-source-agent-framework-battle-2025-9232864f1e10) (Accessed 2026-05-25).
[^3]: Nous Research. *Hermes Agent — The agent that grows with you*. [github.com/nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent) (Accessed 2026-05-25).
[^4]: LinkedIn Pulse. *Hermes Agent by Nous Research: The Self-Improving Open-Source Developer Agent*. Released 2026-02-25; v0.8.0 on 2026-04-08 with 1000+ merged PRs (Accessed 2026-05-25).
[^5]: Nous Research. *Hermes Agent Documentation*. [hermes-agent.nousresearch.com/docs](https://hermes-agent.nousresearch.com/docs/) (Accessed 2026-05-25).
[^6]: Zep. *Stop Using RAG for Agent Memory*. [blog.getzep.com/stop-using-rag-for-agent-memory](https://blog.getzep.com/stop-using-rag-for-agent-memory/) (Accessed 2026-05-25).
[^7]: Cognee. *Beyond Recall: Building Persistent Memory in AI Agents with Cognee*. [cognee.ai/blog/tutorials](https://www.cognee.ai/blog/tutorials/beyond-recall-building-persistent-memory-in-ai-agents-with-cognee) (Accessed 2026-05-25).
[^8]: Graph Praxis. *Entity Resolution at Scale: Deduplication Strategies for Knowledge Graph Construction*. Medium, 2026 (Accessed 2026-05-25).
[^9]: Recall.ai. *Meeting Bot API*. [recall.ai/product/meeting-bot-api](https://www.recall.ai/product/meeting-bot-api) (Accessed 2026-05-25).
[^10]: Vexa. *Open-Source Meeting Bot API*. [vexa.ai](https://vexa.ai/) (Accessed 2026-05-25).
[^11]: Vexa-ai. *vexa* on GitHub. [github.com/Vexa-ai/vexa](https://github.com/Vexa-ai/vexa) (Accessed 2026-05-25).
[^12]: Recall.ai. *Recall.ai vs Attendee*. [recall.ai/recall-ai-vs-attendee](https://www.recall.ai/recall-ai-vs-attendee) (Accessed 2026-05-25).
[^13]: screenappai. *meeting-bot* on GitHub. [github.com/screenappai/meeting-bot](https://github.com/screenappai/meeting-bot) (Accessed 2026-05-25).
[^14]: Meta for Developers. *WhatsApp Webhooks Overview*. [developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview/) (Accessed 2026-05-25).
[^15]: WhatsApp Business Developer Hub. [whatsappbusiness.com/developers/developer-hub](https://whatsappbusiness.com/developers/developer-hub/) (Accessed 2026-05-25).
[^16]: r/WhatsappBusinessAPI. *Open-source WhatsApp Business Platform (OpenBSP)*. (Accessed 2026-05-25).
[^17]: Chatwoot. *WhatsApp Embedded Signup*. [developers.chatwoot.com](https://developers.chatwoot.com/self-hosted/configuration/features/integrations/whatsapp-embedded-signup) (Accessed 2026-05-25).
[^18]: n8n. *Webhook + WhatsApp Business Cloud integration*. [n8n.io/integrations/webhook/and/whatsapp-business-cloud](https://n8n.io/integrations/webhook/and/whatsapp-business-cloud/) (Accessed 2026-05-25).
[^19]: n8n. *ClickUp integrations*. [n8n.io/integrations/clickup](https://n8n.io/integrations/clickup/) (Accessed 2026-05-25).
[^20]: n8n. *Zoho CRM integration*. (Accessed 2026-05-25).
[^21]: Odoo-BS. *Odoo n8n Integration*. [odoo-bs.com/n8n-odoo-integration](https://www.odoo-bs.com/n8n-odoo-integration) (Accessed 2026-05-25).
[^22]: AWS Dev.to. *5 Techniques to Stop AI Agent Hallucinations in Production*. [dev.to/aws](https://dev.to/aws/5-techniques-to-stop-ai-agent-hallucinations-in-production-oik) (Accessed 2026-05-25).
[^23]: Atlan. *AI Agent Risks & Guardrails: 2026 Enterprise Security Guide*. [atlan.com/know/ai-agent-risks-guardrails](https://atlan.com/know/ai-agent-risks-guardrails/) (Accessed 2026-05-25).
[^24]: Agno. *Guardrails for AI Agents*. [agno.com/blog/guardrails-for-ai-agents](https://www.agno.com/blog/guardrails-for-ai-agents) (Accessed 2026-05-25).
[^25]: CrewAI. *Hallucination Guardrail*. [docs.crewai.com](https://docs.crewai.com/en/enterprise/features/hallucination-guardrail) (Accessed 2026-05-25).
[^26]: ZBrain. *Ambient Agents Explained: Applications, Architecture*. [zbrain.ai/ambient-agents](https://zbrain.ai/ambient-agents/) (Accessed 2026-05-25).
[^27]: Moveworks. *What Is an Ambient Agent? The Future of Enterprise AI*. (Accessed 2026-05-25).
[^28]: J. Fahey. *Ambient Agents and the Future of Always-On Intelligence*. Medium (Accessed 2026-05-25).
[^29]: Fracktal Works. [fracktal.in](https://fracktal.in/) (Accessed 2026-05-25).
[^30]: Crunchbase. *Fracktal Works Company Profile*. [crunchbase.com/organization/fracktal-works](https://www.crunchbase.com/organization/fracktal-works) (Accessed 2026-05-25).
[^31]: Sun, Y. et al. (2026). *AgentNet: Decentralized evolutionary coordination for LLM-based multi-agent systems*. arXiv preprint.
[^32]: Chen, W. et al. (2026). *Agentic LLMs in the supply chain: towards autonomous multi-agent systems*.
[^33]: Handler, J. (2023). *A Taxonomy for Autonomous LLM-Powered Multi-Agent Architectures*. DOI: [10.5220/0012239100003598](https://doi.org/10.5220/0012239100003598).
