# Foundation Build‑Out Checklist — CommandCenter

**Date:** 2026-07-11 · **Deploy status updated:** 2026-07-13 · **Competitive refs added:** 2026-07-13
**§BO‑20 rewritten and verified against code: 2026-08-02** (WS‑4 audit remediation). Verified this pass: the ingestion package contents (no `worker.py`), the ClickUp → `event_hooks.emit_event` → `workflows.triggers.dispatch_event` → `start_run` fan-out, the Gmail/Zoho `TODO` stubs, the repo-wide absence of `xreadgroup`/`xgroup`/`xack`, the four checked-in systemd units, the already-provisioned Redis compose service, `uv.lock`'s lack of any job-queue library, and the gateway lifespan's supervised loops (five wired, **all five** stopped on shutdown, four actually started in the default config — WhatsApp enrichment is flag-gated off). §BO‑20 now carries acceptance criteria, verification commands, gate labels, and one named owner decision (§BO‑20.0). **That decision was answered on 2026-08-02 — `BO‑20 = Option A (in‑process)`** — so nothing in §BO‑20 is blocked on a decision any more. **BO‑20f and BO‑20a are BUILT (both 2026-08-02), moving §BO‑20 ☐ → ◑; BO‑20b–e are open and dispatchable.** Two claims in the stamp above were made false by BO‑20a and are corrected in place below: `xreadgroup`/`xgroup`/`xack` now exist (in `ingestion/consumer.py` only), and the lifespan's supervised loops are **six** wired / **all six** stopped on shutdown (how many actually *start* is data‑dependent — see §BO‑20 "What is true today" §7, which counts it honestly; the new ingestion consumer joins WhatsApp enrichment as flag‑gated **off**, so it starts nowhere today). `INGESTION_CONSUMER` is registered in `work_plan.md` §6. **Other sections carry no such stamp** — BO‑1/BO‑19 were stamped by the 2026-08-01 doc-truth pass; the rest are as-authored.
**Companion to:** `FOUNDATION_AUDIT_REPORT.md` · handoff details in `FOUNDATION_CONTINUATION.md` (see its "LATEST STATUS" block) · competitive learnings (proven reference implementations from Hermes Agent & OpenClaw) in `ai-company-brain/specs/competitive_hardening_2026-07.md` (`CH-*`) and `COMPETITIVE_COMPARISON.md`.

> **🚀 Deploy status:** read live deploy state from `gh run list` and `git log origin/main` — not from this doc. Next recommended P0: **BO‑8** (secret rotation + history purge — owner‑gated); BO‑1's approval loop has since shipped (see §BO‑1).
> **Update 2026-08-01 (doc-truth pass):** the previous pinned‑commit claim here (`origin/main = ccccdc8`, unpushed `1684e1a`) was a 2026‑07‑13 snapshot and went stale; this doc no longer tracks deploy state.

This is the list of foundational capabilities that are **missing, partially implemented, or not yet wired up**. It excludes application features. Each item states what is missing, why it matters, what it depends on, a suggested approach, and a recommended priority. Items already addressed in the review pass are marked **✅ done (Fx)** and are retained here for completeness with any residual follow‑up.

**Priority legend:** **P0** = do before any new feature work · **P1** = next hardening sprint · **P2** = scheduled tech‑debt · **P3** = opportunistic.

**Status legend:** ☐ not started · ◑ partial · ✅ done this pass.

---

## A. Security & trust boundaries

### BO‑1 — Action Broker: real approval‑gated write path *(P0)* ◑
- **Done this pass (the decision + execution core, non‑breaking):** the 46‑line stub is now a real component: `decide_disposition(authority, destructive)` — the pure authority‑tier policy (READ→rejected, AUTONOMOUS→auto, SUGGEST→needs‑approval, SUGGEST_APPLY→auto for reversible / needs‑approval for destructive, i.e. FAIL CLOSED); `propose()` computes + audits the disposition (defaults `destructive=True`); and a **fail‑closed executor registry** (`register_action_handler` / `execute`) where a real source‑of‑truth write happens ONLY inside a registered handler and an action with no handler is REFUSED. Ships with **zero** handlers so it cannot write anything yet — inert + non‑breaking. 8 unit tests.
- **Persistence layer added (commit `e59cc6a`, additive, unpushed):** migration `66_pending_actions.sql` + `enqueue` / `list_pending` / `approve` / `reject` / `submit` in `broker.py` (17 unit tests, DB‑hermetic). No live path rerouted, so still inert.
- **Update 2026-08-01 (doc-truth pass):** the wiring the paragraph below described as missing **shipped 2026‑07‑13** (see `FOUNDATION_CONTINUATION.md`): `apps/services/action_broker/action_broker/broker.py` is a ~373‑line real component; the Control Plane approval inbox is bound via gateway `routes/actions.py`; real handlers are registered for ClickUp tasks (`routes/tasks/broker_handlers.py`), WhatsApp outbound (`routes/whatsapp/automation/outbound.py`), and workflows (`routes/workflows/broker_handlers.py`); the previously bypassing task writes route through the broker gate (`routes/tasks/providers.py`). **Remaining:** email/Zoho handlers + integration‑verify against a live Postgres. **OWNER‑GATE:** flipping `ACTION_BROKER_ENFORCE` (default OFF — every write auto‑applies, audited, zero behaviour change).
- **Missing (historical — resolved except as noted in the update above):** bind the Control Plane approval inbox to `approve`/`reject` (gateway `/actions` routes); register real handlers for ClickUp/email/Zoho; and route the existing bypassing writes (`routes/tasks/providers.py:365`, `email_ingestion/providers/*`) through `submit`. Plus **integration‑verify** the new SQL against a live Postgres. Until the wiring lands, either mark the write‑capable agents non‑autonomous or formally waive non‑negotiable #4.
- **Why needed:** It is non‑negotiable #4 ("no autonomous writes to source systems until the Action Broker is live") and the single control point for HITL over all outward writes. Today the guarantee is false.
- **Dependencies:** `03_pending_commits.sql`‑style queue table (add `pending_actions`); `acb_audit`; the Control Plane approval inbox; the auth fix (BO‑2) so approvals are authenticated.
- **Approach:** (1) Add a `pending_actions` table (proposal, actor, authority, payload, status, approved_by). (2) Make `propose()` enqueue and, per authority tier, either auto‑apply (read/idempotent), queue for approval, or reject. (3) Add an `execute(proposal)` that performs the provider write and is the *only* code path allowed to do so. (4) Route the existing ClickUp/email writes through it. (5) Reconcile docs with whichever model ships.
- **Note:** Until this lands, either mark the write‑capable agents (`agent_registry.json` sales/delivery/triage/billing) as **not** autonomous‑write, or accept and document that #4 is waived.
- **Competitive ref (CH‑2):** Hermes Agent routes every risky action through a **single fail‑closed approval gate** — the pattern to copy is "one choke point that a write physically cannot bypass," which is exactly what `execute()`‑only‑writes enforces. See `specs/competitive_hardening_2026-07.md`.

### BO‑2 — Enforceable authentication + authorization *(P0)* ✅
- **Authorization (2026‑07‑29):** org access control shipped — DB‑backed roles + per‑user allow/deny overrides (`acb_auth.permissions`/`access`), `require_permission` on every feature router, per‑agent run gating, and per‑member integration credentials. Spec: `ai-company-brain/specs/org_access_control.md`. The remaining BO‑2 work is the *authentication* posture (residual 1), not the permission model.
- **Missing (historical — resolved):** `get_current_user` never rejects (`acb_auth/deps.py:76`); it only labels. So mutation‑approve (`agent.py:1852`, `git push`), the memory API (`memory.py`, IDOR), and `/agent/webhook/{source}` (`agent.py:3428`; the long‑standing `:2522` here
was stale — corrected 2026-08-02 to match §BO‑20) were anonymous‑reachable. `/v1` had no auth at all. **Update 2026-08-01 (doc-truth pass):** this paragraph is resolved history — every systemic item in the Residual list below is ✅; the honest remaining residual is that in‑process agents can read the identity token until BO‑7.
- **Done this pass:** **✅ F1** authenticates `/v1`; **✅ F7** adds `acb_auth.require_internal_auth` and gates the state‑changing mutation routes + the whole `/memory` router (401 anonymous). This closes C1/C2/C6 for the specific dangerous endpoints.
- **Why needed:** Prevents anonymous code‑push, cross‑tenant memory read/delete, and unauthenticated agent triggering.
- **Dependencies:** Confirm each protected endpoint's caller sends the internal token or a real user session (the Next.js server routes and `memory.ts` already send `Bearer LITELLM_MASTER_KEY` — verified).
- **Residual (the systemic fix):** (1) Add `acb_auth.require_authenticated` and make it the DEFAULT posture rather than opt‑in per route — **✅ done**: attached once at `FastAPI(dependencies=[...])`, so every route is covered by construction and a new one needs no opt‑in. `gateway.main.PUBLIC_ROUTES` is the complete anonymous‑reachable list (health, provider webhooks, OAuth callbacks, bridge/bot callbacks — each self‑authenticating). Closed two live holes: `/agent/workspace/{id}/history` (anonymous read of an agent's file history) and `/promote` (anonymous write). Swagger/ReDoc cannot carry the guard structurally, so they are dev‑only now. A coverage test fails if any route ever bypasses the guard. (2) Cover the remaining `agent.py` routes and `oauth.py` — **✅ done**: agent registry writes now need `agents:manage`, all three run endpoints call `assert_can_run_agent`, and `oauth.py` authorize/refresh need `feature:integrations` (the callback stays open by design — HMAC‑signed `state`). (3) Sign/verify `/agent/webhook/{source}` — **✅ done**: HMAC‑SHA256 over the raw body in `X-CC-Signature`, per‑source secrets override a global one, and it FAILS CLOSED (503) when unconfigured. (4) Split the service‑identity token from `LITELLM_MASTER_KEY` — **✅ done**: `GATEWAY_INTERNAL_TOKEN` is identity‑only and `LITELLM_MASTER_KEY` is the `/v1` key checked by the new `require_llm_api_auth`; every `/v1` client reads `settings.llm_api_key`, with a test asserting none resolves the identity token. Residual: in‑process agents can still read it from `get_settings()` until **BO‑7**. See `ai-company-brain/specs/org_access_control.md` §8b.

### BO‑3 — Self‑mutation governance: human gate + real test gate + attempt counter *(P0)* ◑
- **Done this pass:** **✅ F8** — auto‑push is now opt‑in (`MUTATION_AUTO_PUSH`, default off) so a green commit stages in the approval inbox by default; `_tests_passed("")`/"no tests" now returns False (closes H3). **✅ H4** — `max_mutation_attempts` is now a REAL enforced counter: `mutation._register_mutation_attempt(run_id)` keeps a per‑run tally and refuses a second attempt for the same run (previously both call sites passed 0, so the `0 >= 1` guard was dead). 5 unit tests added (helper + the real entry point's early‑skip path).
- **Residual:** (1) Optionally define sandbox "success" as "a test command ran and exited 0 with ≥1 test" at the runner level (`mutation_runner.py:151`). (2) Wire mutation into the streaming path (H5) or explicitly scope it to structural failures and document that. (3) If cross‑restart durability is wanted, back the counter with Redis/Postgres instead of the in‑process dict (current scope — a restart is a fresh slate — is intentional and adequate given the human‑merge gate).
- **Dependencies:** `pending_commit` table (exists); Control Plane approval inbox; BO‑2 (authenticated approvals — the approve endpoint is now gated by F7).

### BO‑7 — Sandbox for dynamic agent execution (HH‑6) *(P1)* ☐
- **Missing:** cloned agent code runs in‑process (`loader.py:1247`) and installs deps into the shared gateway venv (`:1095`). No isolation.
- **Why needed:** Any compromised/malicious `agent-*` or `skill-*` repo (cross‑org clones allowed, `loader.py:1504`) gets arbitrary in‑process execution with access to all injected secrets and the DB. The mutation path is containerised; execution is not.
- **Dependencies:** the mutation sandbox image (`acb-mutation-runner`) as a reusable execution substrate; an IPC/result protocol; integration‑secret scoping so only the running agent's creds are exposed.
- **Approach:** Run each agent in the mutation‑style container (or a `nsjail`/subprocess with a per‑run venv and a dropped‑privilege user), stream results back over the existing event protocol. Interim mitigation: pin allowed orgs to `github_org`, and install deps into a per‑agent venv rather than the shared one.
- **Competitive ref (CH‑1):** Hermes Agent's container sandbox runs with `--cap-drop ALL` + `no-new-privileges` + pids/mem/disk limits — a concrete flag set to adopt for the `acb-mutation-runner`‑as‑execution‑substrate work. OpenClaw's CVE‑2026‑25253 (42K+ exposed host‑level panels) is the cautionary case for *not* doing this. See `specs/competitive_hardening_2026-07.md`.

### BO‑8 — Secret hygiene: rotate, purge history, fail closed *(P0)* ◑
- **Missing:** committed live Zoho token + 1.7 MB DB dump (**✅ F2** removes from tree + gitignore); but they remain in **git history**, and the token is (was) live. Weak in‑code secret defaults fail open (M4).
- **Why needed:** Files deleted from HEAD are still recoverable from history; a committed DB dump is a data‑breach vector.
- **Dependencies:** repo‑admin coordination (history rewrite forces a re‑clone for all clients); secret‑rotation access.
- **Approach:** (1) **Revoke/rotate** the Zoho token and any credential in `acb_dump.bak`. (2) `git filter-repo --path .zoho_token_cache.json --path acb_dump.bak --invert-paths` and force‑push (coordinate). (3) Make signing/DB/master keys raise on empty in non‑dev (`settings.py`). (4) Add a `gitleaks`/`detect-secrets` pre‑commit + CI hook.
- **Residual after F2:** history purge + rotation + fail‑closed defaults.

---

## B. Observability & operability

### BO‑5 — Real distributed tracing + honest cost tracking *(P1)* ◑
- **Done this pass:** **✅ F4** (unpriced models report *unknown*, not `$0`); tier label is now populated on agent‑traffic usage events (was blank, so per‑tier cost was empty); `/v1/embeddings` zero‑vector fallback now warns loudly (M13) instead of silently disabling semantic search.
- **Missing:** OTel is disabled and exports nowhere (H9); the OTLP exporter isn't installed; no collector in infra.
- **Why needed:** Production requires trace‑level debugging of multi‑agent runs and trustworthy spend numbers; today neither exists end‑to‑end.
- **Dependencies:** `opentelemetry-exporter-otlp` dep; an `otel-collector` (or Langfuse, already half‑present) service in `docker-compose.yml`; a real price map for the tier models.
- **Approach:** (1) Add the exporter dep + a collector service (Langfuse or Tempo/Jaeger). (2) Re‑enable MAF instrumentation once a backend exists and fix the ContextVar‑reset bug the kill‑switch was hiding (`executor.py:311`). (3) Set `OTEL_EXPORTER_OTLP_ENDPOINT` in deploy env. (4) Seed real per‑model prices for the tier models (or wire a pricing source) so cost is populated, and stamp the tier label on agent‑path usage (`_emit_usage(model, "", …)` → real tier, `v1_compat.py:245`).
- **Competitive ref (CH‑8):** Hermes surfaces **per‑turn cost** + `/usage`/`/insights` as a first‑class user‑visible feature; both competitors lean on third‑party OTel (SigNoz/Langfuse). Either finish the collector or formalize the bespoke Redis feed — do not keep advertising a disabled OTel. See `specs/competitive_hardening_2026-07.md`.

### BO‑9 — Resource lifecycle in the gateway shell *(P2)* ☐
- **Missing:** fire‑and‑forget `ensure_future` warmups are untracked and never cancelled on shutdown (`main.py:104,167,216`); no DB `engine.dispose()` / Neo4j `close()` on shutdown; Redis opened per‑call in ingestion (`queue.py:48`).
- **Why needed:** Clean shutdown, no leaked pools/tasks, testability.
- **Dependencies:** none.
- **Approach:** Hold task references and cancel them after `yield`; create/dispose the DB engine and a shared Redis pool in `lifespan`; inject them via `Depends`.

---

## C. Data layer

### BO‑6 — Migration framework + auto‑apply *(P1)* ◑
- **Done this pass:** **✅ F5** resolves the duplicate #50; **✅ M7** writes `agent_run.started_at` at true run start.
- **Missing:** 60+ raw numbered SQL files, no ledger/down‑migrations, not auto‑applied on `docker compose up` (H12).
- **Why needed:** At 60+ files with hand‑idempotency and no ledger, a migration incident is a matter of time; a fresh stack silently lacks most tables.
- **Dependencies:** Alembic; a one‑time baseline of the current schema (`schema.generated.sql` exists as a start).
- **Approach:** Adopt Alembic (autogenerate baselined against `schema.generated.sql`), run it in `lifespan`/entrypoint, keep the raw files as historical. Add a CI check for unique numeric prefixes until then.

### BO‑10 — Consolidate DB access to one engine/pool *(P2)* ◑
- **Done (Session 2, 2026‑07‑13):** **every** engine now bounds the CONNECT phase so a slow/unreachable DB can't hang callers — `settings.db_connect_timeout` (default 10s) on `acb_graph.get_engine()` (`ccccdc8`, live in prod), the two gateway asyncpg engines (`1684e1a`), and the four `email_ingestion` async engines (`1ff6c0d`, local, unpushed) via `connect_args={"timeout": …}`. This makes `acb_audit.record()`'s "never block the caller" guarantee real against a hung connect. Test: `tests/unit/test_db_connect_timeout.py`.
- **Missing:** still three+ engines (`acb_graph/db.py`, `routes/tasks/core.py`, `routes/email/core.py`, plus per‑call engines in `email_ingestion/{scheduler,inbound}.py` that also leak — BO‑9), the foundational one otherwise unconfigured; sync `acb_audit.record()` still blocks the async loop (H11) — connect_timeout bounds the hang but the call is still synchronous.
- **Approach:** Provide a single configured async engine in `acb_graph` (sized pool), funnel all callers through it, and make `acb_audit.record()` async (or always call via `to_thread`).

### BO‑11 — Decide `acb_schemas`: wire in or delete *(P2)* ✅
- **Done:** deleted the package (0 production importers, drifted from the ORM — H10). Removed its 7 `pyproject` dependency declarations + `tool.uv.sources` entry, the smoke‑test import, and the stale "wire/API surface" comment in `acb_graph/models.py`; re‑locked. Bonus: this exposed a latent under‑declared dependency — `orchestrator/triage/schema.py` uses pydantic `EmailStr` (needs `email‑validator`) but only got it transitively via `acb_schemas`; now declared explicitly as `pydantic[email]` on the orchestrator.

### BO‑21 — Activate memory by default + local‑embeddings fallback *(P2)* ☐ *(new — competitive‑informed, CH‑6)*
- **Missing:** all three memory layers are real code but **default‑OFF and inert out of the box** — `mem0_enabled=False`, `graphiti_enabled=False` (both in `packages/acb_common/acb_common/settings.py`; line numbers drift — search the setting names). Worse, `/v1/embeddings` returns a **zero‑vector** when `OPENAI_API_KEY` is unset (BO‑5 made this warn loudly, M13), so even if mem0 were enabled without an embeddings provider it would store facts with **no usable semantic search**.
- **Why needed:** Persistent cross‑session memory is a headline capability we advertise but ship disabled; a platform whose memory does nothing until an operator finds two hidden flags + an embeddings key is effectively memory‑less in practice.
- **Dependencies:** a local‑embeddings path (e.g. a small sentence‑transformer / `fastembed` served via the gateway, or an Ollama embeddings model) so semantic search works without a cloud key; `acb_memory` clients (exist).
- **Approach:** (1) Provide a **local‑embeddings fallback** wired into `/v1/embeddings` so the zero‑vector landmine is gone. (2) Flip mem0 on by default once (1) lands (graphiti stays opt‑in — it needs Neo4j). (3) Add a **human‑readable memory layer** (a curated `MEMORY.md`‑style artefact per subject) so stored memory is auditable, not just an opaque vector table.
- **Competitive ref (CH‑6):** **Hermes** memory works day one — SQLite + FTS5 full‑text over past sessions + a human‑readable `MEMORY.md` the agent curates + Honcho user‑modeling — one memory across all channels. The lesson: a *simple always‑on auditable* memory beats a *sophisticated disabled* one. See `specs/competitive_hardening_2026-07.md`.


### BO‑22 — Platform semantic‑search service *(P2)* ☐ *(new — requested 2026‑07‑30, Workflows app)*
- **Missing:** every surface that needs "find by meaning" either rolls its own or goes without. Memory has mem0's private embedding path (BO‑21); the Workflows capability catalog ships **keyword‑only search by explicit decision** (`gateway/routes/workflows/search.py` — an embedding‑backed variant was built and then deliberately removed in favour of this item); email/notes/tasks search is lexical. There is no shared embed‑and‑retrieve seam.
- **Why needed:** Semantic search is a platform capability, not a per‑app feature — N apps each bolting on their own embeddings means N index tables, N sync loops, N provider‑key fallbacks, and rankings that disagree. One service (index + query API in a shared package, pgvector‑backed, content‑hash keyed sync) lets the workflow palette/copilot, email, notes, tasks, and App Workshop all rank by meaning consistently — and BO‑21's local‑embeddings fallback makes it work without a cloud key.
- **Dependencies:** BO‑21 (a real `/v1/embeddings` path with local fallback — kills the zero‑vector landmine first); pgvector (present); a home in `packages/` (e.g. `acb_search`) per Place‑Before‑Building.
- **Approach:** (1) Land BO‑21's embeddings path. (2) `acb_search`: `index(namespace, key, text, metadata)` + `query(namespace, text, k, filter)` over one pgvector table, hash‑keyed lazy re‑embed, hybrid keyword+cosine ranking with an honest keyword‑only degrade. (3) First consumer: the Workflows catalog search swaps its ranking backend behind the same API shape (`search.py` is written for exactly this swap). (4) Migrate email/notes/tasks search opportunistically.
- **Note:** until this lands, new apps needing search should copy the Workflows stance — deterministic keyword ranking, no private embedding stacks.


---

## D. Orchestration & runtime

### BO‑12 — Reconcile the runtime story (MAF vs Copilot) *(P1)* ✅
- **Done (path a):** `AGENTS.md` reconciled to reality — runtime line, Purpose, and non‑negotiables **#6/#9** now describe MAF as the PRIMARY native runtime and the Copilot SDK as the supported second runtime for interactive coworker chat (Tier 1.5, `/copilot/chat`, BYOK‑routed) + the mutation sandbox, rather than "MAF sole / Copilot sandbox‑only" (closed H6). The unused **`WorkflowBuilder`** import + its "used for pipelines" docstring claim were removed from `orchestrator/agents.py` (closed M2 — it was imported, never instantiated). `as_tool()` is genuinely used, so that claim stays.
- **Competitive ref (CH‑5):** Hermes's multi‑agent layer (orchestrator + isolated sub‑agents exchanging **typed result objects**, resource‑aware concurrency limits, Kanban dispatch) is more built‑out than ours on coordination mechanics — the reference when we finally instantiate the Workflow engine and replace bare‑string sub‑agent handoffs (ties to HH‑7). See `specs/competitive_hardening_2026-07.md`.

### BO‑13 — Break up the executor monolith *(P2)* ◑
- **Done this pass (behaviour‑preserving extractions, each verified green):** the 5,094‑line file is down to **4,069 lines** via four cohesive‑concern extractions, each re‑exported from `executor` so no importer changed:
  - `orchestrator/_todo_tracker.py` — todo‑SQL parsing.
  - `orchestrator/_copilot_session.py` — Copilot permission handler + infinite‑session policy.
  - `orchestrator/_tool_injection.py` — platform tool injection + system‑prompt addendum (~630 lines, the biggest cohesive concern).
  - `orchestrator/_model_resolution.py` — BYOK model resolution.
- **Regression net (`tests/unit/test_run_agent_stream_e2e.py`):** drives `run_agent_stream` end‑to‑end with mocked agents/loader (no git clone, no LLM, no Redis) and now covers BOTH tiers:
  - **Tier‑2 batch:** envelope contract (`RUN_STARTED` first → text streamed → `RUN_FINISHED` terminal), run_id/thread_id propagation, agent‑exception → `RUN_ERROR` (not a crash).
  - **Tier‑1 native streaming:** a mock agent that yields MAF‑shaped `run(..., stream=True)` updates → asserts the `TEXT_MESSAGE_START/CONTENT/END` lifecycle and `TOOL_CALL_START/ARGS/RESULT` events (via the real event_translator).
  - **HITL parking (new this pass):** `resolve_user_input` (found / not‑found) and the full `_make_user_input_handler` round‑trip — emits the `user_input_requested` frame to the relay, parks a Future, and returns the answer once `resolve_user_input` fires. Locks the ask_user → prompt → resolve contract.
- **Residual:** the Tier‑1.5 Copilot‑SDK tier and the idle‑timeout / fall‑through control‑flow branches are still not covered (the Copilot/full‑stream branches can't be exercised on the Windows dev box — they hit the same multi‑point infra hang that deselects this file locally — so they need a Linux/CI‑run harness to add safely); and `run_agent_stream` is still one ~1,600‑line function.
- **Approach for the residual:** (1) extend the harness to the Copilot tier + HITL/idle branches. (2) THEN extract the native / Copilot / batch tiers behind a `Runtime` strategy interface — the `return`‑to‑end vs fall‑through‑to‑batch control flow is the delicate part, so it needs those branches covered first — and move HITL/session‑store/cleanup into collaborators, guarded by this net + the trajectory evals. (3) Ratchet the xenon absolute ceiling down from F.

### BO‑14 — Enforce the permission/risk model *(P1)* ◑
- **Done this pass:** **workspace‑path containment** shipped — `write_artifact`/`save_note`/`recall_notes` routed every caller path through a single `write_artifact.resolve_in_workspace` guard that fails closed on an embedded `..` or an absolute path resolving outside the workspace (previously `write_artifact` could write, and `recall_notes` could READ, arbitrary files). Also fixed a latent bug: `recall_notes` now applies the same `agent-data/` prefixing as `save_note`, so the documented `recall_notes("NOTES.md")` round‑trip actually works. 7 unit tests added.
- **Missing (the enforcement redesign):** the injected‑tool gate still can never deny (M5) and the destructive platform registry is empty. This is deliberately deferred — `decide()` currently *defers* destructive tools (approves, relying on each tool's own `request_confirmation`), so forcing denials risks false‑blocking legitimate tool use across every agent; it needs a product decision on which tools hard‑block + the confirmation UX.
- **Approach for the residual:** annotate the genuinely destructive platform tools (`install_dependency`, outward‑write tools) as `destructive`, pass full call context (not just the name) to `decide`, and make `enforce` mode block destructive/out‑of‑policy calls with a real confirmation card.
- **Competitive ref (CH‑1):** Hermes ships an always‑on **hardline blocklist** (`rm -rf /`, fork bombs, `mkfs`, disk‑zeroing `dd`) that no mode can override, plus **fail‑closed timeout→deny** on the approval prompt — both worth adopting as the floor. NVIDIA **NemoClaw**'s key idea for OpenClaw is **out‑of‑process policy enforcement**: evaluate the gate *outside* the agent's own tool surface so a prompt‑injected agent can't route around it. See `specs/competitive_hardening_2026-07.md`.

### BO‑20 — Event‑bus consumer + durable job queue *(P1)* ◑ *(competitive‑informed, CH‑3)*

> **Verified against code on 2026-08-02.** This section was rewritten after the
> WS‑4 dispatch audit returned **NO‑GO**: the previous body had no acceptance
> criteria, no verification commands, no gate labels, pre‑restructure paths, and
> — decisively — rested on a premise that **stopped being true** when commit
> `e20ea830` (Workflows Slice 2) shipped the event‑sink registry. An implementer
> handed the old row would have built a second, parallel dispatch path for work
> that already has one.
>
> **✅ The owner decision (§BO‑20.0) was taken on 2026-08-02: Option A** — an
> in‑process supervised asyncio consumer started from the gateway lifespan.
> Nothing below is blocked on a decision any more. BO‑20f needed no consumer,
> no flag and no decision and shipped first; **BO‑20a is BUILT** (2026-08-02,
> pending review) with the consumer shipped **OFF** behind `INGESTION_CONSUMER`.
> **BO‑20b–e remain open and are now dispatchable as written.** The item is
> ◑ as of **2026-08-02**: two of six sub‑items built, the flag unflipped in
> every environment. The *reason* the row existed has changed twice now, so
> read "What is true today" before anything else.
> (`work_plan.md`'s WS‑4 State cell mirrors this split.)
>
> **Hardened 2026-08-02 after adversarial review** (that pass shipped no code;
> BO‑20f's code landed later the same day): BO‑20f no
> longer claims to unblock WS‑11 Slice 4 (it unblocks multi‑channel event
> triggers; Slice 4 needs BO‑20a–e + BO‑7); Option B's undefined dispatch step is
> stated; BO‑20b/d/e now prescribe their constants as literals so a "retry with
> backoff" ticket cannot close green with `MAX_ATTEMPTS = 1`.

#### What is true today (each claim re‑verified against the tree 2026-08-02)

1. **Webhook → run is ALREADY wired for ClickUp, and it does not go through
   Redis.** `apps/services/ingestion/ingestion/sources/clickup/webhook.py::receive`
   verifies the HMAC (`:91`), best‑effort `enqueue`s to `ingestion:clickup`
   (`:102`, warn‑and‑continue if Redis is down, `:103‑106`), schedules inline
   normalisation for task events (`:110`), and schedules
   `emit_event("clickup", event_type, payload)` (`:114‑116`). The gateway
   registers `workflows.triggers.dispatch_event` into that sink registry at
   import time (`apps/services/gateway/gateway/main.py:1070‑1076`; the
   `register_event_sink` call is `:1074`), and
   `dispatch_event` (`apps/services/gateway/gateway/routes/workflows/triggers.py:40`)
   calls `start_run(...)` for every **published** workflow whose `kind='event'`
   trigger matches `(source, event_type)`.
   **The old body's "trigger no agent" was true when written and is false now.**
   It is struck, not softened.
2. **There is a second live webhook→run path.** The signed generic webhook
   `POST /agent/webhook/{source}` (`gateway/routes/agent.py:3428`) routes to a
   MAF agent *and* calls `dispatch_event` (`:3476‑3478`) — the two fan out
   independently from the same event. **BO‑20 must not add a third dispatch
   path**; it changes how events *reach* `dispatch_event`, nothing downstream.
3. ~~**Gmail and Zoho are stubs.**~~ **Closed 2026-08-02 by BO‑20f.** It was
   true as written: both receivers carried a `TODO`, only audit‑logged, and
   neither enqueued nor emitted — so "multi‑channel triggers" was blocked on
   these two receivers at least as much as on any consumer, while
   `TriggerPanel.tsx:266‑269` had been offering `gmail` and `zoho` in the
   event‑trigger source dropdown all along (a dead switch in the UI). Both now
   `enqueue` to `ingestion:{gmail,zoho}` and schedule
   `emit_event(source, event_type, payload)` on `BackgroundTasks`, in ClickUp's
   shape. **All three receivers now emit inline**, which is what makes BO‑20a's
   Q1 cutover a three‑receiver change (see BO‑20a). ⚠️ **Closed in code, not in
   any environment:** `zoho_webhook_secret` and `gmail_pubsub_token` are both
   `""` everywhere today, so both receivers 401 every push and the switch stays
   dark until an owner provisions the secrets **and** points the provider at the
   route — see the OWNER‑GATE on the BO‑20f ticket. Bonus findings recorded so
   they are not re‑discovered: the Zoho receiver had been returning **500 on
   every authenticated push** (structlog `event=` kwarg collision) until BO‑20f's
   first `TestClient` drive‑through exposed it, and the same collision in
   `clickup/webhook.py::_normalise_task` had been **dead‑lettering every
   successfully‑normalised task**.
4. ~~**The `ingestion:*` streams are write‑only.**~~ **Half‑closed 2026-08-02 by
   BO‑20a.** It was true as written: `xadd` was the only stream verb in the
   ingestion package and `xreadgroup` / `xgroup` / `xack` appeared **nowhere in
   the repo** (the only `xread` callers being unrelated transports —
   `gateway/room_stream.py:133,161`, `orchestrator/stream_relay.py:221,285,306`,
   `acb_common/activity.py:257`). `ingestion/consumer.py` now issues all three.
   ⚠️ **Still true in every environment:** the loop is gated OFF
   (`INGESTION_CONSUMER` unset everywhere), so the streams are *today* still
   capped at `maxlen=10_000, approximate=True` (`queue.py:46,72‑73`) and
   **trimmed unread**. The `$` group start means the flip does not change that
   for the already‑buffered entries either — see BO‑20a.
5. **`ingestion:dlq` is worse: written and never drained.** `enqueue_dlq`
   (`queue.py:79`) is called from exactly two sites (`clickup/webhook.py:48`
   fetch failure, `:69` normalise failure). Nothing reads, displays, replays or
   alerts on it, so a ClickUp normalisation failure today is **silently
   invisible** and is eventually trimmed away.
6. **No job framework exists to reuse.** `uv.lock` contains no
   celery / arq / rq / dramatiq / taskiq — only `apscheduler` and `redis`.
   APScheduler is used **two** ways, and the second one matters here: as a cron
   *parser* inside the gateway's supervised loops
   (`gateway/routes/workflows/scheduler.py:7,59‑61` —
   `CronTrigger.from_crontab`, docstring "parser only — no scheduler process"),
   **plus one checked‑in but undeployed process**,
   `apps/services/ingestion/ingestion/scheduler.py`: `build_scheduler()`
   (`:101`) returns an `AsyncIOScheduler`, and `_serve()` (`:109‑130`) calls
   `sched.start()` then `await asyncio.Event().wait()`, run as
   `uv run python -m ingestion.scheduler` (docstring `:3‑7`: *"Run as a
   foreground process; long‑lived. In production deploy as a systemd service"*).
   **No systemd unit runs it** (see §8) — so the `python -m ingestion.X` shape
   Option B needs already exists in this exact package, *and* that package is
   already carrying one process that merged and does nothing. Both facts are
   load‑bearing in §BO‑20.0. (`workflows_app.md:226` D6's "no APScheduler
   *process*" is the **gateway** rule; it is not a repo‑wide fact, and D6's own
   "already in the dependency tree via ingestion" is why.)
7. **In‑process supervised asyncio loops are the established shape.** Five are
   wired into the gateway lifespan — email sync (`main.py:230`), WhatsApp
   enrichment (`:253`), tasks provider‑sync (`:265`), calendar auto‑rollover
   (`:275`), workflow schedule scanner (`:294`) — and **all five** are explicitly
   stopped on shutdown (`:324`, `:333`, `:340`, `:347`, `:354`; the cited lines
   are the `await stop_*()` calls, as the start lines are the `await start_*()`
   calls). **BO‑20a made it six** — the ingestion consumer starts at `:307` and
   stops at `:364`, which is why the shutdown line numbers here moved (they were
   `:311`–`:341` before that PR; the start lines did not move). How many actually
   *run* is data‑dependent, and **on an empty DB it is two**: only the calendar auto‑rollover (`routes/tasks/calendar.py:1543` — a
   single loop) and the workflow scanner start unconditionally, while email sync
   and tasks provider‑sync launch **one loop per enabled account row**
   (`routes/tasks/scheduler.py:181‑210`,
   `email_ingestion/scheduler.py:546,593`) and create nothing when there are no
   rows. WhatsApp enrichment is cost‑gated **off** unless `WHATSAPP_ENRICHMENT` is set
   (`routes/whatsapp/scheduler.py::enrichment_enabled` `:36`,
   `start_whatsapp_enrichment` returns `False` and creates no task) — an
   owner‑gated flip per `work_plan.md` §6. Its stop call still runs
   unconditionally, which is the shape a flag‑gated loop should copy.
8. **Redis needs no provisioning; a new *process* does.** `redis:7-alpine` is
   already a compose service (`infra/docker-compose.yml:44`) with the
   `acb-redis-data` volume (`:230`) and a healthcheck (`:61`).
   `deploy/hostinger/` carries exactly four checked‑in units
   (`acb-gateway`, `acb-workbench`, `acb-whatsapp-bridge`, `acb-health-watchdog`);
   `bootstrap.sh:123‑142` additionally generates `acb.service` for the Docker
   infra. **None of them is a worker.**
9. **The code already points here.** `gateway/main.py:280‑283` ("Workflow runs
   are in-process asyncio tasks (BO-20 pending)") and
   `gateway/routes/workflows/service.py:14` both cite this item by name.
10. ~~**Latent packaging defect this item must fix.**~~ **Closed 2026-08-02 by
    BO‑20a**, which added `"ingestion"` to
    `apps/services/gateway/pyproject.toml` `dependencies` and regenerated
    `uv.lock` (it now appears in the `name = "gateway"` package block and in its
    `requires-dist`). It was true as written: the gateway declared
    `email-ingestion` and `whatsapp-ingestion` but **not `ingestion`** — which
    is why the sink registration sits in a `try/except` (the `try` at
    `main.py:1070`, the `register_event_sink` call at `:1074`; comment
    "ingestion optional in some deploys"). It resolved only because the root
    umbrella `pyproject.toml` lists `ingestion` and every environment
    `uv sync`s the whole workspace. The `try/except` itself is left in place —
    it is now belt‑and‑braces rather than the load‑bearing conditionality it
    was.

**Why the item still matters:** retry/backoff (BO‑20b), a drainable dead‑letter
path (BO‑20c), per‑source rate limiting (BO‑20d), and bounded concurrency
(BO‑20e). Two of the six reasons are **closed**: **coverage** — "only one of
three receivers emits anything at all" — by BO‑20f, and **durability/replay** —
"the buffer is written and never read" — by BO‑20a, *in code*. The second one is
closed conditionally and the condition is unmet: with `INGESTION_CONSUMER` unset
in every environment the streams are still trimmed unread today.

#### Scope and non‑goals

**In scope:** BO‑20a–f below, and nothing else.

**Non‑goals (each of these belongs to a named owner — do not build it here):**
- **Not a general background‑job framework.** No new queue dependency; Redis
  Streams consumer groups + the existing `redis` pin only.
- **Not the Action Broker.** `apps/services/action_broker/action_broker/broker.py`
  is already the repo's durable queue — `pending_actions` with `enqueue` (`:187`),
  `list_pending` (`:238`), `approve` (`:332`), `reject` (`:320`), `submit`
  (`:353`). It queues outward **writes awaiting a human**; BO‑20 queues inbound
  **events awaiting a worker**. Two different queues on purpose. Do not merge
  them, do not re‑implement either inside the other.
- **Not workflow‑run durability.** Resuming a workflow run interrupted by a
  restart is `specs/workflows_app.md` **Slice 4** — verbatim at
  `workflows_app.md:217`: *"Slice 4 (post‑BO‑20/**BO‑7**): durable queued runs;
  sandboxed module execution; MCP exposure; retention policies"* — as
  `routes/workflows/service.py:14` already states. BO‑20 delivers the
  intake substrate; Slice 4 consumes it. It consumes **BO‑20a–e** specifically
  (durable queued runs = consumer + retry + DLQ), so BO‑20f alone does not
  release it — see the Tickets sequence below.
- **Not a new inbound channel.** Slack/Telegram ingress is WBS 3.3 / CH‑4.
- **Not a change to `dispatch_event`.** The trigger matcher, `start_run`, and the
  agent‑routing half of `/agent/webhook/{source}` are untouched.
- **Not BO‑9.** See the dependency resolution below.

#### BO‑20.0 — OWNER DECISION: the process model — ✅ **ANSWERED 2026-08-02**

> ## `BO‑20 = Option A (in‑process)`
>
> **Decided by the owner on 2026-08-02.** BO‑20a–e are dispatchable as written
> from that date; BO‑20a was built the same day. Option B is **rejected** — its
> analysis is kept below, in full, because a future reader deciding whether to
> move the consumer into its own process needs to know what was weighed and why
> it was refused, not merely that it was.

*Both options are stated with their consequences; the recommendation carried its
evidence; the acceptance criteria below are written for the chosen option.*

**Option A — an in‑process supervised asyncio consumer, started from the gateway
lifespan. ✅ RECOMMENDED → ✅ CHOSEN 2026-08-02.**
Code lives in `apps/services/ingestion/ingestion/consumer.py` (the package that
owns the producer), exposing `start_ingestion_consumer()` /
`stop_ingestion_consumer()` / `consumer_status()`, called from the gateway
lifespan beside the five loops already there — exactly the
`email_ingestion.scheduler.start_background_sync` precedent (a loop that lives in
a service package and is started by the gateway).
- *Consequence:* ships by ordinary merge; **no VPS action, no OWNER‑GATE for
  deployment.** It dies with the gateway and comes back with it. Multiple gateway
  workers cooperate rather than duplicate — that is precisely what a Redis
  consumer group is for.
- *Evidence:* `specs/workflows_app.md` §9 **D6** records this as the house
  style and says so about this very item: *"APScheduler's `CronTrigger` as a
  parser inside a supervised asyncio loop (the canonical gateway scheduler shape
  — no APScheduler process) … **Revisit under BO‑20.**"* Five such loops are
  already **wired** (see "What is true today" §7 for how many actually start).
  The canonical shape to copy verbatim is
  `gateway/routes/workflows/scheduler.py` (`_scheduler_loop` `:272`,
  `start_workflow_scheduler` `:289`, `stop_workflow_scheduler` `:300`,
  `scheduler_status` `:309`).

**Option B — a separate `python -m ingestion.worker` process. ❌ REJECTED
2026-08-02** (what the previous §Approach literally specified, and what
`queue.py`'s own docstring still promises at `:11‑14`). *The reasons, kept
verbatim — this is the record of why, not a live option:*
- *Consequence:* an independent failure domain and an independent restart —
  genuinely better isolation. But it **cannot be shipped by an agent**: it needs a
  new systemd unit on the VPS plus a deploy change, and there is no worker unit
  today (see §8 above). **A PR that ships `worker.py` this way merges and does
  nothing** — dead code until someone SSHes in. This is not hypothetical: the
  same package already carries `ingestion/scheduler.py`, a complete
  `python -m` long‑lived APScheduler process (§6 above), checked in and deployed
  nowhere. The upside of that precedent is that B's *code* shape is cheap here;
  the downside is that it has already merged‑and‑done‑nothing once.
- 🚩 ***B is not answerable in one line as written — picking it costs a design
  round before BO‑20a can dispatch.*** BO‑20a's core mechanism is "hands it to
  the sink registry", and its done‑when asserts delivery to a sink registered via
  `register_event_sink`. But `_SINKS` (`event_hooks.py:23`) is a **module‑level
  list in the registering process**, and the only registration of a real sink
  happens at **gateway import time** (`main.py:1070‑1076`). A separate
  `python -m ingestion.worker` starts with `_SINKS == []` — it would
  `XREADGROUP`, `XACK`, and dispatch to **nothing**. So under B the *dispatch*
  step is not "unchanged", it is **undefined**, and the owner is implicitly
  choosing one of three mechanisms, none of them free:
  1. **The worker registers `dispatch_event` itself.** Inverts the layering
     `event_hooks.py`'s docstring exists to prevent ("without ingestion importing
     upward", `:1‑9`) and requires `gateway` in
     `apps/services/ingestion/pyproject.toml` `dependencies`, which today lists
     only fastapi / uvicorn / httpx / redis / apscheduler / acb‑common /
     acb‑graph.
  2. **The worker POSTs back into the gateway.** A new authenticated internal
     endpoint — i.e. precisely the **third dispatch path** the non‑goals forbid.
  3. **The worker runs the workflow engine itself.** The engine lives in the
     gateway package (`gateway/routes/workflows/`); this is a package move, not a
     ticket.
- *Had the owner picked B:* BO‑20a's "start from the lifespan" half would have
  been replaced by a `__main__` entrypoint + a unit file + a `deploy.sh` install
  step **and** a written answer to the dispatch question above; **the deployment
  half of BO‑20a–e would have become OWNER‑GATE**; and **BO‑20a would have had
  to be re‑written before it was dispatchable at all**. The
  drain/retry/DLQ/limiter/concurrency logic and all of BO‑20f were unchanged
  either way — **the dispatch step was not**. That asymmetry is what decided it:
  A shipped by ordinary merge with the risk parked behind a flag, B bought a
  design round first.

**Not closed forever.** Choosing A does not assert that the consumer must live
in the gateway process for all time — it asserts that isolation is not worth a
design round and an undeployable PR *today*. Moving it later is a re‑opening of
this decision with a named dispatch mechanism attached (one of the three above),
not a refactor.

**Risk note that made Option A cheap, and still governs:** BO‑20a ships the
consumer **OFF** behind `INGESTION_CONSUMER` (default off), so merging it
changed nothing at runtime. Turning it on in prod is a **🔒 OWNER‑GATE** env flip
in the same family as `SKILLS_INDEX_ONLY` / `SKILLS_FAIL_CLOSED`, and is
**registered as one** in `work_plan.md` §6 (added 2026-08-02). It is not merely
"start a loop": the same flag cuts all three receivers over to enqueue‑only
(Q1 below), so it should be flipped when someone is watching, and reverted by
unsetting it — the receivers read it per request, so a revert takes effect on
the next webhook without a restart (the loop needs one).

#### Open question Q1 — what happens to the inline `emit_event` once a consumer exists? — **ANSWERED, and shipped in BO‑20a**

*Recorded so nobody decides it silently in a PR description.*
If the consumer emits to the sinks **and** the receivers keep emitting inline,
every event fires its workflows **twice**. So the consumer's arrival forces a
cutover: receivers become `enqueue`‑only and the consumer becomes the **only
provider‑webhook path into the sink registry** — precisely, the only caller of
`ingestion.event_hooks.emit_event`.
- ⚠️ **Not "the single dispatch path", full stop** — that phrasing was loose and
  is corrected here. `gateway/routes/agent.py:3476‑3478` calls
  `workflows.triggers.dispatch_event` **directly** from the signed generic
  webhook `POST /agent/webhook/{source}`; it does not go through the sink
  registry, it is a deliberate second path (see "What is true today" §2), and it
  is **untouched by the cutover**. The cutover is about the three provider
  receivers only.
- *Consequence to accept honestly:* before the cutover, if Redis is down
  provider events still dispatch (the enqueue is best‑effort — ClickUp's
  `try`/`except` at `clickup/webhook.py:101‑106`, and the same shape in
  `gmail/webhook.py` and `zoho/webhook.py`). After it, Redis down = events
  buffered nowhere and **dropped**. That is a real regression in one axis traded
  for durability/replay in another. BO‑20a makes it **loud rather than silent**:
  each receiver logs `<source>.queue.dropped` at warning when — and only when —
  the flag is on and the enqueue failed. It must **not** be "fixed" by falling
  back to an inline emit; that is double dispatch by another name.
- **Decision (shipped):** do the cutover, **gated on the same
  `INGESTION_CONSUMER` flag** — flag OFF ⇒ receivers emit inline exactly as
  before and the consumer never starts; flag ON ⇒ receivers only `enqueue` and
  the consumer is the sole emitter. One flag, one path, never both. Each
  receiver reads the flag **per request** (`consumer.consumer_enabled()`), which
  is what makes BO‑20a's "no double dispatch" done‑when checkable — see its
  acceptance E (three receivers × two modes).

#### Dependencies (resolved, not dangling)

- **BO‑9 (§B, ☐) is NOT blocking.** BO‑9's ingestion clause is "Redis opened
  per‑call in ingestion (`queue.py:48`)" — verified: `queue._client()`
  (`apps/services/ingestion/ingestion/queue.py:49‑51`) builds a fresh **sync**
  `redis.from_url` on every `enqueue`. A consumer needs a **long‑lived async**
  client to hold a blocking `XREADGROUP`; that is a different object, and the
  precedent for owning one already ships:
  `packages/acb_common/acb_common/activity.py:66‑76` (`_get_client` at `:66`,
  the pooled `from_url` at `:70‑75`; the previously‑cited `:54‑66` was stale and
  was corrected 2026-08-02) — a module‑level pooled
  `aioredis.from_url(..., max_connections=16, health_check_interval=30)` behind
  `_get_client()` (same pattern in `orchestrator/stream_relay.py` and
  `gateway/room_stream.py`). **BO‑20a reused that shape verbatim**
  (`ingestion/consumer.py::_get_client`). Consolidating the *producer's*
  per‑call sync client into a shared pool remains BO‑9's work — BO‑20a did not
  touch `queue.py`.
- **Redis** — already provisioned (`infra/docker-compose.yml:44`). No action.
- **Verified anchors** (all re‑checked 2026-08-02):
  producer `apps/services/ingestion/ingestion/queue.py`
  (`enqueue` `:54`, `enqueue_dlq` `:79`, stream constants `:40‑43`) ·
  sink registry `apps/services/ingestion/ingestion/event_hooks.py`
  (`register_event_sink` `:26`, `emit_event` `:37`) ·
  receivers `apps/services/ingestion/ingestion/sources/{clickup,gmail,zoho}/webhook.py` ·
  gateway wiring `apps/services/gateway/gateway/main.py` (the `try` at `:1070`,
  `register_event_sink(_wf_dispatch)` at `:1074`) ·
  dispatcher `apps/services/gateway/gateway/routes/workflows/triggers.py:40`
  (`event_trigger_matches` `:32`) ·
  MAF executor entry point **`apps/services/orchestrator/orchestrator/executor.py::run_agent` (`:1683`
  — the cited `:1640` was stale, corrected 2026-08-02)** ·
  canonical supervised loop `apps/services/gateway/gateway/routes/workflows/scheduler.py` ·
  hermetic test pattern `tests/unit/test_clickup_ingestor.py:158‑181`.

#### Tickets

**Sequence: f → a → b → c → (d, e).** BO‑20f needed no consumer, no owner
decision and no flag; it is what **multi‑channel event triggers** actually need,
and it **shipped 2026-08-02**. **BO‑20a shipped the same day**, once §BO‑20.0
was answered `Option A`. **BO‑20b is next and is dispatchable now** — nothing in
b–e waits on a decision any more; each waits only on its predecessor.

⚠️ **Neither BO‑20f nor BO‑20a unblocks WS‑11 Slice 4.**
`specs/workflows_app.md:217` defines Slice 4 as *"(post‑BO‑20/BO‑7): durable
queued runs; sandboxed module execution; MCP exposure; retention policies"* —
none of which Gmail/Zoho receiver parity delivers, and **durable queued runs
means a–e, not a alone**: without BO‑20b a failed dispatch is acked and lost,
which is the opposite of durable. **WS‑11 Slice 4 needs BO‑20a–e plus BO‑7.**
(Same statement as the "Not workflow‑run durability" non‑goal above; if these
two ever disagree, the non‑goal is right.)

---

**BO‑20f — Gmail + Zoho receivers reach ClickUp parity (enqueue + emit).** ✅ **BUILT 2026-08-02** *(code‑side; **inert in prod** — see the gate below)* · *no owner decision, no flag, no migration*
> **Shipped.** Both receivers now `enqueue` to their own stream and schedule
> `emit_event` on `BackgroundTasks`, mirroring `clickup/webhook.py` including
> warn‑and‑continue. `tests/unit/test_ingestion_receiver_parity.py` (22 tests)
> and `tests/unit/test_clickup_normalise_dlq.py` (4 tests) are green, and
> `test_clickup_ingestor.py` is untouched at 10 passed.
>
> ⚠️ **OWNER‑GATE — this closes the *code‑side* dead switch only; the feature
> fires in NO environment today.** `zoho_webhook_secret` and
> `gmail_pubsub_token` both default to `""`, and `_verify` / `_verify_bearer`
> return `False` on unset, so **every push 401s** — `xadd` never runs and
> `emit_event` is never scheduled. Neither key is in `.env.example` (writes to
> it are OWNER‑GATE under WS‑2 and are blocked by the plan‑guard hook) nor on
> the VPS, and no Zoho webhook / Pub/Sub subscription points at these routes.
> **Two owner actions, neither of which an agent can perform:**
> 1. Provision `ZOHO_WEBHOOK_SECRET=` and `GMAIL_PUBSUB_TOKEN=` (they map to
>    `acb_common/settings.py:100,106`) in `.env.example` and in the VPS env.
> 2. Point the Zoho webhook at `POST /webhooks/zoho?token=<secret>` and the
>    Pub/Sub push subscription at `POST /webhooks/gmail` with that bearer.
>
> Until both are done, a user who binds a workflow to `source=gmail` sees
> nothing, forever, with **no signal inside CommandCenter** — the failure is
> visible only in Google's / Zoho's own delivery dashboard. The fail‑closed
> posture (refuse everything when the secret is unset) is deliberate and must
> not be "fixed".
>
> Decisions the ticket left open, plus the latent defects the drive‑through
> exposed — all settled and pinned by tests:
> 1. **Empty / non‑object Gmail decode** (`_decode_envelope` → `{}` on a
>    dataless, malformed, or valid‑JSON‑but‑not‑an‑object push): **ack 200,
>    enqueue nothing, emit nothing.** Such a decode carries neither mailbox nor
>    `historyId`, so enqueueing it replays nothing and emitting it would fire
>    user‑visible workflow triggers with a payload no run can act on; a non‑2xx
>    would only make Pub/Sub retry a push that can never decode. `[1,2]`,
>    `null` and `"hi"` previously raised `AttributeError` → 500 for the same
>    reason the guard exists, so `_decode_envelope` now genuinely honours its
>    `-> dict[str, Any]` annotation (the `# type: ignore` is gone).
> 2. **A latent 500 in the Zoho receiver, found by the first test that drove it
>    through `TestClient` and fixed here** because acceptance is otherwise
>    unreachable: `_log.info("zoho.webhook", event=event, …)` collided with
>    structlog's own `event` message parameter, so **every authenticated Zoho
>    push raised `TypeError` and returned 500** — before this ticket added a
>    line. Now `zoho_event=`, the key `clickup/webhook.py` already uses.
> 3. **The same bug class, last instance in the repo, folded in:**
>    `clickup/webhook.py::_normalise_task` logged `event=event_type` *after* the
>    graph session had committed and the `task_normalised` audit row was
>    written, so the `TypeError` was caught by the enclosing `except` and **every
>    successfully‑normalised ClickUp task was logged as a failure and
>    dead‑lettered.** `test_clickup_ingestor.py` masks it (it stubs
>    `_normalise_task` wholesale), so `tests/unit/test_clickup_normalise_dlq.py`
>    drives the real function and asserts `enqueue_dlq.call_count == 0` on the
>    success path, with the failure paths pinned so it cannot pass by neutering
>    the DLQ. That file also carries an **AST guard over `apps/` + `packages/`**
>    asserting no logger call passes `event=` — empirically the only structlog
>    kwarg that raises.
> 4. **Zoho's `event` is coerced with `str(...)`.** It is a wire token (the
>    Redis Streams field and the `event_type` triggers match on); a push
>    carrying `{"event": {…}}` made the real `xadd` raise
>    `DataError: Invalid input of type: 'dict'`, which the receiver logged as
>    `zoho.queue.unavailable` — blaming Redis for a payload‑shape problem —
>    while the fan‑out still started a run.
> 5. **Both credential checks compare bytes.** `hmac.compare_digest` raises
>    `TypeError` on a non‑ASCII `str`, so `?token=%C3%A9` (and a non‑ASCII
>    bearer) returned **500 instead of 401** on a `PUBLIC_ROUTES` endpoint. It
>    failed closed, so this was noise, not a bypass.
>
> Original ticket text follows.

Give both stub receivers the two lines ClickUp already has: a best‑effort
`enqueue(...)` to their own stream constant, and a `BackgroundTasks`‑scheduled
`emit_event(source, event_type, payload)`. Mirror
`clickup/webhook.py:100‑116` exactly, including the warn‑and‑continue on a Redis
failure (`:103‑106`) — a provider webhook must never 5xx because Redis is down, or
the provider retries and makes the backlog worse.
- **Event‑type vocabulary is prescribed here, not invented in the PR** (it is
  user‑visible: workflow event triggers match on this string,
  `triggers.py::event_trigger_matches` `:32`):
  Gmail → source `"gmail"`, event type `"historyUpdated"` (the Pub/Sub push
  carries only `emailAddress` + `historyId`, `gmail/webhook.py:55‑56` — there is
  no provider event name to pass through), payload = the **decoded**
  `_decode_envelope` notification (`:54`), never the base64 Pub/Sub envelope.
  Zoho → source `"zoho"`, event type =
  the `event` value the receiver **already computes** at `zoho/webhook.py:49`
  (`payload.get("event") or payload.get("operation") or "unknown"`), payload =
  the parsed request body (`:43`), as ClickUp does.
- **Done when:** `tests/unit/test_ingestion_receiver_parity.py` drives each
  receiver through `TestClient` with a valid credential. **Fake only Redis** —
  `monkeypatch.setattr(queue, "_client", lambda: mock_redis)`, the
  `test_clickup_ingestor.py:158‑181` pattern, which works regardless of how the
  receiver imports `enqueue`. Use the **real** `event_hooks` registry with a
  recording sink registered via `register_event_sink`, torn down with
  `clear_event_sinks()` (`event_hooks.py:32`); **do not monkeypatch
  `emit_event`** — faking it would make the sink assertion vacuous, and the
  receiver imports it inside the function body (`clickup/webhook.py:114`) so
  patching the receiver module's attribute would not take effect anyway. Assert
  for **both** Gmail and Zoho: (i) exactly one `mock_redis.xadd`, to
  `STREAM_GMAIL` / `STREAM_ZOHO`, carrying the prescribed event type; (ii) the
  registered sink is invoked **exactly once** with `(source, event_type,
  payload)` equal to the prescribed source string, event type and payload above
  (`TestClient` runs `BackgroundTasks` before returning, so no sleep is needed);
  (iii) with `mock_redis.xadd` raising, the endpoint still returns **200**
  `{"status": "accepted"}` **and the sink is still invoked** — a Redis failure
  must not suppress the event fan‑out.
- **Done when:** an invalid credential still returns **401** for both receivers —
  the existing auth behaviour is unchanged (`gmail/webhook.py:51`,
  `zoho/webhook.py:41`).
- **Verify:** `uv run pytest tests/unit/test_ingestion_receiver_parity.py tests/unit/test_clickup_normalise_dlq.py tests/unit/test_clickup_ingestor.py -q`
  → the new files green **and** `test_clickup_ingestor.py` still exactly **10
  passed**, byte‑identical (the fence around the ClickUp path is behavioural:
  the `clickup_event=` fix in item 3 above is invisible to every assertion in
  that file).
- **Files:** `apps/services/ingestion/ingestion/sources/gmail/webhook.py`,
  `apps/services/ingestion/ingestion/sources/zoho/webhook.py`,
  `apps/services/ingestion/ingestion/sources/clickup/webhook.py` (item 3 only),
  `tests/unit/test_ingestion_receiver_parity.py`,
  `tests/unit/test_clickup_normalise_dlq.py`.

---

**BO‑20a — Consumer group + `XREADGROUP` drain loop.** ✅ **BUILT 2026-08-02** *(under §BO‑20.0 Option A; ships **OFF** behind `INGESTION_CONSUMER`)* · *the flag flip is 🔒 OWNER‑GATE*
> **Shipped.** `apps/services/ingestion/ingestion/consumer.py` declares the
> `cc-ingest` group on all three streams and drains them into the existing sink
> registry; the gateway lifespan starts it (`main.py:307`) and stops it
> unconditionally (`:364`); all three receivers are cut over behind the flag;
> `ingestion` is now a declared gateway dependency. Pinned by
> `tests/unit/test_ingestion_consumer.py` (**41 tests**, no Redis/DB/network).
> ⚠️ **Inert in every environment:** `INGESTION_CONSUMER` is unset everywhere, so
> the loop does not start and the receivers still emit inline — **dispatch‑identical**
> to before the PR until an owner flips it. *(Not "byte‑identical": each receiver
> now does one extra function‑body import of `ingestion.consumer` plus one
> `os.environ` read per request. Nothing observable changes; the wording is
> corrected because a claim that strong is either exact or it is decoration.)*
> **BO‑20b is the next ticket and needs no new decision.**

`apps/services/ingestion/ingestion/consumer.py`: `XGROUP CREATE <stream>
cc-ingest $ MKSTREAM` per stream (idempotent — swallow `BUSYGROUP` **only**;
any other `ResponseError` fails the cycle rather than being hidden), then a
supervised `XREADGROUP GROUP cc-ingest <consumer-name> BLOCK … COUNT …` loop
across `ingestion:{clickup,zoho,gmail}` that decodes each entry
(`event_type` + JSON `data`, the shape `queue.enqueue` writes at `:66‑74`),
hands `(source, event_type, payload_as_dict)` to `event_hooks.emit_event` — a
**decoded dict, never the JSON string** — and `XACK`s it.
**`$` is deliberate, not an oversight:** the group starts at the stream tail, so
everything already buffered is **skipped** — the "audit buffer nobody reads"
(§4 above) stays unread at cutover and is trimmed as before. The alternative,
`0`, would replay up to 10 000 buffered entries per stream into a dispatch storm
of real workflow runs the moment the flag flips. Accept the skip; do not
"fix" it. A one‑off replay, if ever wanted, is BO‑20c's `replay_dlq` shape
applied by hand, not a startup behaviour. Lifecycle
`start_ingestion_consumer()` / `stop_ingestion_consumer()` / `consumer_status()`
copied in shape from `routes/workflows/scheduler.py:272‑313`, wired into the
gateway lifespan next to the existing five, **and stopped on shutdown** beside
all five existing stop calls — stopped **unconditionally**, exactly as
`stop_whatsapp_enrichment` is called even when its loop never started.

**Constants — prescribed by the dispatch audit, not PR‑author choices.** A
deliberate change to any of these is a doc change here, in the same way BO‑20b's
`MAX_ATTEMPTS` is:
- `_GROUP = "cc-ingest"`.
- `_BLOCK_MS = 5_000` — finite, so a cancelled task returns promptly instead of
  parking on a read that never times out.
- `_READ_COUNT = 8` — at or below BO‑20e's `INGESTION_MAX_CONCURRENCY = 8`, so
  that ticket bounds a batch this one already produces.
- consumer name = `f"gw-{socket.gethostname()}-{os.getpid()}"`, **not a
  constant**: BO‑20b's `XAUTOCLAIM` identifies a dead worker by its name in the
  PEL, so two workers sharing one name make a crashed worker's backlog
  unreclaimable.
- `_ERROR_BACKOFF_SECS = 1.0` *(added by the implementation, recorded here)* —
  the pause after a failed cycle. Without it a Redis outage turns the supervised
  loop into a hot loop, because `xreadgroup` raises immediately and no `BLOCK`
  elapses.
- `_DISPATCH_TIMEOUT_SECS = 30.0` *(added by the implementation, recorded here)*
  — the ceiling on **one entry's whole sink fan‑out**, applied as
  `async with asyncio.timeout(…)` around `emit_event`. **It is not retry
  machinery** (that is BO‑20b); it exists because this ticket changes the blast
  radius of a hung sink. Before the cutover a sink that never returns hangs one
  request's `BackgroundTasks` and the other two sources keep flowing; here one
  serial loop drains all three streams, so an unbounded `await` converts a
  per‑event hang into a **bus‑wide stall** — and a silent one, since
  `emit_event` swallows sink exceptions and it could never surface as
  `cycle_failed`. 30.0 is far above any legitimate sink: the registered one,
  `workflows/triggers.dispatch_event`, is DB‑bound (it inserts the run row and
  `create_task`s `_execute_run` at `service.py:226`; it never awaits the run
  itself), so this cannot truncate a workflow. A timed‑out entry is still
  `XACK`'d — interim BO‑20a semantics, below. Logged on its own key
  `consumer.dispatch_timeout`.

**Flag home — `consumer.py`, not `Settings`.** `INGESTION_CONSUMER` is read
through a pure `consumer_enabled(env: dict[str, str] | None = None) -> bool`
that reads `os.environ` **at call time**, truthy set `{"1","true","yes","on"}` —
a verbatim mirror of `gateway/routes/whatsapp/scheduler.py::enrichment_enabled`
(`:36`). It is deliberately **not** a `Settings` field: `get_settings` is
`@lru_cache(maxsize=1)` (`packages/acb_common/acb_common/settings.py:384`),
which freezes the flag for the process and makes it untestable per call. The
receivers call `consumer_enabled()` per request via a function‑body import, the
same shape as their `emit_event` import. (`settings.py` was on this ticket's
Files list until 2026-08-02; it was wrong and is struck.)

**Ack semantics are interim by design:** BO‑20a acks after dispatch **regardless
of outcome**. Honest `XACK` + retry + DLQ is BO‑20b, which also adds the
`emit_event(..., raise_on_error=True)` strict mode this loop would need to
*observe* a failure at all. Do not pre‑build it. One deliberate exception: an
entry whose `data` does not decode to a JSON **object** is logged
(`consumer.entry_undecodable`) and acked **without** dispatch — there is nothing
a sink could act on, and re‑delivering it forever would wedge the group.

**Three "enqueued but never dispatched" states exist in BO‑20a, not one.** The
first is the accepted §BO‑20 Q1 drop at the receiver (Redis down ⇒ the enqueue
fails ⇒ nothing to dispatch). The other two are consequences of `XACK` being
**unguarded** in `_dispatch_entry` while the loop only ever reads `">"`, never
`"0"` — they are recorded here so BO‑20b does not rediscover them:
1. **Ack failure mid‑batch.** A connection reset on `client.xack` propagates
   through `_drain_once` into the supervised loop's `except` → backoff. The
   entries **already returned by that `XREADGROUP`** (up to `_READ_COUNT` = 8
   per stream) were never dispatched, sit in the PEL, and this process will not
   re‑read them. The only log is `consumer.cycle_failed`.
2. **SIGTERM mid‑batch.** Same shape — and the restarted process has a new pid,
   so the stranded entries sit under a `gw-<host>-<pid>` name it never uses.

The unguarded `XACK` is **deliberate, not an oversight**: a raising `xack` means
Redis is gone, and swallowing it would hot‑loop against a dead server instead of
reaching `_ERROR_BACKOFF_SECS`. Both states are recoverable — BO‑20b's reclaim
pass (`XAUTOCLAIM` / `XPENDING` + `XCLAIM`) reclaims **any** consumer name in the
group, including a dead pid's — **but the window is finite**: `queue._MAXLEN`
(`queue.py:46`) trims each stream at 10 000 entries, and a trimmed entry is
beyond the PEL's reach for good. That is why BO‑20b's done‑when below requires
the reclaim pass to run **at startup**, not only on a periodic cadence.

- **Done when (A — delivery + ack):** ✅ `tests/unit/test_ingestion_consumer.py`
  asserts, with the consumer's Redis client faked at `consumer._get_client` per
  the `test_clickup_ingestor.py:158‑181` pattern (**no Redis, no DB, no VPS**)
  and the **real** sink registry (a recording sink via `register_event_sink`,
  never a monkeypatched `emit_event`), that an entry returned by the fake's
  `xreadgroup` **in the shape the real `queue.enqueue` produces** is delivered as
  `("clickup", event_type, payload)` with `payload` a **dict** equal to what the
  producer encoded, and is then `xack`'d **exactly once** on `ingestion:clickup`
  with group `cc-ingest`. **The ack must be asserted to happen *after* the
  dispatch, on one shared ordered timeline** — the recording sink and the fake's
  `xack` append to the *same* list. Two independent lists satisfy every other
  word of this criterion with the `XACK` hoisted **above** `emit_event`, which is
  precisely the line BO‑20b edits.
  → `test_entry_is_delivered_to_the_sink_and_acked_once`,
  `test_read_uses_the_prescribed_group_and_constants`.
- **Done when (B — the group starts at the tail, on all three streams):** ✅
  `xgroup_create` is asserted for **each** of `ingestion:{clickup,zoho,gmail}`
  with `id="$"` and `mkstream=True`. *A test that does not pin `id="$"` does not
  close this ticket* — the difference between `$` and `0` is a quiet startup and
  a dispatch storm.
  → `test_group_created_on_every_stream_at_the_tail`,
  `test_ensure_groups_called_directly_pins_the_same_contract`.
- **Done when (C — idempotence):** ✅ a fake whose `xgroup_create` raises
  `redis.ResponseError("BUSYGROUP …")` does not fail startup (the entry after it
  still dispatches and acks), a non‑BUSYGROUP `ResponseError` is **not**
  swallowed, and a second `start_ingestion_consumer()` while running is a no‑op —
  one live task named `ingestion-consumer`, not two.
  → `test_busygroup_does_not_fail_startup`,
  `test_non_busygroup_response_error_is_not_swallowed`,
  `test_second_start_while_running_is_a_no_op`.
- **Done when (D — flag OFF):** ✅ with `INGESTION_CONSUMER` unset,
  `start_ingestion_consumer()` creates no task, `consumer_status()["running"] is
  False`, no Redis verb is issued at all, and the receivers still emit inline —
  `test_clickup_ingestor.py` stays **10 passed, unmodified** and
  `tests/unit/test_ingestion_receiver_parity.py` (BO‑20f) stays **22 passed**.
  → `test_flag_off_starts_no_task`, `test_consumer_enabled_truthy_set`,
  `test_consumer_enabled_reads_os_environ_at_call_time`.
- **Done when (E — no double dispatch, per receiver, per Q1):** ✅ with the flag
  ON, **each** of the three receivers is driven through `TestClient` with a valid
  credential and the sink is invoked **zero** times while `xadd` still happens
  exactly once; with the flag OFF, exactly once. Six assertions (3 receivers × 2
  modes). **The cutover is three receivers wide, not one**: BO‑20f gave Gmail and
  Zoho the same inline emit, so a ClickUp‑only test would leave the other two
  double‑dispatching.
  → `test_receiver_emits_inline_when_flag_off[clickup|gmail|zoho]`,
  `test_receiver_does_not_emit_when_flag_on[clickup|gmail|zoho]`.
- **Done when (F — flag ON + Redis down):** ✅ with `xadd` raising, each receiver
  still returns **200** `{"status": "accepted"}`, the sink is **not** invoked
  (the event is dropped — the accepted Q1 regression), and the drop is logged at
  warning on its own key `<source>.queue.dropped`, so it is loud rather than
  silent. The mirror case is pinned too: with the flag OFF, Redis down still
  dispatches inline and claims **no** drop. Do **not** "fix" the drop by
  re‑emitting inline.
  → `test_flag_on_redis_down_drops_the_event_but_says_so[…]`,
  `test_flag_off_redis_down_still_dispatches_inline[…]`.
- **Done when (G — supervision):** ✅ a sink that raises does not kill the loop
  (the next entry is still delivered and acked), a failing `xreadgroup` does not
  either, and `asyncio.CancelledError` propagates so `stop_ingestion_consumer()`
  returns — the same two guarantees `_scheduler_loop` (`:272‑286`) makes.
  The cancellation half needs **both** halves of a fix that is easy to get
  half-right: (i) assert `task.cancelled()`, not `task.done()` — a loop that
  caught `CancelledError` and returned normally is `done()` too; **and (ii) let
  the loop actually reach its blocking read before calling `stop`.** (ii) is
  load-bearing and is not obvious: cancelling a task that has never been stepped
  makes asyncio throw `CancelledError` in at the coroutine's *first instruction*
  — above the `try` — so the task is marked cancelled whatever the `except`
  clause does, and even `task.cancelled()` passes against a swallowing loop.
  Verified both ways against a deliberately-swallowing `_consumer_loop`: with
  the wait, red (`Task finished … result=None`); without it, green. A test that
  stops before the first read pins asyncio's `_must_cancel` fast path, not this
  loop.
  → `test_a_raising_sink_does_not_kill_the_loop`,
  `test_a_failing_read_does_not_kill_the_loop`,
  `test_cancellation_propagates_so_stop_returns`,
  `test_stop_when_never_started_is_a_no_op`,
  `test_undecodable_entry_is_acked_not_dispatched`.
- **Done when (G2 — a hung sink cannot stall the bus):** ✅ with
  `_DISPATCH_TIMEOUT_SECS` monkeypatched small and a registered sink that never
  returns, **both** queued entries still reach the recording sink, both are
  `xack`'d, and `consumer.dispatch_timeout` is logged **once per entry** — the
  regression this ticket would otherwise introduce is that one serial loop
  drains all three streams, so an unbounded `await emit_event` stalls **every**
  source, silently. Without the timeout this test hangs until `_drain`'s
  `wait_for` fires; it is a real pin, not a tautology.
  → `test_a_hung_sink_times_out_and_the_bus_keeps_draining`.
- **Done when (H — packaging):** ✅ `ingestion` appears in
  `apps/services/gateway/pyproject.toml` `dependencies` **and** in `uv.lock`'s
  `name = "gateway"` package block (both `dependencies` and `requires-dist`), and
  `uv run python -c "import ingestion.consumer"` succeeds — closing the silent
  `try/except` conditionality at `main.py:1070‑1076` (§10 above).
  → `test_gateway_declares_the_ingestion_dependency`,
  `test_uv_lock_records_ingestion_under_gateway`,
  `test_consumer_module_imports_and_exposes_its_lifecycle`.
- **Done when (I — the lifespan wiring is pinned, not just asserted in prose):**
  ✅ the "stopped **unconditionally**" contract stated above (and in
  `apps/services/gateway/AGENTS.md` §1) is covered by a test, or deleting the
  stop call leaves every other test in this file green. Text‑level over
  `main.py`, for the same reason the two packaging tests above are: importing
  `gateway.main` pulls in the whole app. Asserts both names appear, that the
  start precedes the `yield` and the stop follows it, and that the shutdown
  half contains no `consumer_enabled` guard.
  → `test_gateway_lifespan_starts_the_consumer_and_stops_it_after_yield`.
- **Constraint (kept):** no log call in `consumer.py` may pass `event=` —
  `tests/unit/test_clickup_normalise_dlq.py` carries an AST guard over `apps/` +
  `packages/` (`_SCANNED` at `:119`). Use `clickup_event=` / `zoho_event=` /
  `source=` style keys.
- **Verify:** `uv run pytest tests/unit/test_ingestion_consumer.py tests/unit/test_clickup_ingestor.py tests/unit/test_ingestion_receiver_parity.py tests/unit/test_clickup_normalise_dlq.py -q`
  → **77 passed** (41 + 10 + 22 + 4; the last three unmodified — that is the
  regression fence). The single‑file form this ticket used to carry is
  insufficient: it cannot see the Gmail/Zoho halves of the cutover.
  Plus `uv run ruff check --select F821,F601,F602,F502,F7,B006 apps/services/ingestion/ingestion apps/services/gateway/gateway/routes/workflows`
  → `All checks passed!`
- **Files:** `apps/services/ingestion/ingestion/consumer.py` (new),
  `apps/services/ingestion/ingestion/sources/{clickup,gmail,zoho}/webhook.py`
  (flag‑gated cutover), `apps/services/gateway/gateway/main.py`,
  `apps/services/gateway/pyproject.toml` + `uv.lock`,
  `tests/unit/test_ingestion_consumer.py` (new).
  ~~`packages/acb_common/acb_common/settings.py`~~ — struck; the flag lives in
  `consumer.py` (see "Flag home" above). `queue.py` is deliberately untouched
  (its per‑call sync client is BO‑9's).

---

**BO‑20b — Retry with backoff + honest `XACK` semantics + DLQ hand‑off.** ✅ **AGENT‑SAFE** · *after BO‑20a*
A failed dispatch **must not** be `XACK`'d — the entry stays in the group's PEL
and a reclaim pass (`XAUTOCLAIM`, or `XPENDING` + `XCLAIM` with a `min-idle-time`)
re‑delivers it after a backoff. After `MAX_ATTEMPTS` deliveries the entry is
written to `ingestion:dlq` via the existing `queue.enqueue_dlq` (`:79`) and
`XACK`'d exactly once, so it leaves the PEL and never re‑delivers.
- **The constants are prescribed here, not chosen in the PR** (same reason the
  event‑type vocabulary is prescribed in BO‑20f: without literals this ticket's
  done‑when is satisfiable with `MAX_ATTEMPTS = 1` and
  `_backoff = lambda a: 0.0`, i.e. a ticket titled "Retry with backoff" closing
  green with neither retry nor backoff):
  - `MAX_ATTEMPTS = 5` — module‑level in `consumer.py`.
  - `_backoff(attempt) = min(2.0 ** attempt, 60.0)` → `1, 2, 4, 8, 16` seconds
    across the five attempts; ceiling is the literal **60.0**.
  - Reclaim `min-idle-time = 60_000` ms (module‑level `_RECLAIM_MIN_IDLE_MS`).
    It must be **> 0**: a reclaim pass with `min-idle-time=0` re‑claims entries
    the loop is still working on and hot‑loops.
  A deliberate change to any of these three is a doc change here, not a PR
  detail.
- 🚩 **Blocker this ticket must fix first, or its retry logic is dead code:**
  `event_hooks.emit_event` (`event_hooks.py:37‑49`) **swallows every sink
  exception** by design ("a sink error never propagates back into a provider
  webhook response"). A consumer calling it can therefore never observe a
  failure. Add a strict mode — `emit_event(..., raise_on_error: bool = False)` —
  so receivers keep today's best‑effort default (unchanged, a webhook must never
  5xx) and the consumer opts into propagation. Do **not** make the default
  strict; that would change provider‑facing behaviour.
- **Done when:** `MAX_ATTEMPTS == 5` and `_RECLAIM_MIN_IDLE_MS == 60_000` are
  asserted against those literals, and the reclaim call is asserted to pass
  `_RECLAIM_MIN_IDLE_MS` (not `0`) as `min-idle-time`.
- **Done when — the reclaim pass runs at STARTUP, before the first `">"` read**,
  not only on the periodic cadence, and a test asserts that ordering. *Reason
  (recorded from the BO‑20a review, §BO‑20a "Three enqueued but never dispatched
  states"):* BO‑20a strands a batch's remainder in the PEL on an `xack` failure
  or a SIGTERM mid‑batch, under the **previous pid's** consumer name — which
  only a reclaim reaches, and only until `queue._MAXLEN` trims the entry out of
  the stream. Without a startup pass, every restart while the flag is on adds to
  a backlog that nothing drains until the next periodic tick.
  - ⚠️ **Open sub‑question for this ticket to answer (do not guess):** at
    startup, entries stranded by a *fast* restart have been idle for less than
    `_RECLAIM_MIN_IDLE_MS`, so the min‑idle filter excludes exactly the case the
    startup pass exists for. Decide and record one of: (a) the startup pass uses
    a lower idle bound **restricted to consumer names that are not this process**
    (a dead pid cannot have work in flight), or (b) it uses the same 60 s bound
    and accepts one periodic tick of latency. `_RECLAIM_MIN_IDLE_MS > 0` remains
    binding for the periodic pass either way.
- **Done when:** with a faked Redis and a sink that raises on the first **4**
  deliveries and succeeds on the **5th**, the entry is `xack`'d **exactly once**
  and **never** written to `ingestion:dlq` — i.e. the retry path is exercised
  four times, not zero.
- **Done when:** with a sink that always raises, after exactly **5**
  (`MAX_ATTEMPTS`) deliveries there is **exactly one** `xadd` to `ingestion:dlq`
  carrying `origin_stream="ingestion:clickup"` and the error string, followed by
  **exactly one** `xack` — and no further re‑delivery.
- **Done when:** backoff is a pure function `_backoff(attempt) -> float`
  asserted directly against the prescribed literals — `_backoff(0) > 0`
  (never zero), monotonic non‑decreasing over `range(0, 12)`, and
  `_backoff(10) == 60.0` (the stated ceiling, not a self‑referential "some
  ceiling") — so **the test never sleeps**.
- **Done when:** `emit_event(..., raise_on_error=True)` propagates the first sink
  exception while the default call remains swallow‑and‑log — pinned by a test,
  and `test_clickup_ingestor.py` still **10 passed**.
- **Verify:** `uv run pytest tests/unit/test_ingestion_consumer.py tests/unit/test_clickup_ingestor.py -q`
- **Files:** `apps/services/ingestion/ingestion/consumer.py`,
  `apps/services/ingestion/ingestion/event_hooks.py`,
  `tests/unit/test_ingestion_consumer.py`.

---

**BO‑20c — Make the dead‑letter queue drainable and visible.** ✅ **AGENT‑SAFE** · *after BO‑20b*
`ingestion:dlq` is written by two live call sites today
(`clickup/webhook.py:48`, `:76`) and read by nothing, so a normalisation failure
is invisible and is eventually trimmed. (Both are genuine failure paths again as
of BO‑20f's repair round — until then the `:76` site also fired on **every
success**; see BO‑20f item 3.) Add, in `ingestion/queue.py`:
`read_dlq(limit, start) -> list[dict]` (decoded entries, newest‑first) and
`replay_dlq(entry_id) -> str | None` (re‑`xadd` to `origin_stream`, then `XDEL`
the DLQ entry — one hop, no silent duplication). Expose read + replay behind an
admin route reusing the **existing** permission `admin:access:manage`
(`packages/acb_auth/acb_auth/permissions.py:99`) — do not mint a new permission.
- **Done when:** `read_dlq` against a faked Redis returns entries with
  `origin_stream`, `event_type`, decoded `data`, and `error` — the exact four
  fields `enqueue_dlq` writes (`queue.py:82‑92`) — and an empty stream returns
  `[]`, not an error.
- **Done when:** `replay_dlq(entry_id)` issues exactly one `xadd` to the entry's
  `origin_stream` with the original `event_type` and payload, and exactly one
  `xdel` on `ingestion:dlq` for that id; a non‑existent id returns `None` and
  issues **no** `xadd`.
- **Done when:** the admin route returns **403** for a member without
  `admin:access:manage` and the DLQ listing for a member with it — asserted via
  `TestClient` with the permission check faked, no live DB.
- **Verify:** `uv run pytest tests/unit/test_ingestion_dlq.py tests/unit/test_clickup_ingestor.py -q`
  → the new file green **and** `test_clickup_ingestor.py` still **10 passed,
  unmodified** — this ticket edits `queue.py`, which the ClickUp receiver imports
  (`enqueue`, `enqueue_dlq`), so the regression net applies here as it does to
  BO‑20a/b/f. (BO‑20d/e touch only `consumer.py` and do not need it.)
- **Files:** `apps/services/ingestion/ingestion/queue.py`,
  `apps/services/gateway/gateway/routes/admin/` (new module),
  `tests/unit/test_ingestion_dlq.py`.

---

**BO‑20d — Per‑source rate limiting.** ✅ **AGENT‑SAFE** · *after BO‑20a*
A token‑bucket limiter keyed by source, consulted by the drain loop before each
dispatch, so a provider burst is **paced, never dropped** (the entry stays in the
PEL until it is dispatched and acked).
- **Defaults are prescribed here, not chosen in the PR** (same reason as
  BO‑20b): `INGESTION_RATE_PER_SEC = 10.0` and `INGESTION_RATE_BURST = 20` per
  source, module‑level in `consumer.py` and env‑overridable. Rationale: 10/s is
  an order of magnitude above any observed provider webhook rate here, so the
  limiter is a burst brake rather than a throughput cap; a burst of 2× the rate
  absorbs a normal provider batch without deferring anything.
- **Done when:** the two defaults are asserted against those literals, so a
  later change is visible in a diff.
- **Done when:** `RateLimiter(rate_per_sec, burst)` takes an **injectable clock**
  and is asserted directly with a frozen clock — the first `burst` acquisitions
  are granted immediately and the next is deferred by `1/rate_per_sec`; the test
  **never sleeps**.
- **Done when:** the drain loop with a 1/s limiter and a frozen clock dispatches
  at most one entry per simulated second and **zero entries are lost** — every
  entry offered is eventually dispatched and acked, none discarded.
- **Verify:** `uv run pytest tests/unit/test_ingestion_consumer.py -q`
- **Files:** `apps/services/ingestion/ingestion/consumer.py`,
  `tests/unit/test_ingestion_consumer.py`.

---

**BO‑20e — Bounded concurrency.** ✅ **AGENT‑SAFE** · *after BO‑20a*
An `asyncio.Semaphore(INGESTION_MAX_CONCURRENCY)` bounds in‑flight dispatches;
`XACK` happens only after a dispatch completes; `stop_ingestion_consumer()`
drains in‑flight work before returning.
- **Default is prescribed here, not chosen in the PR** (same reason as BO‑20b):
  `INGESTION_MAX_CONCURRENCY = 8`, module‑level in `consumer.py` and
  env‑overridable. Rationale: each in‑flight dispatch can reach `start_run`, so
  this is the ceiling on concurrent workflow runs a provider burst can start
  inside the gateway process; 8 sits under the pooled async Redis client's
  `max_connections=16` precedent (`acb_common/activity.py:54‑66`). It must be
  **≥ 2** — a value of 1 makes the "peak equals the bound" assertion below true
  trivially and turns the ticket into a no‑op.
- **Done when:** the default is asserted against the literal `8`.
- **Done when:** with a sink that blocks on an `asyncio.Event`, the observed peak
  of concurrently in‑flight sinks equals `INGESTION_MAX_CONCURRENCY` and never
  exceeds it, and the loop does not read more than that many un‑acked entries
  ahead.
- **Done when:** `stop_ingestion_consumer()` awaits in‑flight dispatches, so no
  entry is left both un‑acked and abandoned by the stopping process — asserted by
  releasing the blocked sink after `stop` is called and observing the `xack`.
- **Verify:** `uv run pytest tests/unit/test_ingestion_consumer.py -q`
- **Files:** `apps/services/ingestion/ingestion/consumer.py`,
  `tests/unit/test_ingestion_consumer.py`.

---

#### Verification (Windows; run these and quote the output)

⚠️ **Nothing below may require a live Redis or the VPS** — every consumer test
fakes the Redis client, per `tests/unit/test_clickup_ingestor.py:158‑181`
(`monkeypatch.setattr(queue, "_client", lambda: mock_redis)`).
⚠️ **Never run the full `uv run pytest` suite or a bare `tests/unit/` on this
machine** — it hangs against the live DB. Name test files.

```
uv run pytest tests/unit/test_clickup_ingestor.py -q
```
Baseline confirmed 2026-08-02 on a clean tree: **10 passed** (~0.5–0.8s). Every
BO‑20 PR must keep this green **and unmodified** — it is the regression net that
proves the ClickUp path did not change.

Since BO‑20a the fence is four files wide, because the cutover touches all three
receivers and the consumer:
```
uv run pytest tests/unit/test_ingestion_consumer.py tests/unit/test_clickup_ingestor.py \
  tests/unit/test_ingestion_receiver_parity.py tests/unit/test_clickup_normalise_dlq.py -q
```
Measured after BO‑20a (2026-08-02): **75 passed in 2.35s** — 39 + 10 + 22 + 4,
with the last three **unmodified**. BO‑20b–e must keep that shape: their own new
file grows, the other three do not move.

```
uv run ruff check --select F821,F601,F602,F502,F7,B006 \
  apps/services/ingestion/ingestion \
  apps/services/gateway/gateway/routes/workflows
```
Baseline confirmed 2026-08-02: **All checks passed!** This is the fast local
proxy for the CI correctness gate narrowed to this item's paths; the CI command
is the same select‑list over the whole repo
(`uv run ruff check . --select F821,F601,F602,F502,F7,B006`). Do **not** use a
bare `uv run ruff check <paths>` as a gate — the full rule set is deliberately
non‑blocking style backlog.

- **Competitive ref (CH‑3):** **OpenClaw's job queue** (automatic backoff, retry,
  rate‑limit + concurrent‑job handling) is repeatedly cited as its single
  hardest‑to‑replicate strength — it is the reference design here. This queue is
  also the substrate the messaging‑channel work (WBS 3.3 / CH‑4) needs. See
  `specs/competitive_hardening_2026-07.md`.
- **Cross‑ref:** "BO‑4" in `FOUNDATION_AUDIT_REPORT.md` §5 and the **BO‑4** row in
  `FOUNDATION_CONTINUATION.md` §D both refer to this item; **this section is the
  single owner** (`work_plan.md` §1 point 6) and they defer to it.

---

## E. LLM configuration

### BO‑15 — Single source of truth for tier→model + context windows *(P1)* ◑
- **Done this pass:** the two hand‑synced tier‑alias maps are collapsed — `v1_compat` now imports `acb_llm.client._TIER_ALIAS_MAP` (the map `context.py` and the tests already use) instead of duplicating it.
- **Missing:** the tier→**model** mapping still has four disagreeing definitions (M3: `client._TIER_DEFAULTS`, `config.yaml`, `tier_overrides.yaml`, `settings.py` comment); `_TIER_CONTEXT_WINDOWS` a stale second copy of what `context.py` computes.
- **Approach:** Make the DB `model_config` table authoritative; delete `tier_overrides.yaml`, `enabled_models.json`, and the proxy directives in `config.yaml` once seeded; have `settings.py` read windows from `context.py`'s dynamic resolver instead of a hardcoded map.

### BO‑16 — Retire the vestigial LiteLLM proxy config *(P3)* ☐
- **Missing:** `infra/litellm/config.yaml` is a full proxy config but no proxy runs; only its tier rows are read (M6). `provider_models_cache.json` is a rotting committed cache.
- **Approach:** Reduce `config.yaml` to the tier map (or move fully to DB); delete `provider_models_cache.json`; align `infra/AGENTS.md` (which already claims the proxy files are gone).

---

## F. CI/CD & quality gates

### BO‑17 — Make the claimed gates real *(P1)* ☐
- **Missing:** mypy and full‑ruff are report‑only; evals are path‑gated (skip gateway/ingestion/reconciler); `deploy.yml` allows `skip_tests`; no coverage threshold (M10).
- **Approach:** Ratchet mypy/ruff to blocking per the existing plan; broaden the eval trigger paths or run a fast eval subset on every PR; remove `skip_tests` from production deploy; add `--cov-fail-under` for foundation packages. Reconcile README's CI claims.

### BO‑18 — Secret‑scanning + large‑file gates that actually catch history *(P1)* ◑
- **Done:** **gitleaks secret scanner** wired into CI — `.gitleaks.toml` (default rules + dev‑placeholder allowlist) + a `secret-scan` job in `pr-check.yml` that scans each PR's NEW commits (report‑only initially, per the ratchet; scoped to the PR range so it doesn't trip on the historical leak). Plus `scripts/scan_secrets_history.sh` for the one‑time full‑history audit around the purge. `.gitignore` rules for `*.pid`/`*.bak`/`*token_cache*` shipped earlier (**✅ F2**).
- **Missing:** graduate `secret-scan` to **blocking** after a few green PRs; a CI job that fails on any tracked file > 1 MB; and the actual **history purge + token rotation** (BO‑8, owner‑gated).

---

## G. Documentation

### BO‑19 — Doc↔code reconciliation *(P1)* ◑
- **Missing:** README described LangGraph/Theia/PostgresSaver/escalation_ui and had a garbled layout (**✅ F3** rewrites it); stale "placeholder"/LangGraph docstrings across packages (**✅ F6** sweeps the worst); `AGENTS.md` version pins lag.
- **Done this pass:** `AGENTS.md` Python‑version mismatch fixed — "Python 3.11+" → "3.12+" to match `pyproject` (`>=3.12,<3.14`) and CI/prod (3.12).
- **Residual:** update `AGENTS.md` package versions to the lockfile (`agent-framework-core 1.8.1`) and update `infra/AGENTS.md`'s "no proxy files / no Langfuse" claims to match reality. *(The 3.11/3.12 mismatch is fixed — see "Done this pass" above; duplicate residual entry removed 2026-08-01, doc-truth pass.)*

---

## Suggested sequencing

1. **P0 hardening sprint (do first):** BO‑8 (rotate+purge secrets), BO‑2 (auth enforcement), BO‑1 (Action Broker), BO‑3 (mutation governance). These close the Critical trust‑boundary and governance gaps that everything else sits on.
2. **P1 sprint:** BO‑7 (sandbox), BO‑5 (observability+cost), BO‑6 (migrations), BO‑12/BO‑14 (runtime + permission model), BO‑15 (LLM config SoT), BO‑17/BO‑18 (gates), BO‑19 residual, **BO‑20 (event‑bus consumer + job queue)**.
3. **P2/P3:** BO‑9, BO‑10, BO‑11, BO‑13, BO‑16, **BO‑21 (memory activation)**.

**Competitive‑informed items** (proven reference implementations from Hermes Agent / OpenClaw — full mapping in `ai-company-brain/specs/competitive_hardening_2026-07.md`): CH‑1→BO‑7/BO‑14, CH‑2→BO‑1, CH‑3→BO‑20, CH‑4→WBS 3.3, CH‑5→BO‑12, CH‑6→BO‑21, CH‑7→Phase‑5 Annealer, CH‑8→BO‑5. These do not change the sequencing above — they attach a "what good looks like" reference to items we already have, plus the two new items (BO‑20/BO‑21) the comparison surfaced.

The review pass already delivered F1–F6 (see report §6), which knock out the open LLM proxy, the on‑disk secret/junk exposure, the false‑$0 cost bug, the migration‑number collision, and the worst doc drift — clearing the cheapest Critical/High items so the P0 sprint can focus on the architectural ones.
