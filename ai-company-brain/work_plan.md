# Work Plan of Record — the dispatch board

**Status:** Active · **Date:** 2026-08-09 — **multi-tenancy consolidation pass** (§5
residual 7 is the change list): the D11/D10-premise purge across the corpus after
D15/D16, §2 compacted per **D18** with row narratives moved to owning specs' "Board
record (2026-08-09)" sections, **R5** (tenant-ready by construction) minted, **D17**
(Mem0 binding) + **D18** (priority of record · board format · MT-2/3 pricing inputs)
recorded, WS-29 updated with the H1 scratch-verify result and PR #404, and eighteen
stale-vs-merged row claims swept (branch protection, ledger, backups, deploys,
WS-13/26/27 states). **Prior pass 2026-08-03** (six-row truth pass: WS-1, WS-3, WS-8,
WS-11, WS-12, WS-21 swept to match their rewritten specs; D10 records two owner
calls. **Second pass the same day:** D11 + D12 record the tenancy boundary and
the visibility model from `specs/tenancy_and_visibility.md`; WS-14 unblocked;
WS-13 gains the verified "Centers are unreachable by anyone" finding; §2 gains
the three app-by-app exceptions. **Third pass the same day — WS-14 doc
remediation:** WS-14 was audited NO-GO on 7 of 7 contract points and is now
re-scoped onto four lettered bullets in `department_centers.md` §3 (C1 🟢 · C2
struck, ownerless · C3 🟢 narrow · C4 🔴 owner-decision); **WS-14a is minted** for
TV-1, which passed the contract but had no board row; six stale `rooms.py` anchors
corrected in D11, D12 and the WS-14 row; §4's shared-mailbox and per-Center-approvals
rows re-stated against measurement. **Repair round on the third pass:** **D13** is
registered (the project grant table — `agent-proposed, owner may overrule`, previously
discoverable only inside the WS-14 row); C1's acceptance gains a caller-reachable grant
creation path; and a factual claim this board carried twice is retracted — `actor` in
`pending_actions` **does** name the requesting human at two of its six writers, so §4's
row and §6's gate now rest on the measured shapes rather than on a false absolute. The
C4 verdict is unchanged. **2026-08-04 — WS-24 minted:** colleague onboarding
readiness gets a row, an owning spec (`specs/colleague_onboarding.md`) and an
executable gate (`scripts/onboarding_preflight.py`); the single member of record
and the five member/group write endpoints join §4 and §6; **D14** records that
`data:org:read` grants nothing — it has zero consumers — so `manager`'s
"org-wide visibility" is a name and the department-privacy question is really
about `admin:members:read`) · **Owner:** vjvarada
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
- **R5 — tenant-ready by construction** *(owner-directed 2026-08-09, D18; binds
  every PR while WS-29 is in flight)*. App work continues in parallel with the
  tenancy retrofit on these terms, each enforced by an existing test, not by
  prose: **(a)** every new persisted table is tenant-scoped — it must satisfy
  `tests/unit/test_tenant_coverage.py`'s source gate (covered by the generated
  RLS migration, or in `gen_tenant_migration.EXEMPT` with a reason a reviewer is
  expected to challenge); **(b)** no new database connection sites outside the
  seam — additions to `_SYNC_ENGINE_ALLOWED` / `_PSYCOPG_ALLOWED` need a cited
  reason in the PR; **(c)** new Redis keys go through the tenant-prefix wrapper
  (allow-list additions likewise); **(d)** session acquisition uses the current
  seam idiom only, so H2's conversion stays mechanical — do not invent new
  acquisition idioms; **(e)** never trust a tenant (or identity) from request
  input — `user_management_contract.md` R11/R3. The ratchet tests ride PR #404;
  until it merges they bind on the WS-29 branch, from merge they bind `main`.

---

## 2. The dispatch board

States: 🟢 ready to dispatch · 🟡 dispatchable after the named gate ·
🔴 blocked on owner/decision · ✅ done. "Docs" gate = the §5 fix for that spec.

### WS-0 · Documentation remediation — ✅ executed 2026-08-01 (residuals in §5)
Six-agent truth pass completed: Tier 1 (items 1–10), Tier 2 (11–17), and the
Tier 3 annotations are done, verified against code. Residual items listed at
the top of §5. Findings folded back into this doc: D7 gained the MAF-side MCP
gap; calendar P3 was found already shipped (with revised roll-over semantics).

### Can we go app by app? — yes, with three exceptions *(2026-08-03)*

The owner asked whether the foundation is complete enough to work app by app. It
is. **Three items are exceptions** — they are not app work, they do not get
better by being deferred behind app work, and one of them gets *worse* with every
app added. Recorded here because §2 is where a reader planning the next app
looks. Full statements live in `FOUNDATION_BUILDOUT_CHECKLIST.md`.

| # | Exception | Where it lives | Why it can't wait for "after the apps" |
|---|---|---|---|
| 1 | ~~**`main` has no branch protection**~~ — **CLOSED 2026-08-03** | WS-5 · checklist §BO-17 | Was `404 Branch not protected` with rulesets `[]` under both mechanisms, so every CI gate in the YAMLs was decorative. **Enabled 2026-08-03** (owner-authorised in-session): PRs required, `required_approving_review_count: 0`, **`enforce_admins: true`**, force-push and deletion blocked. Verified by reading the protection back. ⚠️ **`required_status_checks` is deliberately `null`**: `pr-check.yml` has `paths-ignore: ["**.md", "ai-company-brain/**"]`, so a docs-only PR produces **no** check-runs — requiring those contexts would make every docs PR permanently unmergeable (this row's own PR included). Tightening path: add an always-runs sentinel job to `pr-check`, then require **that** one context. |
| 2 | ~~**No backup / restore path**~~ — **CLOSED in substance 2026-08-07** | checklist §BO-23 | Nightly `acb-backup.timer` **verified scheduled 2026-08-07** (after three same-day defects: #382 wrong script, #383 fork bomb, #384 mig-148 cast); a restore was rehearsed for real 2026-08-05 (`live=228 restored=228`); the migration **ledger is merged** (`5f025d80`, renumbered to 153), so a deploy stops replaying the whole ladder. Residue: `BACKUP_REMOTE` unset — off-box copy **deferred by owner decision 2026-08-05** (`backup_and_restore.md` §4.2); losing the disk, box or provider account still falls back to the weekly two-deep Hostinger image. Verify backups by deploy-log lines, never job conclusion. |
| 3 | ~~**DB engine sprawl**~~ **CLOSED 2026-08-06** | checklist §BO-10 | Measured 2026-08-03: **12 `create_async_engine(...)` call sites across 10 modules** (`acb_auth/access.py:69`; gateway `routes/{admin,apps,email,notes,tasks,whatsapp,workflows}/*core*.py`; `email_ingestion/{inbound,scheduler}.py` ×4), plus a 13th **sync** `create_engine` in `acb_graph/db.py:32`. Eight are module-level cached `_ENGINE` singletons and **none of them is disposed on shutdown** — the only `engine.dispose()` calls in the tree are the four `email_ingestion` per-call engines cleaning up after themselves. **This is the one that compounds: one engine per app, added by each app.** The next app should extend a shared seam, not add engine 13. **CLOSED 2026-08-06:** every async caller now resolves to ONE engine and pool in `packages/acb_common/acb_common/db.py` — not `acb_graph` (the gateway does not depend on it, and its engine is sync) and not `gateway/db.py` (which `acb_auth/access.py` cannot import, so a gateway-owned seam could never get below two pools in the gateway process). The six remaining route packages plus `acb_auth.access` were converted, each keeping its historical `get_db`/`_get_db`/`_get_session_factory` name as a re-export so ~50 call sites and every test monkeypatch are untouched; `gateway/db.py` is a re-export. `acb_auth`'s engine had never carried the 2026-08-06 connect/`idle in transaction` bounds — it does now. Pool ceiling 30 (tunable via `db_pool_size`/`db_max_overflow`), deliberately not the old ~165 sum, which exceeded a stock `max_connections` of 100 shared with Langfuse/LiteLLM/ingestion. `acb_audit.record()` is non-blocking on the loop (`to_thread` only when a loop is running; sync callers still inline) and `acb_audit.drain()` is awaited last in the gateway lifespan. Guarded by `tests/unit/test_db_engine_seam.py` + `tests/unit/test_audit_non_blocking.py`. Still open by design: `acb_graph/db.py`'s **sync** `create_engine` and `email_ingestion`'s per-run engines. |

**Row discipline (D18, 2026-08-09).** Rows below carry state, gates and pointers —
nothing else. The narrative that used to live in these cells (up to 29.5k characters
per row; §2 alone was ~77k tokens, unreadable in one pass by the dispatch loop it
serves) was moved verbatim into each owning spec's **"Board record (2026-08-09)"**
section, with that day's corrections applied and enumerated there. R4 binds a
shipping PR to update the row *and* the owning spec's header; **R5 (§1) binds every
PR to tenant-ready-by-construction while WS-29 is in flight.** Git history and the
owning specs are the archive; this file owns ordering, gates and states only.

### Substrate (foundation)

| WS | Workstream | State | Owning spec · record | Gates · next (verified) |
|---|---|---|---|---|
| WS-1 | **Action Broker truth + completion** (BO-1) | 🟢 | `FOUNDATION_BUILDOUT_CHECKLIST.md` §BO-1 · board record 2026-08-09 | Broker loop LIVE and writing; handlers register at SIX sites; `crm.zoho_*` handlers live and the Zoho sync loop is **running** (§6 WS-26 (a)). Open, each AGENT-SAFE, one PR: **BO-1a** two unrouted ClickUp writers (approved delete/archive → `failed` rows) · **BO-1b** pending-marker ignored by `items._push_pending_item` (green "synced", empty `provider_task_id`) · **BO-1c** the email-verb decision, then handlers. 🔴 `ACTION_BROKER_ENFORCE` flip only after 1a+1b (§6). (2026-08-07) |
| WS-2 | **Secrets** (BO-8: rotate Zoho token, purge history, fail-closed) | 🔴 | checklist §BO-8 + `FOUNDATION_CONTINUATION.md` | OWNER-GATE end-to-end (force-push history purge, credential rotation). Standing P0 since 2026-07-11. WS-26e / WS-27g cutovers execute the Zoho / ClickUp revoke halves (§6 WS-26 (c), WS-27 (c)). |
| WS-3 | **Isolation ladder** (BO-7 · HH-6 · T0–T2) | 🟢 a+b · ⏸ T2 | `permissions_sandbox_b6.md` §P5 · board record 2026-08-09 | P5-a (credential scoping), P5-b.1 (ceilings), WS-3a (record+refuse), WS-3b (rootfs+network) shipped. **T2/P5-c re-framed by D16 (2026-08-08):** parked as a **precondition of the §5.1 pooled cutover** (customer 8–12) — no longer "until a second org appears"; acceptance stays unwritten until the owner un-parks (§6 first blockquote). P5-b.3 scoped gateway key: unbuilt *and undesigned*. MT-0b's `organization.first_party` (migration 157, scratch-applied) retires this row's old "no `first_party` field exists anywhere" note. 🔴 flips: `AGENT_PERMISSION_MODE`, `ISOLATION_TIER_ENFORCE` (§6). (2026-08-03 · re-framed 2026-08-09) |
| WS-4 | **Event-bus consumer + durable queue** (BO-20) | 🟢 a+f+b1 | checklist §BO-20 — **file at the REPO ROOT** · board record 2026-08-09 | §BO-20.0 answered: **Option A, in-process** (owner 2026-08-02). Built: BO-20a consumer (reviewed, four P2s repaired) · BO-20b slice 1 · BO-20f receiver parity (inert). Next, AGENT-SAFE in strict order: **BO-20b slice 2** (strict `dispatch_event` path + PEL/XAUTOCLAIM reclaim — the record pins eight traps; read it first) → BO-20c → (BO-20d, BO-20e). 🔴 `INGESTION_CONSUMER` flip (§6) + provisioning `ZOHO_WEBHOOK_SECRET`/`GMAIL_PUBSUB_TOKEN` on the box — ⚠️ D15 coda: those become **per-org** secrets at MT-1a+; one box-wide value cannot serve N tenants. (2026-08-03) |
| WS-5 | **CI gates real** (BO-17/BO-18) | 🟡 Docs | checklist §F · board record 2026-08-09 | Audited 2026-08-01 → NO-GO (§F has zero testable done-whens). ~~"main has no branch protection"~~ **struck 2026-08-09** — protection was ENABLED 2026-08-03 (exceptions row 1); the row had never been swept. Deploy still lints with non-blocking `ruff check .`. Ready slice: **BO-17a main-guard** (`correctness` on push-to-main, deliberately NOT in `needs:`) — AGENT-SAFE. 🔴 GitHub *settings* changes (required checks, `needs:` wiring, `skip_tests` removal). BO-18 → WS-2. (2026-08-01 · corrected 2026-08-09) |
| WS-6 | **Observability wiring + attribution** (BO-5 + D1) | 🟡 partial | `observability_e2.md` §7 · board record 2026-08-09 | WS-6a + WS-6c BUILT 2026-08-02, pending review — attribution reaches **logs + Redis only, nothing durable**. WS-6b/6d/6e **HELD NO-GO**: no mechanism carries run identity across the HTTP hop to `/v1` (contextvars don't cross it; `agent_run` rows are written at run boundary); do not dispatch until §7 names one. 🔴 WS-6f–i activation flips (§6). (2026-08-02) |
| WS-7 | **Memory activation + search** (BO-21 → BO-22) | 🔴 | checklist §C + `llm_caching_memory.md` | 🔴 OWNER-GATE `MEM0_ENABLED` / `GRAPHITI_ENABLED` prod flips (§6; cost + latent findings, `agent_platform_hardening` Part 5). `acb_search` (BO-22) after. ⚠️ WS-29 coda: Mem0 tenant binding is decided — **D17, conninfo option** — and the flip should land only with MT-1c's binding in place. |
| WS-24 | **Colleague onboarding readiness** *(minted 2026-08-04)* | 🔴 2 gates + 1 decision | `specs/colleague_onboarding.md` · board record 2026-08-09 | Every AGENT-SAFE item BUILT + MERGED + DEPLOYED (N1–N8; G4 closed 2026-08-04). ~~G3 backups~~ **closed**: BO-23 timer verified scheduled 2026-08-07, restore rehearsed 2026-08-05. Remaining: **G1** Caddy identity-header strip (§6 WS-24 (a)) · **G2** `GATEWAY_INTERNAL_TOKEN` split from `LITELLM_MASTER_KEY` (§6 WS-24 (b); rotation is a redeploy and delivery works again — see WS-25) · **N5** owner decision: do the nine unscoped `routes/notes` modules block colleague #1? ~~ports-open claim~~ closed 2026-08-05 (§6 identity item 2). ⚠️ D14 coda: `data:org:read` now has a consumer path (WS-27d) — re-verify the capability matrix before member #2. (2026-08-05 · corrected 2026-08-09) |
| WS-25 | **Deploy delivery path** *(minted 2026-08-05)* | 🟡 recovered — cause unverified | `specs/deploy_delivery_path.md` · board record 2026-08-09 | ~~🔴 BROKEN~~ **re-measured 2026-08-09**: deploys landing since 2026-08-06 (migs 144/145 applied on prod); six green runs on **2026-08-07 UTC** alone, the last = #400's log-verified deploy `31217978773` (2026-08-08 IST — `crm_app.md`'s dating; `c1eba71f` fixed the apply script git-resetting itself mid-read — the "six deploys reported success while shipping nothing" hole). Tip run (`b09093a8`, docs-only) failed **health-verify** ×3 rounds 21:21→22:16 UTC 2026-08-07 — box at `affe0647`, one docs-only commit behind, cause unresolved; re-measure before quoting either state. Still real: **D1** extract the 435-line `DEPLOY_SCRIPT` from `deploy.yml` env (two-stage bootstrap) · SHA-in-`/health` (highest-leverage verify fix) · failure visibility. ⚠️ D15 re-scope: delivery becomes placement-parameterised (`saas_multitenancy.md` §5.1 condition 3) — one pipeline, N targets, never per-customer scripts. 🔴 all execution owner-gated. (2026-08-09) |

### Platform

| WS | Workstream | State | Owning spec · record | Gates · next (verified) |
|---|---|---|---|---|
| WS-8 | **Agent architecture A0→C** | 🟡 | `agent_architecture.md` §12.2 (WS-8a…n) · board record 2026-08-09 | A0 `approve_all` half done 2026-07-26. ⚠️ **Read §12.1 before dispatching**: ~60% of Phases A+B exists as complete-but-unwired substrate (`manifest.py`, `declarative.py` — documented, tested, zero production callers); an uninformed implementer rebuilds it. **WS-8c** = the MAF-side MCP injection silent no-op (D7), AGENT-SAFE. WS-14 does **not** wait on Phase A (D3 amendment). (2026-08-03) |
| WS-9 | **Memory tiers 3b/3c/4** | 🟡 Docs | `memory_architecture.md` §9 · board record 2026-08-09 | 3a′ substrate shipped (migs 136–139). **Ownership settled 2026-08-09: the 3a′ remainder (`subject:` compartments) is WS-10's S1; this row owns 3b/3c/4 only.** Audited NO-GO — §9 carries acceptance for 3a′ alone. Ready when specced: **3c-0** correction PATCH slice (AGENT-SAFE; shape in the record). Not owner-gated. ⚠️ never run `tests/unit/` as a directory here — `test_memory_integration.py` hangs. (2026-08-02) |
| WS-10 | **Multiplayer remainder** — S1 `subject:` compartments · floor re-decision · backfill | 🟡 S1 | `docs/multiplayer/memory-clearance.md` §7/§7.1 · board record 2026-08-09 | Steer shipped; two verification/repair rounds closed 2026-08-02. The work: **S1 `subject:` compartments** (AGENT-SAFE once §7.1 accepted). 🔴 floor-control re-decision (§6 — an agent must refuse that part by name) · 🔴 `prefs`/`user` backfill **APPLY** (§6; classifier + dry-run report are AGENT-SAFE and the whole mandate). ⚠️ WS-29 coda: `org:global` scope is deployment-global today and must become tenant-scoped — coordinate S1 with MT-1c/D17; do not mint a sixth scope shape (`saas_multitenancy.md` §1.9). (2026-08-02) |
| WS-11 | **Workflows Slice 3** (gallery, fan-in/join, loops) | 🟢 | `workflows_app.md` §8.3 · board record 2026-08-09 | Slice 3 = **8.3a** gallery · **8.3b** fan-in/join · **8.3c** loops (owner-approved, D10.2; R1 governs the node *catalog*, not control flow). 8.3b/8.3c each must **invert a pinned test** (`test_fan_in_rejected_v1`, `test_cycle_rejected`) — leave either standing and the ticket closes green having built nothing. Template *content* is an owner input; the report-digest template belongs to WS-15. Slice 4 after BO-20b2 → c → (d, e) + 🔴 `INGESTION_CONSUMER` flip; its sandbox-dependent parts follow MT-0c-2's trigger (D16) — the old bare "BO-7" dependency is restated. (2026-08-03) |
| WS-12 | **Framework uplift** | 🟡 Ph4 | `multi_agent_orchestration.md` **Phase 4 only** (D6) · board record 2026-08-09 | Ph0 shipped; Ph1 struck; Ph2–3 superseded (D6); Ph5 struck. One SDK major remains: `github-copilot-sdk 0.1.32 → 1.0.2` (`openai 2.38.0` already in-tree). **0 dispatchable PRs**: 🔴 Phase 4.0 target choice + 🔴 Phase 4.6 recorded human soak (§6). Phase 4.1 throwaway-venv resolution evidence is AGENT-SAFE and must never mutate `.venv`/`uv.lock`. (2026-08-03) |
| WS-23 | **Skills registry + per-agent toggles** *(added 2026-08-01)* | 🟡 built | `specs/skills_registry.md` · board record 2026-08-09 | S1–S4 shipped pending review: registry + measured catalog, per-agent toggles (intersection-only, core floor non-toggleable), scope-out proposal, index diet (full surface 19,259 → 12,644 tokens). The ≤2k target is **unreachable by trimming** — §7.5 progressive disclosure is designed, costed, and deliberately unbuilt. 🔴 `SKILLS_FAIL_CLOSED`, `SKILLS_INDEX_ONLY` flips (§6). (2026-08-01) |

### Product — Centers (`department_centers.md` §3 · combined board record 2026-08-09 there)

| WS | Workstream | State | Owning spec · record | Gates · next (verified) |
|---|---|---|---|---|
| WS-13 | **Centers B — groups become real** | 🟡 review | `department_centers.md` Phase B | Groups admin UI + six-group seed built 2026-08-01, **pending owner review**; `center.*` feature vocabulary shipped 2026-08-03. ~~People directory read view open~~ **closed by WS-28b** (2026-08-06). ~~"nav renders with no access filter" / "catalog-read was rejected"~~ **inverted by merged #389** (`747b65af` — the catalog, not a code mirror, decides). Residue: the owner review itself. (swept 2026-08-09) |
| WS-14 | **Centers C — scoping deepens** | 🟢 with ⚠️ | `department_centers.md` §3 C1–C4 | D12 answered the blocker (a project belongs to a team by an explicit `group:<slug>` grant). **C1 tasks team slice: ⚠️ RE-AUDIT before dispatch (flag added 2026-08-09)** — WS-27e's owner-directed one-store revision (D-PM-6: `pm_tasks` is THE task table; WS-27h retires `gtd_items`) may moot D13's `gtd_*`-local grant table; whichever way it lands, the subject grammar must not fork (§4, D13). C2 shared mailboxes: doc-action only, ownerless in fact (§4) · C3 team-instanced agents: narrow, columns intentionally unread · 🔴 C4 per-Center approvals decision (§6). (2026-08-03 · flag 2026-08-09) |
| WS-14a | **Tenancy TV-1 — the three `org_group` slug-only joins** *(minted 2026-08-03)* | ✅ absorbed | `specs/tenancy_and_visibility.md` §2 → **WS-29 MT-1i** | **Absorbed by WS-29 as MT-1i (2026-08-08) — do not dispatch from this row.** Code shipped on the WS-29 branch. Severity re-framed: under D15 the three joins **leak across tenants**, not merely misbehave within one. The open criterion — the two-org DB-backed fixture run `passed`, never `skipped` (§2 done-when 3) — travels with MT-1i. (2026-08-09) |
| WS-15 | **Centers D — dashboards + Company Center** | 🟡 WS-13 review | `department_centers.md` Phase D | Center dashboards, personal dashboard, weekly digest workflows (double as `workflows_app.md` G1 metric), D4 org-memory fix. Blocked only on WS-13's owner review now that WS-28b shipped the directory. |
| WS-16 | **Centers E — AI budgets** | 🟡 WS-6 | `department_centers.md` Phase E | Per-member caps at the LLM choke points (D2, D8). The chain is real: needs WS-6's **durable** attribution, which is HELD at WS-6b — do not dispatch expecting Redis-only records to suffice. ⚠️ MT-3's credit gate (D18 pricing) lands on the same choke points — design once, serve both. |

### Multi-tenancy (SaaS) — `saas_multitenancy.md`

| WS | Workstream | State | Owning spec · record | Gates · next (verified) |
|---|---|---|---|---|
| WS-29 | **Multi-tenancy — turning CommandCenter into a product sold to other companies** | ◐ H1 scratch-done | **`specs/saas_multitenancy.md`** (architecture; §11 tickets) · ⭐ **`specs/saas_multitenancy_handover.md`** (H1→H8 runbook — hand THIS to the executing agent) · `specs/saas_multitenancy_implementation.md` (shapes) · board record 2026-08-09 in the parent spec | **Phase 0 ✅** (MT-0a · 0b · 0c-1 · 0d, pending review) · **H1 ✅ scratch-verified 2026-08-09**: 157/158/159 applied + idempotent re-run on a full-ladder (00→156) replica with a backfill-exercising seed; every runbook verify query correct; baseline 213 passed / 2 skipped. **Prod apply = owner's merge of PR #404**; verify by the three `- 15N_*.sql ... ok` deploy-log lines, never job conclusion. · MT-1: 1a schema ✅ (identity cutover = H6, open) · 1b generated ✅ · 1c seam + ratchets ✅ — **561 call sites across 138 files unconverted = H2, the long pole** · 1e wrapper ✅ (~58 key sites unconverted = H5) · 1i ✅ (two-org DB fixture owed) · **MT-2/MT-3 owner inputs ANSWERED 2026-08-09 (D18 → §8)** — spec detailing may start; MT-4 still needs the payment-provider split (§8 item 3) · 🔴 MT-0c-2 parked (D16; §6 first blockquote) · §5.1 cutover trigger **ADOPTED 2026-08-09**: ≥8 customers, or deploy overhead > ~1 day/month, or the first version-skew incident — owner checks monthly. **Next: owner merges #404 → H1 GATE passes → dispatch H2.** · ⚠️ **PR #399 carries a second, earlier WS-29** (`specs/multi_tenancy.md`, now marked superseded for architecture): migration **161** keys all 17 `pm_*` + a parent-consistency trigger, **162** makes `app_user` unique on `lower(email)` (byte-exact UNIQUE let one human be two rows in two orgs), S1-1 fixes a cross-tenant **write** into access control, S1-4 removes the process-global agent identity, plus a 14-finding leak audit. **It also found a defect in MT-1b:** the generator scoped `crm_contacts`/`crm_deals`/`crm_activities` by column name, but their `organization_id` references `crm_organizations` — phase 2 would have aborted mid-window. Gated at generation time now (`HOMONYM_BLOCKED`); those three tables carry **no isolation** pending a rename — owner call. (2026-08-09) |

### Apps

| WS | Workstream | State | Owning spec · record | Gates · next (verified) |
|---|---|---|---|---|
| WS-17 | **Email completion** | 🔴 owner calls | `email_app_master_plan.md` | Three owner decisions pending (kill-list batch, schedule-send go, contact-merge identity) + user-parked semantic search. §7 Tier-1 hardening is 🟢 AGENT-SAFE and gates the second account — ⚠️ a second mailbox connected 2026-08-05; re-verify §7's single-account premise at dispatch. |
| WS-18 | **Tasks Phase 3** (Weekly Review, Waiting-For, ~~Horizons~~) | 🟡 partial | `task_manager_app.md` · board record 2026-08-09 | Waiting-For surfacing BUILT 2026-08-02, pending review (explicit-promise semantics settled). 🔴 Weekly Review NO-GO until the `gtd_reviews.summary` JSON contract + per-movement done-whens are written. Horizons: **WS-21 owns it** (§4) — DO-NOT-DISPATCH stands. 🔴 nudge **sending** (shared gate, §6) · ClickUp write-back waits on BO-1. EVAL-LOCKED: `propose()`/`propose_with_llm()`. ⚠️ WS-27e one-store: coordinate any `gtd_*` schema work with WS-27h's retirement plan. (2026-08-02) |
| WS-19 | **Notes + meeting bot** | 🟡 | `note_taker_app.md` + `meeting_bot_platform_plan.md` | Bot Phase 2 error codes 🟢 AGENT-SAFE. 🔴 bot Google account (§6) · share-to-chat needs a Slack integration that does not exist (scope call). ⚠️ D15 flag (2026-08-09): the bot plan's **ELv2 compliance argument reads "not a SaaS we resell"** (`meeting_bot_platform_plan.md`, Attendee is ELv2 not OSS) — re-evaluate before any external tenant uses bot features. |
| WS-20 | **WhatsApp activation + remainder** | 🟡 owner | `whatsapp_message_manager.md` §11 | Search UI 🟢 AGENT-SAFE; OCR needs a vision-tier decision; Odoo/Zoho-bound items bind to `crm` `entity_ref` per WS-26d instead — the linker (nothing writes `wa_contacts.entity_ref`) is owed by whoever takes them. 🔴 Meta env/app review · `WHATSAPP_ENRICHMENT` flip (§6). (2026-08-01) |
| WS-21 | **Calendar F2/F3** | 🟡 partial | `calendar_focus_os.md` §9 (+§5) + `calendar_timeboxing.md` §13 · board record 2026-08-09 | P3 roll-over + ideal-week + packer-breaks all shipped (struck from scope 2026-08-03). `gtd_time_blocks` is **four slices S1–S4** — the "one non-breaking PR" claim was false (17 TS files + 3 gateway modules + skill + agent). Focus Shield is AGENT-SAFE (needs a design, not a credential). Owns Horizons (§4) — DO-NOT-DISPATCH, no acceptance. 🔴 external-sync OAuth credentials (§6) · shared nudge-send gate (§6). Never `pytest tests/unit -k calendar` (collection hangs). (2026-08-03) |
| WS-22 | **draw.io** | 🟡 owner | `drawio_integration.md` | All 13 tickets open, nothing built; best acceptance structure in the corpus; needs an owner and re-verified anchors (~6 weeks stale). ST-DRW-02 is a decision gate. |
| WS-26 | **CRM app — native CRM + Zoho retirement** *(minted 2026-08-05)* | ✅ a–g · D5 PR open | `specs/crm_app.md` · board record 2026-08-09 | a + b + c + d (read · email · write) **merged + deployed** (d-write log-verified via deploy `31217978773`, 2026-08-08); f + g **merged to main** (#391, #397 — the old "on branch, NOT run against prod" wording is struck; f's stage repair still needs its 🔴 `?apply=true` run, §6 WS-26 (d)). **D5 d-autolead BUILT, PR #403 OPEN** — owner: merge, then 🔴 `CRM_AUTO_LEAD` flip (§6 WS-26 (b); clamp-anchor design, never reset-to-now). Zoho sync loop **ENABLED by the owner 2026-08-06** (§6 WS-26 (a)) — every "ships OFF / never run" sentence about it is struck. Next: **h** stage entry-requirements + rot badges (after f2) · **i** merge/bulk/CSV/saved-views — spec-thin, audit-narrow first · **e** cutover + retirement 🔴 (§6 WS-26 (c)). ⚠️ D15 coda: built single-Zoho-tenant by design; per-org credentials (migration 158) + per-org sync flags arrive with MT-1/MT-2, and D-CRM-3's org-wide read becomes org-scoped **by RLS**, not by hand-written predicates. (2026-08-08) |
| WS-27 | **Projects app — native PM + ClickUp retirement** *(minted 2026-08-05)* | ✅ a–n merged · **o–t on PR #399** · c/g/h gated | `specs/project_management_app.md` · board record 2026-08-09 | a b d e f i j k l m n **merged to main** (#390, #393, #394, #398 + fixes — the board's "BUILT on branch" wording is struck). ~~Open defect: **§11.12** — WS-27j's `notifications.deliverable` probes `project_clause`~~ ✅ **FIXED on #399** (assignees without a project grant were judged undeliverable, so assignment notified nobody). 🟡 **c** two-way sync waits on WS-1's BO-1a + BO-1b; 🔴 push enable (§6 WS-27 (b)) · 🔴 **g** cutover + retirement incl. the root-`AGENTS.md` constraint-8 amendment — ships in the g PR, never before (§6 WS-27 (c)) · **h** `gtd_items` retirement after e; the data move is 🔴. ~~Remaining letters: recurring, dependency UI, calendar view, search.~~ ✅ **the §11.2 ClickUp-parity backlog is CLOSED** — o recurrence · p dependencies+subtasks · q calendar · r ⌘K search · s shared task card · t timeline, all on **PR #399** with D-PM-11/D-PM-12 recorded. **Second reference studied 2026-08-09: `makeplane/plane` v1.4.1 (⚠️ AGPL-3.0 — patterns only, never code)** → `specs/plane_pm_research_2026-08.md` + spec §11.19: 12 shipped decisions validated, beyond-parity queue P-1…P-31 minted → **minted as dispatchable tickets WS-27u–z (spec §9.1)**: u intake/triage · v watchers+mention-diff · w read-path/history hardening · x spreadsheet+shown-fields · y board upgrades · z lifecycle policy (🟡 per-project, default off) + a deferred small basket, 2 owner questions ANSWERED same day → **D-PM-13** (project docs live in the knowledge base — creator-owned, grant-shared; PM links, never owns) · **D-PM-14** (public boards deferred). ⚠️ granting `feature:projects`/`data:org:read` is §6 WS-27 (d) — D14's zero-consumer measurement is retired by this row. (2026-08-07) |
| WS-28 | **People Center — directory, org chart, assignment seam** *(minted 2026-08-06)* | ✅ a+b+b-write | `specs/people_center_app.md` · board record 2026-08-09 | a (key shape, mig 148 + quarantine table) · b (directory + person page, mig 149, five-place registration) · b-write (create/edit UI restored; found three ways mig 148 had broken the write routes) — built 2026-08-06/07; **closes WS-13's directory item**. 🟢 c org chart · d capability search (**ranking EVAL-LOCKED**) · e Projects seams; 🔴 f seats/roles writes (§6 WS-24 (d) analogue). ⚠️ `schema.generated.sql` regeneration is **due**: stale since ~migration 113, and 148 reached prod ~2026-08-07 (after the #384 cast fix). (2026-08-07) |

---

## 3. Decisions recorded (D1–D14: 2026-07-31→08-04 · D15/D16: 2026-08-08 · D17/D18: 2026-08-09)

Resolutions for the cross-doc conflicts the audit surfaced. D1–D8, **D13**, **D14**,
**D16** and **D17** are **proposed defaults, adopted unless the owner objects**
(`agent-proposed, owner may overrule`); D9, D10, D11, D12, D15 and **D18** are owner
calls, taken and dated. ⚠️ Two entries below are superseded and kept as records:
**D11** (re-taken by D15) and **D10 part 1's planning premise** (re-scoped by
D15/D16) — read their banners before citing either.

- **D18 — Three owner calls taken 2026-08-09** *(via the consolidation session's
  question round; recorded here so none is re-litigated).*
  1. **Priority of record: parallel + ratchet.** App workstreams continue at full
     speed alongside WS-29; the price is **R5** (§1) — tenant-ready by
     construction, enforced by the shipped ratchet tests, so H2's 561-site
     conversion surface stops growing in unconvertible ways. Neither an MT-first
     freeze nor unruled parallelism was chosen.
  2. **Board format: compact rows.** §2 rows carry state + gates + pointers only;
     narrative lives in each owning spec's "Board record (2026-08-09)" section.
     Rationale: rows had reached 29.5k characters and §2 ~77k tokens — unreadable
     in one pass by the dispatch loop's supervisor, whose own contract says to
     read §2 only.
  3. **MT-2/MT-3 business inputs answered** (were the blockers in
     `saas_multitenancy.md` §8 items 1–2): **modules sell as Core ₹600/user/month**
     (Tasks, Calendar, Chat, People directory) **+ ₹300/user/month per add-on
     module** (CRM, Projects, Email, Meetings, WhatsApp, Workflows); **AI resells
     as a ₹10 "AI action" credit unit at ~50% gross margin** (rate card prices
     each model call at provider cost × 2, denominated in credits; credits sold
     via the rate card, never provider tokens). Recorded in `saas_multitenancy.md`
     §8; MT-4's payment-provider split (§8 item 3) remains the one open input.
- **D17 — Mem0 binds the tenant via connection options (Option A).**
  *(`agent-proposed, owner may overrule` — 2026-08-09; owning spec
  `saas_multitenancy.md` §0.1 path 8, shapes in `_implementation.md` §2.4.)*
  MT-1c's done-when 4 required this decision taken and written down — "leaving it
  undecided fails the ticket". The call: Mem0's pgvector conninfo gains
  `options=-c app.tenant_id=<org>` so the same RLS policies govern memory rows as
  every other table; per-tenant roles (B) add operational surface for no isolation
  gain, and scope-string-only (C) is an accepted-risk fallback nobody has accepted.
  Consequence: `org:global` memory scope becomes tenant-global, not
  deployment-global — coordinate with WS-10 S1 before adding any scope shape
  (`saas_multitenancy.md` §1.9).

- **D16 — The agent sandbox splits; the raw-SQL tool goes now, the container
  tier waits for the pooled cutover.** *(`agent-proposed, owner may overrule` —
  2026-08-08, owner delegated the call.)* MT-0c bundled four clauses of wildly
  different cost and urgency, so the cheapest and most valuable waited behind the
  most expensive. **MT-0c-1 (built):** `query_history` took a *model-generated SQL
  string* and ran it through `acb_graph` — and its keyword guard was wrong both
  ways, rejecting its own documented example (`CREATED_AT` contains `CREATE`)
  while letting `SELECT * FROM provider_keys` straight through. That is a live
  within-org read primitive **today**, so it is fixed now: search criteria, bound
  parameters, two tables, plus a build-failing ratchet against the shape
  returning. **MT-0c-2 (still parked, still OWNER-GATE):** the container/microVM
  tier. **D10's reasoning survives for the silo phase** — one tenant per box means
  an escaped agent reaches only the data it already had — so T2 becomes a
  precondition of the **§5.1 pooled cutover** (customer 8–12), not of Phase 0.
  Building Firecracker-grade isolation before customer #1 is speculative
  infrastructure paid for out of the runway that should be buying customers.
  Owner: **WS-29**, spec `specs/saas_multitenancy.md` MT-0c.
- **D15 — The tenant boundary is a ROW, not a deployment.** *(owner-requested
  2026-08-08; re-takes **D11**.)* Tenant = `organization_id`, enforced by Postgres
  **FORCE ROW LEVEL SECURITY** bound at the `get_db()` seam with `SET LOCAL
  app.tenant_id`; the deployment becomes a *placement* (region/tier), and a dedicated
  database or stack survives as a **priced tier**, not the architecture. D11's cost
  objection — *"a `WHERE organization_id = ?` on 111 tables and every query"* — does not
  hold: connection sites are a bounded set of **eight** (`saas_multitenancy.md` §0.1) and
  **zero existing `SELECT`/`INSERT` statements are rewritten**. **D11's §2–§5 survive
  untouched** — this changes tenancy only, never visibility. Consequences: row-level
  tenancy, an org switcher, multi-org users and per-org credentials all move **into**
  scope (D11 §6 listed all four as out); leak sites 1–10 stop being moot and become
  MT-1i; and **MT-0c requires un-parking D10's T2**, because "trusted colleagues, not
  hostile users" is exactly the threat model that selling externally retires. Owner:
  **WS-29**, spec `specs/saas_multitenancy.md`.
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
  **Amended 2026-08-03:** WS-14's unblock does **not** wait on WS-8 Phase A.
  `config.json`-based instancing already ships via `AgentManifest.instance_key()`
  and is live on the blob store and the workspace file manager with no schema
  change (`agent_architecture.md` §12.1/§12.5). The `dynamic_agents` columns are
  WS-14's own migration; Phase A only changes where they are *derived from*.
- **D4 — Orchestrator org-memory: patch now, unify later.** The missing
  org/agent-scope read on the orchestrator path (`agent_architecture.md`
  §11.1.2) is fixed as a small standalone defect in WS-15. WS-8's A1 runtime
  unification remains the structural fix and deletes the duplicate path.
- **D5 — Shared mailboxes:** `email_app_master_plan.md` owns implementation;
  Centers C sequences it; research §16.7 is design reference only.
- **D6 — The Workflows app won.** `workflows_app.md` + `docs/workflow-editor/`
  are authoritative for graphs, compiler, editor, and workflow-as-tool.
  `multi_agent_orchestration.md` Phases 2–3 and §5.3 are superseded; its
  **Phase 4 alone remains live as WS-12; Phase 1 was struck to WS-23 and
  Phase 5.1 to WS-11 on 2026-08-03** (Phase 5.2 shipped as multiplayer rooms
  under WS-10).
- **D7 — MCP registry exists, with a MAF-side gap.** `13_mcp_servers.sql` +
  gateway CRUD + per-run injection are live (the coherence audit missed it by
  searching for the spec's planned name — R1's disease exactly).
  `mcp_plugin_integration.md` Phase A = shipped; Phases B/C remain research.
  **Verified 2026-08-01:** `_inject_mcp_servers` runs for every agent but
  writes `agent._mcp_servers`, which only the Copilot runtime reads — for
  native-MAF agents MCP injection is a **silent no-op** (no
  `MCPStdioTool`/`MCPStreamableHTTPTool` wiring exists). Any manifest
  `capabilities.mcp_servers` promise (agent_architecture §6) is unimplemented
  on MAF until WS-8 closes this. **Retargeted 2026-08-03:** that instruction is
  now carried in the owning spec as the ticket **WS-8c**
  (`agent_architecture.md` §12.2, AGENT-SAFE) — dispatch it from there, not from
  this decision record.
- **D8 — Budgets/caps enforcement lives at the gateway choke points**, never
  per-app. (Same principle as prompt caching and model tiers: one seam.)
- **D9 — "Pomad Centre" — RESOLVED 2026-08-01.** Owner confirmed it is not a
  real venture (a stray name that should have read Command Center). All 12
  sites across 8 files rewritten as "a second tenant deployment" — the
  phrasing that preserves each sentence's meaning, including the two
  security-requirement sites (`agent_platform_hardening` §64's T2 gate now
  reads "Before multi-tenant (a second org on this platform)"). The name no
  longer appears anywhere outside this decision record. *(2026-08-09: the
  replacement phrase itself — "a second tenant deployment" — embodied D11 and
  was re-swept to organization/placement language after D15;
  `department_centers.md` §4 Q1 keeps the twelve-site inventory as history.)*
- **D10 — Two owner calls taken 2026-08-03.** Recorded here so neither is
  re-litigated by a later dispatch.
  1. **Command Center is an internal Fracktal tool.** *(⚠️ Premise re-scoped
     2026-08-08 by D15/D16: still true as a fact today — no external tenant
     exists yet — but no longer the planning posture; WS-29 exists to retire it.
     The T2 parking below survives in narrowed form: un-parking is a
     precondition of the §5.1 pooled cutover (D16), not "a second org on this
     platform, or agent authorship from outside Fracktal". Every doc decision
     that rests on this premise was annotated with its expiry trigger in the
     2026-08-09 sweep — `agent_platform_hardening_2026-07.md` §1.5,
     `permissions_sandbox_b6.md` §P5-c/d, `workflows_app.md` §1.4,
     `FOUNDATION_BUILDOUT_CHECKLIST.md` §BO-1's enforce posture,
     `meeting_bot_platform_plan.md`'s ELv2 argument.)* The team uses it; there
     are no external tenants and no third-party agent authors. **Consequence,
     already applied in the specs:** WS-3's T2 / full run sandboxing
     (`permissions_sandbox_b6.md` §P5-c) is **parked** under a
     trusted-colleague threat model — the ladder must hold against colleagues,
     not hostile users, and P5-a's credential scoping plus P5-b's ceilings plus
     WS-3a/WS-3b address the concrete standing exposures. **Un-parking is
     OWNER-GATE and has an explicit condition: a second org on this platform,
     or agent authorship from outside Fracktal.** Until then P5-c carries no
     acceptance criteria and none should be written; P5-d is blocked behind it.
     The same threat model is what makes `ACTION_BROKER_ENFORCE` OFF an
     acceptable posture (audit-and-chokepoint rather than per-click approval)
     and what bounds the Agent Workshop's value in `agent_architecture.md` §12.
  2. **Loops in the workflow engine are approved**, against `workflows_app.md`
     §11's standing anti-n8n rule R1. Real automations iterate; an engine that
     cannot iterate pushes makers back to the toil the app exists to remove.
     The engine-complexity cost was stated and accepted. **R1 keeps its original
     meaning unchanged — it governs the node *catalog* (a node exists only if
     the Integration Registry has the integration), not the control-flow
     *vocabulary*** — and must not be cited as a blocker on WS-11's 8.3c.
     Recorded in `workflows_app.md` §8.3c and §11 R1.
- **D11 — ⛔ SUPERSEDED: the tenant boundary is THE DEPLOYMENT.** *(owner call,
  2026-08-03 — **re-taken 2026-08-08 by D15**. Retained verbatim below as the
  decision record; do not build against it and do not cite it for tenancy — cite
  D15. Its §2–§5 visibility content was never touched; its TV-1 carve-out is
  absorbed as WS-29 MT-1i, where the three joins are re-classed from
  "wrong within one org" to "leak across tenants".)*
  One deployment per tenant: a second organization gets its own box, its own
  database, its own credential set. **Row-level organization isolation is
  explicitly NOT being built.** Consequences, each verified against code and
  recorded in `specs/tenancy_and_visibility.md` §1: `organization_id` stays a
  **label, not a mechanism** — it is on **3 of 111** own tables (`app_user`,
  `org_role`, `org_group`) and is read by **zero** authorization decisions
  (`UserContext.organization_id` is populated by an extra `SELECT` at
  `acb_auth/deps.py:155-157` and never consulted; every `WHERE organization_id`
  in the gateway binds from `get_org_id()`'s hardcoded `slug='default'`, not
  from the caller). Nine of the ten enumerated leak classes are **moot by
  definition** rather than by fix; deployment-singleton credentials
  (`provider_keys.provider` is the PK; integration secrets go into the
  process-global `os.environ`) become **correct** rather than a gap. The cost of
  a second tenant — new box, new DB migrated from zero, new credential set, DNS
  + TLS + systemd units — is written down in §1.2 so the choice stays honest.
  **Do not** "fix" this by threading `user.organization_id` into queries: that
  is the first 5% of row-level multi-tenancy and creates a second scoping
  doctrine alongside D12's. The one carve-out is **TV-1** (§2 of that spec): the
  three `org_group` joins that match on **slug alone** are wrong *within* one org
  too, two of them inside the session-authority intersection —
  `gateway/rooms.py:181-199` (the `SELECT g.slug` at `:192`), `:368-403`
  (`SESSION_VISIBLE_SQL` from `:368`, slug join `:377`), `acb_auth/access.py:330-336`.
  *(The first two were published as `:170-179` and `:332-340`; both were wrong at
  `520476ab` and were corrected 2026-08-03 — see `tenancy_and_visibility.md` §2. The
  third was and is correct.)* AGENT-SAFE, one small PR, with a two-org fixture that
  must be verified red first — **but see the board row for the skip-green trap that
  made "verified red" unsatisfiable as originally written.** Owner: the new spec;
  **board row: WS-14a**, minted 2026-08-03 (it had none, which is why it never
  dispatched).
- **D12 — Visibility is private → Center → org, plus ad-hoc groups by invite;
  and a project belongs to a team by an explicit `group:` grant.** *(owner call,
  2026-08-03; owning spec `specs/tenancy_and_visibility.md` §3–§4.)* The owner's
  words were *"department-wise privacy so that the sales team cannot see what the
  finance team is doing… at the same time organizational-level sharing… and
  projects and groups where information can be shared between select users of
  different departments, depending on invite."* **department = Center =
  an `org_group` row** (R3; `department_centers.md` §1) — write "Center".
  **The primitive exists and must be generalised, not reinvented:**
  `routes/rooms.py::_valid_subject` (`:100-111`) already accepts
  `email | group:<slug> | org` and `chat_session.visibility` is already
  `private|people|org`, with group membership expanded at read time
  (`gateway/rooms.py:181-199` — corrected 2026-08-03 from the stale `:163-179`).
  **Correction to the claim that reached this
  board:** `app_grants` does **not** share that vocabulary — `routes/apps/
  grants.py::is_valid_subject` (`:68-85`) is `email | agent:<name> | agents:*`
  and **rejects the literal `org`** (`:77`), with no `group:` case at all; the
  docstring at `rooms.py:103` claiming the two are "identical" was **false** and
  was corrected 2026-08-03 (a docstring-only edit — the false claim was actively
  misdirecting implementers of this very decision).
  Rooms is the only surface honouring `group:` today; the gap table in §5 of the
  spec is the app-by-app map. **"A project belongs to a team" = an explicit grant
  row carrying a `group:<slug>` subject** — *not* derived from assignees (access
  would become a side effect of task assignment) and *not* an owning column
  (single-valued, so it cannot express the cross-Center project the owner asked
  for). This is the semantic that has blocked **WS-14** for weeks; it is
  answered. **Standing review rule:** a new persisted user-facing surface
  declares its tier — it does not inherit one by accident. Two doctrines in one
  codebase is what produced the Notes hole — **PR #346 merged as `d2ef7fa0` on
  2026-08-03**, so the Notes owner filter has landed
  (`routes/notes/core.OWNED_MEETING_PREDICATE`) and a grant table is the remaining
  work there; the spec's §3.3 and §5 rows were updated to match.
- **D13 — The project grant table is `gtd_*`-local, and it has no `role` column.**
  *(`agent-proposed, owner may overrule` — 2026-08-03; owning spec
  `specs/tenancy_and_visibility.md` §4.1.)* Registered here 2026-08-03 because it was
  discoverable only through a parenthetical in the WS-14 row, while being the first
  decision the tasks team slice makes. **The call:** `gtd_project_grant (project_id,
  subject, granted_by, created_at)` — a `gtd_*`-local table with a real FK onto
  `gtd_projects`. **Three alternatives, all rejected in §4.1:** a polymorphic
  `object_grants` (no FK, an index per `object_type`, and a platform migration
  decision taken inside an app ticket — if the owner takes it, it is its own ticket
  that *also* migrates `app_grants`); reusing `app_grants` itself (impossible without
  dropping its `app_id … REFERENCES apps(id)` key, `114_custom_apps.sql:58-67` — i.e.
  the `object_grants` option reached by mutating a live table four Custom-Apps code
  paths read); and an owning `group_id` column on the project row (single-valued, so
  it cannot express the cross-Center project D12 requires). **The `role` column is
  cut, not deferred:** every clause of the slice's acceptance is a read-path clause,
  so `role` would ship with one legal value and no reader — write-through-grant is
  unanswered and arrives later as an additive `ALTER TABLE` at the next free number
  (R1). **What must not fork is the subject grammar:** one validator for
  `email | group:<slug> | org`, and §4.1 now names its home —
  `packages/acb_auth/acb_auth/permissions.py` (pure, already owns the permission
  vocabulary, no new import edge), because "the shared validator" previously named no
  module and no shared home existed. Acceptance: `department_centers.md` C1.
  *(⚠️ 2026-08-09: re-audit C1 against WS-27e's owner-directed one-store revision
  (D-PM-6 — `pm_tasks` is THE task table, WS-27h retires `gtd_items`) before
  dispatching — the `gtd_*`-local grant table may be building on a floor that is
  scheduled for demolition. The subject grammar rule above is unconditional either
  way.)*

- **D14 — `manager`'s "org-wide visibility" is not `data:org:read`, and
  `data:org:read` should not be relied on by anything.** *(`agent-proposed,
  owner may overrule` — 2026-08-04; owning spec `specs/colleague_onboarding.md`
  §3.0(b).)* Minted because WS-24's capability matrix had to answer "does
  `manager` contradict D12's department privacy?" and the received answer named
  the wrong permission. **The measurement:** `data:org:read` is declared
  (`packages/acb_auth/acb_auth/permissions.py:132`), granted to `admin`,
  `manager` and `agent_service` (`130_org_access_control.sql:205, 221`;
  `:258`), and listed in the legacy-fallback set (`acb_auth/access.py:148`) —
  and **no route, query, predicate or frontend check in the repository ever
  reads it.** A repo-wide search outside the vocabulary, the seed migrations and
  the specs returns nothing. `org_access_control.md:81` described `manager` as
  "sees org-wide data" on the strength of it; that sentence was aspirational
  and was corrected on 2026-08-04 (the same edit replaced that row's *"all
  `feature:*` except `build.*`"* grants cell, which was wrong in five slugs —
  `manager` also lacks workflows, integrations, models, agents and every
  `center.*`).
  **The proposed call, in two parts.** (i) **No spec, ticket or acceptance
  criterion may rest on `data:org:read` until it has a consumer.** Writing one
  is its own ticket: either give it a meaning (which is an org-wide read path,
  i.e. the exact thing D12 constrains) or strike it from `CAPABILITIES` and the
  three seed grants. Leaving it as-is is also acceptable — it grants nothing —
  provided nobody *cites* it. (ii) **The department-privacy question the owner
  actually has to answer is about `admin:members:read`**, which is the floor for
  the **entire** `/admin` package (`routes/admin/_common.py:77-91`), not just
  the member list: a `manager` reads the full member directory, the role
  catalogue and the group list, and `/auth/me` returns `is_admin: true` for them
  (`routes/admin/me.py:96`). Combined with `feature:approvals`,
  `feature:observability` and `memory:write_org` (`131:62`), that is the real
  breadth of the role. **Rejected alternative:** quietly narrowing `manager` in
  a migration. It is a policy call about who may see the shape of the
  organisation, it is exactly the shape of D12, and no acceptance should be
  written for it until the owner decides. **Consequence if the owner does
  nothing:** `manager` stays as seeded and WS-24's matrix labels it accurately;
  nothing breaks, and the only standing rule is (i). *(2026-08-09: the
  zero-consumer measurement is retired — WS-27d's full-portfolio view is
  deliberately `data:org:read`'s first consumer, and granting it to a real
  member is owner-gated in §6 WS-27 (d). Part (i) still binds for every other
  spec: name the consumer or don't cite the permission.)*

## 4. Single-owner registry (who owns duplicated work)

| Work | Owner | Mirrors (link-only after §5) |
|---|---|---|
| **The user-management contract every app must follow** (identity chain, member lifecycle, permission vocabulary, the ten build rules) | **`specs/user_management_contract.md`** — created 2026-08-05, and it deliberately **owns RULES, not FACTS**: every fact is cited to the spec that owns it, so it can never become a fifth competing description of the access model | `org_access_control.md` (the model) · `colleague_onboarding.md` (the gate + the runbook + the matrix) · `tenancy_and_visibility.md` (D11/D12) · `department_centers.md` (Centers as projections). Surfaced to builders from root `AGENTS.md` constraint 10, `apps/services/gateway/AGENTS.md` and `workbench/AGENTS.md` |
| **Colleague onboarding readiness** (the pre-invite gate, the invite runbook, the role × app capability matrix) | **WS-24 — `specs/colleague_onboarding.md`** | `org_access_control.md` §7 (bootstrap) and its role table, lines 79-83 — **line 81's `manager` row was corrected 2026-08-04 per D14** (intent no longer claims org-wide data; the grants cell is now the literal seeded array, because *"all `feature:*` except `build.*`"* was wrong in five slugs) · `department_centers.md` §2 (the five-place Center registration checklist the runbook's step 3 depends on) · `tenancy_and_visibility.md` §5 (the app-by-app gap table — that doc owns the *doctrine*, this one owns the *measured current state per role*) |
| **The single member of record** | **`vjvarada@fracktal.in` is the only signed-in member** (⚠️ **owner-reported 2026-08-04, NOT measured** — it is a live-DB fact and §6 forbids an agent the tool that could measure it; re-check on the box before relying on it) | There is exactly one. `EXECUTIVE_EMAILS` is the bootstrap candidate list (`acb_auth/access.py:467-519`) and is **not** a role — a member's real access is resolved from `app_user` + `user_role` + `user_permission_override`. **No agent may add, promote or suspend a member**: `POST /admin/members`, `PUT /admin/members/{email}/roles` and `PATCH/DELETE /admin/members/{email}` are live-DB writes to the access model and are registered in §6. Onboarding runbook: `specs/colleague_onboarding.md` §2 |
| Groups admin UI + seeding | **WS-13 / Centers B** | groups_sessions_authority §6.5 · org_access §8 Ph2 · multiplayer §4.5 |
| Team-instanced agents | **WS-14 / Centers C3** (mechanism per D3) | `docs/multiplayer/agent-kinds.md` §6/§8 — **note the path: it is under `docs/multiplayer/`, not `ai-company-brain/specs/`**, and its §6 roster is a **design proposal, not a work list** (seven of its twelve agents do not exist; it contradicts three shipped `config.json` files — both annotated there 2026-08-03) · agent_architecture §6/§12A · memory_architecture §6.1 · groups §6.2 |
| Shared mailboxes | ⚠️ **OWNERLESS IN FACT — do not dispatch** (measured 2026-08-03) | D5 assigns implementation to `email_app_master_plan.md`, sequenced by WS-14. That spec contains **zero** occurrences of "shared mailbox", and `email_account_member` — cited as Phase-2 content by `department_centers.md` and `org_access_control.md:311` — **exists nowhere in the repo** (0 hits in `*.sql` and `*.py`). D5's *sequencing* stands; its *ownership* is nominal. **Next action is a doc action, not a build:** either `email_app_master_plan.md` gains a section for it, or this row names a different owner. Recorded in `department_centers.md` C2. | org_access §8 Ph2 · groups §1 · research §16.7 |
| Per-Center approvals routing | **WS-14 C4 — 🔴 OWNER-DECISION, not dispatchable** | `org_access_control.md:405` Q2 is open verbatim (*"who is asked? … per-module approvers is a Phase 2 question"*), **and there is no column to route on**: `infra/postgres/66_pending_actions.sql:13-38` carries no requesting-member, group or Center column. ⚠️ **Corrected 2026-08-03** — this cell used to add "(`actor` is the proposing *agent*)", which is **false**: two of `actor`'s six writers put the requesting human in the string (`routes/apps/tools.py:393`, `routes/apps/actions.py:345`, both `actor=f"app:{slug}:{email}"`), so a group **is** derivable there. The verdict holds on the real evidence — `actor` is free text with five shapes (`app:<slug>:<email>` · `app:<slug>` · `workflow:<name>` · `tasks:<provider>` · `tasks:clickup:ws:<id>`) and a human in only **two of six** proposers, so a Center inbox filtered on it would be silently empty for every workflow-, publish- and provider-originated proposal. The new column must be written by every proposer, not parsed from an ad-hoc string. Evidence: `department_centers.md` C4. The ticket is "answer Q2, then add a column", never "add a filter" |
| Cost attribution | **WS-6** (D1) | multiplayer §5.3/Ph4 · agent-kinds §9 Q4 · Centers D |
| Budgets | **WS-16** (D2) | multiplayer §4.3/§5.3/Ph4 |
| Digest workflows | **WS-15** (also scores workflows G1) | workflows_app §1.2 |
| Orchestrator org-memory fix | **WS-15** (D4); structural fix WS-8 A1 | agent_architecture §11.1.2 |
| Workflow engine/editor | **workflows_app.md** (D6) | multi_agent_orchestration Ph2–3/§5.3 · Ph5.1 (Magentic/GroupChat as graph node types — reassigned to WS-11, 2026-08-03) |
| Isolation ladder (BO-7 / HH-6 / T0–T2) | **`permissions_sandbox_b6.md`** (the Phase-5 build order `P5-a…d`; WS-3) | `agent_platform_hardening_2026-07.md` §1.2 — the ladder *definition* only, and the single T0/T1/T2 table of record · `FOUNDATION_BUILDOUT_CHECKLIST.md` §BO-7 · `competitive_hardening_2026-07.md:119-141` (build log for the 2026-07-27 passes) |
| Context discipline / prompt budget | **WS-23** — `skills_registry.md` + `skills_scope_out.md` | multi_agent_orchestration Ph1 (struck 2026-08-03: 1.1 shipped, 1.2 moot, 1.3 delivered here) |
| Collaborative multi-agent chat (Shape C) | **WS-10** — shipped as multiplayer rooms (`docs/multiplayer/README.md`); the floor-control residue is OWNER-GATE | multi_agent_orchestration Ph5.2/§5.6 (struck 2026-08-03) |
| Calendar / Focus OS | **WS-21** — `calendar_focus_os.md` §5 canonical for `gtd_time_blocks`, §9 canonical for all F2/F3 acceptance; `calendar_timeboxing.md` §13 canonical for P4 external sync | The family has **four** docs, not two: `calendar_ai_review.md` and `calendar_ux_review.md` are **unregistered sub-docs**. `calendar_ai_review.md` is cited by three shipped migration headers (92 / 97 / 100) but by no board row and no spec index entry — *(focus_os §9.13 lists the third as 98; the file that cites it is 100)*. `calendar_ux_review.md` is the **sole** home of the block-reminders/notifications item (focus_os §9.13). **Horizons / Top-5 outcomes is DISPUTED between WS-21 (§4.7) and WS-18 — assigned here, to WS-21**; it is still DO-NOT-DISPATCH until it has acceptance (`calendar_focus_os.md` §9.10). |
| Chat HITL model | **generative_ui_2.md §2** (shipped) | chat_ux §12.3 (superseded) |
| Multiplayer prior art (`qm`, 2026-08-01) | **`multiplayer_prior_art_qm_2026-08.md` is reference-only** — it owns no work and no status; the specs it links stay authoritative | multiplayer README §4.6/§5.1/§6.4/§6.5 · memory-clearance §3.3/§7 · agent-kinds §9 Q1 · skills_scope_out §6 · WS-10 · WS-23 |
| Memory compartments + clearance (incl. `subject:`) | **`docs/multiplayer/memory-clearance.md` §7** (surface design §7.1); dispatched as **WS-10 S1** | memory_architecture §9 `3a′` (link-only since 2026-08-02) · multiplayer README §6.3/§8 Phase 3 (index only) · prior-art §QM-D1 (reference only) |
| Native CRM + the Zoho retirement path | **WS-26 — `specs/crm_app.md`** (minted 2026-08-05) | `department_centers.md` Sales Center "Pipeline" app (a projection of `/crm`, flipped live by WS-26c) · WS-1 interplay **settled 2026-08-05 (D-CRM-7/D-CRM-8) — the writer now EXISTS** (branch `ws-26b-zoho-sync`): `ingestion/sources/zoho/writer.py`, the sync engine's **single, broker-gated** writer with one grep-asserted caller (`routes/crm/sync_zoho.py::execute_push`) and three registered `crm.zoho_*` handlers that auto-apply while `ACTION_BROKER_ENFORCE` is off, retired at WS-26e. WS-1's "no Zoho write path anywhere in the repo" sentence was corrected in that same change (done-when 6) — this row and the WS-1 row now agree, and neither should be re-softened · WS-2 (the Zoho-token P0's endgame is WS-26e's **revoke**) · WS-20 §11's "Odoo/Zoho-bound items" (bind to `crm` `entity_ref` per WS-26d instead — ⚠️ as of 2026-08-06 WS-26d has made `"crm"` a KNOWN system so such a ref **parses**, but there is still no linker: nothing writes `wa_contacts.entity_ref` for any system, and the drawer's `crm` block is still `None`. Whoever binds these items owes both halves) · `orchestrator/sales_views.py` + `scripts/reconciler.py` + `skills/sales\|reconciler/*` keep reading the graph mirror until WS-26e repoints them |
| Native project management + the ClickUp retirement path | **WS-27 — `specs/project_management_app.md`** (minted 2026-08-05) | `task_manager_app.md` (the personal GTD lens — untouched as an app; its ClickUp provider **arm** retires at WS-27g while the provider *interface* stays, becoming the seam WS-27e's internal `commandcenter` provider uses) · `department_centers.md` C1/WS-13 (the tasks team slice and the People Center sub-app list; C1's `gtd_project_grant` = D13 stays C1's own — `pm_project_grants` is a sibling on the same subject vocabulary, never a replacement) · `task_manager_hr_planning_and_memory.md` (people/capability layer — WS-27 reads it, never rebuilds it) · `workflows_app.md` owns the automation engine WS-27f feeds (D6; the Paca-grade uplifts are recorded there as backlog, not here — **written up in full 2026-08-06 as `workflows_app.md` §13, items U1–U8**, where **U1** = the `pm.update_task` node and **U7** = agent dispatch, i.e. WS-27f's two halves, and U2–U6/U8 are engine work WS-27 does not wait on; §13 is backlog and changes neither Slice 3 nor Slice 4) · `paca_pm_research_2026-08.md` (reference-only, owns no work) · WS-1's BO-1a/BO-1b are **named prerequisites** of WS-27c, not discoveries |
| The People Center's surfaces (directory, org chart, capability search, seats) | **WS-28 — `specs/people_center_app.md`** (minted 2026-08-06) | It owns **surfaces, not facts**: `task_manager_hr_planning_and_memory.md` owns the HR data and the capability vectors · `org_access_control.md` owns identity, roles and overrides · `colleague_onboarding.md` owns the invite process and the role × app matrix · `department_centers.md` owns Centers and groups · `project_management_app.md` owns the work. WS-13's *People directory read view* is closed by WS-28b rather than staying open in Centers B |
| **Tenancy boundary** (which company) | **`specs/saas_multitenancy.md`** (**D15** §1 · the three planes §0.9 · tickets §11) + its child **`specs/saas_multitenancy_implementation.md`** (SQL, seams, ratchets, runbooks — shapes only, no decisions) | ⚠️ **`tenancy_and_visibility.md` §1 + §6 are SUPERSEDED** (D11 re-taken 2026-08-08). Cite D15 for tenancy, never D11 |
| Visibility model (who inside that company) | **`specs/tenancy_and_visibility.md`** (D12 §3–§4 · the app-by-app gap table §5 · TV-1 §2 — **unchanged and still binding**) | `department_centers.md` (the "separate deployment is for a separate org, never a department" rule) · `org_access_control.md` §8 Ph2 · `multi_user_organization_research.md` §5/§7/§8/§9/§17 (**research only, and superseded for planning by the new spec**) · `groups_sessions_authority.md` §3 (the intersection rule it constrains) · D9 (the twelve "second tenant deployment" sites) |

## 5. Documentation remediation backlog (WS-0)

> **Update 2026-08-01 (doc-truth pass): EXECUTED.** All Tier 1–3 items below
> were applied by a six-agent pass, each edit verified against code first.
> Kept as the record of what changed. **Residual items** (new or deferred):
> 1. ~~`ai-company-brain/AGENTS.md` build-table rows are themselves stale~~
>    **CLOSED 2026-08-09** — the "What Has Already Been Built (as of
>    2026-06-20)" table was retired outright rather than refreshed: it was a
>    second competing status description (40%+ wrong: broker/meeting-bot/
>    WhatsApp rows claimed unbuilt over shipped work) and §4's doctrine says
>    mirrors are link-only. The file now points at §2 here and the owning
>    specs.
> 2. `note_taker_app.md` §3.13's status-as-blockquote → proper table (cosmetic).
> 3. `chat_ux.md` full archival decision (banner + supersession notes are in;
>    body retained as protocol reference for the still-open §12 VII–XI items).
> 4. ~~`calendar_focus_os.md` "breaks in the packer" may have partially
>    shipped — verify before dispatching F2.~~ **CLOSED 2026-08-03.** It
>    **shipped 2026-07-23** (`80722e17`, migration 97) as *packer geometry*: a
>    widened buffer behind the block that trips `max_focus_run_mins`, plus an
>    optional protected lunch window, applied to plan, replan, rollover **and**
>    the nightly job. The nuance that keeps F2 alive: **the break is a gap, not
>    a row** — nothing renders it, nothing can skip it, nothing counts it. The
>    `kind='break'` row is §9.1 S4.
> 5. ~~D9 (Pomad Centre) remains an owner call~~ — resolved 2026-08-01, all
>    12 sites rewritten as "a second tenant deployment" (see D9).
> 6. **Spec-index and docstring staleness (new, 2026-08-03).**
>    `ai-company-brain/AGENTS.md`'s per-feature spec index is missing rows: it
>    has **no calendar row at all** (four calendar specs, none listed) and no
>    `agent_architecture.md` entry. Separately,
>    `ai-company-brain/AGENTS.md:190` and `apps/AGENTS.md:23` still carry the
>    struck falsehood that the Action Broker *"ships with zero handlers and is
>    not yet wired into the write path"* — untrue since 2026-07-13; see WS-1's
>    five registration sites. ~~Both are AGENT-SAFE doc fixes, neither is in this
>    change.~~ **CLOSED 2026-08-09** — spec index completed (16 missing rows
>    added, incl. the whole calendar cluster and `crm_app.md`) and the broker
>    falsehood corrected at `ai-company-brain/AGENTS.md` (glossary + build-row +
>    priorities) and `apps/AGENTS.md:24`.
> 7. **2026-08-09 — WS-29 consolidation pass EXECUTED** (this change). One
>    sweep, driven by four parallel audits (board digest · MT plan-of-record ·
>    D11/D10-language inventory · status-header inventory): **(a)** §2 compacted
>    per D18, narratives → owning specs' "Board record (2026-08-09)" sections
>    with corrections enumerated; **(b)** D11 and D10.1 bannered as
>    superseded/re-scoped, D9's replacement phrase re-swept, D13/D14 annotated;
>    **(c)** R5 minted, D17/D18 recorded; **(d)** the D15-conflict inventory
>    fixed across ~25 docs (deployment-tenancy claims, internal-tool premises,
>    `slug='default'` teachings, "second tenant deployment" phrasing) — rewrite
>    class: `agent_platform_hardening_2026-07.md` §1.5,
>    `permissions_sandbox_b6.md` P5-c/d parking,
>    `docs/DESIGN_LIMITATION_native_maf_mutation.md` ("tenancy not settled" was
>    false); **(e)** status headers added/corrected per the inventory (5 files
>    had none; 7 contradicted fact); **(f)** WS-25 re-measured (deploys green
>    2026-08-06/07 UTC, tip health-verify failure open); **(g)** MT specs updated:
>    §8 pricing inputs (D18), D17 Mem0 decision, H1 scratch-verify + PR #404,
>    MT-1a anchor corrections, §5.1 cutover trigger ADOPTED. Residuals that
>    remain open: §5 items 2–3 above; `multi_user_organization_research.md`
>    §17.3 got its rejection banner but the doc stays research-only;
>    `reference.md`/`system_architecture.md` carry stale-warning banners, not
>    re-verification (re-measure before relying).

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
14. ~~`agent_architecture.md` — one status for approve_all (§3.2 vs §11.3 vs
    §12 A0); Phases F/G dependency split (3a partly shipped).~~ **CLOSED
    2026-08-03 — both halves done:** A0 now carries one status (done
    2026-07-26, remaining scope named as the runtime/entrypoint check), and the
    §12 phase table splits F/G onto the still-open half of multiplayer 3a.
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

> 📋 **Handing this to another agent?** Start at [`HANDOVER.md`](HANDOVER.md) — branch state,
> the two migrations that are on no real database yet, the verification protocol, the ticket
> queue in dependency order, and a list of every trap that cost real time.

## 6. Owner-gate registry (agents must refuse these)

> **WS-29 / MT-0c-2 — un-parking the WS-3 T2 container tier.** Still OWNER-GATE, and
> **still parked** — narrowed by **D16** (2026-08-08). `saas_multitenancy.md` §0.9.3's
> *conditions* (no raw-SQL tool; no agent-reachable `app.tenant_id` write) are satisfied
> without it: **MT-0c-1 shipped the first**, and the second cannot be violated before
> `app.tenant_id` exists (MT-1b). What remains is the container/microVM boundary, which
> D10 parked on the "trusted colleagues" threat model — a model that survives the silo
> phase and dies at the pooled cutover. **An agent must refuse to build T2 and say so**;
> it is a precondition of the §5.1 cutover, not of Phase 0.
>
> **WS-29 — moving any customer onto the pooled tier.** Cutover is a data move against
> live customer data. AGENT-SAFE to build; **OWNER-GATE to execute.**


> **Two identity-boundary items, measured on the running deployment 2026-08-05 —
> both OWNER-GATE, and together they are what makes every other access control
> in this plan trustworthy or not.**
>
> 1. **`GATEWAY_INTERNAL_TOKEN` is byte-identical to `LITELLM_MASTER_KEY`** on the
>    box (same length, same sha256). It is *set*, so a "is it configured" check
>    reads green — it was set to the same value. The service identity is therefore
>    the key every agent's BYOK client holds. **Rotate it by redeploying**, never by
>    hand into `.env` alone: `deploy.yml` reconciles `.env.local` from `.env`, and
>    setting only the first locks out every signed-in member (see
>    `colleague_onboarding.md` §1.1's lockout warning).
>    ~~⚠️ Blocked 2026-08-05: the prescribed rotation *is* a redeploy, and the
>    delivery path is broken.~~ **UNBLOCKED 2026-08-09:** delivery recovered —
>    deploys landing since 2026-08-06, six green runs on 2026-08-07 UTC (#400
>    log-verified on the box; see WS-25). The rotation is executable again via a
>    redeploy; the
>    both-files reconcile warning above still binds, and the tip run's
>    health-verify failure (WS-25) is worth understanding before choosing the
>    deploy window.
> 2. ~~**Gateway `:8080` and workbench `:3001` are open to the internet**~~
>    **CLOSED 2026-08-05.** Both UFW rules removed (v4 and v6); verified from
>    outside the box that each now refuses while `https://api.…/health` still
>    answers 200 and the UI 307s to `/signin`. There is **no Hostinger cloud
>    firewall** on this VPS (`firewall_group_id: null`, firewall list empty), so
>    UFW is the only barrier and the only place this can regress.
>    Still owed: Caddy's `header_up -X-User-Email` / `-X-User-Role` strip
>    (`deploy/hostinger/caddy/Caddyfile`) — now defence-in-depth rather than the
>    load-bearing control, since the bypass path it guards is closed.
>
> Item 1 still blocks *trusting* app development: an owner predicate applied to a
> forged identity is not a control. Delivery works again (2026-08-09), so the
> only thing between here and the rotation is the owner choosing a window.

Force-push / history rewrite (BO-8) · credential rotation (Zoho, Hostinger
token) · enforcement flips (`ACTION_BROKER_ENFORCE`, `AGENT_PERMISSION_MODE=
enforce`, `MEM0_ENABLED`, `GRAPHITI_ENABLED`, `WHATSAPP_ENRICHMENT`,
`SKILLS_FAIL_CLOSED` — the WS-23 fail-closed default-profile flip; review
`skills_scope_out.md` §3 dynamic-agent rows first · `SKILLS_INDEX_ONLY` —
the WS-23-successor skills-index flip: every agent's prompt becomes a
one-line-per-family index with bodies read on demand; see
`skills_scope_out.md` §7 · `INGESTION_CONSUMER` — the WS-4/BO-20
ingestion-consumer flip (the loop **shipped OFF** in BO-20a, 2026-08-02):
turning it on is not just "start a loop" — it cuts all three provider receivers
over from inline `emit_event` to enqueue-only so the consumer becomes the
**only caller of `emit_event`** (not "the single dispatch path" — that wording
was loose: `routes/agent.py:3476-3478` calls `dispatch_event` directly and is
untouched), which means Redis down = provider events dropped rather than
dispatched inline, logged as `<source>.queue.dropped`; see
`FOUNDATION_BUILDOUT_CHECKLIST.md` §BO-20.0 (answered: Option A) and its Q1) ·
**WS-6 observability activation** (Langfuse keys + bringing up
`--profile obs` in prod, `OTEL_EXPORTER_OTLP_ENDPOINT` in the deploy env,
`LLM_USAGE_AUDIT=1`, and re-enabling MAF telemetry by setting
`ENABLE_INSTRUMENTATION` — the kill switch is the env read at
**`executor.py:138`**, inside `_disable_agent_telemetry_once` (block
`:113-140`; the long-standing `:114` citation pointed into the comment banner
above it — corrected and re-verified 2026-08-03). It hides a known
ContextVar-reset bug that turns a successful streamed run into a `RUN_ERROR`) ·
**`copilot_sandbox_scope`** (`packages/acb_common/acb_common/settings.py:222`,
ships `""` = fully off, in-process everywhere). Putting `code_task` or
`app_builder` in it routes **real Copilot sessions into containers** — a live
execution-path change, not a config tweak. It was registered nowhere until
2026-08-03 ·
**`ISOLATION_TIER_ENFORCE`** — the new switch WS-3a introduces
(`permissions_sandbox_b6.md` §P5-a.2). Today every unscoped agent derives T2,
so flipping it **refuses most real runs**; it ships OFF and the refusal must be
behind it ·
**WS-12 Phase 4.0's target choice** (minimal-bump vs full-bump,
`multi_agent_orchestration.md` §6 Phase 4.0) — a cost/schedule call, and the
reason WS-12 has **zero** dispatchable PRs. An agent may produce the 4.1
evidence and must then stop and report ·
**WS-12 Phase 4.6's manual soak** of the Copilot streaming path — an agent
cannot simulate or self-certify it, and must not mark 4.6 done without a
recorded human sign-off ·
**Calendar external sync (WS-21)** — needs Google Calendar and/or Microsoft
Graph **OAuth client credentials (client id + secret + redirect URI)
provisioned on the VPS** and registered in the Integration Registry;
`calendar_timeboxing.md` §13 P4 clause 1 ("a `calendar_accounts` row created
through a real OAuth connect flow") is unverifiable without them ·
**outbound nudge sending — one shared gate for two rows:** WS-21 §9.4's
Waiting-on chase block and WS-18's follow-up nudges both end in a real
outbound message from a real account. Drafting and queueing are AGENT-SAFE;
**sending is not**, and neither row may flip it independently ·
creating the bot Google account + real-meeting joins · Meta app review ·
real-account email sends / live-DB one-offs (`merge_ghost_messages --apply`) ·
**the WS-10 floor-control re-decision** — whether the five `chat_session.floor_mode`s,
the turn queue, the observer lane, handoff-with-a-note and HITL floor-holder
routing still earn their place now that steer ships (`docs/multiplayer/README.md`
§8 Phase 2: *"pending the owner's re-decision"*). No acceptance exists for it and
none should be written until the owner decides; an agent asked to "finish
multiplayer Phase 2" must refuse **this** part by name and may build only the
S1 `subject:` slice ·
**the per-Center approvals-routing decision (WS-14 C4)** — `org_access_control.md:405`
Q2 (*"who is asked? … per-module approvers is a Phase 2 question"*) is a policy call
about who may approve an outward write or a spend on another Center's behalf. Same
shape as the floor-control gate below: **no acceptance exists for it and none should
be written until the owner decides.** Registered 2026-08-03 because it read as a UI
filter and was not one — `pending_actions` (`infra/postgres/66_pending_actions.sql:13-38`)
carries no requesting-member, group or Center **column**, so the follow-on is "answer Q2,
then add a column at the next free migration number". *(Corrected 2026-08-03: the
companion claim that `actor` never names the human is **false** — `routes/apps/tools.py:393`
and `routes/apps/actions.py:345` write `app:<slug>:<email>`. The gate stands on the real
measurement: five ad-hoc `actor` shapes, a human in two of six proposers. See
`department_centers.md` C4.)* ·
**the WS-10 `prefs`/`user` backfill APPLY** — running the classifier's output
against live Mem0 personal memories (`docs/multiplayer/memory-clearance.md` §8 Q1:
*"it should be a deliberate, communicated choice"*). The classifier itself and a
**dry-run report** are AGENT-SAFE and are the whole of the agent's mandate; the
mutating pass is a live-DB one-off ·
`test_owner_bootstrap.py` against prod (never) · any deploy that changes auth
behaviour (supervised window per `FOUNDATION_CONTINUATION.md`) ·
**the four WS-24 colleague-onboarding gates** (`specs/colleague_onboarding.md`
§1.1), registered 2026-08-04 because "invite a colleague" reads like a UI
action and is not one:
**(a) installing the Caddy identity-header strip** — writing
`deploy/hostinger/caddy/Caddyfile` is AGENT-SAFE, `sudo install` +
`systemctl reload caddy` on the box is not; it changes auth behaviour, and the
pipeline only reinstalls the repo copy when the live one **fails**
`caddy validate` (`.github/workflows/deploy.yml:496-501`), so the two can drift
silently and an agent must not assume a merged repo file is live ·
**(b) provisioning `GATEWAY_INTERNAL_TOKEN`** — a credential, and it must land
in **both** `/opt/acb/app/.env` and the workbench's `.env.local`, because the
Next BFF mirrors the same `LITELLM_MASTER_KEY` fallback
(`workbench/control_plane/src/lib/gateway.ts:58-61`); a mismatch turns every
proxied browser call anonymous. **`GATEWAY_REFUSE_LLM_KEY_IDENTITY` is a
separate owner gate of its own** — it ships OFF, defaults to today's behaviour
exactly, and flipping it while the token is unset **401s every signed-in
member** ·
**(c) installing/scheduling the BO-23 backup timer** — building the dump
script, the manifest and the restore runbook is AGENT-SAFE; installing the
systemd unit and pointing it at prod data is not ·
**(d) any write to the member/role/group tables on the live box** —
`POST /admin/members`, `PUT /admin/members/{email}/roles`,
`PATCH`/`DELETE /admin/members/{email}`, `PUT /admin/members/{email}/overrides`,
`POST`/`DELETE /admin/groups/{slug}/members`. Inviting a real person, changing
what they can see, or removing them is the owner's act. An agent may write the
runbook, the preflight and the matrix, and must stop there ·
**running `scripts/onboarding_preflight.py` against production** — the script
is agent-safe to author and its DB checks read the live database, so an agent's
only mode is `--mode local`, which refuses the box-only checks by design ·
**the four WS-26 CRM gates** (`specs/crm_app.md`), registered 2026-08-05 (d added 2026-08-07):
**(a) the Zoho two-way sync against production** — **BUILT 2026-08-05 · BACKFILL RUN
2026-08-06 · SYNC LOOP ENABLED BY THE OWNER 2026-08-06.** (The old "never run"
reading is retired; the gate is NOT — it now governs changes to a *running* loop
rather than a first switch-on.) Measured at enablement: the loop cycles every 600s;
the first cycle pushed **nothing** (no row was dirty), pulled
737/1,189/1,516/551/1,909, and left **zero** rows dirty — echo suppression held. One
defect surfaced in the first cycles and is fixed in main (PR #375): the `Deals`
watermark could never advance, because this tenant returns no `Modified_Time` for any
module and no `Created_Time` for Deals, so that module re-pulled all 551 records every
cycle. Deal conflict resolution is consequently one-sided (native-wins) by design —
spec §7.1. Building the engine was AGENT-SAFE; **turning the sync flag on, the first
backfill run, and any hand-run sync cycle were the owner's acts and remain so**: the
engine **WRITES the live Zoho tenant**
(re-scoped 2026-08-05 per spec D-CRM-7, owner-directed), pushes native edits
up, and propagates deletes in both directions. The **code floor is
`admin:access:manage`**, not `integrations:use:zoho-crm` — audit finding
2026-08-05: migration 131 grants `member` `integrations:use:*`, so the
integration slug gates nothing ·
**(b) flipping `CRM_AUTO_LEAD`** — ships OFF; ON turns unknown inbound email
senders into CRM lead rows — **each born `zoho_dirty = true`, i.e. queued for
push into the live Zoho tenant on the next sync cycle (which
`POST /crm/sync/zoho` runs with or without `CRM_ZOHO_SYNC`)**. Ruled D-CRM-9
(owner, 2026-08-06): this is intended behaviour — agent- and auto-originated
writes enter the push queue exactly like human ones. So the flip is both a live
change to email-app behaviour and, transitively, a write path into Zoho. ⚠️ The
settings field **does not exist yet** and was deliberately not added by WS-26d's
read half. **The hook it was missing is now named (2026-08-06, `crm_app.md` §9.2):**
`routes/email/scheduler_hooks.py::process_new_mail` — the one seam the scheduler,
the manual-sync route and the webhook all funnel through. The field lands with
WS-26d-autolead, shipping OFF, with a regression proving the OFF state makes no
CRM call at all ·
**(c) the WS-26e cutover + retirement** — the final import + parity check,
repointing the graph-mirror consumers (`sales_views.py`, `reconciler.py`),
retiring `ingestion/sources/zoho/` + cron + webhook + config (spec §7.4, which
includes an `.env.example` edit that plan-guard already blocks), and **revoking
the Zoho refresh token** — the act that executes part of WS-2's standing P0 ·
**(d) applying the WS-26f stage-metadata repair against prod**
(`POST /crm/import/zoho/stages?apply=true`) — it rewrites the live pipeline's lane
order, stage types and probabilities in one call, and the board every `feature:crm`
holder sees reorders under them; the dry-run (no `apply`) is agent-safe and is how the
proposal reaches the owner. If the tenant returns more than one pipeline the repair
must STOP unapplied (spec D-CRM-11). Re-minting the Zoho token with `settings.*` scopes,
should the probe report no-scope, is likewise the owner's act ·
**the five WS-27 Projects gates** (`specs/project_management_app.md`), (a)–(d)
registered 2026-08-05, (e) added 2026-08-08:
**(a) running either ClickUp import endpoint against the production workspace** —
~~⚠️ **ALSO BLOCKED ON WS-29a AS OF 2026-08-08**~~ — **LIFTED the same day:
migration 158 keyed all seventeen `pm_*` tables, which was the reason to
wait.** ⚠️ Two conditions replace it: migration 158 **must be applied to the
target database first** (it is on no real box yet — the deploy path is
broken, WS-25), and the mapping decision below still stands. Kept struck
because the reasoning is the reusable part: CommandCenter is becoming
multi-tenant and all seventeen `pm_*` tables carry no `organization_id`
(`specs/multi_tenancy.md` §2). Importing a real workspace now writes hundreds
of tasks, activities, attachments and grants into unscoped tables, which turns
a one-line default on empty tables into a backfill plus an `ALTER` on live
rows. The import is not wrong, it is **early**: land WS-29a first. —
building both is AGENT-SAFE; executing them is not. `POST /projects/import/clickup/plan`
writes nothing to our DB but **reads the live ClickUp tenant** and spends LLM
budget classifying it; `POST /projects/import/clickup` writes the live DB, and
during coexistence a re-import is last-import-wins on ClickUp-sourced fields
(spec §7.1). **Confirming the Space→Center mapping is itself the owner's act
(D-PM-10):** an agent may propose the mapping and must not apply one, because a
wrong map grants a Center visibility of another department's work. Code floor is
`admin:access:manage`, per the WS-26b finding that `integrations:use:*` gates
nothing ·
**(b) enabling the WS-27c outbound push** against the real workspace — the sync's
ClickUp writes flow through `_broker_gate`, and **BO-1a + BO-1b must both be in
first** (the same two flip-blockers WS-1 names; approving a delete with no handler
marks the row `failed`, and an ignored pending marker shows a green "synced" task
that exists in no workspace) ·
**(c) the WS-27g cutover + retirement** — final import + parity sign-off, flipping
the sync to pull-only then off, repointing the graph-mirror consumers off the
ClickUp arm, retiring `ingestion/sources/clickup/` + the `ClickUpProvider` arm +
`skill-clickup-sync` + catalog/OAuth entries, **revoking the ClickUp tokens**, and
the root-`AGENTS.md` constraint-8 amendment (CommandCenter becomes the PM system
of record) — that amendment ships in the WS-27g PR, never before ·
**(d) granting `feature:projects` or `data:org:read` to any real member** on the
live box — the same member/role-table write rule as WS-24 (d); the full-portfolio
view is deliberately `data:org:read`'s first consumer, so granting it now grants
visibility that previously granted nothing. ·
~~**(e) answering D-PM-12 — whether a `blocks` dependency CONSTRAINS the schedule
or only describes it**~~ **ANSWERED 2026-08-08 and the gate is CLEARED.** The owner
was given the three options and their costs and delegated the choice back
(*"go ahead with the decision that you think would be best"*); recorded as
**D-PM-12 = (c) constrain-and-warn**, so WS-27p's "derived and shown, never
enforced" stands unamended and no cascade of writes was introduced. Kept struck
rather than deleted because the shape of the gate is the reusable part: an agent
must still refuse to make `blocks` **push dates** — moving to option (b) is a new
owner decision, not an extension of this one, and it would strike WS-27p's
paragraph rather than sit beside it.
