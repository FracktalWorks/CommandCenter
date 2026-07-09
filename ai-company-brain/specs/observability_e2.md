# E2 — Observability & Debugging (interaction logging + run traces)

> **Status:** Phases 1–4 **shipped** (2026-07-03). Phase 5 (live activity feed)
> **shipped** (2026-07-09). E2 C+ → A.
> **Module:** E2 (core_module_map.md).
> **Goal (user request):** log every agent/model interaction so an engineer can
> debug "error X happened with agent Y" after the fact (Phases 1–4); AND give
> operators a live, cross-app view of "whenever any agent or model is activated"
> across chats and every app (Phase 5); and eventually run feature tests against
> the live VPS.

## ⏩ RUNBOOK — the user reports "error X with agent Y" (start here)

Follow in order; each step is more granular than the last. Prefer the API path
(no SSH). See `observability-run-traces` memory for the exact copy-paste commands.

1. **Is the feature even up, and where's it broken?** On the VPS:
   `cd /opt/acb/app && uv run python scripts/feature_check.py` (add `--only chat_maf`
   / `chat_copilot` to isolate a runtime, `--json` for machine output). It drives
   the real endpoints, prints a pass/fail table, and **on failure prints the exact
   `run_id` + the next command to run.**
2. **Get the durable record + full trace (no SSH):** `GET /debug/runs?agent=Y&status=error&since_hours=24`
   → pick the `run_id` → `GET /debug/runs/{run_id}` for the full trace + traceback.
   (EXECUTIVE/AGENT-gated — traces hold message content.) `POST /debug/runs/{id}/flag`
   to preserve a successful run's trace before it's pruned.
3. **Correlated log stream (deepest, needs SSH):** `ssh acb@187.127.179.143` then
   `journalctl -u acb-gateway -o cat | grep '"agent": "Y"'` — every line for the
   run carries `run_id`/`thread_id`/`agent`/`user` and the `run_error` line carries
   the full `exc_info` traceback. Requires `LOG_FORMAT=json` in `/opt/acb/app/.env`
   (already set in prod). Durable DB fallback if journald has rotated:
   `docker exec acb-postgres psql … "SELECT … FROM agent_run WHERE agent_name='Y' AND status='error' …"`.

**Retention (know this before you look):** metadata + tool_summary are kept for
ALL runs; the full `trace` + `error_traceback` only for errored / cancelled /
flagged runs. A *successful* run you want to inspect must be `flag`ged first (or
reproduced with an induced error). Redis event stream is latest-run-only, 1h TTL —
`agent_run` is the thing that survives.

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

## Phase 3 — Diagnostics API (`apps/gateway/gateway/routes/debug.py`)
Read-only, EXECUTIVE/AGENT-gated (a trace can hold message content):
- `GET /debug/runs?agent=&status=&user=&thread_id=&since_hours=&limit=` — list
  recent runs newest-first, all filters AND-combined, `limit` clamped [1,500].
  **Lean rows — no `trace` blob** (that's the detail view). Invalid status → 400.
- `GET /debug/runs/{run_id}` — full record: metadata + tokens + error +
  traceback + the folded `trace` (present only per the retention policy). 404 if
  unknown.
- `POST /debug/runs/{run_id}/flag` — set `flagged=true` to keep a run's trace.

This is what lets me query prod **without SSH** (and a UI panel could surface
failures). Extends the coarse `GET /agent/run/{id}/status` (`agent.py:1571`).
Verified end-to-end via TestClient against the live DB: filters, the lean-vs-
full split, retention honored through the API, the EXECUTIVE gate (employee →
403), and 404s.

## Phase 4 — VPS feature-check harness (`scripts/feature_check.py`)
One command, human-readable pass/fail table (or `--json`), CI/monitoring exit
code (non-zero on any fail):

    cd /opt/acb/app && uv run python scripts/feature_check.py

Checks: `health`, `debug_api` (the diagnostics API must itself be up),
`chat_maf` and `chat_copilot` (drive `/agent/run/stream` on each runtime, assert
`RUN_FINISHED` + text + no `RUN_ERROR`). For each run it then looks up the E2
**run trace** (`GET /debug/runs/{run_id}`) and prints the durable status — and on
failure prints the exact `GET /debug/runs/{id}` + `journalctl | grep <run_id>`
lines to debug. Shares the `CC_*` env config with the exhaustive
`tests/integration/test_chat_features.py` (which stays the CI-depth suite; this
is the fast operator "is it up, and where's it broken?" sweep). `--only <name>`
runs a single check.

Debugging loop is now fully self-serve: `feature_check.py` says WHAT broke +
the run_id → `GET /debug/runs/{id}` gives the full trace + traceback, no SSH
needed (SSH `journalctl` remains available for the correlated log stream).

## Tests
- `tests/unit/test_observability.py` (11): contextvar bind/clear (no leak),
  merge_contextvars present in the chain, run-trace row derivation (metadata-
  only on success, full trace on error/cancel/flag, cancelled/no-folded cases).
- Migration validated against the live local DB (idempotent re-run) + an E2E
  `_persist_row` write/read-back proving the errored-vs-successful retention
  policy. Full suite: 664 green, zero regressions.

## Phase 5 — Live activity feed (operator-facing, cross-app)
Phases 1–4 are an *engineer's post-hoc* view (logs + `agent_run` + `/debug`).
Phase 5 adds the *operator's live* view the user asked for: "see whenever any
agent or model is activated," across chat AND every app (email, tasks, …).

- **Global activity bus** (`packages/acb_common/acb_common/activity.py`): one
  process-wide Redis stream `cc:activity` that every activation publishes a
  small event to. `publish_activity(**fields)` is best-effort + non-blocking +
  never raises (a dropped event can never affect the run that emitted it — the
  durable record stays in `agent_run`). Presence keys `cc:activity:live:{run_id}`
  (TTL `LIVE_TTL_SECONDS`) track in-flight runs and self-heal if an "end" is
  lost. Cross-app coverage is automatic because the two publish sites are shared
  libraries:
  - **Agent activations** — the executor run boundary (`executor.py`
    `run_agent_stream`): a `kind="agent" phase="start"` event right after
    `bind_run_context`, and a `phase="end"` event (status + duration_ms) in the
    `finally`.
  - **Model activations** — `acb_llm._emit_usage` fires `kind="model"`
    (model/tier/tokens) on EVERY completion → chat, email automation, and tasks
    all covered with no per-app wiring.
  - **Source attribution** — `bind_run_context(..., source=)` adds `source` to
    the run-context contextvars (chat / email / tasks / webhook); model calls
    inside a run inherit it, so the feed shows which app triggered each call.
- **Live API** (`apps/gateway/gateway/routes/observability.py`, EXECUTIVE/AGENT-
  gated like `/debug`): `GET /observability/activity/recent` (backfill),
  `GET /observability/activity/stream` (SSE tail with heartbeats),
  `GET /observability/active` (runs in flight now).
- **UI** — new `/observability` page ("Live Activity", nav under Apps): backfills
  via `recent`, live-tails via `EventSource` on the SSE proxy, and polls
  `active` for the "running now" panel. Next proxies:
  `src/app/api/observability/{activity/recent,activity/stream,active}/route.ts`.
- **Tests** — `tests/unit/test_activity_bus.py` (7): event shaping + run-context
  inheritance + source binding + the best-effort/non-blocking publish contract
  (never raises on shaping or write failure). Full unit suite green (801).
- **Relation to Phase 3** — `/observability` is the *live signal* (ephemeral,
  Redis); `/debug` stays the *durable trace* (Postgres `agent_run`). Cost/token
  rollups + per-agent history are the next increment (read `agent_run` +
  `audit_event`; needs `LLM_USAGE_AUDIT=1`).

## Status
- 2026-07-03 — Phases 1+2 shipped. E2 C+ → B+.
- 2026-07-03 — Phases 3+4 shipped. E2 B+ → A−. `/debug/runs` diagnostics API
  (`routes/debug.py`, registered in main.py) + `scripts/feature_check.py`
  one-command live sweep. 9 debug-route integration tests (TestClient vs live
  DB) + 3 harness unit tests; full suite 667 green. OTLP trace-backend export
  remains the only deferred item (dormant, gated on `OTEL_EXPORTER_OTLP_ENDPOINT`).
- 2026-07-09 — Phase 5 shipped. E2 A− → A. Live cross-app activity feed: global
  `cc:activity` bus (`acb_common.activity`), publish at the executor run
  boundary + `acb_llm._emit_usage`, `/observability` gateway API (recent / SSE
  stream / active) + a new `/observability` Control Plane page. 7 activity-bus
  unit tests; full unit suite 801 green. Next: cost/token rollups + per-agent
  history (the "full dashboard" increment).
