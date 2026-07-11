# Foundation Build‑Out Checklist — CommandCenter

**Date:** 2026-07-11
**Companion to:** `FOUNDATION_AUDIT_REPORT.md`

This is the list of foundational capabilities that are **missing, partially implemented, or not yet wired up**. It excludes application features. Each item states what is missing, why it matters, what it depends on, a suggested approach, and a recommended priority. Items already addressed in the review pass are marked **✅ done (Fx)** and are retained here for completeness with any residual follow‑up.

**Priority legend:** **P0** = do before any new feature work · **P1** = next hardening sprint · **P2** = scheduled tech‑debt · **P3** = opportunistic.

**Status legend:** ☐ not started · ◑ partial · ✅ done this pass.

---

## A. Security & trust boundaries

### BO‑1 — Action Broker: real approval‑gated write path *(P0)* ☐
- **Missing:** `apps/action_broker/action_broker/broker.py` is a 46‑line stub (`propose()` only writes an audit row). No queue, no approval UI binding, no write executor, no authority‑tier enforcement. Nothing imports it. Meanwhile real ClickUp (`routes/tasks/providers.py:365`) and email (`email_ingestion/providers/*`) writes already ship, bypassing it.
- **Why needed:** It is non‑negotiable #4 ("no autonomous writes to source systems until the Action Broker is live") and the single control point for HITL over all outward writes. Today the guarantee is false.
- **Dependencies:** `03_pending_commits.sql`‑style queue table (add `pending_actions`); `acb_audit`; the Control Plane approval inbox; the auth fix (BO‑2) so approvals are authenticated.
- **Approach:** (1) Add a `pending_actions` table (proposal, actor, authority, payload, status, approved_by). (2) Make `propose()` enqueue and, per authority tier, either auto‑apply (read/idempotent), queue for approval, or reject. (3) Add an `execute(proposal)` that performs the provider write and is the *only* code path allowed to do so. (4) Route the existing ClickUp/email writes through it. (5) Reconcile docs with whichever model ships.
- **Note:** Until this lands, either mark the write‑capable agents (`agent_registry.json` sales/delivery/triage/billing) as **not** autonomous‑write, or accept and document that #4 is waived.

### BO‑2 — Enforceable authentication + authorization *(P0)* ◑
- **Missing:** `get_current_user` never rejects (`acb_auth/deps.py:76`); it only labels. So mutation‑approve (`agent.py:1852`, `git push`), the memory API (`memory.py`, IDOR), and `/agent/webhook/{source}` (`agent.py:2522`) are anonymous‑reachable. `/v1` had no auth at all (**✅ F1** fixes `/v1`).
- **Why needed:** Prevents anonymous code‑push, cross‑tenant memory read/delete, and unauthenticated agent triggering. Closes C2/C6 and the H1 root cause.
- **Dependencies:** Confirm each protected endpoint's caller sends the internal token or a real user session (the Next.js server routes and `memory.ts` already send `Bearer LITELLM_MASTER_KEY`).
- **Approach:** (1) Add `acb_auth.require_authenticated` (rejects when neither a valid internal bearer nor a domain‑verified `X-User-Email` is present). (2) Apply it as a router‑level dependency on `agent.py` (esp. all `mutations/*`), `memory.py`, and `oauth.py` (whose claimed admin gate is absent). (3) Sign/verify `/agent/webhook/{source}` (per‑source HMAC like the ingestion receivers) or remove it. (4) Split the service‑identity token from `LITELLM_MASTER_KEY` (`deps.py:56`) so an LLM key ≠ an identity secret.
- **Residual after F1:** the `/v1` open proxy is closed; the rest of BO‑2 remains.

### BO‑3 — Self‑mutation governance: human gate + real test gate + attempt counter *(P0)* ☐
- **Missing:** auto‑push without review (`mutation.py:210`); "success" = "a commit exists" not "tests passed" (`mutation_runner.py:151`); `_tests_passed("")==True` (`mutation.py:79`); `max_mutation_attempts` unenforced (H4).
- **Why needed:** A self‑modifying platform that pushes unreviewed code to agent repos is the highest‑blast‑radius governance gap; contradicts the "human must merge" model.
- **Dependencies:** `pending_commit` table (exists); Control Plane approval inbox; BO‑2 (authenticated approvals).
- **Approach:** (1) Remove `_auto_push_commit`; always stage to the `pending_commit` inbox. (2) Define success as "a test command ran and exited 0 with ≥1 test"; treat empty test output as failure. (3) Persist a per‑failure‑event mutation counter (in `agent_run` or a `mutation_attempts` table) and pass it to `attempt_self_mutation`. (4) Wire mutation into the streaming path (H5) or explicitly scope it to structural failures and document that.

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
- **Missing:** OTel is disabled and exports nowhere (H9); the OTLP exporter isn't installed; no collector in infra. Cost tracking reported a false `$0` for tier models (**✅ F4** fixes the $0→unknown correctness bug).
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

### BO‑6 — Migration framework + auto‑apply + `started_at` *(P1)* ◑
- **Missing:** 60+ raw numbered SQL files, no ledger/down‑migrations, not auto‑applied on `docker compose up` (H12); `agent_run.started_at` never written (M7). Duplicate #50 (**✅ F5**).
- **Why needed:** At 60+ files with hand‑idempotency and no ledger, a migration incident is a matter of time; a fresh stack silently lacks most tables.
- **Dependencies:** Alembic; a one‑time baseline of the current schema (`schema.generated.sql` exists as a start).
- **Approach:** Adopt Alembic (autogenerate baselined against `schema.generated.sql`), run it in `lifespan`/entrypoint, keep the raw files as historical. Add a CI check for unique numeric prefixes until then. Write `started_at` at run start in `run_trace`.

### BO‑10 — Consolidate DB access to one engine/pool *(P2)* ☐
- **Missing:** three engines (`acb_graph/db.py`, `routes/tasks/core.py`, `routes/email/core.py`), the foundational one unconfigured; sync `acb_audit.record()` blocks the async loop (H11).
- **Approach:** Provide a single configured async engine in `acb_graph` (sized pool), funnel all callers through it, and make `acb_audit.record()` async (or always call via `to_thread`).

### BO‑11 — Decide `acb_schemas`: wire in or delete *(P2)* ☐
- **Missing:** the package has 0 production importers and has drifted from the ORM/SQL (H10).
- **Approach:** Either adopt the Pydantic models as the real request/response surface for the entity API (and keep them aligned with `01_schema.sql`), or delete the package and its smoke‑test import. Deleting is the lower‑cost default.

---

## D. Orchestration & runtime

### BO‑12 — Reconcile the runtime story (MAF vs Copilot) *(P1)* ☐
- **Missing:** two coexisting runtimes while docs claim MAF is sole and Copilot is sandbox‑only (H6); MAF Workflow engine advertised but unused (M2).
- **Approach:** Either (a) update `AGENTS.md`/README to acknowledge Copilot‑SDK as a first‑class interactive runtime and define when each is used, or (b) migrate the Copilot‑SDK agents to native MAF. Remove the unused `WorkflowBuilder`/`as_tool()` claims or actually adopt the Workflow engine for the multi‑step pipelines it's advertised for.

### BO‑13 — Break up the executor monolith *(P2)* ☐
- **Missing:** `run_agent_stream` is one ~1,690‑line function inside a 5,094‑line file (M1).
- **Approach:** Extract Tier‑1/1.5/2 behind a `Runtime` strategy interface; move HITL parking, session store, and cleanup into collaborators. Then ratchet the xenon absolute ceiling down from F. Regression‑guarded by the existing trajectory evals.

### BO‑14 — Enforce the permission/risk model *(P1)* ☐
- **Missing:** the injected‑tool gate can never deny (M5); the destructive registry is empty; fail‑closed is a convention, not an invariant.
- **Approach:** Annotate the genuinely destructive platform tools (e.g. `install_dependency`, `write_artifact` with overwrite, any outward‑write tool) as `destructive`, pass full call context (not just the name) to `decide`, and make `enforce` mode actually block destructive/out‑of‑policy calls with a real confirmation. Add workspace‑path containment to `write_artifact`/`save_note`/`recall_notes` (currently `..`‑traversable).

---

## E. LLM configuration

### BO‑15 — Single source of truth for tier→model + context windows *(P1)* ☐
- **Missing:** four disagreeing definitions (M3); `_TIER_CONTEXT_WINDOWS` a stale second copy.
- **Approach:** Make the DB `model_config` table authoritative; delete `tier_overrides.yaml`, `enabled_models.json`, and the proxy directives in `config.yaml` once seeded; have `settings.py` read windows from `context.py`'s dynamic resolver instead of a hardcoded map. De‑dup the two tier‑alias maps (`client.py:44` / `v1_compat.py:30`).

### BO‑16 — Retire the vestigial LiteLLM proxy config *(P3)* ☐
- **Missing:** `infra/litellm/config.yaml` is a full proxy config but no proxy runs; only its tier rows are read (M6). `provider_models_cache.json` is a rotting committed cache.
- **Approach:** Reduce `config.yaml` to the tier map (or move fully to DB); delete `provider_models_cache.json`; align `infra/AGENTS.md` (which already claims the proxy files are gone).

---

## F. CI/CD & quality gates

### BO‑17 — Make the claimed gates real *(P1)* ☐
- **Missing:** mypy and full‑ruff are report‑only; evals are path‑gated (skip gateway/ingestion/reconciler); `deploy.yml` allows `skip_tests`; no coverage threshold (M10).
- **Approach:** Ratchet mypy/ruff to blocking per the existing plan; broaden the eval trigger paths or run a fast eval subset on every PR; remove `skip_tests` from production deploy; add `--cov-fail-under` for foundation packages. Reconcile README's CI claims.

### BO‑18 — Secret‑scanning + large‑file gates that actually catch history *(P1)* ☐
- **Missing:** the large‑file hook only inspects new additions (it missed `acb_dump.bak`); no secret scanner.
- **Approach:** Add `gitleaks`/`detect-secrets` to pre‑commit and CI; add `.gitignore` rules for `*.pid`/`*.bak`/`*token_cache*` (**✅ F2**); add a CI job that fails on any tracked file > 1 MB.

---

## G. Documentation

### BO‑19 — Doc↔code reconciliation *(P1)* ◑
- **Missing:** README described LangGraph/Theia/PostgresSaver/escalation_ui and had a garbled layout (**✅ F3** rewrites it); stale "placeholder"/LangGraph docstrings across packages (**✅ F6** sweeps the worst); `AGENTS.md` version pins lag; `AGENTS.md`/README Python‑version mismatch.
- **Residual:** update `AGENTS.md` package versions to the lockfile (`agent-framework-core 1.8.1`), fix the 3.11/3.12 mismatch, and update `infra/AGENTS.md`'s "no proxy files / no Langfuse" claims to match reality.

---

## Suggested sequencing

1. **P0 hardening sprint (do first):** BO‑8 (rotate+purge secrets), BO‑2 (auth enforcement), BO‑1 (Action Broker), BO‑3 (mutation governance). These close the Critical trust‑boundary and governance gaps that everything else sits on.
2. **P1 sprint:** BO‑7 (sandbox), BO‑5 (observability+cost), BO‑6 (migrations), BO‑12/BO‑14 (runtime + permission model), BO‑15 (LLM config SoT), BO‑17/BO‑18 (gates), BO‑19 residual.
3. **P2/P3:** BO‑9, BO‑10, BO‑11, BO‑13, BO‑16.

The review pass already delivered F1–F6 (see report §6), which knock out the open LLM proxy, the on‑disk secret/junk exposure, the false‑$0 cost bug, the migration‑number collision, and the worst doc drift — clearing the cheapest Critical/High items so the P0 sprint can focus on the architectural ones.
