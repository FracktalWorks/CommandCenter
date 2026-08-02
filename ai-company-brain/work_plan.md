# Work Plan of Record — the dispatch board

**Status:** Active · **Date:** 2026-07-31 · **Owner:** vjvarada
**Purpose:** the single sequencing document from which independent agents are
dispatched. Content lives in the owning specs; *this* doc owns ordering,
ownership, and the rules that make a spec executable without questions.

Built from a three-way audit (2026-07-31) of the foundation docs, the app
master plans, and the platform specs. The audit found the corpus rich but not
dispatchable: status drift (docs claiming "not built" for shipped work and
vice versa), the same work claimed by 2–6 specs with no single owner, and
broken anchors (stale migration numbers, pre-restructure file paths, colliding
phase IDs). §5 is the remediation backlog; §2 is the board.

**Authority.** For *what to build and how*, the owning spec wins. For *what
order and who owns it*, this doc wins — including over `project_plan.md` §6
sequencing for near-term work. When a mirror spec disagrees with the owner
named in §4, the mirror is stale by definition; fix the mirror.

---

## 1. The agent-ready spec contract

A workstream may be handed to an independent agent only when its owning spec
carries all seven. (Exemplars: `permissions_sandbox_b6.md` Tier 0 for tests +
decision table; `drawio_integration.md` for per-ticket "done when";
`task_manager_app.md` §9.3 for the runbook; `observability_e2.md` for
verification commands.)

1. **Status header** — dated, with "verified against code on <date>". A header
   that contradicts the body (WhatsApp, task-manager) is worse than none.
2. **Scope and non-goals** — explicit, like email master §1.
3. **Acceptance per item** — a "done when" an agent can test, not "owner call".
4. **Current file paths** — `apps/services/...` tree; anchors re-verified at
   dispatch, not trusted from authoring time.
5. **Verification commands** — the exact pytest/tsc/build/feature_check calls.
6. **Single owner** — one owning spec; every other doc that mentions the work
   links here and adds nothing.
7. **Gate labels** — every item marked **AGENT-SAFE** or **OWNER-GATE**
   (see §6). An agent must refuse OWNER-GATE work and say so.

**Standing rules** (bind all specs from today):
- **R1 — no absolute future migration numbers.** Write "next free number at
  build time". The audit found ~12 wrong citations (117/118/119/120/122/123/
  128/131/133/134/135 all point at unrelated shipped migrations).
- **R2 — no phase-ID reuse across docs.** "Phase 2" currently means three
  different things. New work uses the WS-n IDs below.
- **R3 — nomenclature per `department_centers.md` §1.** "Agent Workshop" not
  "Agent Creator" (5 spec sites violate this); "Agent Registry" for `/agents`;
  Center/module/group as defined there.
- **R4 — status changes propagate.** A PR that ships spec'd work updates the
  owning spec's status header in the same PR.

---

## 2. The dispatch board

States: 🟢 ready to dispatch · 🟡 dispatchable after the named gate ·
🔴 blocked on owner/decision · ✅ done. "Docs" gate = the §5 fix for that spec.

### WS-0 · Documentation remediation — ✅ executed 2026-08-01 (residuals in §5)
Six-agent truth pass completed: Tier 1 (items 1–10), Tier 2 (11–17), and the
Tier 3 annotations are done, verified against code. Residual items listed at
the top of §5. Findings folded back into this doc: D7 gained the MAF-side MCP
gap; calendar P3 was found already shipped (with revised roll-over semantics).

### Substrate (foundation)

| WS | Workstream | Owning spec | State | Next / notes |
|---|---|---|---|---|
| WS-1 | **Action Broker truth + completion** (BO-1) | `FOUNDATION_BUILDOUT_CHECKLIST.md` §BO-1 (corrected 2026-08-01) | 🟢 | Broker loop LIVE (inbox, `/actions`, ClickUp + WhatsApp + workflow handlers). Remaining: email/Zoho handlers, verify vs live DB. **OWNER-GATE:** flipping `ACTION_BROKER_ENFORCE` on. |
| WS-2 | **Secrets** (BO-8: rotate Zoho token, purge history, fail-closed) | checklist §BO-8 + `FOUNDATION_CONTINUATION.md` | 🔴 | **OWNER-GATE end-to-end** (force-push, rotation). Standing P0 since 2026-07-11. |
| WS-3 | **Isolation ladder** (BO-7 / HH-6 / B6 Tier 1→2, `tool_scope` deny, T2 for non-first-party agents) | `permissions_sandbox_b6.md` + `agent_platform_hardening_2026-07.md` Part 1 | 🟢 Tier 1 | Tier 1 container flags partially landed 2026-07-27 (competitive log) — reconcile B6 first. T2 is its own sub-project; required before Agent Workshop opens to non-engineers. **OWNER-GATE:** `AGENT_PERMISSION_MODE=enforce` flip. |
| WS-4 | **Event-bus consumer + durable queue** (BO-20) | `FOUNDATION_BUILDOUT_CHECKLIST.md` §BO-20 — **the file is at the REPO ROOT, not under `ai-company-brain/`** (this row's old anchor was wrong) | 🟢 BO-20f · 🔴 a–e | **State cell:** §2's legend has no single state for *"one sub-item dispatchable now, the rest blocked on an owner call"*, so this cell composes the two that are individually true — BO-20f is 🟢 ready to dispatch **today**, BO-20a–e are 🔴 blocked on §BO-20.0. **Audited 2026-08-02 → NO-GO; §BO-20 rewritten the same day and now carries acceptance criteria, verification commands, gate labels and anchors.** ⚠️ **NOT a greenfield build: webhook→run is ALREADY wired.** ClickUp → `ingestion/event_hooks.emit_event` → `workflows/triggers.dispatch_event` → `start_run` has been live since commit `e20ea830`, and `/agent/webhook/{source}` is a second live path — the old row's "trigger no agent" premise died there, and an implementer handed it would have built a parallel dispatch path. What IS missing is narrower: `xreadgroup`/`xack` exist **nowhere in the repo**, so `ingestion:*` and `ingestion:dlq` are write-only and trimmed unread (no durability, no replay, no retry, no drainable DLQ, no rate limit, no bounded concurrency), and only 1 of 3 receivers emits at all. **🔴 ONE OWNER DECISION BLOCKS BO-20a–e (not f) — §BO-20.0, the process model:** *Option A, an in-process supervised asyncio consumer started from the gateway lifespan* (**recommended** — `workflows_app.md` §9 D6 names this the house style and says "Revisit under BO-20"; five such loops are already wired into the lifespan; ships by ordinary merge) vs *Option B, a separate `python -m ingestion.worker` process* (needs a new systemd unit on the VPS — **an agent cannot deploy it**, so that PR would merge and do nothing; picking B re-labels the deployment half of BO-20a–e OWNER-GATE). Answer with one line: `BO-20 = Option A` or `BO-20 = Option B` — but note that **only Option A unblocks BO-20a–e as written**; Option B leaves the dispatch step undefined (a separate process starts with an empty `event_hooks._SINKS`, so it would `XREADGROUP`, `XACK` and dispatch to nothing), so answering B buys a design round plus a rewrite of BO-20a, not a dispatch. **BO-20f (Gmail/Zoho receivers reach ClickUp's enqueue+emit parity) is the sub-item "multi-channel event triggers" actually need** — it needs no consumer, no flag and no owner decision, and is dispatchable today. ⚠️ **It does NOT unblock WS-11 Slice 4**, which `workflows_app.md:217` defines as "(post-BO-20/BO-7): durable queued runs; sandboxed module execution; MCP exposure; retention policies" — durable queued runs need the consumer + retry + DLQ, so **Slice 4 needs BO-20a–e (plus BO-7) and still waits on §BO-20.0**; WS-11's "Slice 4 after WS-4" stays blocked exactly as before. BO-9 resolved as **not blocking** (a consumer needs a long-lived async client; the precedent is `acb_common/activity.py:54-66`). **OWNER-GATE:** flipping `INGESTION_CONSUMER=1` (the code ships OFF; **registered in §6 on 2026-08-02** — the flip also cuts the receivers over to enqueue-only, per §BO-20 Q1). |
| WS-5 | **CI gates real** (BO-17/BO-18) | checklist §F | 🟡 Docs | Un-gate evals, blocking gitleaks, coverage floor. ~~AGENT-SAFE~~ → **mixed: the highest-value item is a GitHub *settings* change an agent cannot make.** **Audited 2026-08-01 → NO-GO**: §F has zero testable "done when" ("per the existing plan", "a few green PRs", "for foundation packages"), its ratchet-plan anchor points at a path that moved to `specs/archive/` (3 stale citations live *in the workflow files*), and BO-17 reads ☐ while half of it shipped (blocking ruff-correctness + xenon, a frontend tsc/vitest job, gitleaks, per-PR health). **THE MISSING ITEM — why the 2026-08-01 F821 escape happened, in no doc today:** (1) `main` has **no branch protection** (`gh api …/branches/main/protection` → 404) — every "blocking" gate in these YAMLs is decorative; (2) commits pushed straight to main get **zero check-runs** (`15c8933f` had none); (3) `deploy.yml:56-58` lints with the *non-blocking full* `ruff check .`, **not** the `--select F821,…` correctness gate, so deploy went green over a broken tree; (4) PR #318's `pr-check` **failed on that exact F821 and merged anyway**. **Slice when specced (BO-17a "main-guard"):** add a `correctness` job to `deploy.yml` on push-to-main running the `--select` gate, deliberately NOT in the deploy job's `needs:` — loud, not blocking. AGENT-SAFE. **OWNER-GATE:** enabling branch protection / required checks, wiring any gate into `needs:`, removing `skip_tests`; BO-18's purge+rotation is WS-2's, not this row's. Refuted two long-standing beliefs: pr-check **does** cover the frontend, and it **does** run on non-main branches. |
| WS-6 | **Observability wiring + attribution** (BO-5 + decision D1) | `observability_e2.md` §6.7 | 🟡 Docs | OTel exporter (absent from uv.lock), Langfuse wiring, durable cost table, and the (run, member, agent, instance) attribution stamp — prereq for WS-16. **Audited 2026-08-01 → NO-GO on the doc contract, not the work.** The cited "§6.7" is an unnumbered recommendation memo with **zero acceptance criteria**, stale pre-restructure paths (`apps/gateway/…`), no gate labels, and D1's attribution stamp **appears in no spec at all**. Verified drift: `agent_run.{prompt,completion,total}_tokens` are read by `/debug/runs` + `/observability/runs` but **never written** (`run_trace.py::_persist_row` is the only INSERT) — the spec claims they carry cost attribution; they are always NULL. Cost today lives only in Redis day-hashes (45-day TTL) plus opt-in `audit_event`; the durable precedent to generalise is `app_audit` (mig 114), already used for a monthly budget in `routes/apps/runtime.py`. Only 2 of D1's 4 fields reach the choke point (`v1_compat` reads `x-cc-agent`/`x-cc-source`; run_id + member are dropped) and `instance` exists nowhere — reuse `_resolve_agent_instance()` (`executor.py:917`), do not invent a second key. **To unblock:** add a numbered `## 7. WS-6 — open work` to `observability_e2.md` with per-item "done when" + AGENT-SAFE/OWNER-GATE labels, fix the 5 stale paths, correct the token-column claim. Then the dispatchable slice is the **D1 stamp + a durable `llm_call` table** (agent-safe); Langfuse/OTel/`LLM_USAGE_AUDIT` are OWNER-GATE (§6). |
| WS-7 | **Memory activation + search** (BO-21 → BO-22) | checklist §C + `llm_caching_memory.md` | 🔴 | **OWNER-GATE:** flipping `MEM0_ENABLED`/`GRAPHITI_ENABLED` in prod (cost + latent findings in `agent_platform_hardening` Part 5). `acb_search` (BO-22) after. |

### Platform

| WS | Workstream | Owning spec | State | Next / notes |
|---|---|---|---|---|
| WS-8 | **Agent architecture A0→C** (single runtime, manifests + `agent_defs`, generic declarative builder, Agent Workshop describe-to-create) | `agent_architecture.md` §12 | 🟢 A0/A1 | A0 items partially done (approve_all fixed 2026-07-26 — three states in one doc, see §5). Phase A unblocks D3's long-term form. |
| WS-9 | **Memory tiers 3b/3c/4** (budgeted file-tier header, provenance markers, correction UX, supersession) | `memory_architecture.md` §9 (corrected 2026-08-01) | 🟡 Docs | 3a′ substrate shipped (migs 136–139). §6.7 correction UX is the highest-leverage UX item in the corpus. **Audited 2026-08-02 → NO-GO**: §9 gives acceptance for **3a′ only** (which is WS-10's, already shipped) — 3b/3c/4, the whole of WS-9, have none; §6.7 is experience prose with no endpoint, model or assertion; §6.5 ends "there are two honest paths… don't do both", an owner call presented as acceptance. Header still says `Draft / RFC · 2026-07-26` over a body stamped 2026-08-01 (R4). Paths are bare filenames whose line numbers have moved (`routes/memory.py` gate is now `_authorize_scope` :128-167; `_tool_injection.py:488-493` moved to `acb_skills/addendum.py` in WS-23 S3). **Verified substrate:** `MemoryClient` has search/add/get_all/delete and **no `update`**; the API has no PUT/PATCH; `/memory` already does list + semantic search + delete + clear-all (§5.5 understates it) but has **no edit, no provenance**, and hardcodes one of the **five** scope shapes (`<email>` · `prefs:` · `room:` · `agent:` · `org:global`). No provenance/supersession fields exist anywhere. **NOT owner-gated** — the gate logic is testable against a fake with Mem0 disabled (41 tests, 0.58s); the real trap is inverted: **this box's `.env` already has Mem0 enabled, and `tests/unit/test_memory_integration.py` HANGS (measured exit 124); assume `test_memory_e2e.py` does too — name test files, never `tests/unit/`.** **D4 constraint:** `orchestrator/agents.py:520-534` reads only the user scope, so correcting an `org:global` fact would show fixed in the UI and change nothing on that path — PR-1 must restrict to `<email>`/`prefs:`/`agent:` or say so. **Slice when specced (3c-0, AGENT-SAFE):** `PATCH /memory/{scope}/{memory_id}` reusing `_authorize_scope(write=True)` + the 404-not-403 membership probe at `memory.py:237-240`; `MemoryClient.update`; provenance in **Mem0's own metadata** (`corrected_by`/`corrected_at`/`supersedes`) — no new table; PATCH in the Next proxy; inline edit + compartment selector on `/memory`. **Scope creep to cut:** §6.1 instance-keying is WS-14's and the 3a′ remainder is WS-10's — this row should stop claiming both. |
| WS-10 | **Multiplayer Phase 2 + 3b** (floor control, steer, `subject:` compartments, `prefs`/`user` backfill) | `docs/multiplayer/README.md` §8 + `memory-clearance.md` (stamped 2026-08-01) + `specs/multiplayer_prior_art_qm_2026-08.md` | 🟢 | README's 12 stale claims corrected; shipped surface + role vocabulary now stated in-doc. **Prior-art re-scope 2026-08-01 (`qm`, QM-1/3/5):** build **steer before floor control** and then re-decide whether five floor modes are load-bearing — `qm` ships rooms with no baton at all because a second turn folds into the live run. §5.2's supersede fix survives either way. Also: a shared room should have **no ambient credentials** (per-credential grants bound to the room, QM-3) rather than one `acting_identity`; participant tenure windows should narrow the **model's** replay, not only each viewer's (QM-5). |
| WS-11 | **Workflows Slice 3** (full-graph copilot authoring, loops/fan-out, template gallery); Slice 4 after WS-4 | `workflows_app.md` §8 (inconsistencies fixed 2026-08-01) | 🟢 | — |
| WS-12 | **Framework uplift + context discipline** | `multi_agent_orchestration.md` Phases 1, 4 (D6 banner added 2026-08-01) | 🟢 | Phases 2–3 marked superseded by the shipped Workflows app; Phase 5 orchestrations stay live. Phase 1's addendum-size target is delivered through WS-23. |
| WS-23 | **Skills registry + per-agent skill toggles** (added 2026-08-01) | `specs/skills_registry.md` | 🟡 S1+S2 built | **S1+S2 shipped pending review 2026-08-01**. S1: `acb_skills/skill_families.py` registry + measured token-cost catalog, `GET /integrations/skills`, Integrations → Skills tab, drift test; measured baseline ≈19.3k tokens (core floor ≈15.1k). S2: `agent_skill_setting` table (override-shape provenance), `GET/PUT /agent/{name}/skills` (`admin:access:manage`; core/apps → 422), **intersection-only** enforcement in `_resolve_injected_scope` (no rows ⇒ byte-identical — regression-tested), Agents-page Skills panel with live token meter; decision note in spec §2: workflows toggle honored at its append site, Custom-App grants NOT toggle-governed. **S3 generation half + scope-out shipped pending review 2026-08-01**: addendum prose now GENERATED from family-tagged section registries in `acb_skills/addendum.py` (one renderer for injection AND catalog cost measurement; tool set byte-identical, text identical except the `App()Ellipsis` f-string fix); evidence-based scope-out in `specs/skills_scope_out.md` (GENERAL = core/memory/workflows/apps; SPECIALISED = history→orchestrator, coding→apis-config); `DEFAULT_PROFILE` + `SKILLS_FAIL_CLOSED` switch prepared and **shipped OFF**. Measured: all-families 19.3k → DEFAULT_PROFILE 17.8k → core floor 15.4k tokens — the ≤2k email target needs a core-floor diet, not toggles. Remaining: **OWNER-GATE** the `SKILLS_FAIL_CLOSED=1` flip (review dynamic agents first, `skills_scope_out.md` §4). Per-instance profiles defer to Centers C; manifest side lands with WS-8. **S4 core-floor diet BUILT 2026-08-01** (`skills_scope_out.md` §7): *Half A* `acb_skills/skill_index.py` — addendum becomes one line per family + `recall_notes("skills/<family>.md")`, bodies materialized to `agent-data/skills/` content-hash-idempotently after the blob rehydrate, byte-preserved via the new `addendum.rendered_parts()`, index inside the prompt-cache-stable prefix, **`SKILLS_INDEX_ONLY` ships OFF**; *Half B* schema trim, live, **zero call-contract change** (pinned in `tests/unit/test_tool_schema_diet.py`). Measured: addendum 5,697 → **570**, core-floor schemas 9,998 → **8,510**, full surface 19,259 → **12,644**, email-assistant-recommended 17,757 → **11,337**. **≤2k still NOT met and unreachable by trimming** (22 schemas cost 1,252 tokens with descriptions deleted) — progressive tool disclosure + an `emit_generative_ui` schema pointer are designed and costed in `skills_scope_out.md` §7.5, **deliberately not built**. Remaining: **OWNER-GATE** the `SKILLS_INDEX_ONLY=1` flip. |

### Product — Centers (`department_centers.md` §3)

| WS | Workstream | State | Next / notes |
|---|---|---|---|
| WS-13 | **Centers B — groups become real** (groups admin UI, seed six groups, People directory read view) | 🟡 | Groups admin UI + six-group seed **built 2026-08-01, pending owner review** (`routes/admin/groups.py`, `/settings/groups`, seed migration; see `department_centers.md` Phase B update). People directory read view still open. The unlock for everything below. Single owner: Centers B (groups spec §6 step 5 and org_access Phase 2 are mirrors). |
| WS-14 | **Centers C — scoping deepens** (tasks team slice, shared mailboxes, team-instanced agents, per-Center approvals) | 🟡 WS-13 + D3 | Audit correction: the blob/memory substrate is live but the **`dynamic_agents` sharing columns do not exist** (agent-kinds' "migration 119" was never built) — Centers C includes that migration per D3. |
| WS-15 | **Centers D — dashboards + Company Center** (Center dashboards, personal dashboard, weekly digest workflows, orchestrator org-memory fix per D4) | 🟡 WS-13 | Digest workflows double as `workflows_app.md` G1 launch metric — one artifact, both scorecards. |
| WS-16 | **Centers E — AI budgets** (per-member caps at the LLM choke points; per-room degrade later) | 🟡 WS-6 | Subjects per D2. |

### Apps

| WS | Workstream | Owning spec | State | Next / notes |
|---|---|---|---|---|
| WS-17 | **Email completion** | `email_app_master_plan.md` | 🔴 owner calls | 3 pending owner decisions (kill-list batch, schedule-send go, contact-merge identity) + user-parked semantic search. Tier-1 hardening (§7) is 🟢 AGENT-SAFE and gates a second account. |
| WS-18 | **Tasks Phase 3** (Weekly Review, Waiting-For, ~~Horizons~~) | `task_manager_app.md` (corrected 2026-08-01) | 🟡 partial | **Audited 2026-08-02 → GO-NARROWED, and point 3 splits per view — the first row in four cycles to clear it.** ✅ **Waiting-For *surfacing* BUILT 2026-08-02, pending review** (`lib/waiting.ts` pure predicates + `WaitingForView.tsx` grouped by person + `ITEM_SELECT`/`GtdItemModel` now project the write-only mig-48 columns `expected_by`/`last_nudged_at`; **no migration — the substrate all shipped in mig 48**). Delegate now defaults `expected_by` from the item's own `due_at` (the in-app delegate path wrote NULL, so the headline §12 journey produced no flag at all). Fixed en route: a frozen `MOCK_NOW` (4 copies) that made the shipped overdue badge wrong by 33 days and growing, plus `mockData.ts`'s orphaned anchor. **🔴 Weekly Review = NO-GO** (§9.2 is a bare checkbox; `gtd_reviews.summary` is untyped JSONB — define the JSON contract + a per-movement done-when first). **🔴 Horizons = NO-GO and MIS-ASSIGNED** — no acceptance criterion exists anywhere, `gtd_horizons` has no link column to items/projects, and **the spec puts it in Phase 4, not 3**; strike it from this row's title or move it in the spec. **~~Open~~ CLOSED 2026-08-02 (follow-up):** `expected_by` now means exactly one thing — **an explicit human promise**. NULL ⇒ no promise was made, so the overdue line is the item's own `due_at` read **live** (nothing copied, nothing to go stale); non-NULL ⇒ a promise that stands independent of `due_at`. All four insert sites stopped deriving a copy (each was writing the item's own due date under another name), so the column is now written by exactly one path: `PATCH /tasks/items/{id}` with `expected_by` (ISO sets, `""` clears), which updates the open `gtd_waiting` row under a re-stated ownership `EXISTS`. Client judges `expectedBy ?? dueAt`. **No migration, no backfill** — rows delegated before this change keep their snapshot and stay judged on it; clearing one is a normal edit. **OWNER-GATE:** nudge drafting/sending (real-account email sends), delegation write-back to ClickUp (blocked on BO-1). **Drift found:** `gtd_reviews`/`gtd_horizons` have existed since mig 48 with zero gateway references — do NOT write a new migration for them; and the spec's `POST /tasks/projects/plan` was fiction (real: `POST /tasks/plan` + `/plan/apply`, shipped — only the ProjectPlanner UI is missing). **EVAL-LOCKED:** `propose()`/`propose_with_llm()` in `routes/tasks/ai.py`. |
| WS-19 | **Notes + meeting bot** (share-to-chat, ask-during-recording; bot Phase 2 error codes AGENT-SAFE) | `note_taker_app.md` + `meeting_bot_platform_plan.md` | 🟡 | **OWNER-GATE:** bot Phase 1 needs a human-created Google account (`notetaker@fracktal.in`); share-to-chat needs a Slack integration that doesn't exist (scope call). |
| WS-20 | **WhatsApp activation + remainder** (search UI 🟢 AGENT-SAFE; OCR needs a vision-tier decision; Odoo/Zoho-bound items blocked) | `whatsapp_message_manager.md` §11 (header fixed 2026-08-01) | 🟡 owner | **OWNER-GATE:** Meta env/app review, enrichment cost flags. |
| WS-21 | **Calendar F2/F3** (`gtd_time_blocks`, email windows, ideal week, external sync) | `calendar_focus_os.md` + `calendar_timeboxing.md` (acceptance + verification added 2026-08-01) | 🟢 F2 | P3 roll-over found ALREADY SHIPPED (released-to-unscheduled semantics, mig 78 + `start_auto_rollover`). Focus Shield stays blocked on the missing notification hold/release hook. Verify "breaks in the packer" state before dispatch (§5 residual 4). |
| WS-22 | **draw.io** (all 13 tickets open, nothing built) | `drawio_integration.md` | 🟡 owner | Best acceptance structure in the corpus; needs an owner and re-verified anchors (~5 weeks stale). ST-DRW-02 is a decision gate. |

---

## 3. Decisions recorded (2026-07-31)

Resolutions for the cross-doc conflicts the audit surfaced. D1–D8 are
**proposed defaults, adopted unless the owner objects**; D9 is an owner call.

- **D1 — Cost attribution is one workstream.** Stamp every LLM call at the
  gateway choke points with (run_id, member_email, agent, instance). Per-room
  (multiplayer §5.3), per-instance (agent-kinds §9.4), per-member and
  per-Center views are all rollups of that one record. Owner: WS-6.
- **D2 — Budget subject: member first.** Per-member monthly caps ship first
  (WS-16); per-room `token_budget` + degrade-to-read-only (multiplayer Phase 4)
  builds later on the same records. Per-group rollups after.
- **D3 — Instancing storage: columns now, manifest later.** Add the `sharing`
  columns to `dynamic_agents` now (agent-kinds §3 shape; next free migration
  number) to unblock WS-14. When WS-8 Phase A lands, those columns become
  *derived from* `agent_defs` manifests — one store, not two. The
  agent_architecture manifest is the long-term source of truth.
- **D4 — Orchestrator org-memory: patch now, unify later.** The missing
  org/agent-scope read on the orchestrator path (`agent_architecture.md`
  §11.1.2) is fixed as a small standalone defect in WS-15. WS-8's A1 runtime
  unification remains the structural fix and deletes the duplicate path.
- **D5 — Shared mailboxes:** `email_app_master_plan.md` owns implementation;
  Centers C sequences it; research §16.7 is design reference only.
- **D6 — The Workflows app won.** `workflows_app.md` + `docs/workflow-editor/`
  are authoritative for graphs, compiler, editor, and workflow-as-tool.
  `multi_agent_orchestration.md` Phases 2–3 and §5.3 are superseded; its
  Phases 1/4/5 remain live as WS-12.
- **D7 — MCP registry exists, with a MAF-side gap.** `13_mcp_servers.sql` +
  gateway CRUD + per-run injection are live (the coherence audit missed it by
  searching for the spec's planned name — R1's disease exactly).
  `mcp_plugin_integration.md` Phase A = shipped; Phases B/C remain research.
  **Verified 2026-08-01:** `_inject_mcp_servers` runs for every agent but
  writes `agent._mcp_servers`, which only the Copilot runtime reads — for
  native-MAF agents MCP injection is a **silent no-op** (no
  `MCPStdioTool`/`MCPStreamableHTTPTool` wiring exists). Any manifest
  `capabilities.mcp_servers` promise (agent_architecture §6) is unimplemented
  on MAF until WS-8 closes this; scope it into WS-8 Phase A/B.
- **D8 — Budgets/caps enforcement lives at the gateway choke points**, never
  per-app. (Same principle as prompt caching and model tiers: one seam.)
- **D9 — "Pomad Centre" — RESOLVED 2026-08-01.** Owner confirmed it is not a
  real venture (a stray name that should have read Command Center). All 12
  sites across 8 files rewritten as "a second tenant deployment" — the
  phrasing that preserves each sentence's meaning, including the two
  security-requirement sites (`agent_platform_hardening` §64's T2 gate now
  reads "Before multi-tenant (a second org on this platform)"). The name no
  longer appears anywhere outside this decision record.

## 4. Single-owner registry (who owns duplicated work)

| Work | Owner | Mirrors (link-only after §5) |
|---|---|---|
| Groups admin UI + seeding | **WS-13 / Centers B** | groups_sessions_authority §6.5 · org_access §8 Ph2 · multiplayer §4.5 |
| Team-instanced agents | **WS-14 / Centers C** (mechanism per D3) | agent-kinds §8 · agent_architecture §6/§12A · memory_architecture §6.1 · groups §6.2 |
| Shared mailboxes | **email master** (sequenced by WS-14) | org_access §8 Ph2 · groups §1 · research §16.7 |
| Per-Center approvals routing | **WS-14** | org_access §9 Q2 |
| Cost attribution | **WS-6** (D1) | multiplayer §5.3/Ph4 · agent-kinds §9 Q4 · Centers D |
| Budgets | **WS-16** (D2) | multiplayer §4.3/§5.3/Ph4 |
| Digest workflows | **WS-15** (also scores workflows G1) | workflows_app §1.2 |
| Orchestrator org-memory fix | **WS-15** (D4); structural fix WS-8 A1 | agent_architecture §11.1.2 |
| Workflow engine/editor | **workflows_app.md** (D6) | multi_agent_orchestration Ph2–3/§5.3 |
| Chat HITL model | **generative_ui_2.md §2** (shipped) | chat_ux §12.3 (superseded) |
| Multiplayer prior art (`qm`, 2026-08-01) | **`multiplayer_prior_art_qm_2026-08.md` is reference-only** — it owns no work and no status; the specs it links stay authoritative | multiplayer README §4.6/§5.1/§6.4/§6.5 · memory-clearance §3.3/§7 · agent-kinds §9 Q1 · skills_scope_out §6 · WS-10 · WS-23 |

## 5. Documentation remediation backlog (WS-0)

> **Update 2026-08-01 (doc-truth pass): EXECUTED.** All Tier 1–3 items below
> were applied by a six-agent pass, each edit verified against code first.
> Kept as the record of what changed. **Residual items** (new or deferred):
> 1. `ai-company-brain/AGENTS.md` build-table rows are themselves stale
>    (email row says "Phase 1 open" over shipped Phases 1–3; note-taker and
>    task-manager rows similarly behind) — refresh against the corrected specs.
> 2. `note_taker_app.md` §3.13's status-as-blockquote → proper table (cosmetic).
> 3. `chat_ux.md` full archival decision (banner + supersession notes are in;
>    body retained as protocol reference for the still-open §12 VII–XI items).
> 4. `calendar_focus_os.md` "breaks in the packer" may have partially shipped
>    (commit 80722e17, lunch-carve-out tests) — verify before dispatching F2.
> 5. ~~D9 (Pomad Centre) remains an owner call~~ — resolved 2026-08-01, all
>    12 sites rewritten as "a second tenant deployment" (see D9).

**Tier 1 — status truth (hours; AGENT-SAFE; do before any dispatch):**
1. `whatsapp_message_manager.md` — header "PLANNING, no code yet" → point at
   §11 (W0–W14 built, 227 tests); reconcile §10 vs §11 phasing.
2. `task_manager_app.md` — header resume-point + §9.1/§8 status sweep against
   the repo (`/tasks/sync` ✅, EngageView exists, AssistantRail ✅).
3. `docs/multiplayer/README.md` — stamp the 12 stale claims (§2.2 of the
   audit): room compartments shipped, authorship shipped (139), participant
   table/roles vocabulary (`chat_session_participant`, owner/member/viewer),
   real endpoint surface (`routes/rooms.py`), floor default `'open'`.
4. `FOUNDATION_BUILDOUT_CHECKLIST.md` §BO-1 — rewrite body per shipped state
   (broker live, handlers live for ClickUp/WhatsApp; remaining: email/Zoho
   handlers + enforce flip); reconcile the prod-SHA note; fix BO-2/BO-19
   internal contradictions; note BO-4 = BO-20.
5. Migration-number sweep (R1): groups §6 (134→138, 135→139, 133→137),
   org_access §10.1 (128/129→130), memory_architecture §9 (120→136),
   workflows §8 (131→132), plus "next free" phrasing in agent-kinds,
   agent_architecture, memory-clearance, multiplayer README.
6. Path sweep: `apps/gateway|orchestrator|ingestion/` → `apps/services/...`
   in the three foundation docs, `llm_caching_memory.md`,
   `mcp_plugin_integration.md`, `drawio_integration.md`.
7. `memory_architecture.md` §5 — mark §5.1 fixed (2026-07-30), §5.3 superseded
   by migs 136/137; §10 Q5 answered (clearance-keyed session cache, built).
8. `org_access_control.md` §10.2 — mark collisions 2/3/4 resolved (138/139 +
   intersection shipped); §8 Phase 2 row → "in progress as Centers B/C".
9. `mcp_plugin_integration.md` — Phase A marked shipped (D7), header updated.
10. `project_plan.md` — C-08/C-09 annotations (superseded by BO-12/ADR-028),
    M2.8 vs BO-21 honesty fix, HH-1/2/3 marked shipped, pointer to this doc.

**Tier 2 — make dispatchable (per-spec, before that WS dispatches):**
11. Calendar pair — add acceptance criteria + verification (contract items
    3/5); cross-map P0–P5 ↔ F0–F3; fix "PR not merged" (merged as #71);
    reconcile Pomodoro (shipped in F1 vs deferred in P5); one
    `gtd_time_blocks` column set (three variants exist).
12. `chat_ux.md` — fold live backlog (§11/§12 items VII–XI) into a short
    addendum; mark §12.3 superseded by generative_ui_2 §2; archive the rest.
13. `note_taker_app.md` — convert the §3.13 blockquote to a status table;
    reconcile §3.4/D4/D5 with the D3 AssemblyAI decision + deferred Tier-B.
14. `agent_architecture.md` — one status for approve_all (§3.2 vs §11.3 vs
    §12 A0); Phases F/G dependency split (3a partly shipped).
15. `email_app_master_plan.md` — refresh §3 at-a-glance to include §3.14;
    archive `email_feature_review_2026-07.md` per its own §9 instruction.
16. `department_centers.md` — corrections shipped alongside this doc: Phase C
    now names the `dynamic_agents` sharing-columns gap (D3), Phase E cites
    D1/D2, and §4 Q1 carries the full 12-site Pomad inventory.
17. Section-anchor fixes (audit §4.2): groups→memory-clearance §3.3/§3.1,
    groups→README §4.2/§7.1, memory_architecture→agent_architecture §7, etc.

**Tier 3 — archive/annotate:** multi_agent_orchestration Ph2–3 superseded
banner (D6) · "Agent Creator"→"Agent Workshop" sweep (R3, 5 sites) ·
`llm_caching_memory.md` proxy-hook sections struck per its own header ·
drawio §12's stray Hostinger-token action item moved to WS-2's list.

## 6. Owner-gate registry (agents must refuse these)

Force-push / history rewrite (BO-8) · credential rotation (Zoho, Hostinger
token) · enforcement flips (`ACTION_BROKER_ENFORCE`, `AGENT_PERMISSION_MODE=
enforce`, `MEM0_ENABLED`, `GRAPHITI_ENABLED`, `WHATSAPP_ENRICHMENT`,
`SKILLS_FAIL_CLOSED` — the WS-23 fail-closed default-profile flip; review
`skills_scope_out.md` §3 dynamic-agent rows first · `SKILLS_INDEX_ONLY` —
the WS-23-successor skills-index flip: every agent's prompt becomes a
one-line-per-family index with bodies read on demand; see
`skills_scope_out.md` §7 · `INGESTION_CONSUMER` — the WS-4/BO-20
ingestion-consumer flip: the code ships OFF, and turning it on is not just
"start a loop" — it cuts the provider receivers over from inline `emit_event`
to enqueue-only so the consumer becomes the **single** dispatch path, which
means Redis down = events dropped rather than dispatched inline; see
`FOUNDATION_BUILDOUT_CHECKLIST.md` §BO-20.0 and its open question Q1) ·
**WS-6 observability activation** (Langfuse keys + bringing up
`--profile obs` in prod, `OTEL_EXPORTER_OTLP_ENDPOINT` in the deploy env,
`LLM_USAGE_AUDIT=1`, and re-enabling the MAF telemetry kill switch at
`executor.py:114` — it hides a known ContextVar-reset bug) ·
creating the bot Google account + real-meeting joins · Meta app review ·
real-account email sends / live-DB one-offs (`merge_ghost_messages --apply`) ·
`test_owner_bootstrap.py` against prod (never) · any deploy that changes auth
behaviour (supervised window per `FOUNDATION_CONTINUATION.md`).
