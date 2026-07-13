# Foundation Build‑Out Checklist — CommandCenter

**Date:** 2026-07-11 · **Deploy status updated:** 2026-07-13
**Companion to:** `FOUNDATION_AUDIT_REPORT.md` · handoff details in `FOUNDATION_CONTINUATION.md` (see its "LATEST STATUS" block).

> **🚀 Deploy status:** All ✅/◑ items below are **merged to `main` and LIVE on prod** (`origin/main` = `ccccdc8`, deploy succeeded, VPS + gateway health verified 2026‑07‑13). One local-only commit `1684e1a` (BO‑10 connect_timeout on the gateway engines) is **not yet pushed**. Next recommended P0: **BO‑1** (Action Broker persistence + wiring, Postgres‑unblocked).

This is the list of foundational capabilities that are **missing, partially implemented, or not yet wired up**. It excludes application features. Each item states what is missing, why it matters, what it depends on, a suggested approach, and a recommended priority. Items already addressed in the review pass are marked **✅ done (Fx)** and are retained here for completeness with any residual follow‑up.

**Priority legend:** **P0** = do before any new feature work · **P1** = next hardening sprint · **P2** = scheduled tech‑debt · **P3** = opportunistic.

**Status legend:** ☐ not started · ◑ partial · ✅ done this pass.

---

## A. Security & trust boundaries

### BO‑1 — Action Broker: real approval‑gated write path *(P0)* ◑
- **Done this pass (the decision + execution core, non‑breaking):** the 46‑line stub is now a real component: `decide_disposition(authority, destructive)` — the pure authority‑tier policy (READ→rejected, AUTONOMOUS→auto, SUGGEST→needs‑approval, SUGGEST_APPLY→auto for reversible / needs‑approval for destructive, i.e. FAIL CLOSED); `propose()` computes + audits the disposition (defaults `destructive=True`); and a **fail‑closed executor registry** (`register_action_handler` / `execute`) where a real source‑of‑truth write happens ONLY inside a registered handler and an action with no handler is REFUSED. Ships with **zero** handlers so it cannot write anything yet — inert + non‑breaking. 8 unit tests.
- **Persistence layer added (commit `e59cc6a`, additive, unpushed):** migration `66_pending_actions.sql` + `enqueue` / `list_pending` / `approve` / `reject` / `submit` in `broker.py` (17 unit tests, DB‑hermetic). No live path rerouted, so still inert.
- **Missing (needs decisions + live rerouting):** bind the Control Plane approval inbox to `approve`/`reject` (gateway `/actions` routes); register real handlers for ClickUp/email/Zoho; and route the existing bypassing writes (`routes/tasks/providers.py:365`, `email_ingestion/providers/*`) through `submit`. Plus **integration‑verify** the new SQL against a live Postgres. Until the wiring lands, either mark the write‑capable agents non‑autonomous or formally waive non‑negotiable #4.
- **Why needed:** It is non‑negotiable #4 ("no autonomous writes to source systems until the Action Broker is live") and the single control point for HITL over all outward writes. Today the guarantee is false.
- **Dependencies:** `03_pending_commits.sql`‑style queue table (add `pending_actions`); `acb_audit`; the Control Plane approval inbox; the auth fix (BO‑2) so approvals are authenticated.
- **Approach:** (1) Add a `pending_actions` table (proposal, actor, authority, payload, status, approved_by). (2) Make `propose()` enqueue and, per authority tier, either auto‑apply (read/idempotent), queue for approval, or reject. (3) Add an `execute(proposal)` that performs the provider write and is the *only* code path allowed to do so. (4) Route the existing ClickUp/email writes through it. (5) Reconcile docs with whichever model ships.
- **Note:** Until this lands, either mark the write‑capable agents (`agent_registry.json` sales/delivery/triage/billing) as **not** autonomous‑write, or accept and document that #4 is waived.

### BO‑2 — Enforceable authentication + authorization *(P0)* ◑
- **Missing:** `get_current_user` never rejects (`acb_auth/deps.py:76`); it only labels. So mutation‑approve (`agent.py:1852`, `git push`), the memory API (`memory.py`, IDOR), and `/agent/webhook/{source}` (`agent.py:2522`) were anonymous‑reachable. `/v1` had no auth at all.
- **Done this pass:** **✅ F1** authenticates `/v1`; **✅ F7** adds `acb_auth.require_internal_auth` and gates the state‑changing mutation routes + the whole `/memory` router (401 anonymous). This closes C1/C2/C6 for the specific dangerous endpoints.
- **Why needed:** Prevents anonymous code‑push, cross‑tenant memory read/delete, and unauthenticated agent triggering.
- **Dependencies:** Confirm each protected endpoint's caller sends the internal token or a real user session (the Next.js server routes and `memory.ts` already send `Bearer LITELLM_MASTER_KEY` — verified).
- **Residual (the systemic fix):** (1) Add `acb_auth.require_authenticated` (rejects when neither a valid internal bearer nor a domain‑verified `X-User-Email` is present) and make it the DEFAULT posture rather than opt‑in per route. (2) Cover the remaining `agent.py` routes and `oauth.py` (whose claimed admin gate is absent). (3) Sign/verify `/agent/webhook/{source}` (per‑source HMAC like the ingestion receivers) or remove it. (4) Split the service‑identity token from `LITELLM_MASTER_KEY` (`deps.py:56`) so an LLM key ≠ an identity secret.

### BO‑3 — Self‑mutation governance: human gate + real test gate + attempt counter *(P0)* ◑
- **Done this pass:** **✅ F8** — auto‑push is now opt‑in (`MUTATION_AUTO_PUSH`, default off) so a green commit stages in the approval inbox by default; `_tests_passed("")`/"no tests" now returns False (closes H3). **✅ H4** — `max_mutation_attempts` is now a REAL enforced counter: `mutation._register_mutation_attempt(run_id)` keeps a per‑run tally and refuses a second attempt for the same run (previously both call sites passed 0, so the `0 >= 1` guard was dead). 5 unit tests added (helper + the real entry point's early‑skip path).
- **Residual:** (1) Optionally define sandbox "success" as "a test command ran and exited 0 with ≥1 test" at the runner level (`mutation_runner.py:151`). (2) Wire mutation into the streaming path (H5) or explicitly scope it to structural failures and document that. (3) If cross‑restart durability is wanted, back the counter with Redis/Postgres instead of the in‑process dict (current scope — a restart is a fresh slate — is intentional and adequate given the human‑merge gate).
- **Dependencies:** `pending_commit` table (exists); Control Plane approval inbox; BO‑2 (authenticated approvals — the approve endpoint is now gated by F7).

### BO‑7 — Sandbox for dynamic agent execution (HH‑6) *(P1)* ☐
- **Missing:** cloned agent code runs in‑process (`loader.py:1247`) and installs deps into the shared gateway venv (`:1095`). No isolation.
- **Why needed:** Any compromised/malicious `agent-*` or `skill-*` repo (cross‑org clones allowed, `loader.py:1504`) gets arbitrary in‑process execution with access to all injected secrets and the DB. The mutation path is containerised; execution is not.
- **Dependencies:** the mutation sandbox image (`acb-mutation-runner`) as a reusable execution substrate; an IPC/result protocol; integration‑secret scoping so only the running agent's creds are exposed.
- **Approach:** Run each agent in the mutation‑style container (or a `nsjail`/subprocess with a per‑run venv and a dropped‑privilege user), stream results back over the existing event protocol. Interim mitigation: pin allowed orgs to `github_org`, and install deps into a per‑agent venv rather than the shared one.

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

---

## D. Orchestration & runtime

### BO‑12 — Reconcile the runtime story (MAF vs Copilot) *(P1)* ✅
- **Done (path a):** `AGENTS.md` reconciled to reality — runtime line, Purpose, and non‑negotiables **#6/#9** now describe MAF as the PRIMARY native runtime and the Copilot SDK as the supported second runtime for interactive coworker chat (Tier 1.5, `/copilot/chat`, BYOK‑routed) + the mutation sandbox, rather than "MAF sole / Copilot sandbox‑only" (closed H6). The unused **`WorkflowBuilder`** import + its "used for pipelines" docstring claim were removed from `orchestrator/agents.py` (closed M2 — it was imported, never instantiated). `as_tool()` is genuinely used, so that claim stays.

### BO‑13 — Break up the executor monolith *(P2)* ◑
- **Done this pass (behaviour‑preserving extractions, each verified green):** the 5,094‑line file is down to **4,069 lines** via four cohesive‑concern extractions, each re‑exported from `executor` so no importer changed:
  - `orchestrator/_todo_tracker.py` — todo‑SQL parsing.
  - `orchestrator/_copilot_session.py` — Copilot permission handler + infinite‑session policy.
  - `orchestrator/_tool_injection.py` — platform tool injection + system‑prompt addendum (~630 lines, the biggest cohesive concern).
  - `orchestrator/_model_resolution.py` — BYOK model resolution.
- **Regression net (`tests/unit/test_run_agent_stream_e2e.py`):** drives `run_agent_stream` end‑to‑end with mocked agents/loader (no git clone, no LLM, no Redis) and now covers BOTH tiers:
  - **Tier‑2 batch:** envelope contract (`RUN_STARTED` first → text streamed → `RUN_FINISHED` terminal), run_id/thread_id propagation, agent‑exception → `RUN_ERROR` (not a crash).
  - **Tier‑1 native streaming:** a mock agent that yields MAF‑shaped `run(..., stream=True)` updates → asserts the `TEXT_MESSAGE_START/CONTENT/END` lifecycle and `TOOL_CALL_START/ARGS/RESULT` events (via the real event_translator).
- **Residual:** the Tier‑1.5 Copilot‑SDK tier and the HITL‑parking / idle‑timeout / fall‑through control‑flow branches are not yet covered; and `run_agent_stream` is still one ~1,600‑line function.
- **Approach for the residual:** (1) extend the harness to the Copilot tier + HITL/idle branches. (2) THEN extract the native / Copilot / batch tiers behind a `Runtime` strategy interface — the `return`‑to‑end vs fall‑through‑to‑batch control flow is the delicate part, so it needs those branches covered first — and move HITL/session‑store/cleanup into collaborators, guarded by this net + the trajectory evals. (3) Ratchet the xenon absolute ceiling down from F.

### BO‑14 — Enforce the permission/risk model *(P1)* ◑
- **Done this pass:** **workspace‑path containment** shipped — `write_artifact`/`save_note`/`recall_notes` routed every caller path through a single `write_artifact.resolve_in_workspace` guard that fails closed on an embedded `..` or an absolute path resolving outside the workspace (previously `write_artifact` could write, and `recall_notes` could READ, arbitrary files). Also fixed a latent bug: `recall_notes` now applies the same `agent-data/` prefixing as `save_note`, so the documented `recall_notes("NOTES.md")` round‑trip actually works. 7 unit tests added.
- **Missing (the enforcement redesign):** the injected‑tool gate still can never deny (M5) and the destructive platform registry is empty. This is deliberately deferred — `decide()` currently *defers* destructive tools (approves, relying on each tool's own `request_confirmation`), so forcing denials risks false‑blocking legitimate tool use across every agent; it needs a product decision on which tools hard‑block + the confirmation UX.
- **Approach for the residual:** annotate the genuinely destructive platform tools (`install_dependency`, outward‑write tools) as `destructive`, pass full call context (not just the name) to `decide`, and make `enforce` mode block destructive/out‑of‑policy calls with a real confirmation card.

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
- **Residual:** update `AGENTS.md` package versions to the lockfile (`agent-framework-core 1.8.1`), fix the 3.11/3.12 mismatch, and update `infra/AGENTS.md`'s "no proxy files / no Langfuse" claims to match reality.

---

## Suggested sequencing

1. **P0 hardening sprint (do first):** BO‑8 (rotate+purge secrets), BO‑2 (auth enforcement), BO‑1 (Action Broker), BO‑3 (mutation governance). These close the Critical trust‑boundary and governance gaps that everything else sits on.
2. **P1 sprint:** BO‑7 (sandbox), BO‑5 (observability+cost), BO‑6 (migrations), BO‑12/BO‑14 (runtime + permission model), BO‑15 (LLM config SoT), BO‑17/BO‑18 (gates), BO‑19 residual.
3. **P2/P3:** BO‑9, BO‑10, BO‑11, BO‑13, BO‑16.

The review pass already delivered F1–F6 (see report §6), which knock out the open LLM proxy, the on‑disk secret/junk exposure, the false‑$0 cost bug, the migration‑number collision, and the worst doc drift — clearing the cheapest Critical/High items so the P0 sprint can focus on the architectural ones.
