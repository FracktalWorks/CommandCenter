# Core Module Map — Orchestration / Agent / Chat Systems

> **Status:** Living review checklist · **Created:** 2026-07-02
> Atomic inventory of the platform core (apps like email/task-manager/drawio are OUT of scope here).
> Each module maps to its [awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering) practice area so module-by-module completeness reviews compare against current best practice.
> Companions: [`harness_hardening_2026-07.md`](harness_hardening_2026-07.md) (HH queue) · [`chat_implementation_review_2026-07.md`](chat_implementation_review_2026-07.md) (chat audit) · [`llm_caching_memory.md`](llm_caching_memory.md).
> Grades: **A** solid, best-practice-aligned · **B** works, known gaps · **C** significant gaps / drift risk · **D** scaffold or missing.

## A. Agent Execution Core (orchestrator)

| # | Module | Lives in | List section | Grade | Key gaps |
|---|---|---|---|---|---|
| A1 | **Agent loop / executor** — run_agent_stream/run_agent, 3-tier dispatch (native MAF stream / Copilot SDK / batch shim), watchdogs, retries | `apps/orchestrator/orchestrator/executor.py` (~4.2k lines) | Agent Loop | **B** | Monolith; watchdog policy still per-tier; P1-2 multi-worker control state; P1-6 Copilot session continuity; no loop detection. Duplicated stream paths eliminated (Phase 2) |
| A2 | **Event translation** — `orchestrator/event_translator.py` (ONE canonical mapping + TranslatorHooks), per-message dedup | `event_translator.py`; folds still in `chat/route.ts` + `chatStream.ts` + `chat_fold.py` | Agent Loop / AG-UI | **B+** | Unified 2026-07-02 (Phase 2, parity evals). Remaining: client renders via the fold heuristic, so three parallel folds persist until Phase 3 (message-id-native rendering) deletes them |
| A3 | **Stream relay** — Redis Streams per thread, detached runs, replay/subscribe cursors, cancel cascade | `apps/orchestrator/orchestrator/stream_relay.py` | Long-running agents / observability | **A−** | Invariants now locked by trajectory evals; remaining: `lastEventId` always 0-0 (P1-5), server-side persistence owner (P0-3) |
| A4 | **Sub-agent orchestration** — call_agent family, SUB_AGENT_* event forwarding, depth/cycle guards, tier inheritance, background children | `packages/acb_skills/acb_skills/agent_tools.py`, `executor._run_sub_agent_streaming` | Multi-agent orchestration | **B** | Handoff = message string only (no typed schema/history/memory) — HH-7; child injected-tool events un-namespaced in parent |
| A5 | **HITL subsystem** — ask_user/ask_questions/request_confirmation blocking futures, respond-input, HITL-aware watchdog, mutation inbox | `acb_skills/ask_tools.py`, `executor._pending_user_input`, gateway `/respond-input` | Human-in-the-Loop | **B+** | Fail-closed shipped (HH-2); `_pending_user_input` per-process → multi-worker unsafe (P1-2); 3 delivery paths (A/B/C) is complexity debt |

## B. Agent System (lifecycle & capability)

| # | Module | Lives in | List section | Grade | Key gaps |
|---|---|---|---|---|---|
| B1 | **Dynamic agent loader** — clone/pull, importlib `build_agents()`, static+DB registry, config.json contract, push-guard hook, auto-dep install | `packages/acb_skills/acb_skills/loader.py`, `gateway/routes/agent.py` `_AGENT_REGISTRY` | Governing agents | **B+** | In-process import = no isolation (→ B6); `runtime` field authoritative but drift between registry sources possible |
| B2 | **Tool injection & scoping** — `_inject_agent_tools` (4 agent shapes), `tool_scope` + `own_tool_scope`, addendum builder, `normalize_tools` | `executor.py` 546–760 | Tool Design | **B+** | own_tool_scope shipped (HH-5) but email subset unset; addendum is hand-maintained prose (drift risk vs actual tools) |
| B3 | **Platform tool suite** — web, artifacts, memory, todos, notes, history, github search, errors, deps + risk annotations | `packages/acb_skills/*_tools.py`, `tool_annotations.py` | Tool Design / Skills | **B+** | Annotations shipped (HH-2); no per-tool eval coverage; error messages not systematically agent-optimised ("Writing Effective Tools") |
| B4 | **MCP integration** — `mcp_servers` table, per-run injection, agent_scope filter | `executor._inject_mcp_servers`, spec `mcp_plugin_integration.md` | Skills & MCP | **B** | No tool budgeting/identity propagation (list: "MCP production gaps"); no MCP Inspector-style debug path |
| B5 | **Integration registry** — encrypted Postgres creds, OAuth flows, env/`mcp_servers=` injection | `acb_skills/integrations.py`, gateway `/integrations` | Permissions & Authorization | **A−** | On-behalf-of vs fixed-credential distinction implicit; audit granularity per-operator unresolved (plan open Q7) |
| B6 | **Permissions & sandboxing** — `PermissionHandler.approve_all`, in-process agent code, workspace visibility rules | `executor.py` (~1048, ~2428), loader | Security, Sandbox & Permissions | **C** | HH-6: allowlist handler using risk annotations (near-term); container isolation for normal runs (Phase 5); OWASP excessive-agency exposure |
| B7 | **Self-mutation** — mutation container, 1-attempt cap, commit gate + auto-push on green, HITL approval, rollback | `orchestrator/mutation.py`, `Dockerfile.mutation`, `mutation_runner.py` | Verification & CI | **A−** | PR automation (WBS 1.3) + mutation audit surfacing (1.5) still open; eval gate inside sandbox is pytest-only |

## C. Model & Context Layer

| # | Module | Lives in | List section | Grade | Key gaps |
|---|---|---|---|---|---|
| C1 | **LLM gateway & tier routing** — LiteLLM SDK, 3 tiers + aliases, encrypted key store, model_config DB, BYOK, v1_compat | `packages/acb_llm/client.py`, `key_store.py`, `infra/litellm/` | LiteLLM / routing | **A−** | Retry telemetry now logged (HH-3); JSON-mode audit across call sites incomplete (known deepseek empty-content issue); no complexity/cost-aware routing |
| C2 | **Context assembly** — per-turn history built in Next.js route, memory_context enrichment, sub-agent result caps, tool-result stripping | `chat/route.ts`, gateway `agent.py` enrichment, `executor` regexes | Context Delivery & Compaction | **C+** | History assembly lives client-side → non-chat paths get different context; no central token accounting; dedup partial (P1-1) |
| C3 | **Compaction** — manual + auto (80% of real model window, hysteresis, checkpoint model, active-window slicing) | `AgentChat.tsx` 475–592, `compact/route.ts`, `lib/tokenCount.ts` | Compaction | **A−** | Frontend-only (API/webhook runs never compact); summariser model hardcoded to one provider |
| C4 | **Prompt caching** — byte-stable prefixes (`lru_cache` on registry block) only | planned: `infra/litellm/acb_litellm_hooks.py` | Prompt Caching | **D** | Entire caching plan unimplemented; NOW measurable via HH-3 cache counters — top build priority |
| C5 | **Memory subsystem** — Mem0 (pgvector) episodic, Graphiti bi-temporal KG, active tools, NOTES.md pattern, run-start enrichment | `packages/acb_memory/`, `acb_skills/memory_tools.py`, `note_tools.py` | Memory & State | **B+** | No write-gate on Graphiti (every turn writes); extraction skipped on reconnect/LiteLLM paths (P1-9); email↔agent memory bridge pending |

## D. Chat System (frontend + API)

| # | Module | Lives in | List section | Grade | Key gaps |
|---|---|---|---|---|---|
| D1 | **Chat API layer** — SSE proxy/translator (live path), respond-input proxy, Mem0 extraction hook; authoritative persistence now gateway-side (`chat_fold.py`) | `workbench/.../api/agent/chat/route.ts`, `api/chat/sessions/*`, `gateway/chat_fold.py` | Agent Loop (context assembly resp.) | **B−** | P0-3 closed both paths (Phase 1/2). Remaining: route still owns history assembly + live fold; P1-5 reconnect placeholder ids; `lastEventId`≈0-0 full replays; P1-9 no memory extraction on reconnect |
| D2 | **Stream reducer & store** — `applyStreamEvent` fold helpers, ownership tokens, `_stream_id` dedup, StrictMode guards | `src/lib/chatStream.ts`, `chatStore.ts`, `hooks/useAgentChat.ts` | AG-UI | **B+** | Centralised reducer shipped; duplicate-token guards must not be removed; 2 refactors deliberately skipped (documented) |
| D3 | **Chat UI surfaces** — AgentChat, tool/HITL/artifact/todo cards, context ring, mobile drawer, sub-agent timeline | `src/components/AgentChat.tsx` + cards | A2UI / AG-UI | **B+** | AgentChat is its own monolith (~2k lines); card lifecycle hardening done batches 1–3 |
| D4 | **Session & model management** — sessions CRUD, model picker + tier lock, per-agent model resolution chain | `api/chat/sessions`, `_apply_model_for_maf_agent`, `_active_run_model` | — | **B** | Model-resolution chain spans 3 layers (documented in memory but not in one code location); session stores per-process (P1-2 class) |

## E. Cross-cutting

| # | Module | Lives in | List section | Grade | Key gaps |
|---|---|---|---|---|---|
| E1 | **Evals & CI gates** — trajectory evals (blocking), inspect smoke, promptfoo golden cases, pr-check, deploy gates | `evals/`, `.github/workflows/` | Evals & Verification | **B** | Was D before HH-1; promptfoo gate inactive until CI secrets; coverage = harness invariants only, no agent-quality evals yet |
| E2 | **Observability** — structured logs, audit_event, per-call usage telemetry, OTEL callback (gated), MAF instrumentation kill-switch | `acb_common` logging, `acb_audit`, `acb_llm._emit_usage` | Observability & Tracing | **C+** | No trace backend → nothing exported yet; no session-replay tooling; cost dashboards read logs only |

## Review order (impact-first, core-only)

Impact = (how much every run touches it) × (distance from best practice). Apps excluded per scope.

1. **A1+A2+D1 — Executor / event translation / chat API** *(one review: they are one system)* — highest-traffic code, known 4-way duplication, the HH-8 refactor target. The trajectory evals now make this safe to restructure.
2. **C2+C4 — Context assembly + prompt caching** — every token of every run; caching plan is written and now measurable.
3. **B6 — Permissions & sandboxing** — worst gap grade in the core; risk annotations give the allowlist handler its vocabulary.
4. **A4 — Sub-agent orchestration** — typed handoffs (HH-7) after the translation refactor stabilises the boundary.
5. **A5 — HITL** — collapse 3 delivery paths to 1; multi-worker-safe pending state (Redis-backed futures).
6. **B2+B3 — Tool injection + platform tools** — generate the addendum from tool metadata (kill prose drift); per-tool eval cases.
7. **C5 — Memory** — Graphiti write-gate, extraction-path parity.
8. **C1 — LLM gateway** — JSON-mode audit, cost-aware routing pass.
9. **B4 — MCP** — tool budgeting, debug tooling.
10. **B1/B5/B7, A3, D2–D4, E1–E2** — already A−/B+ or scheduled elsewhere; sweep last.

## Status log
- 2026-07-02 — Map created from the harness-engineering audit + chat implementation review.
- 2026-07-02 — Review #1 (A1+A2+D1) design fleshed out in [`core_loop_unification.md`](core_loop_unification.md); Phase 1 (one persistence owner, P0-3) shipped for the named-agent path. D1 grade C+ → B− (persistence no longer client-only).
- 2026-07-02 — Phase 2 shipped (one event translator; P0-3 closed on `/copilot/chat` too). Grades: A1 B− → **B**, A2 C+ → **B+**, D1 stays **B−**. Review #1 remaining: Phase 3 (message-id-native rendering — deletes the three parallel folds), unified watchdog policy, P1-2/P1-5/P1-6/P1-9, `lastEventId` cursoring, §6 doc drift.
