# Apps

## Purpose
Three distinct kinds of unit, grouped by lifecycle into subfolders. The split
is load-bearing: **services** are deployed processes; **agents** and **skills**
are *loaded by* a service at runtime and are never deployed on their own.

## `services/` — deployed FastAPI processes
- gateway/ -- FastAPI entry point, AG-UI chat, agent routes, OAuth, integration credential management (DB-backed, encrypted at rest), MCP server registry, plugin registry
- orchestrator/ -- Agent execution engine, mutation layer, MAF integration
- ingestion/ -- ClickUp/Zoho/Gmail webhook receivers, MCP servers, the Redis-Streams producer (`queue.py`), the drain loop (`consumer.py`), and the sink registry (`event_hooks.py`). Rules below; the design record is `FOUNDATION_BUILDOUT_CHECKLIST.md` §BO-20.
  - ⚠️ **`sources/zoho/writer.py` is the only outward-WRITE client in this package, and the only Zoho write surface in the repo** (WS-26b, spec `crm_app.md` §7.1/D-CRM-7). Its sibling `client.py` stays read-only — six `list_*` GETs plus `list_deleted`, and the one POST is the OAuth refresh. The writer has **exactly one caller**, `gateway/routes/crm/sync_zoho.py::execute_push`, grep-asserted in `tests/unit/test_crm_zoho_sync.py`; it is deliberately dumb about authority because the Action-Broker gate lives gateway-side (ingestion cannot import the gateway, which is also why the sync LOOP is a gateway lifespan task and not a job in `ingestion/scheduler.py`). Do not import it from anywhere else, and do not add a second write client beside it — the whole path retires with WS-26e.
  - **Receivers** (all three, same shape): verify the credential → log → best-effort `queue.enqueue` to their own `ingestion:*` stream (a Redis failure warns and continues — a provider webhook must never 5xx) → `BackgroundTasks`-schedule `emit_event(source, event_type, payload)`. **Never `await` the emit inline** — an emit inside the ack window turns a slow DB into provider retries. Gmail and Zoho also write an `acb_audit` row in `receive`; ClickUp audits only from its `_normalise_task` background task.
  - **Fail closed:** with `clickup_webhook_secret` / `zoho_webhook_secret` / `gmail_pubsub_token` empty (the default, and the state of every environment) each push 401s and nothing is enqueued or emitted. Provisioning them and pointing the provider at the route is an OWNER action.
  - ⚠️ **The emit is flag-conditional** (BO-20a): each receiver calls `consumer.consumer_enabled()` per request; with `INGESTION_CONSUMER` set it **skips the inline emit entirely** and enqueues only, so the consumer is the sole caller of `emit_event` and an event fans out once, never twice (§BO-20 Q1). Flag unset (the default everywhere) = **dispatch-identical** to before, not byte-identical (one extra function-body import + one `os.environ` read per request). A failed `enqueue` while the flag is on is a **dropped event** — the accepted Q1 regression, logged at warning on `<source>.queue.dropped`. Never "fix" it by falling back to an inline emit.
  - **`(source, event_type)` is a user-visible vocabulary** (workflow event triggers match on it), prescribed in §BO-20 — do not invent strings in a PR, and coerce the provider's value to `str` before `xadd`. Zoho does; Gmail uses a constant; **ClickUp is the known exception** (`clickup/webhook.py:95`, a bare `payload.get("event", "unknown")` annotated `: str`) — pre-existing; fix it in the next PR that touches that receiver, not as a drive-by.
  - **Never pass `event=` to a logger** — it is structlog's own message parameter and raises `TypeError` at call time. Use `clickup_event=` / `zoho_event=`; pinned by an AST guard in `tests/unit/test_clickup_normalise_dlq.py`.
  - **`consumer.py` — the drain side** (BO-20a, §BO-20.0 Option A): `XGROUP CREATE … cc-ingest $ MKSTREAM` per stream (`$` = tail, so the buffered backlog is skipped, never replayed) + a supervised `XREADGROUP` loop that decodes each entry, hands `(source, event_type, dict)` to `event_hooks`, then `XACK`s. Started/stopped from the gateway lifespan, gated OFF behind `INGESTION_CONSUMER`, and owns its own long-lived pooled `redis.asyncio` client (the producer's per-call sync `queue._client` is BO-9's — untouched). The dispatch is bounded by `asyncio.timeout(_DISPATCH_TIMEOUT_SECS=30.0)`: **one serial loop drains all three streams**, so an unbounded await turns one hung sink into a silent bus-wide stall. It acks **regardless of outcome** on purpose — honest ack + retry + DLQ is BO-20b, and so is the reclaim pass that recovers the batch remainder stranded in the PEL when an `XACK` raises mid-batch (the loop only ever reads `">"`).
  - **`event_hooks.py` — the sink registry** (the `post_sync.py` hook pattern): the gateway subscribes its workflow event dispatcher here, so **ingestion never imports upward**. `emit_event` takes a **keyword-only** `raise_on_error: bool = False` (BO-20b slice 1). Default = swallow the sink exception, log `event_hooks.sink_failed`, run the next sink — every receiver depends on it, because a webhook must never 5xx over a workflow sink. `raise_on_error=True` propagates the **first** sink exception and skips the rest, the only way a drain loop can observe a failed dispatch and honestly withhold the `XACK`. **Never flip the default, and keep it keyword-only:** the receivers schedule `add_task(emit_event, source, event_type, payload)` with three positional args, so keyword-only is what stops a future fourth positional from switching provider-facing behaviour on by accident.
    - ⚠️ **`raise_on_error=True` is a no-op against the only sink registered in production.** `gateway/main.py:1074` registers `workflows.triggers.dispatch_event`, whose body is entirely inside a `try/except Exception` that logs `workflows.event_dispatch_failed` and returns `[]` — nothing reaches `emit_event` to re-raise. **BO-20b slice 2 owns the matching strict path in `dispatch_event`** (propagate the DB/query failure and `RunRejected`; never the fire-and-forget per-run execution failures). Until it lands, do not build anything that assumes a strict emit can fail in production.
    - **Sinks must be idempotent per `(source, event_type, payload)`.** Strict mode stops at the first failure, so a retry re-runs every sink that already succeeded and still never runs the ones after it. Free today (one sink); it breaks silently the day a second is registered.
- email_ingestion/ -- Multi-provider email sync engine (Gmail, Microsoft 365, IMAP/SMTP, aiosmtpd inbound, background scheduler)
- reconciler/ -- Nightly source-of-truth diff and escalation
- action_broker/ -- Approval-gated source-of-truth write executor: authority-tier disposition + fail-closed handler registry. **Decision core exists but ships with zero handlers and is not yet wired into the write path** — tracked as BO-1 (see `FOUNDATION_BUILDOUT_CHECKLIST.md`)

## `agents/` — agent definitions (dynamically loaded at runtime)
Identity + system prompt + tool set + integrations. Loaded via `build_agents()`
and a `local_path` entry in `agent_registry.json` / the gateway `_AGENT_REGISTRY`.
Run *inside* the orchestrator/gateway process — no server of their own.
- agent-orchestrator/ -- Wraps the built-in orchestrator Agent so it goes through the same `/agent/run/stream` path as all other agents. Eliminates the separate `/copilot/chat` code path in the frontend.
- agent-task-manager/ -- ClickUp task management
- agent-apis-config/ -- API discovery and configuration assistant
- agent-email-assistant/ -- Email AI assistant: read, search, summarize, draft replies across Gmail and Microsoft accounts
- agent-whatsapp-assistant/ -- WhatsApp inbox briefing, triage, and reply drafting (drafts only)
- agent-crm/ -- CRM assistant (`crm-assistant`): search, pipeline, record and timeline reads over the native CRM. ⚠️ **The directory is `agent-crm`, the agent is `crm-assistant`** — nothing derives one from the other; the `local_path` in `_AGENT_REGISTRY` is the whole mapping. **READ-ONLY by construction:** `_ALLOWED_METHODS = {"GET"}` is checked inside the single `_request` helper every tool goes through, and the module deliberately ships no `_post`/`_patch`/`_delete` helper, so the WS-26d write half must arrive together with the confirmation gate it owes rather than as a helper somebody can call. Every tool calls the gateway's `/crm` routes with the caller's `X-User-Email` — the agent never opens a DB session, so authorization has exactly one implementation (the route's)
- agent-app-builder/ -- App Workshop builder (Custom Apps): Copilot-SDK engine; each chat session runs in its app's workspace via the executor's `allow_session_workspace` binding; enforces the platform contract (window.cc only — see docs/app-workshop/README.md §4.0)

## `skills/` — importable tool packages
Capabilities (tools) an agent picks up. No identity, no server. Python packages
imported as tool providers. (Distinct from the repo-root `skills/` folder, which
holds SKILL.md + subprocess-script skills for the DOE-v2 registry agents.)
- skill-clickup-sync/ -- ClickUp read/write MCP skill
- skill-task-gtd/ -- GTD task tools (capture/clarify/organize/engage) over the gateway `/tasks` API

## Conventions
- Each service / agent / skill has its own pyproject.toml and is a uv workspace member (`apps/services/*`, `apps/agents/*`, `apps/skills/*` — see root `pyproject.toml`)
- Moving a dir between groups means updating its `local_path` (registry + gateway `_AGENT_REGISTRY`) — Python imports are by package name and are unaffected
- Services communicate via Redis Streams (event bus)
- Gateway is the only internet-facing service
- All agents go through the unified `/agent/run/stream` endpoint (including orchestrator)
- The `/copilot/chat` endpoint in main.py is retained for backward compatibility but the workbench frontend no longer routes to it

## Child DOX Index
- apps/services/gateway/AGENTS.md
- apps/services/orchestrator/AGENTS.md
- apps/services/email_ingestion/AGENTS.md
