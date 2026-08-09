# C2 — Server-side Context Assembly

> **Status:** **Shipped (2026-07-03)** — C2 grade B− → A−.
> **Module:** C2 (core_module_map.md)
> **Related:** [`llm_caching_memory.md`](llm_caching_memory.md) (C4, session-scoped memory), [`core_loop_unification.md`](core_loop_unification.md) (chat_fold = the OUTPUT-side assembler; this is the INPUT side)

## The gap (audited 2026-07-03)

Per-turn LLM **input context** (conversation history + memory + system prompt)
is assembled **client-side and trusted verbatim by the server**:

- **Client owns it.** `useAgentChat.sendMessage` reads history from the
  in-memory `chatStore`, applies `activeContextSlice` (a compaction-checkpoint
  window), strips tool-results/reasoning down to `{role, content}`, and POSTs
  the resulting array as `messages`. `route.ts` is a pure proxy — it prepends
  the `context` system message, appends the current turn, dedups the current
  turn (`withoutCurrentTurn`), and forwards. No server windowing/budgeting.
- **The gateway trusts `messages`.** Both orchestrator paths read history from
  `event_payload["messages"]`. The executor then re-slices that same client
  history in **six** distinct sites, each with a **different COUNT cap and
  different char-truncation**, all token-blind:
  - `:2963` Copilot-SDK continuity fallback — last **12** msgs, 200 chars each
  - `:3360` stale-session retry — last **20**, 300 chars each
  - `:3712` streaming BYOK MAF — last **20**
  - `:4218` Tier-2 batch chat — last **50**
  - `:4288` `_compose_maf_run_input` (streaming native MAF) — last **20**
  - `:4340` `_build_event_message` (string/webhook/email fallback) — last **16**, 600 chars each
  The code itself documents (`:4298-4306`) that `_compose_maf_run_input`
  *mirrors* the batch path — acknowledged duplication. None rebuild from the DB;
  none count tokens.
- **Token accounting exists but only email uses it.**
  `acb_llm/context.py::count_message_tokens` (litellm real tokenizer + chars/4
  fallback), `context_window_for`, and `fit_messages_to_context` (token-budgeted
  truncation) are wired ONLY into the email automation path
  (`acompletion_with_fallback`). The chat + agent-run paths have zero token
  budgeting.
- **The DB is the real source of truth, unused as a server rebuild.**
  `chat.py::_get_messages(session_id, user_id, limit)` returns
  oldest→newest history from `chat_message`. Nothing on the agent-run path
  reads it — so a non-browser caller (API, webhook, external integration) that
  hits `/agent/run/stream` with a `thread_id` but no client-maintained
  `messages` array gets **zero history**.

### Consequences
1. **Non-chat callers get inconsistent/empty context** — the exact "history
   assembly lives client-side → non-chat paths get different context" gap.
2. **Token-blind caps** — 50 short turns and 50 huge turns are treated the
   same; a long transcript can overflow the window despite the count cap, and a
   short one wastes the budget it could use.
3. **Three different caps (50/20/20)** — drift risk; the streaming and batch
   paths can feed the model *different* history for the same turn.

## Design — one server-side assembler

Add `acb_llm/context.py::assemble_run_context(...)` — the single INPUT-side
context builder, reusing the token utilities already in that module. It is a
pure function over its inputs (DB access is injected, so `acb_llm` stays free of
a gateway dependency):

```
assemble_run_context(
    *,
    system_context: str,          # persona / memory / integrations preamble
    history: list[dict],          # client-sent messages (may be [])
    current_message: str,         # the new user turn
    model: str,                   # tier alias or concrete id (for the budget)
    max_output_tokens: int = 1024,
    history_loader: Callable[[], list[dict]] | None = None,  # DB rebuild
    max_turns: int = 50,          # hard upper bound (belt + suspenders)
) -> list[dict]                   # OpenAI-format messages, budget-fitted
```

Behaviour:
1. **Source of history.** Use `history` when non-empty. When it's empty AND a
   `history_loader` is supplied (server has a `thread_id`), rebuild from the DB
   via the loader → **parity for non-chat callers**.
2. **Current-turn dedup.** Drop a trailing history entry equal to
   `current_message` (server-side `withoutCurrentTurn`), then append the current
   turn — so the model never sees the prompt twice regardless of caller.
3. **Assemble** `[system?] + history[-max_turns:] + current` in OpenAI shape.
4. **Token-budget windowing.** Call `fit_messages_to_context(messages, model,
   max_output_tokens=…)`. This is the key upgrade: token-aware fitting REPLACES
   the blind count caps. The `max_turns` count cap stays only as a cheap upper
   bound before the (more expensive) token pass.

Wire it into the executor's three history sites (`_compose_maf_run_input`, the
Tier-2 batch path, the streaming prep at `:3367`) so streaming and batch feed
the model **identically**, both token-budgeted. The client keeps doing its own
windowing for the UI ring + compaction (that's fine and additive); the server
no longer *depends* on the client having done it.

### Non-goals (this pass)
- Moving compaction server-side (C3 is already A−; frontend-owned by design).
- Rebuilding the client-side context ring (UI concern, not correctness).
- The email path already uses `fit_messages_to_context` — untouched.

## Tests
- Unit (`tests/unit/test_context_assembly.py`): dedup, DB-rebuild-when-empty,
  token-budget fit shrinks an over-long transcript, count-cap upper bound,
  system-message leading, empty inputs.
- Trajectory (`evals/trajectories/test_context_assembly_trajectory.py`):
  streaming vs batch produce the SAME assembled context (parity — the drift the
  three different caps risked); a non-chat caller with `thread_id` + no
  `messages` gets DB history.

## Status
- 2026-07-03 — Design from the C2 audit. Building the assembler + wiring.
- 2026-07-03 — **Shipped.** `acb_llm.assemble_run_context` added (`context.py`),
  exported from `acb_llm/__init__.py`. Wired into both executor structured-
  message sites (`_compose_maf_run_input` + the Tier-2 batch path) via
  `_active_run_model.get()` for the budget; `agent.py` injects a `_get_messages`-
  backed `_history_loader` into the payload for `thread_id`-carrying callers
  with no client history. Two-stage token fit (drop oldest whole turns, then
  char-trim the longest survivor) — the single-message trimmer alone couldn't
  converge on many-medium-turn chat transcripts. 12 unit
  (`tests/unit/test_context_assembly.py`) + 4 trajectory
  (`evals/trajectories/test_context_assembly_trajectory.py`, CI-blocking);
  full suite 646 green, zero regressions. The email path keeps its own
  string-flatten assembler (app-scoped, out of core C2). The client still
  assembles for the UI ring — additive, no longer trusted for correctness.
