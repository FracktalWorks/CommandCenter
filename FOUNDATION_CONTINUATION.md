# Foundation Audit — Continuation & Handoff Guide

**Purpose:** everything still needed to finish the foundational audit + fixing, written so it can be picked up on a machine **with Postgres access**. Read this alongside `FOUNDATION_AUDIT_REPORT.md` (findings) and `FOUNDATION_BUILDOUT_CHECKLIST.md` (item tracker). This doc is the *executable* plan — concrete files, DDL, code sketches, test approach, and verification commands.

**Branch:** originally `claude/foundation-architecture-audit-ftur3x`; **now merged to `main`** (see status block below).
**Status at handoff:** 30 commits, unit suite **887 passed**, trajectory evals **118 passed**, both CI blocking gates (ruff-correctness, xenon) green. Everything shipped so far is behaviour-safe and additive/non-breaking.

---

## ⏱️ LATEST STATUS — updated 2026-07-13 (Session 2)

**The whole foundation branch is MERGED to `main`, DEPLOYED, and VERIFIED LIVE on prod.** Everything in Section 0 is running in production.

**Deployment / git state**
- `origin/main` = **`2965944`** — includes the foundation merge (`1991f43`), the `acb_graph` connect_timeout (`ccccdc8`, deployed+verified live), and the two gateway-engine connect_timeouts (`1684e1a`).
- **`local main` is 4 commits AHEAD of origin/main — NOT pushed** (autonomous Session-2b work, held for review; a push = a prod deploy):
  - `1ff6c0d` — `connect_timeout` on the four `email_ingestion` async engines (completes BO-10 connect_timeout across every engine).
  - `e59cc6a` — **A2**: `pending_actions` migration (66) + broker `enqueue/list_pending/approve/reject/submit` + tests (8→17).
  - `0cc5228` — docs for the above.
  - `9d0888e` — **A2**: gateway `/actions` approval-inbox routes (`GET /actions/pending`, `POST …/approve`, `…/reject`), all `require_internal_auth`-gated + 4 tests. App verified to import with the routes registered.
  - All additive; **no live write path rerouted** (that needs the B1 authority decision), so the broker stays inert. The new SQL is unit-tested (mocked) but **not yet integration-verified against a live Postgres**.
- **ACTION FOR NEXT SESSION:** review the 4 local commits + integration-verify against a live PG; then `git push origin main` (watch `deploy.yml` + `/health`) when ready.

**Prod verification done this session (all ✅, read-only):**
- Migrations applied: `gtd_items.origin` JSONB + index, `agent_avatars`, `agent_run` trace table.
- **Internal-auth gating (F1/F7):** `/v1/chat/completions` → **401** with no auth *and* with a bogus bearer (does not fail open).
- **Action Broker (BO-1):** policy correct, **0 handlers registered = inert** (cannot write — as designed).
- **Executor refactor (BO-13):** re-exports + all 4 extracted submodules import cleanly in prod.
- **Containment (BO-14)** `resolve_in_workspace` present; **mutation counter (BO-3)** `_register_mutation_attempt` present.
- `audit_event` table has ~17k rows → the audit happy-path writes fine; the connect_timeout only bounds pathological hangs.

**New robustness fix this session — DB `connect_timeout` (BO-10 partial):**
- **Problem found:** `acb_audit.record()` promises "never block the caller" and wraps its DB write in try/except, but a hanging TCP/TLS connect is **not** an exception, and the engines had **no connect timeout** → a slow/firewalled DB could hang an agent indefinitely (observed: a unit run wedged 90s on one audit write).
- **Shipped:** `settings.db_connect_timeout` (default 10s), threaded into `acb_graph.get_engine()` via `_engine_kwargs()` for Postgres URLs only (ccccdc8, LIVE), and into the two gateway asyncpg engines via `connect_args={"timeout": …}` (1684e1a, committed-local-unpushed). Test: `tests/unit/test_db_connect_timeout.py`.
- **Still open under BO-10:** the per-call async engines in `email_ingestion/{scheduler,inbound}.py` (also leak an engine per call — BO-9), consolidating to **one** shared engine, and making `acb_audit.record()` non-blocking (`async`/`to_thread`).

**⚠️ Windows test-runner caveat (important for the next session):**
Running the **full** `tests/unit/` on Windows against a live/localhost DB **hangs** — several non-hermetic "unit" tests (`test_memory_e2e`, `test_action_broker` via the audit write, others) make real DB/network connects that **Linux/CI fast-refuses but Windows does not** (Windows doesn't fast-refuse `::1`/`127.0.0.1:5432` with no listener). And pytest-timeout's only Windows method is `thread`, which `os._exit`s the whole run on the first hang. **Workarounds:**
- Point the DB at a fast-refusing IPv4 and deselect the e2e tests:
  ```bash
  DATABASE_URL="postgresql+psycopg://acb:x@127.0.0.1:1/acb" REDIS_URL="redis://127.0.0.1:1/0" \
  uv run --with pytest-timeout python -m pytest tests/unit/ --timeout=60 --timeout-method=thread \
    --ignore=tests/unit/test_memory_e2e.py --ignore=tests/unit/test_memory_integration.py \
    --ignore=tests/unit/test_run_agent_stream_e2e.py --ignore=tests/unit/test_integration_env_scoping.py -q
  ```
  → last clean run: **816 passed, 9 deselected, 0 failed**.
- Or treat **CI (Linux) as the authoritative full-suite oracle** — push the branch and let `pr-check.yml` run it.

**Recommended next work:** **BO-1 Action Broker persistence + wiring (§A2)** — the top P0, now Postgres-unblocked; needs the §B1 authority decision first. Pair with the small remaining BO-10 items above. (Secret rotation **BO-8** is the other P0 but needs owner credentials to rotate the Zoho token.)

---

## 0. What is already done (so you don't redo it)

| Area | Done | Commit theme |
|---|---|---|
| Deliverables | Audit report + build-out checklist | `docs: foundation architecture audit …` |
| Secrets/junk | Removed `.zoho_token_cache.json`, `acb_dump.bak`, `gateway.pid`, `_test_byok_final.py` from tree + `.gitignore` | F2 |
| Open LLM proxy | `/v1/chat/completions` now requires internal bearer; SSRF passthrough gated; error strings sanitized | F1 |
| Anonymous mutation push / memory IDOR | mutation approve/reject/… + `/memory/*` gated on `require_internal_auth` | F7 |
| Self-mutation governance | Auto-push opt-in (`MUTATION_AUTO_PUSH`, default off); empty tests ≠ green; **real** `max_mutation_attempts` counter | F8 + BO-3 |
| Cost/obs | Unpriced models report *unknown* not `$0`; tier label populated on agent traffic; embeddings degradation warns | F4 + batch |
| LLM config | Tier-alias map de-duplicated to one source of truth | batch |
| Migrations | Duplicate `#50` resolved; CI guard test for unique prefixes | F5 + batch |
| Docs | README rewritten to reality; stale LangGraph/placeholder docstrings swept | F3 + F6 |
| Executor | 5,094 → 4,069 lines: extracted todo-tracker / copilot-session / tool-injection / model-resolution modules | R1–R4 |
| Streaming coverage | First end-to-end `run_agent_stream` regression harness (batch + native tiers) | BO-13 enabler |
| Path security | `write_artifact`/`save_note`/`recall_notes` containment guard (`resolve_in_workspace`) | BO-14 (path) |
| Dead code | Removed the `acb_schemas` phantom package; fixed the `email-validator` under-declaration it exposed | BO-11 |
| Action Broker | Real authority-policy + fail-closed executor **core** (no handlers → still inert) | BO-1 core |

**What that leaves** is exactly the work that needs (a) a running Postgres, (b) a product decision, or (c) broader test coverage before risky surgery. Those are Sections A–D below.

---

## 1. Environment setup on the new (Postgres-capable) machine

```bash
# 1. Python workspace
uv sync

# 2. Bring up the data plane (Postgres 16 + pgvector, Redis, optional Neo4j)
docker compose -f infra/docker-compose.yml up -d postgres redis
#   compose ONLY auto-loads 00_create_databases.sql + 01_schema.sql on a fresh
#   volume. Everything 02+ must be applied explicitly:
bash scripts/apply_migrations.sh          # env: PG_CONTAINER (default acb-postgres), APP_DIR

# 3. Point the app at the DB (settings.database_url / POSTGRES_* in .env)
cp .env.example .env    # then set POSTGRES_*, LITELLM_MASTER_KEY, ACB_MASTER_KEY

# 4. Verify
uv run python -m pytest tests/unit/ -q                 # expect 887 passed
uv run python -m pytest evals/trajectories/ -q         # expect 118 passed
uv run python -m pytest -m integration -q              # NEW: needs the docker stack (see §A0)
```

**DB connection facts:**
- Settings key: `database_url` (`packages/acb_common/acb_common/settings.py`), default `postgresql+psycopg://acb:acb_dev_change_me@localhost:5432/acb`.
- Access layer: `acb_graph.get_session()` (sync SQLAlchemy). Async engines also exist in `routes/tasks/core.py` and `routes/email/core.py` (see BO-10).
- Migrations dir: `infra/postgres/NN_*.sql` (idempotent by hand); runner: `scripts/apply_migrations.sh`; applied on deploy by `deploy/hostinger/deploy.sh:71` and `.github/workflows/deploy.yml:163`.

---

## A. Postgres / live-infra-gated work (do these first on the new machine)

### A0. Make integration tests actually runnable + wire them into CI *(prereq, ~0.5 day)*
- **Why:** `pyproject.toml` marks integration tests `-m 'not integration'` by default and **no CI job runs them**. With a DB you can finally exercise the real persistence paths (audit writes, `agent_run` trace, chat history, key store, pending_commit). This is the safety net for everything else in Section A.
- **Do:**
  1. `uv run pytest -m integration` against the live stack; fix any bit-rot.
  2. Add an `integration` job to `.github/workflows/pr-check.yml` that spins up `postgres`/`redis` service containers, runs `apply_migrations.sh`, then `uv run pytest -m integration`.
- **Verify:** integration job green in CI.

### A1. Migration framework — Alembic + auto-apply (BO-6) *(P1, ~1–2 days)*
- **Problem:** 60+ raw numbered SQL files, no ledger, re-run every deploy, and a bare `docker compose up` yields a DB missing everything ≥ `02_`. No down-migrations, no checksums.
- **Approach (incremental, low-risk):**
  1. **Ledger first (smallest safe win):** add a `schema_migrations` table (`filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ`). Modify `scripts/apply_migrations.sh` to `INSERT … ON CONFLICT DO NOTHING` and **skip** files already recorded. This stops the "re-run all 60 every deploy" behaviour and gives a real applied-set. Idempotent SQL means this is safe to introduce mid-stream.
  2. **Adopt Alembic:** `uv add --dev alembic`; `alembic init infra/alembic`; set `sqlalchemy.url` from `settings.database_url`. Baseline against the current schema — `infra/postgres/schema.generated.sql` is a `pg_dump` snapshot you can use as the `alembic stamp head` starting point. Keep the raw `NN_*.sql` files as historical; new schema changes become Alembic revisions.
  3. **Auto-apply on boot:** call `alembic upgrade head` from the gateway `lifespan` (or an entrypoint) so a fresh stack is never missing tables.
- **Files:** `scripts/apply_migrations.sh`, new `infra/alembic/`, `apps/gateway/gateway/main.py` (lifespan), `pyproject.toml`.
- **Verify:** fresh volume → `docker compose up` + boot → all tables present; `alembic current` == head; the existing `tests/unit/test_migration_prefixes.py` still green.
- **Keep** the unique-prefix guard test until Alembic fully owns ordering.

### A2. Action Broker — persistence + wiring (BO-1 residual) *(P0, ~2–3 days; needs §B1 decisions)*
The **core + persistence layer are built** (`apps/action_broker/action_broker/broker.py`, all unit-tested, 17 tests). **Done (commit `e59cc6a`, additive, unpushed):** migration `66_pending_actions.sql`, and `enqueue` / `list_pending` / `approve` / `reject` / `submit`. **Remaining = steps 4–5 below** (gateway routes + inbox, then registering real handlers and rerouting the bypassing writes) — these need §B1 and touch live paths, plus **integration verification against a live Postgres** (the mocked unit tests prove the logic, not the SQL against PG).
1. ~~**`pending_actions` table**~~ ✅ shipped as `infra/postgres/66_pending_actions.sql`. *(Original sketch below for reference.)*
   ```sql
   CREATE TABLE IF NOT EXISTS pending_actions (
       id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
       actor        TEXT NOT NULL,          -- "agent:sales"
       action       TEXT NOT NULL,          -- "clickup.comment"
       target       TEXT NOT NULL,          -- "task:<id>"
       payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
       authority    TEXT NOT NULL,          -- read|suggest|suggest+apply|autonomous
       destructive  BOOLEAN NOT NULL DEFAULT true,
       disposition  TEXT NOT NULL,          -- auto_apply|needs_approval|rejected
       status       TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','applied','failed')),
       result       JSONB,
       reviewed_by  TEXT,
       reviewed_at  TIMESTAMPTZ,
       created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS pending_actions_status_idx ON pending_actions (status, created_at DESC);
   ```
2. ~~**`enqueue` / `list_pending` / `approve` / `reject`**~~ ✅ done (`e59cc6a`). `approve()` loads the row → `execute()` → marks `applied`/`failed` + `result`; fails closed on missing/non-pending rows.
3. ~~**`submit(proposal)`**~~ ✅ done (`e59cc6a`): `AUTO_APPLY`→`execute()`, `NEEDS_APPROVAL`→`enqueue()`, `REJECTED`→refuse.
4. ~~**Gateway routes**~~ ✅ done (`9d0888e`): `apps/gateway/gateway/routes/actions.py` — `GET /actions/pending`, `POST …/approve`, `…/reject`, all `require_internal_auth`-gated, registered in `main.py`. **Still to do:** the Next.js proxy + an inbox pane (mirror the mutation inbox).
5. **Register real handlers** and **route existing writes through the broker** — the actual bypassing sites:
   - ClickUp: `apps/gateway/gateway/routes/tasks/providers.py:261,365` (`http.post`).
   - Email send: `apps/email_ingestion/email_ingestion/providers/{gmail,outlook,imap}.py` (`base.py` send path).
   Wrap each as a handler `async def _clickup_comment(p): …` registered via `register_action_handler("clickup.comment", …)`, and replace the direct call site with `await action_broker.submit(propose(actor, "clickup.comment", target, payload, authority=<per §B1>, destructive=<per action>))`.
- **Verify (integration):** an `autonomous`-tier action auto-applies + audits; a `suggest+apply` destructive action lands in `pending_actions` and only writes after `approve()`; a `read`-tier actor is rejected; an action with no handler is refused (already unit-tested).

### A3. Verify the DB-dependent fixes already shipped *(0.5 day)*
With a DB, confirm end-to-end (they're unit/mocked today):
- **`agent_run.started_at`** now written at true run start (M7) — run a chat, check `SELECT run_id, started_at, ended_at FROM agent_run ORDER BY started_at DESC` orders by real start.
- **Cost tracking** — confirm `/observability` spend view shows per-tier costs (not `$0`, not blank tier).
- **BYOK key store** round-trips (`acb_llm/key_store.py`) against the real `provider_keys` table.

---

## B. Decision-gated work (needs a human call; then buildable + testable)

### B1. Authority model for the Action Broker (unblocks A2) — **DECISION NEEDED**
Decide, per first-party agent in `agent_registry.json` (sales, delivery, triage, reconciler, billing, task-manager, strategy):
- its **AuthorityTier** (`read` | `suggest` | `suggest+apply` | `autonomous`), and
- which **actions are destructive/outward-facing** (email send, CRM write, ClickUp status change → yes; read-cache refresh → no).
**Recommendation:** start everyone at `suggest+apply` with all outward writes marked `destructive=True` (so every real write is human-approved) and relax to `autonomous` per-agent later. This satisfies non-negotiable #4 immediately.

### B2. Systemic auth posture (BO-2) — **DECISION NEEDED**
`get_current_user` (`packages/acb_auth/acb_auth/deps.py`) **never rejects** — it only labels. The dangerous endpoints are now gated (F1/F7), but the default posture is still fail-open.
- **Decision:** flip to **default-deny** (add a global dependency / middleware requiring a valid internal bearer or domain-verified SSO identity, with an explicit allow-list for `/health`, OAuth callback, provider webhooks), or keep gating per-route?
- **Recommendation:** default-deny with a small public allow-list. Then: sign/verify `/agent/webhook/{source}` (currently unauthenticated, `apps/gateway/gateway/routes/agent.py:2522`), gate `oauth.py` (its "admin gate" is absent), and split the service token from `LITELLM_MASTER_KEY` (`deps.py:56`).
- **Build after decision:** add `acb_auth.require_authenticated`; apply as router-level dependency; add per-source HMAC to the agent webhook (mirror `ingestion/sources/*/webhook.py`). Unit-test allow/deny; integration-test the webhook signature.

### B3. Runtime story (BO-12) — **DECISION NEEDED**
Two runtimes coexist (native MAF + GitHub Copilot SDK) while `AGENTS.md` claims MAF-only. Also `WorkflowBuilder`/`as_tool()` are advertised but unused (M2).
- **Decision:** (a) accept Copilot-SDK as a first-class interactive runtime and **update `AGENTS.md`/README** to say when each is used, or (b) migrate the Copilot-SDK agents to native MAF.
- Lowest-effort correct move: (a) — update the docs; delete the unused `WorkflowBuilder` import/claims or actually adopt the Workflow engine.

---

## C. Larger refactors — need more coverage first (then execute)

### C1. Finish the executor decomposition (BO-13) *(P2, ~2–3 days)*
- **Have:** `tests/unit/test_run_agent_stream_e2e.py` covers the **batch (Tier-2)** + **native-streaming (Tier-1)** paths (envelope order, text streaming, tool events, id propagation, error→RUN_ERROR).
- **Next (coverage before surgery):** extend that harness to (a) the **Tier-1.5 Copilot** path (mock a `GitHubCopilotAgent`-shaped agent), (b) **HITL parking** (`ask_user`/`ask_questions` → `user_input_requested` frame → `resolve_user_input`), (c) the **idle-timeout** and **fall-through** branches.
- **Then extract:** pull Tier-1/1.5/2 out of `run_agent_stream` (currently ~1,600 lines, 4 exit paths, ~12 closed-over locals) behind a `Runtime` strategy interface; move HITL/session-store/cleanup into collaborators. Guard with the harness + trajectory evals. Ratchet the xenon absolute ceiling down from `F`.
- **Do NOT** attempt the extraction until the Copilot/HITL/idle branches are covered — those are the paths the current net misses.

### C2. Permission-gate enforcement (BO-14 residual) — part decision, part build *(P1)*
- The injected-tool gate (`orchestrator/_copilot_session._gate_injected_tool` → `acb_skills.permission_policy.decide`) can never deny; the destructive **platform** registry (`acb_skills/tool_annotations.py`) is empty.
- **Decision:** which platform tools hard-block in `enforce` mode (candidates: `install_dependency`, any outward-write tool), and the confirmation UX.
- **Build:** annotate those tools `destructive`; pass full call context (not just the name) to `decide`; make `enforce` actually block with a real confirmation card. **Risk:** false denials break legit tool use — ship behind a flag + trajectory eval first.

---

## D. Remaining medium/smaller items (mostly DB-independent; batchable)

| Item | What | Where | Notes |
|---|---|---|---|
| **BO-4** event bus | Redis Streams producer (`ingestion/queue.py`) has **no consumer**; `ingestion.worker` referenced but missing; webhook→agent flow not wired | `apps/ingestion/` | Ship `ingestion/worker.py` (`xreadgroup` loop → dispatch to executor) OR drop the "event bus" claim. Connect provider webhooks → agent dispatch. Needs Redis. |
| **BO-5** observability | OTel disabled + exporter not installed + no collector | `acb_common` deps, `infra/docker-compose.yml`, `executor` kill-switch | Either add `opentelemetry-exporter-otlp` + a collector (Langfuse half-present under `obs` profile) and re-enable MAF/LiteLLM tracing, or delete the OTel deps + "OTLP-ready" claim. |
| **BO-9** lifecycle | Fire-and-forget `ensure_future` warmups untracked/never cancelled; no engine/Neo4j dispose on shutdown; Redis per-call in ingestion | `apps/gateway/gateway/main.py`, `ingestion/queue.py` | Hold task refs + cancel after `yield`; create/dispose a shared engine + Redis pool in `lifespan`. |
| **BO-10** DB engines ◑ | **Partial:** `connect_timeout` now on **every** engine — `acb_graph` (ccccdc8), the two gateway engines (1684e1a), and the four `email_ingestion` engines (`1ff6c0d`, local). **Left:** consolidate to ONE shared async engine; **make sync `acb_audit.record()` non-blocking** (still blocks the loop on async paths). | `acb_graph/db.py`, `routes/tasks/core.py`, `routes/email/core.py`, `email_ingestion/*`, `acb_audit/log.py` | Provide one configured async engine in `acb_graph`; funnel all callers; make `record()` async (or always `to_thread`). |
| **BO-15** LLM SoT | tier→model still defined in 4 disagreeing places; `_TIER_CONTEXT_WINDOWS` a stale copy | `acb_llm/client.py`, `infra/litellm/*.yaml`, `settings.py`, DB `model_config` | Make DB `model_config` authoritative; delete `tier_overrides.yaml`/`enabled_models.json`/proxy directives once seeded; have `settings.py` read windows from `context.py`. |
| **BO-16** vestigial proxy | `infra/litellm/config.yaml` is a full proxy config but no proxy runs; `provider_models_cache.json` a rotting committed cache | `infra/litellm/`, `infra/provider_models_cache.json` | Reduce to the tier map (or DB); delete the cache; align `infra/AGENTS.md`. |
| **BO-7** sandbox | Dynamic agent code runs in-process w/ full gateway privileges; deps install into shared venv | `acb_skills/loader.py` | Run agent execution in the mutation-style container / restricted subprocess w/ per-run venv. Big; security-critical. |
| **L5** dedup | `_find_uv` (loader + dep_tools), 3 workspace-root resolvers (note_tools/error_tools/permission_policy — partly unified by `resolve_in_workspace`), 2 `_split_frontmatter` (registry/agent_md) | `packages/acb_skills/*` | Pure refactors; consolidate into shared helpers. Testable, low-risk. |
| **M14** role check | `UserRole` has `agent` but `app_user` CHECK allows only `executive|employee` | `acb_auth/roles.py`, `infra/postgres/09_app_user.sql` | `agent` is synthetic/in-memory — either widen the CHECK or document it. |
| **BO-8 residual** | Rotate the leaked Zoho token + `git filter-repo` the removed secret files out of **history**; make signing/DB/master keys fail-closed in prod | repo history, `settings.py` | **Owner action** (history rewrite forces re-clone; needs the real token rotated). Add `gitleaks`/`detect-secrets` pre-commit + CI. |

---

## E. Definition of done for the foundational audit

The foundation is "production-ready" (the audit's bar) when:
1. **Trust boundaries enforced:** default-deny auth (B2); Action Broker gates all outward writes (A2/B1); dynamic agent code sandboxed (BO-7); leaked secret rotated + purged from history (BO-8 residual).
2. **Governance real:** self-mutation counter + human gate + real test gate — **done** (BO-3/F8); mutation wired into the streaming path or explicitly scoped (H5).
3. **Data layer sound:** Alembic + auto-apply (A1); one DB engine + non-blocking audit (BO-10).
4. **Observability honest:** either real OTLP export + collector, or the claim removed; cost per-tier populated — **partly done** (BO-5).
5. **Event flow wired:** webhook→agent path real, or the bus claim removed (BO-4).
6. **Executor maintainable:** `run_agent_stream` decomposed behind a `Runtime` interface, xenon ceiling ratcheted (C1).
7. **Docs match code:** runtime story reconciled (B3); `AGENTS.md` versions/claims current.
8. **Gates real:** mypy/ruff/eval blocking per the ratchet; integration tests in CI (A0); secret-scanning (BO-8).

Track item-level status in `FOUNDATION_BUILDOUT_CHECKLIST.md` (updated live: ✅ done · ◑ partial · ☐ not started).

---

## F. Working conventions for whoever continues

- **One concern per commit**, each verified: `uv run python -m pytest tests/unit/ -q` (887 baseline) **and** `uv run python -m pytest evals/trajectories/ -q` (118 baseline) must stay green; run the CI blocking gates too: `uv run ruff check . --select F821,F601,F602,F502,F7,B006` and `uv run xenon --max-absolute F --max-modules F --max-average B apps packages`.
- **Additive first:** prefer non-breaking expansion (like the Action Broker core) over rerouting live paths, until the relevant decision (Section B) is made.
- **Behaviour-preserving refactors** re-export moved symbols so importers don't change (see the R1–R4 executor extractions for the pattern).
- **Update the checklist** (`FOUNDATION_BUILDOUT_CHECKLIST.md`) status marker with each change.
- When a combined `pytest tests/unit evals/trajectories` run hangs, it's local-runner contention from orphaned processes — run the two suites separately (they pass cleanly apart).
- **On Windows, the full `tests/unit/` hangs against a live/localhost DB** (non-hermetic tests + Windows not fast-refusing `::1:5432`). Use the DB-override + deselect recipe in the LATEST STATUS block, or lean on CI (Linux) as the full-suite oracle. Kill orphaned `pytest`/`python` processes between runs (they starve CPU and cause false "hangs").
- **`git push origin main` = auto-deploy.** Commit freely to `main` locally, but treat every push as a production deploy — get explicit go-ahead, then watch `gh run list --workflow=deploy.yml` + the gateway `/health` on the VPS.
