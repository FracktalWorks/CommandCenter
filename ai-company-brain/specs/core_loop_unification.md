# Core Loop Unification — A1 Executor · A2 Event Translation · D1 Chat API

> **Status:** Phase 1 in progress · **Created:** 2026-07-02
> Build-out of module-map review #1 ([`core_module_map.md`](core_module_map.md)) — the three strategic refactors from [`chat_implementation_review_2026-07.md`](chat_implementation_review_2026-07.md) §5, designed against [awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering) practices.

## Guiding practices (from the list)

| Practice | Source | How it shapes this design |
|---|---|---|
| **Append-only event log as source of truth; replay for crash recovery** | "Scaling Managed Agents: Decoupling the Brain from the Hands" | The per-thread Redis stream already IS the event log. Persistence must **derive from the log**, not from whoever happens to be watching the stream. Phase 1 folds the log server-side at run end. |
| **Multi-agent/streaming systems are distributed systems: typed boundaries, one owner per concern** | "Multi-Agent Workflows Often Fail" | Today translation+persistence+history-assembly all live in the Next route (3 concerns, 1 file) while translation ALSO lives in 4 backend paths. Target: one owner per concern. |
| **Middleware hooks intercept every loop stage** | "How Middleware Lets You Customize Your Agent Harness" | `run_detached` gains an `on_complete` hook — the first deterministic lifecycle hook on the run boundary; watchdog/telemetry policies can attach here later instead of being copy-pasted per tier. |
| **Loop architecture, not model identity, determines behavior; harness-only improvements move rankings** | "Improving Deep Agents with Harness Engineering", deepclaude | Justifies investing in the loop itself over feature work. Tier feature asymmetry (TODO_LIST/elicitation/PARTIAL only on Tier 1.5) is a harness defect, not a model one. |
| **Message boundaries are known by the runtime — don't infer them** | AG-UI protocol spec | The fold/un-fold heuristic infers narration-vs-answer. Runtimes know real message ids. Phase 3 makes the protocol message-id-native and deletes the heuristic family. |

## Current state (what drifts)

- **Translation** exists in 6 places: executor Tier 1 (native MAF → AG-UI), Tier 1.5 (Copilot events → AG-UI), Tier 2 batch shim, sub-agent forwarding, `route.ts` (AG-UI → frontend SSE + fold), `chatStream.ts` (frontend SSE → message state + fold).
- **Persistence** is owned by `route.ts` (`persistAssistantMessage` every 3 s + final). If the browser/Next reader goes away, the detached run keeps streaming into Redis and **the tail is lost after TTL** (review P0-3 — the last open P0).
- **History assembly** also lives in `route.ts` (per-mode message arrays).

## Target architecture (one owner per concern)

```
executor tiers ──┐
sub-agents ──────┤→ [A2 one translator (py)] → Redis stream (source of truth)
                                                    │
                        ┌───────────────────────────┼─────────────────────────┐
                        │ live SSE subscriber       │ gateway fold-and-persist│
                        │ (route.ts: translate only)│ (authoritative, at run  │
                        │ → chatStream.ts reducer   │  end via on_complete)   │
                        └───────────────────────────┴─────────────────────────┘
```

- **Gateway owns persistence** (fold of the Redis log → `chat_message` upsert). The Next route remains the *live-path* writer (3 s checkpoints for snappy refresh-recovery) but is no longer load-bearing: same row id, idempotent upsert, server fold wins at run end.
- **route.ts owns translation only** (long-term: thin proxy once the client reducer consumes AG-UI directly).
- **Executor owns emission** through one translator module.

## Phases

### Phase 1 — One persistence owner (P0-3) 🔄 this session
1. **`stream_relay.run_detached(..., on_complete=)`** — async callback invoked in the drain task's `finally` (after `mark_inactive`), regardless of finish/error/cancel. Best-effort; never raises into the relay.
2. **`gateway/chat_fold.py`** — Python port of the fold pipeline, event-for-event equivalent to `route.ts`/`chatStream.ts`:
   `group_reasoning_blocks` / `fold_for_tool_start` / `unfold_trailing_answer` / `parse_tool_args` + `fold_run_events(events) -> persisted-message dict`. Timestamps derive from each event's Redis `_stream_id` (`<ms>-<seq>`) — deterministic from the log, no wall-clock in the fold.
3. **`persist_final_assistant_message(thread_id, message_id)`** — `replay_events(thread_id, "0-0")` → fold → `_upsert_messages` (direct call, same process). Skips empty runs (same guard as route.ts).
4. **Message-id plumbing** — `AgentRunRequest.assistant_message_id`; route.ts forwards the frontend's `assistantMessageId` in the `/agent/run/stream` body; fallback `assistant-{thread}-{run_id}` (used only when the frontend sent none — then route.ts's own time-based fallback may write a second row; acceptable, pre-existing).
5. **Evals** — fold-parity trajectory tests (synthetic event log → folded message: fold/unfold, failed-tool status, sub-agent attachment, todos/custom) + an end-to-end `run_detached` → `on_complete` persistence trajectory on FakeRedis.

Kills: P0-3 (tail loss), the persisted half of steer-resurrection, and persisted-vs-live divergence at run end. Non-goals in this phase: /copilot/chat orchestrator path (RunAgentInput drops unknown keys — needs a query param; Phase 2), reconnect-path memory extraction (P1-9), removing route.ts checkpoints.

### Phase 2 — One event translator (A2)
Extract the content→AG-UI mapping (function_call/result, text, reasoning, todo, elicitation, partial, intent) into `orchestrator/event_translator.py`, consumed by all four backend paths; one watchdog policy parameterized per tier. Acceptance: a golden trajectory eval feeding identical synthetic runtime updates through each tier adapter yields byte-identical AG-UI streams; tier asymmetries (TODO_LIST, elicitation bridge, TOOL_CALL_PARTIAL on Tier 1/2) close as a side effect. Also: extend `assistant_message_id` to `/copilot/chat` (query param).

### Phase 3 — Message-id-native protocol (rides on Phase 2)

**3a — true boundaries on the wire (backend + additive client capture).**
The translator currently attributes ALL of a run's text to the first
message id; runtimes actually mint a new id per assistant segment (text
between tool rounds). 3a: the translator closes/opens text messages on
`message_id` change, so every tier emits real segment boundaries;
`route.ts` forwards `messageId` + a `message_end` frame instead of
discarding them; `chatStream.ts` records `segments: [{id, text}]` on the
message additively (renderer untouched); `chat_fold.py` derives
narration-vs-answer from segments when present (last segment = answer —
ground truth) with the heuristic as fallback for id-less runs.

**3b — segment-native rendering (frontend, verified against the running UI).**
Render each segment as its own timeline entry with the last segment as the
answer body. Do NOT attempt blind — this changes the chat surface's core
rendering; drive it with /run + Playwright.

**3b design correction (2026-07-02, after tracing all three folds + both
loops).** The original line — "delete the fold family, `route.ts` stops
folding entirely" — was written before confirming that **`litellm` mode emits
no message ids at all** (`streamLiteLLM` sends bare `delta` frames), and the
langgraph batch path emits one delta with no ids either. Deleting the fold
would break every id-less runtime. So 3b **prefers segments when the runtime
supplies real ids and keeps the fold as the documented fallback**, not a
delete. Concretely:
- The chronology problem (segments live in a separate array from `toolEvents`,
  so a naive segment render loses narration↔tool interleaving) is solved the
  same way reasoning already is: on `tool_start` record `segmentCutoff` = number
  of segments captured so far, mirroring `reasoningCutoff`. The renderer then
  interleaves segments ⊕ reasoning ⊕ tools chronologically.
- **Last segment = answer body**; earlier segments render in the timeline as
  narration. When no segment ids are present (litellm/langgraph/legacy rows),
  the renderer falls back to today's `content` + folded `reasoningBlocks`.
- The fold helpers stay (they still run for id-less streams and still produce
  the persisted `content` for memory extraction + non-segment clients), but
  they are no longer load-bearing for id-carrying runtimes. The parity eval
  keeps them honest.
This is a smaller, safer change than a delete, and it degrades cleanly.

## Verification (live-app drive, 2026-07-02)

Drove real orchestrator turns through a locally-run gateway + Postgres/Redis
to confirm Phases 1–3a end-to-end (not just via unit evals):
- **3a confirmed on a live model**: a search-then-answer turn produced two
  genuinely distinct `message_id`s with a clean `TEXT_MESSAGE_END`/`START`
  around the tool call — narration segment then answer segment, no inference.
- **Found + fixed a P0-3 completion bug**: the run-end fold hit a
  `chat_message → chat_session` FK violation and silently dropped the message
  when the parent session row didn't exist yet. The frontend normally upserts
  the session first, but the persistence owner must be self-sufficient (its
  whole point is surviving a gone client — including a first-turn client death
  before the session upsert lands). Fix: `persist_final_assistant_message` now
  calls a new `_ensure_session` (INSERT … ON CONFLICT DO NOTHING, owned by the
  acting user) before the message insert. Re-drove a fresh-session turn:
  `chat_fold.persisted` succeeded, message + auto-created session both landed.

## Invariants (locked by evals)
- The Redis stream remains the single source of truth; anything derived (persisted rows, UI state) must be reproducible by replaying it.
- Persisted tool status honors `success` (never hardcode `done`).
- Fold semantics identical across languages until Phase 3 deletes them — the parity eval is the contract.

## Status log
- 2026-07-02 — Spec created; Phase 1 implementation started.
- 2026-07-02 — **Phase 1 shipped**: `gateway/chat_fold.py` (fold port + `persist_final_assistant_message`), `run_detached(on_complete=)` lifecycle hook (shielded, runs on finish/error/cancel), `AgentRunRequest.assistant_message_id` + route.ts forwarding on `/agent/run/stream`. 9 fold/persistence trajectory evals in `evals/trajectories/test_chat_fold_trajectory.py` (incl. cancelled-run partial-turn persistence). P0-3 closed for the named-agent path; `/copilot/chat` orchestrator path follows in Phase 2.
- 2026-07-02 — **Phase 3a shipped**: the translator closes/reopens text messages on real `message_id` changes (every tier now emits true segment boundaries; id-less runtimes degrade to one segment); `route.ts` forwards `messageId` on deltas + `message_start`/`message_end` frames; `chatStream.ts` captures `segments: [{id, text}]` on the message additively (renderer untouched); `chat_fold.py` records segments, persists them in `agent_state.segments`, and uses last-segment ground truth to rescue answers stranded by the fold heuristic — the reproducible case being CANCELLED runs (no RUN_FINISHED → un-fold never ran → Phase 1's cancel-persistence wrote an empty bubble). 4 new trajectory evals. Remaining (3b): segment-native rendering + delete the three folds — drive against the running UI, not blind.
- 2026-07-02 — **Phase 3b shipped** (segment-native rendering, driven against the real UI). The renderer now PREFERS real message segments over the fold heuristic, with the fold demoted to the documented fallback for id-less runtimes (litellm/langgraph emit no message ids — deleting the fold outright, as the original spec line said, would have broken them). What changed:
  - **Capture (all three folds):** each `tool_start` records `segmentCutoff` = segment count at its start, mirroring `reasoningCutoff`, so segments interleave with tools chronologically. When real segment ids are present, narration is NO LONGER double-folded into `reasoningBlocks` (it lives only in the segment) — `reasoningBlocks` then holds only genuine chain-of-thought. `chatStream.ts`, `route.ts`, and `chat_fold.py` all apply this conditional identically.
  - **Renderer:** `MarkdownMessage` uses the **last segment as the answer body** and passes earlier segments to `ThinkingContainer` as `narrationSegments`; `buildTimeline` three-way-interleaves narration ⊕ reasoning ⊕ tools (each channel advances by its own cutoff). Id-less messages fall back to `content` + folded `reasoningBlocks` unchanged. The `done` reducer backfills `content` from the last segment so copy/action-bar/memory consumers still see the answer.
  - **Round-trip:** segments persist in `agent_state.segments` (route.ts live-path, chat_fold.py authoritative, sessions.ts client cache) and are restored on poll + full DB load; the reconnect/replay reset clears `segments` (the delta reducer appends by id, so stale segments would double).
  - **Verification (real running UI):** added `e2e/chat.spec.ts` "multi-segment turn segment-native" Playwright test — a narration→tool→answer SSE run renders the narration segment in the timeline and the last segment as the answer body, with the narration NEVER duplicated into the body. Green + screenshot-confirmed. Fixed the harness's pre-existing `gotoChat` drift (New-session modal now auto-opens; "Conversations"/subtitle selectors) and sidebar-preview strict-mode collisions on the tests adjacent to the rendering surface. Left 4 pre-existing e2e failures untouched (the send-mode control + model `<select>` were redesigned since the tests were written — out of Phase 3b scope; noted here so the drift is tracked). Python parity locked by 2 new fold trajectory evals (segment-native no-double-fold + id-less fallback shape).
- 2026-07-02 — **Phase 2 shipped**: `orchestrator/event_translator.py` is the ONE canonical runtime-update → AG-UI mapping; all four executor paths consume it (native MAF loop, Copilot loop, Tier 2 batch text via `text_message_events`, sub-agent via `wrap_sub_agent_events`). Copilot-only behaviour (TODO_LIST interception, elicitation bridge + cleanup) moved into `TranslatorHooks` wired only on that path — the native path's tools emit those events themselves via the queue, so hooks there would double-emit. ~240 lines of duplicated mapping deleted from the executor. Side effects: Copilot gains streamed-tool-call id dedup; Tier 2 batch now speaks TEXT_MESSAGE_START/END with message ids (Phase 3 groundwork); dead `copilot_premature_end` branch removed. `/copilot/chat` now takes `assistant_message_id` as a query param (its AG-UI body model drops unknown keys) and runs the Phase-1 fold-and-persist `on_complete` — P0-3 fully closed. Parity contract locked by `evals/trajectories/test_event_translator_trajectory.py` (8 trajectories incl. identical-input cross-path parity). Remaining Phase 2 item: unified watchdog policy (still per-tier) — deferred to Phase 3 alongside message-id-native rendering.
