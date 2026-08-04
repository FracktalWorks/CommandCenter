# Work Plan of Record — the dispatch board

**Status:** Active · **Date:** 2026-08-03 (six-row truth pass: WS-1, WS-3, WS-8,
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
| 1 | **`main` has no branch protection** | WS-5 · checklist §BO-17 | Re-verified 2026-08-03 against the live repo: `gh api repos/FracktalWorks/CommandCenter/branches/main/protection` → **`404 Branch not protected`** *and* `gh api …/rulesets` → **`[]`**. So there is no protection under either mechanism, and **every CI gate in the YAMLs is decorative** — a push straight to `main` gets zero check-runs and a red PR can merge. Every app shipped from here inherits that. **OWNER-GATE** (a GitHub settings change; an agent cannot make it). |
| 2 | **No backup / restore path** | **new: checklist §BO-23** | The only DB script that dumps anything is `scripts/dump_schema.sh`, which is `pg_dump --schema-only` (`:52`) — **structure, zero rows**. There is no `pg_restore`, no logical data dump, no WAL archiving (`archive_mode`/`wal_level`/`pgbackrest`/`wal-g` appear nowhere in `infra/` or `deploy/`), and no restore runbook. Meanwhile `scripts/apply_migrations.sh` replays **every** numbered migration ≥ `02_` on **every** deploy under `psql -v ON_ERROR_STOP=1` (`:59-74`) with no ledger and no down-migrations — 140 files today, 142 numbered files on disk. `deploy/hostinger/README.md:115` is honest that the only backup is Hostinger's **weekly whole-VPS** image and that PITR is a "later" item. Largest uncovered risk, and it scales with app count. |
| 3 | **DB engine sprawl** | checklist §BO-10 | Measured 2026-08-03: **12 `create_async_engine(...)` call sites across 10 modules** (`acb_auth/access.py:69`; gateway `routes/{admin,apps,email,notes,tasks,whatsapp,workflows}/*core*.py`; `email_ingestion/{inbound,scheduler}.py` ×4), plus a 13th **sync** `create_engine` in `acb_graph/db.py:32`. Eight are module-level cached `_ENGINE` singletons and **none of them is disposed on shutdown** — the only `engine.dispose()` calls in the tree are the four `email_ingestion` per-call engines cleaning up after themselves. **This is the one that compounds: one engine per app, added by each app.** The next app should extend a shared seam, not add engine 13. |

### Substrate (foundation)

| WS | Workstream | Owning spec | State | Next / notes |
|---|---|---|---|---|
| WS-1 | **Action Broker truth + completion** (BO-1) | `FOUNDATION_BUILDOUT_CHECKLIST.md` §BO-1 (rewritten + verified against code 2026-08-03) | 🟢 | Broker loop LIVE and writing (inbox, `/actions`, ClickUp + WhatsApp + workflow + app-publish handlers). **Handlers register at FIVE sites, not the three this row claimed:** `gateway/main.py:983-985` (the four ClickUp task actions), `main.py:1067-1069` (`workflow.resume_run`), `routes/whatsapp/scheduler_hooks.py:30` (`whatsapp.broadcast`) — those three at startup — plus `routes/apps/tools.py:211` and `:261`, which register **at module import**, not startup. ~~"Remaining: **Zoho** handlers"~~ **struck — the work does not exist.** `apps/services/ingestion/ingestion/sources/zoho/client.py` is read-only: six `list_*` functions and exactly two CRM calls, both `GET /crm/v2/*` (`:109`, `:152`); the one `POST` (`:58`) is the OAuth token refresh. There is no Zoho write path anywhere in the repo to route through the broker, so this is not BO-1 work until a Zoho write client is specced and built elsewhere. ~~"verify vs live DB"~~ → **OWNER-GATE, and the "already done 2026-07-13" claim is UNSUPPORTED** — `FOUNDATION_CONTINUATION.md:145` records it outstanding and nothing since records it executed; no agent may claim it done or reach prod to do it, and it is not an acceptance criterion for anything below. **Three new tickets in §BO-1, all AGENT-SAFE, one PR each — the first two are flip-blockers, both new findings:** **BO-1a** — `providers.py` routes **six** ClickUp action names through `_broker_gate` but `broker_handlers._WRITERS` registers **four**, and the two missing are the two *irreversible* ones (`clickup.delete_task` `:551`, `clickup.archive_task` `:575`); under enforcement, approving one falls into `broker.execute()`'s no-handler branch (`broker.py:155-166`) and the row is marked **`failed`**. **BO-1b** — `_broker_gate` returns `{"pending": True, …, "provider_task_id": ""}` (`providers.py:171-172`) and `items._push_pending_item` ignores the marker, writing `sync_state='synced'` with an empty `provider_task_id` — under enforcement the user sees a green "synced" task that exists in no workspace. **BO-1c** — email handlers (zero `action_broker` wiring under `email_ingestion/`), buildable but blocked on §BO-1's recorded decision naming which of the base class's **14** mutating verbs are broker actions. **OWNER-GATE:** flipping `ACTION_BROKER_ENFORCE` on — **not until BO-1a and BO-1b are both in**, for the two reasons above. |
| WS-2 | **Secrets** (BO-8: rotate Zoho token, purge history, fail-closed) | checklist §BO-8 + `FOUNDATION_CONTINUATION.md` | 🔴 | **OWNER-GATE end-to-end** (force-push, rotation). Standing P0 since 2026-07-11. |
| WS-3 | **Isolation ladder** (BO-7 / HH-6 — T0/T1/T2 per `agent_platform_hardening_2026-07.md` §1.2) | `permissions_sandbox_b6.md` | 🟢 **WS-3a** (record + refuse, §P5-a.2) · 🟢 **WS-3b** (rootfs + network posture, §P5-b.2) | P5-a (per-run credential scoping, 2026-07-04) + P5-b.1 (cap/resource ceilings, 2026-07-27) shipped. **T2 / P5-c PARKED** under the internal-tool threat model (owner decision 2026-08-03, D10) — the ladder must hold against trusted colleagues, not hostile users; **un-parking is OWNER-GATE**, and no acceptance should be written for P5-c until it happens. P5-d is blocked behind it. **Two claims struck from the old title:** `tool_scope` deny belongs to **WS-23** (shipped there), and "T2 for non-first-party agents" named a distinction the code does not carry — no `first_party` field exists on any manifest, config or column; the phrase occurs only in comments and one test helper. **OWNER-GATE:** the `AGENT_PERMISSION_MODE` enforcement flip · P5-b.3's scoped gateway key (unbuilt *and* undesigned) · the new `ISOLATION_TIER_ENFORCE` flip WS-3a introduces. |
| WS-4 | **Event-bus consumer + durable queue** (BO-20) | `FOUNDATION_BUILDOUT_CHECKLIST.md` §BO-20 — **the file is at the REPO ROOT, not under `ai-company-brain/`** (this row's old anchor was wrong) | 🟢 a+f built · b slice 1 built · b slice 2 + c–e open | **§BO-20.0 IS ANSWERED — `BO-20 = Option A (in-process)`, owner, 2026-08-02.** Nothing in this row is blocked on a decision any more; the recorded rejection of Option B (a separate `python -m ingestion.worker`: needs a systemd unit no agent can deploy, and a separate process starts with an empty `event_hooks._SINKS`, so it would `XREADGROUP`, `XACK` and dispatch to nothing) is kept in §BO-20.0 as the reasoning, not deleted. **BO-20a BUILT 2026-08-02, pending review:** `apps/services/ingestion/ingestion/consumer.py` — `XGROUP CREATE <stream> cc-ingest $ MKSTREAM` on all three streams (`$` = tail, so the ~10k buffered entries per stream are skipped, not replayed into real workflow runs), a supervised `XREADGROUP` drain loop (`_GROUP="cc-ingest"`, `_BLOCK_MS=5_000`, `_READ_COUNT=8`, per-worker consumer name `gw-<host>-<pid>` because BO-20b's `XAUTOCLAIM` identifies a dead worker by it) decoding `{event_type, JSON data}` into `event_hooks.emit_event(source, event_type, dict)` and `XACK`ing, a long-lived pooled `redis.asyncio` client per `acb_common/activity.py:66-76`, `start/stop_ingestion_consumer()` + `consumer_status()` in the gateway lifespan (start `main.py:307`, stop `:364` — **unconditional**, like `stop_whatsapp_enrichment`), and the **§BO-20 Q1 cutover in all three receivers**: flag ON ⇒ enqueue-only, flag OFF ⇒ **dispatch-identical** to before (not byte-identical — each receiver now also does one function-body import + one `os.environ` read per request). Packaging defect closed: `ingestion` is now a declared gateway dependency (`pyproject.toml` + `uv.lock`), not an inheritance from the root workspace umbrella. Pinned by `tests/unit/test_ingestion_consumer.py` (41 tests; **77 passed** across the four-file fence — 41 + 10 + 22 + 4, the other three unmodified), no Redis/DB/network. **Adversarial review 2026-08-03 → APPROVE, no P0/P1;** the four P2s were repaired in-branch: a `asyncio.timeout(_DISPATCH_TIMEOUT_SECS=30.0)` around `emit_event` (one serial loop drains all three streams, so an unbounded await turned a per-event hang into a **bus-wide, silent** stall — strictly worse than the pre-cutover `BackgroundTasks` hang it replaces), a test pinning the lifespan start/stop wiring itself, one shared ordered timeline so criterion A can tell ack-after-dispatch from ack-before-dispatch (the line BO-20b edits), and `assert task.cancelled()` instead of the weaker `task.done()` — **the reviewer's last item was half a fix**: cancelling a task that has never been stepped makes asyncio raise `CancelledError` above the loop's `try`, so `task.cancelled()` passes against a swallowing loop too; the test now waits for the loop to reach its first read before stopping, and was verified red against a deliberately-swallowing `_consumer_loop`. ⚠️ **Ships OFF and is inert in every environment:** `INGESTION_CONSUMER` is unset everywhere, so the loop never starts and the receivers still emit inline. **OWNER-GATE:** flipping `INGESTION_CONSUMER=1` (registered in §6) — it is not just "start a loop": the same flag cuts the three provider receivers over to enqueue-only, so **Redis down = provider events dropped** rather than dispatched inline. That drop is now logged loudly (`<source>.queue.dropped`, warning) instead of being silent, and must not be "fixed" by re-emitting inline. **Interim semantics, deliberate:** BO-20a acks after dispatch regardless of outcome — honest `XACK` + retry + DLQ is **BO-20b**, now split in two. **BO-20b slice 1 BUILT 2026-08-03:** `event_hooks.emit_event` gained a **keyword-only** `raise_on_error: bool = False` — the strict mode the consumer needs to observe a failure at all, since `emit_event` swallowed every sink exception by design and BO-20b's retry logic is dead code without it. Default unchanged (swallow, log `event_hooks.sink_failed`, run the next sink — a webhook must never 5xx); `raise_on_error=True` propagates the **first** sink exception and skips the remaining sinks. Keyword-only so the three receivers' three-positional-arg `add_task(emit_event, source, event_type, payload)` can never reach it, and the default is pinned as the literal `False` via `inspect.signature` so a later PR cannot flip provider-facing behaviour silently. `consumer.py` is **untouched** — it still acks regardless of outcome. Three new tests (`tests/unit/test_ingestion_consumer.py` §J), four-file fence **80 passed** (44 + 10 + 22 + 4, the last three unmodified); both mutants (drop the `raise`, flip the default) verified red. **BO-20b slice 2 is open, and its SCOPE GREW on 2026-08-03** (adversarial review, repair round 1): slice 1 is *necessary but not sufficient*. `main.py:1074` registers exactly **one** sink, `workflows.triggers.dispatch_event`, and its whole body sits inside a `try/except Exception` that logs `workflows.event_dispatch_failed` and returns `[]` (`triggers.py:45-46`, `:90-104`) — so `raise_on_error=True` is a **no-op on the real registry**: slice 2 would have called it, `dispatch_event` would have swallowed, `emit_event` would have returned normally, the loop would have `XACK`ed, and the event would be **gone** with no retry, no PEL entry and no DLQ row — with every test green, because the suite registers a *raising fake* sink, a shape production does not have. Slice 2 therefore also owns a keyword-only strict path in `dispatch_event` (`triggers.py` joins its Files list; `tests/unit/test_workflows_slice2.py` joins its regression fence, 80 → 90 passed), with the failure boundary prescribed in §BO-20b: **propagate** the `_get_db`/trigger-query failure and `RunRejected` (raised at `service.py:193-196` *before* the run row and the task, so nothing ran), **never** the per-run execution failures (fire-and-forget via `create_task` at `service.py:226` — re-delivering would start a *second* run of the same workflow on the same payload), and raise **after** the row loop so a partial dispatch is not made worse. §BO-20's non-goal "Not a change to `dispatch_event`" is **struck and qualified** accordingly — that is a third `DECISION (agent-proposed, owner may overrule)` on this row; the rejected alternative was to leave `dispatch_event` untouched and accept that the consumer cannot distinguish "dispatched" from "swallowed", i.e. BO-20b cannot deliver its guarantee. Slice 2 also carries two `DECISION (agent-proposed, owner may overrule)` entries recorded in §BO-20b, because the ticket as written was *satisfiable while doing nothing*: (i) **retry is PEL-and-reclaim, not an in-loop `asyncio.sleep`** — the prescribed `_backoff` schedule (1,2,4,8,16 s) was dominated by the same section's `_RECLAIM_MIN_IDLE_MS = 60_000`, so the two constants could not both be true; `_backoff` is **struck** (it was also unpinned at its *call site*, so it could be defined, satisfy all four asserted properties, never be called, and close green), a `_RECLAIM_EVERY_SECS = 30.0` periodic cadence is prescribed with a done-when that the periodic pass **exists**, and the attempt counter is `XPENDING`'s `times_delivered` (an in-process dict resets on restart ⇒ a poison entry never reaches the DLQ). The rejected in-loop model would have blocked **all three streams for ~165 contiguous seconds** per poison entry, reintroducing exactly what BO-20a added `_DISPATCH_TIMEOUT_SECS` to prevent; the accepted cost of the chosen model is retry latency quantised to the reclaim cadence (~5 min to succeed on the 5th attempt, ~6 min to DLQ). (ii) **a dispatch `TimeoutError` is a FAILED dispatch** (retry, then DLQ) — acking it is a silent drop, which is the thing this ticket abolishes; consequence: BO-20a's `test_a_hung_sink_times_out_and_the_bus_keeps_draining` must be **rewritten** by slice 2 (its ack assertion inverts; its bus-keeps-draining half is preserved). Also recorded: the DLQ write must **not** call the sync `queue.enqueue_dlq` from the async loop (fresh sync client per call at `queue.py:49`, blocks the loop, invisible to the `consumer._get_client` fake), and `XAUTOCLAIM`'s **third** reply element — ids whose stream entry `_MAXLEN` trimmed away — must be unpacked and logged, because on redis-py 7.1.1 the common two-element unpack raises `ValueError` and wedges the whole **drain loop** every cycle — the `try` at `consumer.py:294-298` spans `_ensure_groups` *and* `_drain_once`, so a failing top-of-iteration reclaim stops the bus draining entirely, at ~1 Hz, forever (the reclaim pass must be wrapped so its failure degrades to "no reclaim this cycle"). Also newly recorded in §BO-20b: `JUSTID` is **forbidden** (it suppresses the very delivery-counter increment the retry design rests on, and `redis-py` returns a bare id list that unpacks into three names *without raising*); the `XPENDING`-before-`XAUTOCLAIM` read order is pinned (the other order moves the observable DLQ threshold from 5 deliveries to 6 and no fake-backed test can tell); `times_delivered` counts **deliveries, not failures**, so a crash-loop burns retry budget on a healthy event (mitigated by recording it on the DLQ row); the reclaim's 60 s min-idle bound is **per entry, not per batch** and is safe today only because the loop is serial — a constraint now sits on **BO-20e** to bound per-entry idle before concurrency is enabled, or the same event runs twice; **per-stream ordering is given up** by PEL-and-reclaim and is now listed as an accepted cost (a stale `taskUpdated` can start a run after a fresher one); and the attempt counter survives a *gateway* restart but **not a Redis** one (`xgroup_create(id="$")` re-creates the group at the tail after a flush, and `infra/` sets no `appendonly`). ⚠️ **Two further "enqueued but never dispatched" states are now recorded in §BO-20a** beyond that accepted drop: the `XACK` is deliberately unguarded (a raising `xack` means Redis is gone and must reach the backoff, not hot-loop), and the loop only ever reads `">"`, so an ack failure or a SIGTERM **mid-batch** strands the rest of that `XREADGROUP` reply in the PEL under the old pid's consumer name. Only BO-20b's reclaim pass recovers them, and only until `queue._MAXLEN` trims — so **BO-20b's done-when now requires the reclaim pass to run at startup**, not only on the periodic cadence, and carries an explicit open sub-question about the min-idle bound at startup. **BO-20f (Gmail + Zoho receivers reach ClickUp enqueue+emit parity) shipped 2026-08-02** and is what multi-channel event triggers actually needed; it is still **inert in prod** — `zoho_webhook_secret` and `gmail_pubsub_token` default to `""`, both receivers fail closed, and **OWNER-GATE (an agent can do neither):** provision `ZOHO_WEBHOOK_SECRET` + `GMAIL_PUBSUB_TOKEN` on the VPS (`.env.example` is itself OWNER-GATE under WS-2 — the plan-guard hook blocks agent writes to it) **and** point the provider subscription/webhook at `/webhooks/{zoho,gmail}`. The fail-closed posture is correct and must not be changed. ⚠️ **Not a greenfield build:** webhook→run was ALREADY wired — ClickUp → `ingestion/event_hooks.emit_event` → `workflows/triggers.dispatch_event` → `start_run` since commit `e20ea830`, and `/agent/webhook/{source}` (`routes/agent.py:3476-3478`) is a second live path that calls `dispatch_event` **directly** and is **untouched by the cutover** — so §BO-20 Q1's old "the consumer becomes the single dispatch path" was loose and is corrected there to "the only caller of `emit_event`". **Remaining: BO-20b slice 2 → c → (d, e)** — retry via PEL reclaim + honest `XACK` + DLQ hand-off, a drainable/visible DLQ, per-source rate limiting, bounded concurrency; all ✅ AGENT-SAFE, each waiting only on its predecessor. **WS-11 Slice 4 still waits**: `workflows_app.md:217` defines it as "(post-BO-20/BO-7): durable queued runs; …", and durable means a–e — without BO-20b a failed dispatch is acked and lost. BO-9 resolved as **not blocking** (the consumer owns its own long-lived async client; the producer's per-call sync `queue._client` stays BO-9's, untouched here). |
| WS-5 | **CI gates real** (BO-17/BO-18) | checklist §F | 🟡 Docs | Un-gate evals, blocking gitleaks, coverage floor. ~~AGENT-SAFE~~ → **mixed: the highest-value item is a GitHub *settings* change an agent cannot make.** **Audited 2026-08-01 → NO-GO**: §F has zero testable "done when" ("per the existing plan", "a few green PRs", "for foundation packages"), its ratchet-plan anchor points at a path that moved to `specs/archive/` (3 stale citations live *in the workflow files*), and BO-17 reads ☐ while half of it shipped (blocking ruff-correctness + xenon, a frontend tsc/vitest job, gitleaks, per-PR health). **THE MISSING ITEM — why the 2026-08-01 F821 escape happened, in no doc today:** (1) `main` has **no branch protection** (`gh api …/branches/main/protection` → 404) — every "blocking" gate in these YAMLs is decorative; (2) commits pushed straight to main get **zero check-runs** (`15c8933f` had none); (3) `deploy.yml:56-58` lints with the *non-blocking full* `ruff check .`, **not** the `--select F821,…` correctness gate, so deploy went green over a broken tree; (4) PR #318's `pr-check` **failed on that exact F821 and merged anyway**. **Slice when specced (BO-17a "main-guard"):** add a `correctness` job to `deploy.yml` on push-to-main running the `--select` gate, deliberately NOT in the deploy job's `needs:` — loud, not blocking. AGENT-SAFE. **OWNER-GATE:** enabling branch protection / required checks, wiring any gate into `needs:`, removing `skip_tests`; BO-18's purge+rotation is WS-2's, not this row's. Refuted two long-standing beliefs: pr-check **does** cover the frontend, and it **does** run on non-main branches. |
| WS-6 | **Observability wiring + attribution** (BO-5 + decision D1) | `observability_e2.md` **§7** | 🟡 partial | **Docs gate CLEARED** (PR #319 added the numbered §7 with nine lettered tickets WS-6a–i, per-item done-whens and gate labels). **Re-audited 2026-08-02 → GO-NARROWED to WS-6a+WS-6c only.** ✅ **BUILT 2026-08-02, pending review:** D1's attribution stamp exists as a substrate — `instance` joins `_RUN_CONTEXT_KEYS`/`bind_run_context`, resolved once in `run_agent_stream` via a **second additive bind** after `load_agent` (the early bind stays: it is what correlates a failure *during* load; moving it would trade 5 fields for 1), and `_emit_usage` carries the full (run, member, agent, instance) tuple with **zero call-site changes** — it arrives by inheritance via `activity._INHERIT`. Shared agents produce an **absent key, never `''`** (double-guarded + pinned). `refresh_run_presence()` patches `cc:activity:live:{run_id}` after the late bind, so `/observability/active` + `/roster` carry it; interim `by_instance` cost dimension added to the Redis rollup. **Nothing durable is written yet** — logs + Redis feed only. **🔴 WS-6b/6d/6e HELD, still NO-GO:** WS-6b's security amendment names *no workable mechanism* — `bind_run_context` has one call site (`executor.py`), contextvars do not cross the HTTP hop to `v1_compat`, and `agent_run` rows are written at the run *boundary* so a mid-run join finds nothing. **The only mechanism the code supports at request time is the presence key `cc:activity:live:{run_id}`**, which for the orchestrator path carries a server-established `user`; §7 must name it (or name another) before WS-6b dispatches. WS-6e has no token source (`build_run_trace_row` is pure over events+folded) so it sequences *after* WS-6b, not independently; WS-6d additionally waits on the retention/PII answer (Q3). **Two recorded asymmetries** — the `phase="start"` event predates the bind, and **a delegated sub-run inherits the caller's partition** while its blobs key to `''`, so WS-6d must not treat `instance` as a foreign key onto `agent_blob.instance`. **OWNER-GATE:** WS-6f/g/h/i (Langfuse keys, `--profile obs`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `LLM_USAGE_AUDIT`, the MAF telemetry kill switch) — all now listed in §6. |
| WS-7 | **Memory activation + search** (BO-21 → BO-22) | checklist §C + `llm_caching_memory.md` | 🔴 | **OWNER-GATE:** flipping `MEM0_ENABLED`/`GRAPHITI_ENABLED` in prod (cost + latent findings in `agent_platform_hardening` Part 5). `acb_search` (BO-22) after. |
| **WS-24** | **Colleague onboarding readiness** — the gate, the runbook, and the capability matrix *(minted 2026-08-04)* | `specs/colleague_onboarding.md` | 🔴 **NOT READY — 3 blocking gates still open (2 OWNER-GATE, 1 AGENT-SAFE). ✅ G4 CLOSED 2026-08-04 — all FOUR tickets shipped:** N4 (`ws-24-n4-people-scoping`) the Tasks people directory is *directory open, HR fields restricted* with all four writes on `admin:members:manage`; **N1–N3** (`ws-24-n1n3-notes-scoping`) the Notes owner-scoping remainder. **G1/G2/G3 unchanged — inviting anybody is still unsafe.** **✅ N6a BUILT 2026-08-04** (`ws-24-n6-signin-requests`, spec §6) — the sign-in queue: migration 143 `access_request`, `resolve_access(record_request=)` gated to the request path only, `GET/POST /admin/members/requests…`, a Requests tab, and `invited` rows now labelled "never signed in". N6a is **not a gate** and does not move this row's colour; **merging it IS an owner gate** (§6 of this plan — `deploy.yml:202-203` replays migrations, so the merge arms an auth-behaviour deploy). N6b needs no code; one owner question (auto-promote on first sign-in?) is recorded in spec §6. | **Read this row before inviting anybody, and before assuming any other row's access work is safe to demonstrate with a second person.** Exactly one member is signed in (`vjvarada@fracktal.in`, §4). The question "is it safe to invite colleagues" had been re-derived in conversation repeatedly and recorded nowhere; the spec is the durable answer and `scripts/onboarding_preflight.py` is its executable half (**agent-safe to write, NOT to run against prod — `--mode local` is an agent's only mode**; it refuses the box-only checks rather than guessing, because `resolve_access` degrades to `is_active=False` on an unreachable DB too, so a local PASS on default-deny would be vacuous). **The blockers, each with a done-when in §1.1 — G4 is the one that closed: G1** the Caddy strip — `deploy/hostinger/caddy/Caddyfile:13-18` has **no** `header_up -X-User-Email` / `-X-User-Role`, and `acb_auth/deps.py:27-35` says in its own docstring that the reverse proxy IS the boundary, because nothing in that module can tell a forwarded identity header from a forged one. 🔴 OWNER-GATE to install (writing the repo file is agent-safe). **G2** `GATEWAY_INTERNAL_TOKEN` unprovisioned ⇒ service identity falls back to `LITELLM_MASTER_KEY` (`deps.py:108-117`), the key every agent's BYOK client holds; `GATEWAY_REFUSE_LLM_KEY_IDENTITY` (PR #346) makes that refusable and **ships OFF**, and is inert once the token is set. 🔴 OWNER-GATE (a credential, in two places — the Next BFF mirrors the same fallback at `lib/gateway.ts:58-61`, so flipping the flag with the token unset 401s every signed-in member). ⚠️ **G2 has a LOCKOUT mode, repaired in the preflight 2026-08-04.** Setting the token in `/opt/acb/app/.env` only — which is what "restart the gateway and the workbench" invites — leaves the BFF sending `sk-local-dev-change-me`, so every proxied browser call carries a bad Bearer with a real `X-User-Email` while an internal token *is* configured, and `deps.py:356-361` returns **NO_ACCESS for every signed-in member**. Check 1 read only `.env` and would have certified that state green; it now reads `workbench/control_plane/.env.local` too and FAILs naming the lockout when the two disagree. Do it by **redeploying** — `.github/workflows/deploy.yml:166-187` reconciles `.env.local` from `.env` in place on every deploy, so the only dangerous window is "provisioned by hand without a redeploy", which is exactly what a hand-run owner gate looks like. **G3** a restore path — **BO-23 is unbuilt**: there is no data-inclusive dump, no `pg_restore` inverse, no restore runbook and no pre-migration hook; `scripts/dump_schema.sh` is `--schema-only` (structure, zero rows). `scripts/backup_db.sh` and `restore_db.sh` are proposed on the **independent** PR #347 (`ws-0-bo23-backup-restore`) and are **not on this branch**. 🟢 agent-safe to write, 🔴 owner-gate to run or schedule. ⚠️ **Repaired 2026-08-04:** the preflight's check 4 used to assert an `acb-backup.timer` unit and a `MANIFEST.txt` that **BO-23's own done-when never specifies**, while testing no dump format, size or restore script — so a schema-only dump printed "Backups run, land, and are recent" over zero rows, and G3 could not have gone green even after BO-23 shipped exactly what it promised. It is now measured against `FOUNDATION_BUILDOUT_CHECKLIST.md` §BO-23 done-when 1-4 verbatim, plus a size floor on the newest dump; the timer is probed as a note, never asserted by name. **G4** the four owner-scoping holes (below) — **all four closed 2026-08-04, so this gate IS green. WS-24 is not**: G4 closes the holes that survive a *correct* identity, and G1/G2 are about the identity itself — an owner predicate applied to a forged `X-User-Email` is not a control.** **PR #348 IS in this branch's ancestry** — `permissions.py:95-100` carries the six `center.*` slugs, so the preflight's Centers check passes here. **✅ G4's N4 CLOSED 2026-08-04** (`ws-24-n4-people-scoping`, spec §4 N4's `owner-answered` DECISION block): **directory open, HR fields restricted.** `GET /tasks/people` still serves the org chart to any `feature:tasks` holder, but `skills`, `skills_source`, `resume_summary`, `years_experience` and capacity/current-load/available are projected to null/empty for a caller without `admin:members:read` (`routes/tasks/people.py` — `HR_FIELDS`, `_row_to_person(row, *, include_hr)` with **no default**, so a future route cannot inherit the permissive answer), and `?q=` drops its `unnest(skills)` clause for that caller so the search box cannot become an oracle for the field the strip exists to hide. All **four** write routes — `POST /people`, `PATCH /people/{person_id}`, `POST /people/{person_id}/resume`, and `capability.py`'s `POST /people/embed` — carry `require_people_write()` = `admin:members:manage` as a route dependency (`routes/tasks/core.py`). **No new permission slug** was minted, deliberately: a new slug is nobody's grant until an admin creates it, which would switch HR features off for the owner too; both permissions are existing `CAPABILITIES` entries and the owner's `*` matches both. Consequence recorded, not a defect: a `manager` (holds `admin:members:read`, not `:manage`) sees the HR half and cannot write it — consistent with the matrix. `fetch_people_for_clarify` is **unchanged** and still returns full rows: the projection is at the serialization layer, never in the SQL, so in-process agent delegation (`ai.py`, `capture_email.py`, `planning.py`) is untouched. `tests/unit/test_tasks_people_scoping.py`, 35 cases, three mutants verified red first. **✅ G4's N1–N3 CLOSED 2026-08-04** (`ws-24-n1n3-notes-scoping`, cut from `891903de`), all three reachable until then with the default `member` role because it holds `feature:notes` (`130:235`). **N1** — fifteen of the sixteen routes in the six named files (`recordings.py` upload/start/chunk/complete/audio, `qa.py`, `share.py`, `copilot.py` ×2, `live.py`'s `/stt/live-token`, `actions.py` ×3) now load through `core.load_owned_meeting` or bind `core.OWNED_MEETING_PREDICATE` and answer **404, never 403**. `_recording_path` — the loader `/chunk` and `/complete` share — carries the join, so neither can acquire the hole separately and the per-chunk path pays no extra round trip; `qa` loads the meeting **before** the transcript so the 409 "no transcript yet" stops being an oracle; the copilot **stream** checks before the `StreamingResponse` starts, because a 404 raised inside a started stream is a broken connection, not a refusal; `share.py` was read first and has no sharing mechanism to preserve (no grant, no token, no redemption — the send is a separate `/email/send` under the caller's own account), so the whole route is a read. **`live.py:256` stays machine-authed by recorded decision** — the caller is the bot worker with `MEETING_BOT_TOKEN` and no member identity, so an owner predicate has no owner, and both ways to invent one turn the bot token into a way to *assert* an identity; it discloses one boolean plus a settings-derived sentence, and the same answer for an id that does not exist. **N2** — `actions._load_action` joins `meeting` and binds the predicate, so both single-item routes inherit it; the test pins **both** harms separately (no `INSERT INTO gtd_items`, no `UPDATE action_item`, and the colleague's description never reaches a bound parameter), because a 404 alone would not have proved the exfiltration half. `approve-all` was *aligned* rather than left alone: already safe at the `_dispatch` seam, it answered **200 with an empty list** — "your meeting, nothing qualified" where the truth was "not your meeting" — and read the colleague's draft rows to get there. **N3** — the attach branch binds the predicate **into the `UPDATE`** (`UPDATE meeting AS m … WHERE m.id = … AND (lower(m.owner_email)=lower(:owner) OR m.owner_email IS NULL) RETURNING m.id`) rather than loading first: a load-then-write leaves a window, and this statement *is* the mutation. The acting principal is the **caller**, necessarily — it is the only identity the request carries, and checking the row against its own `owner_email` would compare the meeting to itself and pass every time; the asymmetry is preserved, not collapsed, and a test pins that the ingest side still reads `meeting_bot.requested_by`. Evidence: `tests/unit/test_notes_owner_scoping.py` 21 → **57 passed**, every non-owner case verified **red** against pre-fix behaviour *with the parameter renames already applied* (so each red is the security claim, not a `TypeError`), plus four mutants — drop the audio guard, drop the action-item predicate, drop the `bot_join` predicate, and compare against the wrong identity — each red on exactly its own cases with the tree byte-identical after revert. Notes suite **280 passed**, `test_org_access_enforcement.py` **31 passed**. ⚠️ **TWO findings recorded, neither fixed here.** (a) **N1's table was not exhaustive** — `routes/notes` has 24 modules and **nine** still carry zero owner predicates after this change (`summaries.py`'s `GET`/`PUT /meetings/{id}/note` + `GET .../actions`, `copilot_context.py`, `copilot_agenda.py`, `meeting_bot.py`'s four `/bot/*` routes, `live_transcript.py` incl. `POST /meetings/{id}/say` — which makes the notetaker *speak into somebody else's call* — `live_session.py`, `speaker_id.py`, `agenda_progress.py`, `events.py`). Minted as spec §4 **N5**, deliberately **outside G4**: G4's done-when is "each of §4's four tickets meets its own done-when" and all four do, and re-scoping an owner-facing gate is the owner's call. **Owner decision needed:** does N5 block colleague #1? (b) `/notes/meetings/{meeting_id}/live/wanted` is in **neither** `main.PUBLIC_ROUTES` **nor** `core.router`'s `exempt` list while both its siblings are in both — so `require_authenticated` and then the feature gate 401 the worker before `_check_bot_auth` runs, and the poll that decides whether to keep paying for streaming ASR is dead. Not fixed here because the fix *opens* a route, the opposite of this change's direction. `test_org_access_enforcement.py`'s own `GATED_ROUTERS` lists the path, which is how the drift stayed invisible — that registry is the test's opinion, not the router's. **Two findings that correct the received account of the roles, both in spec §3.0 — anything quoting `130` alone is wrong:** (a) role grants come from **two** migrations — `131_integration_memory_permissions.sql` additionally gives `member` `integrations:use:*` **and `memory:read_org`** (`131:70-78`), gives `manager`/`admin` `memory:write_org` too, and gives `guest` **nothing** (`131:80`); (b) **`data:org:read` grants nothing — it has zero consumers.** It is declared (`permissions.py:132`), granted to admin/manager/agent_service (`130:205, 221`) and listed in the legacy fallback (`access.py:148`), and **no route, query or predicate in the tree ever checks it**. So "manager has org-wide visibility" is a name, not a mechanism; what actually widens a manager is `admin:members:read` (the floor for the **whole** `/admin` package, `admin/_common.py:77-91`, and `is_admin: true` at `me.py:96`), plus `feature:approvals`/`observability`/`whatsapp` and `memory:write_org`. That is **D14**. **Three more measured cells worth carrying up here** (full matrix in spec §3): `feature:memory`, `feature:artifacts` and `feature:observability` are enforced **nowhere server-side** (`memory.py:45-48` gates on the internal Bearer then per-scope; `workspace.py:53` and `observability.py:46-51` gate on nothing beyond authentication) — they hide a nav pane and the per-object rule is the boundary, exactly as `lib/access.ts:126-129` says; **artifacts are shared for most agents**, because 4 of the 6 first-party `config.json`s declare `instancing: "shared"` ⇒ `instance_key()` = `''` ⇒ one workspace for everybody (`workspace.py:230-260` → `manifest.py:235-246`); and a **member can read/write every agent's memory compartment**, since `_authorize_agent` (`memory.py:103-109`) gates on `can_run_agent` and member holds `agents:run:*`. **Granting `feature:workflows` is a labelled consequence, not a defect** (spec §3.4): org-wide read is a recorded v1 decision (`crud.py:1-5`), the detail response returns `hook_token` (`crud.py:230`), and the hook route is unauthenticated by design (`core.py:29`, `hooks.py:3` — "the token IS the credential"), so the grant hands over a permanent copyable trigger for **every** workflow that survives off-boarding, and there is no rotate endpoint. **Not in this row:** building spec §4's new **N5** (the nine further `routes/notes` modules) until the owner says whether it blocks colleague #1, per-Center *data* scoping (WS-14/WS-15 — `140_center_features.sql:9-12` is explicit that Center features gate navigation and the landing pages, not data), and shared mailboxes (ownerless, §4). |

### Platform

| WS | Workstream | Owning spec | State | Next / notes |
|---|---|---|---|---|
| WS-8 | **Agent architecture A0→C** (single runtime, manifests + `agent_defs`, generic declarative builder, Agent Workshop describe-to-create) | `agent_architecture.md` **§12.2** (the lettered tickets WS-8a…WS-8n) | 🟡 | A0's `approve_all` half done 2026-07-26. ~~"three states in one doc, see §5"~~ **repaired 2026-08-03** — §5 doc-remediation item 14 is closed (one A0 status; the F/G dependency split is written). **~60% of Phases A+B is unwired substrate — read §12.1 before dispatching anything from this row**, or an implementer will rebuild `manifest.py` / `declarative.py`, both of which are complete, documented and tested with zero production callers. ~~"Phase A unblocks D3's long-term form"~~ **struck — verified false in the direction that matters:** `config.json`-based instancing already ships via `AgentManifest.instance_key()` (`manifest.py:235`, live at `executor.py:917-937` and `routes/workspace.py:247-256`, with a `sharing` block on all six first-party agents), so **WS-14 is NOT waiting on WS-8 Phase A** (§12.5). D7's MAF-side MCP gap is now a ticket here — **WS-8c**. |
| WS-9 | **Memory tiers 3b/3c/4** (budgeted file-tier header, provenance markers, correction UX, supersession) | `memory_architecture.md` §9 (corrected 2026-08-01) | 🟡 Docs | 3a′ substrate shipped (migs 136–139). §6.7 correction UX is the highest-leverage UX item in the corpus. **Audited 2026-08-02 → NO-GO**: §9 gives acceptance for **3a′ only** (which is WS-10's, already shipped) — 3b/3c/4, the whole of WS-9, have none; §6.7 is experience prose with no endpoint, model or assertion; §6.5 ends "there are two honest paths… don't do both", an owner call presented as acceptance. Header still says `Draft / RFC · 2026-07-26` over a body stamped 2026-08-01 (R4). Paths are bare filenames whose line numbers have moved (`routes/memory.py` gate is now `_authorize_scope` :128-167; `_tool_injection.py:488-493` moved to `acb_skills/addendum.py` in WS-23 S3). **Verified substrate:** `MemoryClient` has search/add/get_all/delete and **no `update`**; the API has no PUT/PATCH; `/memory` already does list + semantic search + delete + clear-all (§5.5 understates it) but has **no edit, no provenance**, and hardcodes one of the **five** scope shapes (`<email>` · `prefs:` · `room:` · `agent:` · `org:global`). No provenance/supersession fields exist anywhere. **NOT owner-gated** — the gate logic is testable against a fake with Mem0 disabled (41 tests, 0.58s); the real trap is inverted: **this box's `.env` already has Mem0 enabled, and `tests/unit/test_memory_integration.py` HANGS (measured exit 124); assume `test_memory_e2e.py` does too — name test files, never `tests/unit/`.** **D4 constraint:** `orchestrator/agents.py:520-534` reads only the user scope, so correcting an `org:global` fact would show fixed in the UI and change nothing on that path — PR-1 must restrict to `<email>`/`prefs:`/`agent:` or say so. **Slice when specced (3c-0, AGENT-SAFE):** `PATCH /memory/{scope}/{memory_id}` reusing `_authorize_scope(write=True)` + the 404-not-403 membership probe at `memory.py:237-240`; `MemoryClient.update`; provenance in **Mem0's own metadata** (`corrected_by`/`corrected_at`/`supersedes`) — no new table; PATCH in the Next proxy; inline edit + compartment selector on `/memory`. **Scope creep to cut:** §6.1 instance-keying is WS-14's and the 3a′ remainder is WS-10's — this row should stop claiming both. |
| WS-10 | **Multiplayer remainder** — S1 `subject:` compartments · floor-control re-decision · `prefs`/`user` backfill | `docs/multiplayer/memory-clearance.md` §7 + §7.1 (**the dispatchable slice**) · `docs/multiplayer/README.md` §8 (room-side index) — *`specs/multiplayer_prior_art_qm_2026-08.md` is reference-only per §4 and supplies acceptance for nothing* | 🟡 Docs → S1 | **Steer is SHIPPED — struck from this row's title** (`15c8933f`, ancestor of `main`: `orchestrator/steer.py::route_turn` → DROP/ENGAGE/ABORT/STEER, durable `cc:steer:` signals, `202 {"steered": true}` stand-down, `409 steer_outside_run_floor`, plus the two-layer supersede guard; `tests/unit/test_steer_routing.py` + `test_supersede_guard.py` green). **Audited 2026-08-01 → NO-GO on 5 of 7 contract points; §5-style remediation applied 2026-08-02** (both docs re-headered "verified against code on 2026-08-02", §3.5's 5 stale anchors fixed, gate labels added, verification blocks added). **That remediation was then independently verified and returned FAIL; repair round 1 landed the same day.** The P0 was the remediation's own new claim that `mark_active(reset=True)` raises `SupersedeRefused` — **it does not**: `mark_active` (`stream_relay.py:343-405`) deletes the stream at `:377` with no ownership check, and the only `raise` is at `:895` inside **`run_detached`** (`:823`), before it calls `mark_active` at `:909`. So the guard covers `run_detached`'s callers, **not** the destructive statement; both docs now say so, and README §12.3 carries an anchor grep that shows the line ordering. Six smaller defects fixed with it: `feature:memory` is `permissions.py:68` (not `:70`); §7.1.3 dw1 said "member" where §7.1.5 allows members (now **non-member**); dw5's `409` now matches its own precedent's **400** (`routes/rooms.py:533-538`); the slug grammar no longer claims `_clean_slug` (which forbids `.`, allows a leading `-`/`_` and unicode alnum) — it is `_SEGMENT_RE`'s shape plus a 64-char bound; `subject_ref` now reads as a **compartment scope key** everywhere (§3.2/§3.4/§4.1/§7.1.8), not an entity ref; and three already-green done-whens (§7.1.1 dw2/dw3, §7.1.5's miscounted row) were **replaced with criteria that require the work**, not merely labelled. Residual recorded, not built: moving the ownership check into `mark_active` would make it an invariant over the statement — no ticket minted for it here. **The row is now three things, and only one is work:** ① **`subject:` compartments = WS-10 S1, the dispatchable slice.** It is the one item with real query-layer acceptance (`memory-clearance.md` §7, kept verbatim) — it was NO-GO only because the surface it presumes was unspecified. **`memory-clearance.md` §7.1 now specifies it** (create/add-member endpoints and their gating, the `subject_ref` writer folded into the existing `PATCH /sessions/{id}/room`, the `_authorize_scope` rule, `audience='team'` → the shipped `org_group`, and a testable `sensitivity='restricted'` = *existence is confidential*, 404-not-403). Every decision there is marked `DECISION (agent-proposed, owner may overrule)` — **AGENT-SAFE once §7.1 is accepted**: dispatch after the owner reads it, or overrule and re-dispatch. (The owning spec's own Gate cell now carries that qualifier too — it read an unqualified "AGENT-SAFE" until 2026-08-02, and by this board's Authority rule the owning spec out-ranks this row for *what to build and how*, so the weakest of the three preconditions was the one that would have won.) **Repair round 2 (2026-08-02) — adversarial review returned REQUEST-CHANGES with no P0 and five P1s; all repaired in the same change.** The one that mattered: §7.1.4 specified the clearance cap as *"computed the way `_capability_cap` (`rooms.py:191`) already computes the credential cap"* — but `_capability_cap` **drops `group:` and `org` subjects by design** (`:207`, and short-circuits empty at `:208-212`, its own comment at `:209-211` saying so), so an implementer following that pointer would have turned the intersection into a **union** for exactly the rooms where a leak is widest: `[owner@x, group:sales]` bound to a restricted subject would come back with an empty cap, read as "no non-member participants", and admit the compartment to `Clearance.read` for forty people — while done-when 4 ("a non-member participant") passed green against two email addresses. §7.1.4 now names the site (`_subject_clearance_cap` beside `_capability_cap` in `routes/rooms.py`, consumed at the tree's only `resolve_clearance` call site, `routes/agent.py:1768-1774`), requires participants to be **expanded before** the intersection through one factored-out helper (`acb_auth.access.expand_session_subjects`, lifted out of `resolve_session_access` `:343-434` which already does the `group:`/`org` expansion at `:330-340`), and requires that expansion to **fail closed** — the opposite posture to `resolve_session_access`'s deliberate fail-open at `:417-426`, stated as such so nobody "fixes" it back. Done-when 4 is now four parts that cannot be satisfied without the `group:` and `org` cases. The other four P1s: the prior-art doc's QM-1 state cell still read "designed, unbuilt" for shipped steer (and QM-2 "✖" for built-but-off S4) while two other files in the same change said built; README §2's anchor table was **7 wrong of 8** under a "verified" header (fixed + caveat added, plus four stale repeats outside the table); §5.2 cited `test_reset_wipes_the_event_log` as demonstrating the `mark_active` bypass when that test seeds no `cc:runactor:` and so **cannot distinguish the two states** (README now says no test demonstrates it and describes the one that would); and §7.1.4 done-when 6 asserted a `422` on unknown `PATCH` keys that shipped code does not produce — `RoomPatch` (`routes/rooms.py:81-84`) is a plain `BaseModel`, no `extra="forbid"` anywhere in the gateway, verified against the repo interpreter (pydantic 2.13.4) — so it now pins the *real* behaviour and closing the model is filed as its own ticket in §7.1.9 rather than smuggled into this slice. ② **Floor control = OWNER-GATE, registered in §6 by name.** Per QM-1 steer dissolved most of the problem the baton was invented for; README §8 Phase 2 says whether the five modes still earn their place is *"pending the owner's re-decision"*. No acceptance is written for it on purpose — writing one would make an owner call look like queued work. ③ **`prefs`/`user` backfill** — classifier + **dry-run report** is AGENT-SAFE; **applying it is OWNER-GATE**, registered in §6 (mutates live Mem0). Verified: nothing writes a `prefs:` key anywhere today, so `prefs:` is permanently empty until this runs. **Two prior-art corrections (2026-08-02):** QM-3's *"rather than one `acting_identity`"* was factually wrong — there is no such column and never was (mig 138 `:26` rejects it explicitly), so QM-3 is net-new work with zero acceptance and maps to **WS-2 / WS-1, not here**; and the R2 phase-ID collision is resolved — the prior-art doc called `subject:` compartments "3b" while the owning spec puts them in the **3a remainder**, so the owning spec's ID wins and the board calls the slice **S1**. QM-5 (tenure narrows the model, not just the viewer) is a **real gap with an undone design**: viewer half built (mig 138 `:97-98` → `rooms.py:277-292` → `chat.py:314-316`), model half not (`_get_messages(thread_id, _hist_uid, …)` at `routes/agent.py:1947-1956` narrows by the acting caller only) — but README §6.5 says the two mechanisms are *"worth comparing before building either"*, which is a decision to record, not acceptance. |
| WS-11 | **Workflows Slice 3** (template gallery, fan-in/join, loops); Slice 4 after WS-4 | `workflows_app.md` **§8.3** (re-scoped truth pass 2026-08-03) | 🟢 | Slice 3 = **8.3a** template gallery · **8.3b** fan-in/join · **8.3c** loops (**owner-approved 2026-08-03**, D10 — §11's standing anti-n8n rule R1 governs the node *catalog*, not the control-flow *vocabulary*, and must not be cited as a blocker on loops). All three AGENT-SAFE. **~1/3 of this row was struck:** "describe→generate→refine full-graph authoring" **shipped as F14** (`39b1e17a`) — dispatching it would have sent an implementer to rebuild the live `POST /workflows/{id}/copilot`; "parallel fan-out" also ships (`engine/graph.py:17`, MAF's superstep scheduler routes it), so the real remaining content is fan-**in** plus loops. Templates are greenfield — nothing exists. **8.3b and 8.3c each invert a pinned test** (`test_fan_in_rejected_v1`, `tests/unit/test_workflows_engine.py:155`; `test_cycle_rejected`, `:148`) — leave either asserting rejection and the ticket closes **green having built nothing**. Template *content* is an owner input; the report-digest template is **WS-15's** artifact, not this row's. Slice 4 stays blocked on **BO-20b slice 2 → BO-20c → (BO-20d, BO-20e) + BO-7** (§8.4), and its activation rides the OWNER-GATE `INGESTION_CONSUMER` flip. |
| WS-12 | **Framework uplift** | `multi_agent_orchestration.md` **Phase 4 only** (D6 banner 2026-08-01; shrunk 2026-08-03) | 🟡 Ph4 | **Audited NO-GO on all seven contract points; shrunk to Phase 4 only on 2026-08-03, not closed.** Ph0 shipped. **Ph1 struck** — 1.1 shipped as *progressive disclosure* (`93b93a08`, #191); 1.2 moot (`technical-project-planner` exists in neither `_AGENT_REGISTRY` nor `apps/agents/`); 1.3 delivered by **WS-23**. Ph2–3 superseded by the shipped Workflows app (D6). **Ph5 struck** — 5.2 shipped as multiplayer rooms *without* the orchestrations package, so it never depended on Phase 4; **5.1 is reassigned to WS-11**. **Ph4 is the genuinely undone part** — all four §5.5 shims re-verified in-tree 2026-08-03. **Drift correction: Phase 4 drags ONE SDK major, not two** — `uv.lock` and the repo `.venv` both carry `openai 2.38.0`, so the billed `openai 1.99 → 2.x` major already landed independently; only `github-copilot-sdk 0.1.32 → 1.0.2` remains. **0 PRs dispatchable today:** 4.0's target choice (minimal- vs full-bump) is **OWNER-GATE**; 4.1 (resolution proof in an isolated throwaway venv, evidence-only, AGENT-SAFE — it must never mutate `<repo>/.venv` or `uv.lock`) is what unblocks it. |
| WS-23 | **Skills registry + per-agent skill toggles** (added 2026-08-01) | `specs/skills_registry.md` | 🟡 S1+S2 built | **S1+S2 shipped pending review 2026-08-01**. S1: `acb_skills/skill_families.py` registry + measured token-cost catalog, `GET /integrations/skills`, Integrations → Skills tab, drift test; measured baseline ≈19.3k tokens (core floor ≈15.1k). S2: `agent_skill_setting` table (override-shape provenance), `GET/PUT /agent/{name}/skills` (`admin:access:manage`; core/apps → 422), **intersection-only** enforcement in `_resolve_injected_scope` (no rows ⇒ byte-identical — regression-tested), Agents-page Skills panel with live token meter; decision note in spec §2: workflows toggle honored at its append site, Custom-App grants NOT toggle-governed. **S3 generation half + scope-out shipped pending review 2026-08-01**: addendum prose now GENERATED from family-tagged section registries in `acb_skills/addendum.py` (one renderer for injection AND catalog cost measurement; tool set byte-identical, text identical except the `App()Ellipsis` f-string fix); evidence-based scope-out in `specs/skills_scope_out.md` (GENERAL = core/memory/workflows/apps; SPECIALISED = history→orchestrator, coding→apis-config); `DEFAULT_PROFILE` + `SKILLS_FAIL_CLOSED` switch prepared and **shipped OFF**. Measured: all-families 19.3k → DEFAULT_PROFILE 17.8k → core floor 15.4k tokens — the ≤2k email target needs a core-floor diet, not toggles. Remaining: **OWNER-GATE** the `SKILLS_FAIL_CLOSED=1` flip (review dynamic agents first, `skills_scope_out.md` §4). Per-instance profiles defer to Centers C; manifest side lands with WS-8. **S4 core-floor diet BUILT 2026-08-01** (`skills_scope_out.md` §7): *Half A* `acb_skills/skill_index.py` — addendum becomes one line per family + `recall_notes("skills/<family>.md")`, bodies materialized to `agent-data/skills/` content-hash-idempotently after the blob rehydrate, byte-preserved via the new `addendum.rendered_parts()`, index inside the prompt-cache-stable prefix, **`SKILLS_INDEX_ONLY` ships OFF**; *Half B* schema trim, live, **zero call-contract change** (pinned in `tests/unit/test_tool_schema_diet.py`). Measured: addendum 5,697 → **570**, core-floor schemas 9,998 → **8,510**, full surface 19,259 → **12,644**, email-assistant-recommended 17,757 → **11,337**. **≤2k still NOT met and unreachable by trimming** (22 schemas cost 1,252 tokens with descriptions deleted) — progressive tool disclosure + an `emit_generative_ui` schema pointer are designed and costed in `skills_scope_out.md` §7.5, **deliberately not built**. Remaining: **OWNER-GATE** the `SKILLS_INDEX_ONLY=1` flip. |

### Product — Centers (`department_centers.md` §3)

| WS | Workstream | State | Next / notes |
|---|---|---|---|
| WS-13 | **Centers B — groups become real** (groups admin UI, seed six groups, People directory read view) | 🟡 | Groups admin UI + six-group seed **built 2026-08-01, pending owner review** (`routes/admin/groups.py`, `/settings/groups`, seed migration; see `department_centers.md` Phase B update). People directory read view still open. The unlock for everything below. Single owner: Centers B (groups spec §6 step 5 and org_access Phase 2 are mirrors). ✅ **FIXED 2026-08-03 (`ws-13-centers-feature-vocabulary`): the feature-vocabulary half of this row is closed.** `acb_auth.permissions.FEATURES` now carries the six `center.*` slugs in migration-140 sort order, two invariant tests in `tests/unit/test_org_access_control.py` now fail loudly if one goes missing — `::test_every_center_has_a_feature_slug` (anchored on a literal `EXPECTED_CENTER_SLUGS`, because the first version *derived* the expectation from `CENTER_GROUP_SLUGS` and therefore went vacuous when that tuple was emptied) and `::test_centers_registry_matches_the_feature_vocabulary` (**parses** `lib/centers.ts` and pins it both ways to `FEATURES`, so the documented "add a Center" recipe can no longer reproduce this bug with a green suite). `department_centers.md` §2 now carries the five-place registration checklist. And the admin role editor groups its chips by `feature_catalog.category` with a real "Centers" heading (`settings/roles/page.tsx`, `Feature.category` union widened in `members/types.ts`). No migration was needed — 140 already widened the CHECK. **Separate, still open:** `workbench/control_plane/src/app/page.tsx:11-12` renders `NAV_SECTIONS` with **no** access filter, so the home grid still advertises every pane (Centers included) to every viewer while the sidebar correctly hides them — recorded in `workbench/AGENTS.md`. The finding as originally written, for the record: **Centers were unreachable by ANYONE, including the owner.** `/auth/me` returns `"features": list(access.allowed_features())` (`routes/admin/me.py:84`), and `allowed_features()` iterates the **hardcoded Python tuple** `acb_auth.permissions.FEATURES` (`:64-81` as the tuple then stood; `:73-101` after the fix) — sixteen slugs, **no `center.*` entry**. The frontend gates on exactly those slugs: `lib/access.ts:66` maps `/centers/<slug>` → `c.feature` (= `center.sales`…), `canUseFeature` is `access.features.includes(slug)` (`:118`), and `visibleSections` drops any pane whose feature is absent — **and drops the whole section when it empties** (`lib/nav.ts:229-233`). Net effect: the Centers section renders in neither nav, and typing `/centers/sales` hits `AccessGate`'s "You don't have access to this". Migration `140_center_features.sql` **does** seed six `feature_catalog` rows, but `allowed_features()` never reads that table — so migration 140's own comment ("owners and admins see all Centers via their `feature:*` baseline") is **false as written**: an owner holding `*` still gets an empty set, because the wildcard is only ever evaluated against the sixteen literals. The fix taken was the vocabulary one (`FEATURES` gains the Center slugs) plus the invariant test; making `allowed_features()` read `feature_catalog` was rejected — `permissions.py` is pure and does no I/O by design. |
| WS-14 | **Centers C — scoping deepens** (tasks team slice, shared mailboxes, team-instanced agents, per-Center approvals) | 🟢 **unblocked 2026-08-03 (D12)** | **The blocker is answered.** This row read "blocked on what makes a project a team's project" for weeks; **D12** answers it: **a project belongs to a team when an explicit grant row carries a `group:<slug>` subject** — *not* derived from assignees, *not* an owning column. Both alternatives and why they were rejected are recorded in `specs/tenancy_and_visibility.md` §4 (`DECISION (owner-answered 2026-08-03)`); §5's gap table is the app-by-app map, and §3.2 is binding on the mechanism — **extend the existing `email \| group:<slug> \| org` subject vocabulary, do not invent a second one.** ⚠️ **The primitive is narrower than previously claimed:** only **rooms** honour `group:` today (`routes/rooms.py::_valid_subject` `:100-111`, expanded at `gateway/rooms.py:181-199` — **corrected 2026-08-03 from the stale `:163-179`**, which is the `chat_session` SELECT, not the group join; the `SELECT g.slug` is at `:192`). `app_grants` does **not** — `routes/apps/grants.py::is_valid_subject` (`:68-85`) is `email \| agent:<name> \| agents:*` and explicitly **rejects `org`** (`:77`); the "identical to grants.is_valid_subject" docstring at `rooms.py:103` is false and should be corrected by whichever ticket touches it first. **What it can now build, in order:** (1) the tasks team slice — a project grant table + a read path unioning "mine" with "granted to a group I'm in" (blast radius: 27 `user_id` predicates in `routes/tasks/items.py`); (2) the `dynamic_agents` sharing columns per D3 — re-verified 2026-08-03, `15_dynamic_agents.sql:7-20` has **no** owner/visibility/sharing column and a repo-wide grep finds none, so this migration is genuinely WS-14's, at the **next free number resolved at build time** (R1); (3) `group:` on the Custom-Apps grant subject, the cheapest conversion since `apps.visibility` already carries the three tiers. Shared mailboxes stay `email_app_master_plan.md`'s implementation, sequenced here (D5). **Not blocked on WS-8 Phase A** (D3 amendment) and **not** waiting on WS-13's UI — but note WS-13's new finding: the Center *surfaces* are currently unreachable, so scoping work will need that one-line feature-vocabulary fix to be demonstrable. ⚠️ **Re-audited 2026-08-03 → the row was NOT dispatchable as written; `department_centers.md` §3 Phase C was rewritten and this row now points at four lettered bullets, only two of which are work.** **C1 tasks team slice — 🟢 AGENT-SAFE**, and it is the whole of the near-term value: grant table decided (`tenancy_and_visibility.md` §4.1 = **D13**, `gtd_project_grant`, agent-proposed and overrulable, **no `role` column**), union read path, migration at the next free number resolved at build time, and a **404-not-403** assertion for the non-member (the shipped convention — `routes/memory.py:237-240`). ✅ **Repaired 2026-08-03** after review found C1's acceptance could go green with **no way to create a grant**: done-when 1 now names a caller-reachable creation path (`POST`/`DELETE /tasks/projects/{project_id}/grants` on the shipped `/tasks` router, `feature:tasks` + project ownership, 404-not-403 per `routes/apps/_common.py:459-475`, module wired into `routes/tasks/__init__.py`), done-when 2 requires the grant under test to be created **through that route** rather than by a fixture `INSERT`, and done-when 5 names the shared validator's home (`packages/acb_auth/acb_auth/permissions.py`) — it previously named no module and no shared home existed. **C2 shared mailboxes — 🟢 AGENT-SAFE for the doc action, build blocked, no owner in fact** (see §4; the bullet's old "NOT DISPATCHABLE" was a third gate token and was mapped onto the contract's two). **C3 team-instanced agents — 🟢 AGENT-SAFE but narrow:** the seven agents the old bullet named do not exist, and `t:<team>`'s *writer already ships* (`acb_skills/manifest.py:242-246`), so the slice is the `dynamic_agents` columns (shape per `agent-kinds.md` §3, `:143-155`; **pre-provisioning — the columns are intentionally unread, per D3, and wiring a consumer is out of scope**) plus reconciling `agent-kinds.md` §6 against three shipped `config.json` files — **changing any existing agent's `instancing` is a silent memory/blob re-partition and is out of scope.** **C4 per-Center approvals — 🔴 OWNER-DECISION** (org_access Q2 open; `pending_actions` has no member/group/Center column). |
| **WS-14a** | **Tenancy TV-1 — the three `org_group` slug-only joins** *(minted 2026-08-03)* | 🟢 **AGENT-SAFE · 1 small PR** | Owning spec: **`specs/tenancy_and_visibility.md` §2**, which passes all seven contract points and had **no board row** until now — §4 assigned it to a spec, and the dispatch loop selects from §2, so the corpus's most dispatch-ready ticket was undispatchable. `org_group` is joined on **slug alone** at three sites; slug is unique only *within* an org (`UNIQUE (organization_id, slug)`, `138_…sql:49`), and **two of the three sit inside the session-authority intersection**, where a too-wide group *widens* access. Nothing leaks today (D11: one org), but these are wrong within one org too, which is why they survive D11. **Anchors, re-verified 2026-08-03 — the previously-published ones were wrong at `520476ab` and are corrected in the spec:** (a) `apps/services/gateway/gateway/rooms.py:181-199`, the `SELECT g.slug` at `:192` *(was `:170-179` = `if row is None` + the participant fetch)*; (b) `:368-403`, `SESSION_VISIBLE_SQL` opening at `:368` with the slug join at `:377` *(was `:332-340` = the tail of `resolve_room_access`'s return)*; (c) `packages/acb_auth/acb_auth/access.py:330-336`, `_GROUP_MEMBER_SQL` — **correct, unchanged**. ⚠️ **The spec's own "verified red" requirement was unsatisfiable and was repaired in the same pass:** §7 named `tests/unit/test_session_authority.py` and `tests/unit/test_rooms.py` as the extension point, and both open with `pytest.mark.skipif(not _db_ready(), …)` (`:33-51` and `:33-52`), so a fixture added there **skips green** with no Postgres. §2 done-when 2 now attaches red-first to a genuinely hermetic string assertion over the three queries (which requires lifting anchor a's inline SQL to a module constant — that extraction is part of the ticket), and done-when 3 requires quoting a `-v`/`-rs` run showing the DB-backed fixture `passed`, never `skipped`. Numbered **14a** rather than a fresh WS-n because it is the `org_group`-join half of the same subject-vocabulary surface WS-14 generalises; the two are independent PRs and either may land first. |
| WS-15 | **Centers D — dashboards + Company Center** (Center dashboards, personal dashboard, weekly digest workflows, orchestrator org-memory fix per D4) | 🟡 WS-13 | Digest workflows double as `workflows_app.md` G1 launch metric — one artifact, both scorecards. |
| WS-16 | **Centers E — AI budgets** (per-member caps at the LLM choke points; per-room degrade later) | 🟡 WS-6 | Subjects per D2. |

### Apps

| WS | Workstream | Owning spec | State | Next / notes |
|---|---|---|---|---|
| WS-17 | **Email completion** | `email_app_master_plan.md` | 🔴 owner calls | 3 pending owner decisions (kill-list batch, schedule-send go, contact-merge identity) + user-parked semantic search. Tier-1 hardening (§7) is 🟢 AGENT-SAFE and gates a second account. |
| WS-18 | **Tasks Phase 3** (Weekly Review, Waiting-For, ~~Horizons~~) | `task_manager_app.md` (corrected 2026-08-01) | 🟡 partial | **Audited 2026-08-02 → GO-NARROWED, and point 3 splits per view — the first row in four cycles to clear it.** ✅ **Waiting-For *surfacing* BUILT 2026-08-02, pending review** (`lib/waiting.ts` pure predicates + `WaitingForView.tsx` grouped by person + `ITEM_SELECT`/`GtdItemModel` now project the write-only mig-48 columns `expected_by`/`last_nudged_at`; **no migration — the substrate all shipped in mig 48**). Delegate now defaults `expected_by` from the item's own `due_at` (the in-app delegate path wrote NULL, so the headline §12 journey produced no flag at all). Fixed en route: a frozen `MOCK_NOW` (4 copies) that made the shipped overdue badge wrong by 33 days and growing, plus `mockData.ts`'s orphaned anchor. **🔴 Weekly Review = NO-GO** (§9.2 is a bare checkbox; `gtd_reviews.summary` is untyped JSONB — define the JSON contract + a per-movement done-when first). **🔴 Horizons = NO-GO and MIS-ASSIGNED** — no acceptance criterion exists anywhere, `gtd_horizons` has no link column to items/projects, and **the spec puts it in Phase 4, not 3**; strike it from this row's title or move it in the spec. **~~Open~~ CLOSED 2026-08-02 (follow-up):** `expected_by` now means exactly one thing — **an explicit human promise**. NULL ⇒ no promise was made, so the overdue line is the item's own `due_at` read **live** (nothing copied, nothing to go stale); non-NULL ⇒ a promise that stands independent of `due_at`. All four insert sites stopped deriving a copy (each was writing the item's own due date under another name), so the column is now written by exactly one path: `PATCH /tasks/items/{id}` with `expected_by` (ISO sets, `""` clears), which updates the open `gtd_waiting` row under a re-stated ownership `EXISTS`. Client judges `expectedBy ?? dueAt`. **No migration, no backfill** — rows delegated before this change keep their snapshot and stay judged on it; clearing one is a normal edit. **OWNER-GATE:** nudge drafting/sending (real-account email sends), delegation write-back to ClickUp (blocked on BO-1). **Drift found:** `gtd_reviews`/`gtd_horizons` have existed since mig 48 with zero gateway references — do NOT write a new migration for them; and the spec's `POST /tasks/projects/plan` was fiction (real: `POST /tasks/plan` + `/plan/apply`, shipped — only the ProjectPlanner UI is missing). **EVAL-LOCKED:** `propose()`/`propose_with_llm()` in `routes/tasks/ai.py`. |
| WS-19 | **Notes + meeting bot** (share-to-chat, ask-during-recording; bot Phase 2 error codes AGENT-SAFE) | `note_taker_app.md` + `meeting_bot_platform_plan.md` | 🟡 | **OWNER-GATE:** bot Phase 1 needs a human-created Google account (`notetaker@fracktal.in`); share-to-chat needs a Slack integration that doesn't exist (scope call). |
| WS-20 | **WhatsApp activation + remainder** (search UI 🟢 AGENT-SAFE; OCR needs a vision-tier decision; Odoo/Zoho-bound items blocked) | `whatsapp_message_manager.md` §11 (header fixed 2026-08-01) | 🟡 owner | **OWNER-GATE:** Meta env/app review, enrichment cost flags. |
| WS-21 | **Calendar F2/F3** (`gtd_time_blocks`, email windows, mobile timeline, external sync) | `calendar_focus_os.md` **§9** (canonical for all F2/F3 acceptance; **§5** canonical for `gtd_time_blocks`) + `calendar_timeboxing.md` **§13** (canonical for P4) — both rewritten 2026-08-03 | 🟡 partial | **Re-audited 2026-08-03 → GO-NARROWED.** P3 roll-over was already shipped (released-to-unscheduled, mig 78 + `start_auto_rollover`). ~~"ideal week"~~ **struck — substantially shipped** (mig 98 + settings round-trip + editor + grid render + packer honouring + 2 unit tests); only the unused-focus-window / template-adherence gap remains (§9.6). **Breaks-in-the-packer SHIPPED 2026-07-23** (`80722e17`, mig **97**) as *packer geometry* — a widened buffer plus lunch protection, **a gap, not a `kind='break'` row**, which is exactly why F2 survives (§5 residual 4, now closed). **The 2026-08-01 acceptance was satisfiable by doing nothing** — 2 of its 3 `gtd_time_blocks` clauses were already green against shipped code; they are deleted and replaced with four that all fail today. **`gtd_time_blocks` is 4 slices, not 1 PR** (§9.1 S1–S4): the "non-breaking `TimeBlock[]` swap" claim was **FALSE** — the measured blast radius is 17 TS files + 3 gateway modules + `apps/skills/skill-task-gtd/` + `apps/agents/agent-task-manager/`. **Focus Shield is AGENT-SAFE, not owner-gated** (§9.5) — it needs a design, not a credential; do not dispatch on §4.1 prose alone. **Top-5 outcomes (Horizons) — DO NOT DISPATCH:** it collides with WS-18; §4 assigns it here, and WS-18's title keeps it struck. **Verify by naming test files — never `pytest tests/unit -k calendar`**: `-k` still collects the whole directory, and whole-directory collection hangs on the Windows box. **Dispatchable today:** §9.1 S1 · the ritual-stamp localStorage residue (§9.1 done-when 4, independently shippable) · §9.6 · §9.7. **OWNER-GATE:** external sync (§9.11 / timeboxing §13 P4) needs Google Calendar and/or Microsoft Graph OAuth client credentials provisioned on the VPS. |
| WS-22 | **draw.io** (all 13 tickets open, nothing built) | `drawio_integration.md` | 🟡 owner | Best acceptance structure in the corpus; needs an owner and re-verified anchors (~5 weeks stale). ST-DRW-02 is a decision gate. |

---

## 3. Decisions recorded (2026-07-31)

Resolutions for the cross-doc conflicts the audit surfaced. D1–D8, **D13** and
**D14** are **proposed defaults, adopted unless the owner objects** (D13 and D14
are labelled `agent-proposed, owner may overrule` in their owning specs and stay
distinct from D11/D12's `owner-answered`); D9, D10, D11 and D12 are owner calls,
taken and dated.

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
  longer appears anywhere outside this decision record.
- **D10 — Two owner calls taken 2026-08-03.** Recorded here so neither is
  re-litigated by a later dispatch.
  1. **Command Center is an internal Fracktal tool.** The team uses it; there
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
- **D11 — The tenant boundary is THE DEPLOYMENT.** *(owner call, 2026-08-03.)*
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
  nothing breaks, and the only standing rule is (i).

## 4. Single-owner registry (who owns duplicated work)

| Work | Owner | Mirrors (link-only after §5) |
|---|---|---|
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
| Tenancy boundary + visibility model (who can see what) | **`specs/tenancy_and_visibility.md`** (D11 §1 · D12 §3–§4 · the app-by-app gap table §5 · TV-1 §2) | `department_centers.md` (the "separate deployment is for a separate org, never a department" rule) · `org_access_control.md` §8 Ph2 · `multi_user_organization_research.md` §5/§7/§8/§9/§17 (**research only, and superseded for planning by the new spec**) · `groups_sessions_authority.md` §3 (the intersection rule it constrains) · D9 (the twelve "second tenant deployment" sites) |

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
>    five registration sites. Both are AGENT-SAFE doc fixes, neither is in this
>    change.

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

## 6. Owner-gate registry (agents must refuse these)

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
only mode is `--mode local`, which refuses the box-only checks by design.
