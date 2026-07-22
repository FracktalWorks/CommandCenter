# Single-Agent Chat Bug Audit — 2026-07

**Status:** audit complete · P0 fixes landed 2026-07-22 (T1, C2, C1/CX1 —
see §4; regression tests in `tests/unit/test_run_agent_stream_e2e.py` and
`tests/unit/test_v1_context_fit.py`) · **Date:** 2026-07-22 · **Requested by:** Vijay
**Scope:** single-agent chat on both engines — native MAF (Tier 1) and Copilot SDK (Tier 1.5) —
hunting context-management failures, premature termination (runs / tools / output), and
BYOK/LiteLLM context-limit handling. Companion to
[`chat_agent_framework_review_2026-07.md`](chat_agent_framework_review_2026-07.md).

**Method:** four targeted code audits (Tier 1 stream loop + watchdog; Tier 1.5 session/resume/
stall; context assembly + model limits + `/v1`; Redis relay + persistence + frontend translator),
with every HIGH finding independently re-verified line-by-line. Baseline: **1545 unit tests and
118 trajectory evals pass** on this branch.

---

## 1. Verdict

**The previously-encountered issues are fixed and regression-locked** (§2). The conversation
path is **not yet "completely error-free"**: the audit found **7 confirmed bugs** (§3) — one
deterministic crash on the native path, a duplication/termination cluster on the Copilot path,
and delivery-pipeline holes that make healthy runs look broken. BYOK/LiteLLM context handling
is sound for native-MAF agents but **effectively absent for resumed Copilot sessions** (C1).

---

## 2. Previously-encountered issues — verified mitigated

| Past issue | Mitigation verified | Regression lock |
|---|---|---|
| False "context length exceeded" on BYOK (Copilot backend guesses ~90k) | `effective_infinite_sessions()` disables backend compaction for BYOK; applied on create, resume, AND executor rebind (`_copilot_session.py:101-203`, `copilot_agent.py:190-192,279-281`) | `test_copilot_infinite_sessions.py` incl. rebind tests |
| Telemetry ContextVar bug → successful runs reported as RUN_ERROR | killswitch runs at top of both entry points (`executor.py:127-150`, `:1321`, `:1744`); "different Context" teardown guard in the Tier 1 loop (`:2256-2274`) | `test_executor_telemetry_killswitch.py` |
| Idle watchdog killed runs parked on HITL ("disappearing question card") | Tier 1: `_hitl_pending` switches idle timeout 120s→3600s (`:2181-2184`, `watchdog.py:59`); Copilot: `_hitl_pending()` stall suppression (`copilot_agent.py:641`) | `test_hitl_stall_suppression.py`, `test_watchdog_trajectory.py`, `test_hitl_both_runtimes.py` |
| Copilot final answer swallowed after tool use (dedup bug) | per-`message_id` dedup replaced the turn-global guard (`copilot_agent.py:355,564-594`) | `test_copilot_dedup.py` |
| Run ends with no assistant text (Copilot) | `_copilot_no_text_end` three-way branch: HITL-park silent / tool-work soft-finish / no-work error (`executor.py:4227-4295`) | `test_executor_no_text_end.py` |
| Accidental Copilot-native 402 (quota) instead of BYOK | BYOK-by-default coercion of bare/unknown tiers (`executor.py:2044-2064`) | `test_byok_default.py` |
| Output budgeted at 1K while gateway allowed 32K → provider reject | `_reserved_output_tokens` reserves what the gateway will really send (`executor.py:4045-4062`) | `test_history_budget.py`, `test_v1_compat_max_tokens.py` |
| Prompt-cache churn from memory injection | memory is the dynamic suffix after `CACHE_BREAK`; stable prefix byte-stable | `test_prompt_cache_trajectory.py` |

Also verified sound: mid-stream provider errors on Tier 1 surface as RUN_ERROR (no hang);
`asyncio.wait` vs `_nq` race recovers stragglers; reconnect replays from cursor with no
RUN_STARTED gap; Redis-down degrades to direct streaming; HITL cards re-render on reconnect
(while the stream is alive); resume re-applies persona/provider/model.

---

## 3. Confirmed bugs (all independently re-verified)

### T1 — Native MAF loop-trip crash *(HIGH, deterministic)*
`executor.py:2275` sets `_next_task = None` before translating the update; the loop-detected
branch then calls `_next_task.cancel()` at `:2329` → `AttributeError` every time the
LoopDetector trips. The generator close (`:2330-2331`) is skipped and the outer handler emits a
second, bogus RUN_ERROR ("'NoneType' object has no attribute 'cancel'") with **no terminal
RUN_FINISHED**. Compounding: `LoopDetector` counts identical `name(args)` over the whole run
with no window/reset (`watchdog.py:79-83`), so a legitimate 5th identical call (no-arg status
tool, repeated `manage_todo_list` snapshot) trips it on a healthy run — and lands in this crash.
**Fix:** cancel only if `_next_task is not None`; consider a sliding window or higher threshold
for the detector. Add an executor-level loop-trip test (none exists).

### C1 — Resumed BYOK Copilot session has no input-side context management *(HIGH)*
The false-overflow fix disabled backend compaction for BYOK, justified by a comment
(`_copilot_session.py:63-65`) claiming gateway-side assembly bounds the prompt — **false for
this path**: the Copilot CLI POSTs to `/v1`, and `v1_compat.py` never calls
`fit_messages_to_context` / `assemble_run_context` (`:343`, `:401` call `acompletion` raw).
History lives inside the CLI session and grows unboundedly; once it exceeds the real window the
provider 4xx surfaces as SESSION_ERROR → run fails. The old *false* failure became a *real*
failure on genuinely long chats. Only the fresh/rebuilt-session path is budgeted
(`_render_history_block`). **Fix options:** (a) fit messages in `/v1` when
`x-cc-agent` traffic exceeds the resolved window (drop/compress oldest turns server-side);
(b) re-enable Copilot compaction for BYOK with the *real* window once the copilot-sdk 1.0.2
uplift exposes context limits (spec §5.5 row 1); (c) proactive session rollover: track
cumulative tokens per `service_session_id` and start a fresh session with injected history
before the limit. (a) is the near-term guard; (c) gives the "infinite session" UX.

### C2 — Mid-stream Copilot error → whole turn re-runs → duplicated visible output *(HIGH)*
The stale-session classifier's third clause — `"session" in msg and "error" in msg`
(`executor.py:2850-2861`) — matches ANY mid-run `AgentException("GitHub Copilot session error:
…")` (`copilot_agent.py:599-603`), including provider errors after output already streamed
(`:2829-2830` yields as it goes). The retry resets `_TranslationState` (`:2915`) → fresh
message IDs → the frontend renders the entire turn twice. **Fix:** track `_emitted_any` in the
attempt; only classify as stale-resume when nothing has been emitted (the genuine stale case
fails inside `_get_or_create_session` before any events), or match the exact resume-failure
message only.

### C3 — Copilot stall detector kills long-running silent tools *(MED-HIGH)*
`copilot_agent.py:619-657`: flat 300s timeout; the only suppression is HITL. The native path
grants 600s while a tool is open (`executor.py:2210-2218` via `WatchdogPolicy`); the Copilot
path has no tool-in-flight tier, so a >5-min silent shell/build tool dies with "The CLI
subprocess may have crashed." **Fix:** track TOOL_EXECUTION_START/END in `_stream_updates` and
extend the quiet budget while a tool is in flight (mirror `WatchdogPolicy`).

### R1 — Redis `MAXLEN 10000` silently truncates long turns *(HIGH)*
Every delta is one stream entry (`stream_relay.py:53,100-105`); long reasoning/tool-heavy turns
exceed 10k entries and Redis trims the **head** (RUN_STARTED + start of the answer). Both
consumers replay from `0-0`: reconnect (`agent.py:1567-1579`) rebuilds a turn that starts
mid-answer, and `persist_final_assistant_message` (`chat_fold.py:406-408`) writes the
**truncated** turn to Postgres — permanent data loss on exactly the biggest turns. **Fix:**
raise MAXLEN and/or coalesce text deltas before teeing; have the run-end persist fold from the
in-process event list (the executor already has it) instead of the Redis replay; alert when a
fold sees a trimmed head (first id ≠ run start).

### R2 — Cross-worker HITL answer / Stop can report success while undelivered *(HIGH)*
`dispatch_control` falls back to `is_active()` when pub/sub delivered to zero subscribers
(`stream_relay.py:462-463`) — an answer published during the subscribe race or after the owning
worker restarted is lost, the API returns `{ok:true}`, the card clears, and the agent stays
parked up to 3600s. Same shape for Stop: `cancel_run` marks inactive + pushes RUN_FINISHED even
when `relayed == 0` (`:743-751`) — UI says stopped, the detached task keeps running/spending.
**Fix:** ack over Redis (owner writes `cc:ctrl-ack:{thread}:{request_id}`; API waits ~2s, else
returns retryable failure); for cancel, only emit RUN_FINISHED after ack, else surface "stop not
confirmed".

### R3 — ACTIVE flag lapses during a long HITL park → synthetic RUN_FINISHED *(MED-HIGH)*
The flag refresh lives in `push_event` (`stream_relay.py:114`) and never fires while the agent
is parked (no events up to `ASK_USER_TIMEOUT=3600s`, same value as the TTL — any pre-park
elapsed time guarantees a lapse). Subscribers then terminate and reconnect reports the parked
run as finished (`agent.py:1592-1599`) — question card gone, "completed" turn, agent still
waiting. **Fix:** heartbeat the ACTIVE key from the parked `ask_user` wait loop (or a periodic
`asyncio` timer while any `_pending_user_input` future exists).

### Context-layer defects *(MEDIUM cluster, confirmed)*
- **CX1** `/v1` has no overflow re-fit or fallback; `acompletion_with_fallback` exists but only
  internal (email/tasks) callers use it. Over-long prompts surface as raw "upstream completion
  failed (400)".
- **CX2** Unknown BYOK models default to a **128k** window claim (`model_limits.py:67`) and an
  unclamped `max_tokens=32000` — a small self-hosted model overflows immediately; the
  "provider catches it and we retry" justification is not wired on the chat path (CX1).
- **CX3** Small-window math: `fit_messages_to_context`'s rescue branch budgets prompt to
  `window*3//4` without accounting for the `max_tokens` actually sent (`context.py:163-166`) —
  for a 32k-window unvetted model, prompt 24.5k + output 32k is unsatisfiable by construction.
- **CX4** `finish_reason == "length"` is never inspected anywhere — output truncated
  mid-sentence renders as a normal completed turn on both engines (the no-text handler only
  covers the zero-text case).
- **CX5** The char-trim stage picks the longest message **regardless of role**
  (`context.py:178-193`) — under pressure the system prompt or the user's current message gets
  silently truncated, contradicting the "never dropped" invariant (which only governs
  whole-turn eviction).
- **CX6** No user-facing signal exists for context pressure — eviction/trim is silent; quality
  degrades with no "long conversation" notice.

### Lower-severity (tracked, not urgent)
Refresh-during-thinking mints a new assistant id → duplicate Postgres rows
(`useAgentChat.ts:528` + `route.ts:654`); executor path persists to a fallback id where the
copilot path deliberately gates (`agent.py:1374-1388` vs `main.py:515`); stale-run reset can
race a >2s run-end persist (`stream_relay.py:606-615`); `_hitl_pending()` is global across
sessions (`copilot_agent.py:55-66`); stall-vs-ask timeout read different env vars
(`HITL_IDLE_TIMEOUT_SECONDS` vs `ASK_USER_TIMEOUT`); `TOOL_CALL_RESULT` with missing `call_id`
leaves a UI row open (`event_translator.py:307`); native Tier 1 lacks a `_copilot_no_text_end`
equivalent (tool work + no closing text → silent half-turn).

---

## 4. Priority fix plan

| P | Fix | Bugs closed | Effort |
|---|---|---|---|
| **P0** | Guard `_next_task` on loop trip + loop-detector window/threshold + executor-level test | T1 | hours |
| **P0** | Emitted-output guard on the Copilot stale-session retry (or exact-match classifier) | C2 | hours |
| **P0** | Context guard for resumed Copilot sessions (near-term: `/v1` fit for agent traffic; then session rollover or real-window compaction post-uplift) | C1, CX1, CX2 | 1–2 days |
| **P1** | Control-bus ack for respond-input + cancel | R2 | ~1 day |
| **P1** | ACTIVE-flag heartbeat during HITL parks | R3 | hours |
| **P1** | Tee coalescing / MAXLEN raise + persist-from-process fold | R1 | ~1 day |
| **P1** | Tool-in-flight grace in the Copilot stall detector | C3 | hours |
| **P2** | Surface `finish_reason=length` + context-pressure notice; role-protect the char-trim; fix small-window budget math | CX3–CX6 | 1–2 days |

## 5. Regression tests to add (currently uncovered)

Loop-trip through the executor (T1) · mid-stream SESSION_ERROR must not re-emit (C2) ·
long-session BYOK overflow behavior (C1) · MAXLEN-trimmed replay/persist (R1) ·
`dispatch_control` with zero subscribers (R2) · ACTIVE lapse during HITL park (R3) ·
long silent tool surviving >300s on the Copilot path (C3) · `finish_reason=length`
visibility (CX4) · system-prompt protection in char-trim (CX5) · small-window unvetted
model end-to-end (CX3).
