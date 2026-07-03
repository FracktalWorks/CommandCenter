# E2 — Observability & Debugging (interaction logging + run traces)

> **Status:** Phases 1+2 **shipped** (2026-07-03). Phases 3+4 designed, not built.
> **Module:** E2 (core_module_map.md) — grade C+ → B+ after Phases 1+2.
> **Goal (user request):** log every agent/model interaction so an engineer can
> debug "error X happened with agent Y" after the fact, and eventually run
> feature tests against the live VPS.

## The gap (audited 2026-07-03)

- **Logs weren't correlated or machine-parseable.** structlog was configured
  with `merge_contextvars` (capability present) but **nothing bound** run ids —
  and it rendered **colored console text**, not JSON. You couldn't grep "all
  logs for run X"; most lines (incl. `acb_llm.usage`) carried no run id.
- **The full run trace lived only in Redis, 1-hour TTL, latest-run-only.** An
  hour after an error, the detail was gone; only the UI-shaped folded
  `chat_message` survived. `audit_event` kept a coarse start/complete/error row
  with the exception **message only — no traceback**.
- **LLM telemetry wasn't attributed** to a run/agent/user.
- No trace-dump endpoint beyond the coarse `/agent/run/{id}/status`.

VPS access already existed (SSH from the dev machine → `journalctl -u
acb-gateway`, `docker exec acb-postgres psql`; Hostinger MCP for metrics), so
the missing piece was the *structured, queryable interaction record* — not
reachability.

## What shipped — Phases 1+2

### Phase 1 — Correlated, JSON-able logs (`packages/acb_common/_log.py`)
- `bind_run_context(run_id, thread_id, agent, user)` / `clear_run_context()` /
  `get_run_context()` bind the run fields into structlog contextvars. The
  executor binds them at the run boundary in `run_agent_stream` (and clears in
  the `finally`), so **every log line the run emits — across all tiers and
  injected tools on that context — automatically carries them**. Verified:
  `agent.step` and `acb_llm.usage` (which passes no ids) both come out tagged.
- `configure_logging(level, json_logs=?)` + `LOG_FORMAT` env: `LOG_FORMAT=json`
  → `JSONRenderer` (one JSON object per line, greppable / aggregator-ready);
  default stays the colored console renderer for local dev. **Prod turns this
  on by adding `LOG_FORMAT=json` to the systemd `EnvironmentFile` (`.env`)** —
  no code change (it's read at `configure_logging` time).
- LLM usage attribution (`acb_llm/client.py::_emit_usage`): the `acb_llm.usage`
  log line is auto-correlated via contextvars; the optional `audit_event` row
  (`LLM_USAGE_AUDIT=1`) now also carries `run_id`/`agent`/`user` via
  `get_run_context()`, and its `actor` becomes `agent:<name>` so cost is
  attributable per agent.

### Phase 2 — Durable run-trace store (`agent_run` table)
- Migration `infra/postgres/50_agent_run_trace.sql`: one row per run —
  `run_id, thread_id, agent_name, user_id, model, status,
  started_at/ended_at/duration_ms, {prompt,completion,total}_tokens,
  tool_count, tool_summary(JSONB), error_message/error_type/error_traceback,
  trace(JSONB), flagged`. Indexed for the diagnostics queries (by agent, by
  status, by thread, by time; partial index on `status='error'`).
- `apps/gateway/gateway/run_trace.py`: `build_run_trace_row(...)` (pure,
  unit-tested) derives status from the events (RUN_ERROR → error, cancelled
  RUN_FINISHED → cancelled, else completed) and a lightweight
  `[{name,status}]` tool summary. **Retention policy (user choice): metadata +
  tool summary for ALL runs; the full `trace` (content + tool results +
  reasoning) ONLY for errored / cancelled / flagged runs** — you rarely debug
  successful runs, and this bounds storage + sensitive-data exposure.
  `record_run_trace(...)` upserts it (never raises).
- Wired at the run boundary in `chat_fold.persist_final_assistant_message`
  (both orchestrator paths) — it already replays the Redis event log and folds
  it, so the trace write reuses that same replay (one extra DB write, all data
  in hand). A run that produced no message still gets a row (itself a signal).
- Traceback capture (`executor.py`): the run-error handler now logs with
  `exc_info=True` (the `format_exc_info` processor renders the full stack, and
  with Phase-1 correlation that line carries the run id), and the
  `agent_run_error` audit payload now includes `error_type` + `traceback`.

## Debugging workflow this enables (today)
- **"Error X happened with agent Y"** → over SSH:
  `journalctl -u acb-gateway -o cat | grep '"agent": "Y"'` (once `LOG_FORMAT=json`
  is set) to see every correlated line incl. the traceback; and
  `docker exec acb-postgres psql -c "SELECT * FROM agent_run WHERE agent_name='Y'
  AND status='error' ORDER BY started_at DESC LIMIT 20"` for the durable record
  + full trace of each failure.
- **Cost / token attribution** → `agent_run` token columns + the correlated
  `acb_llm.usage` lines (per agent).

## Designed next — Phases 3+4 (not built)
- **Phase 3 — Diagnostics API.** `GET /debug/runs?agent=&status=&limit=` (list)
  and `GET /debug/runs/{run_id}` (full trace + error + tokens). Extends the
  existing coarse `GET /agent/run/{id}/status` (`agent.py:1571`). This is what
  lets me query prod without SSH, and lets a UI panel surface failures.
- **Phase 4 — VPS feature-test harness.** Build on the EXISTING live-VPS suite
  `tests/integration/test_chat_features.py` (env-configurable gateway/token/
  agents; already covers SSE/thinking/tools/HITL/delegation/memory/artifacts/
  reconnection) — turn it into a one-command "exercise chat + each AI app,
  assert each completes, capture the trace, report pass/fail per feature" run
  over SSH against the live VPS.

## Tests
- `tests/unit/test_observability.py` (11): contextvar bind/clear (no leak),
  merge_contextvars present in the chain, run-trace row derivation (metadata-
  only on success, full trace on error/cancel/flag, cancelled/no-folded cases).
- Migration validated against the live local DB (idempotent re-run) + an E2E
  `_persist_row` write/read-back proving the errored-vs-successful retention
  policy. Full suite: 664 green, zero regressions.

## Status
- 2026-07-03 — Phases 1+2 shipped. E2 C+ → B+.
