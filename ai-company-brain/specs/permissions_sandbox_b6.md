# B6 — Permissions & Sandboxing (HH-6)

> **Status:** Near-term handler **shipped (2026-07-03)** — B6 grade C → B−. **Phase 5 (isolation) in progress (2026-07-04)** — see the "Phase 5" section below.
> **Module:** B6 (core_module_map.md).
> **Scope of THIS pass:** replace the blanket `PermissionHandler.approve_all`
> with a **risk-aware allowlist handler** that gates shell / file-write /
> network / tool operations using the SDK's own request classification + our
> `tool_annotations` risk vocabulary. **Out of scope (Phase 5):** container
> isolation for normal runs — the in-process `importlib` execution model stays;
> that's a much larger infra change tracked separately.

## The gap (audited 2026-07-03)

- **Copilot-SDK agents run with `PermissionHandler.approve_all`** — set at FIVE
  sites in `executor.py` (`~1190, ~2572, ~3023, ~3796, ~4297`), always as
  `if agent._permission_handler is None: agent._permission_handler = _PH.approve_all`.
  `approve_all` returns `PermissionRequestResult(kind="approved")` for EVERY
  request: every shell command, file write, and network fetch the model decides
  to run is auto-approved with no policy. This is the OWASP "excessive agency"
  exposure the module map flags.
- The risk vocabulary exists (`tool_annotations.py`: `read_only` /
  `destructive` / `idempotent` / `open_world` per tool) but **nothing gates on
  it** — it only feeds the prompt addendum and the opt-in `request_confirmation`
  gate (which individual destructive TOOLS call themselves; HH-2). There is no
  gate on the tool *call* itself, and none at all on raw shell/file/network ops.
- The SDK hands the handler a rich `PermissionRequest`: `kind`,
  `commands`/`full_command_text` (shell), `has_write_file_redirection`,
  `path`/`new_file_contents` (file write), `url`/`possible_urls` (network),
  `read_only`, `tool_name`, `warning`. **We were throwing all of that away.**

## Design — a risk-aware permission handler

New `acb_skills/permission_policy.py::risk_aware_permission_handler` — a drop-in
replacement for `approve_all` with the same `(request, invocation) ->
PermissionRequestResult` signature, so it swaps in at all five sites with a
one-line change each. It decides from the request + policy:

| Request shape | Default decision | Why |
|---|---|---|
| `read_only` true, or a `tool_name` annotated `read_only` | **approve** | observation only — safe to call freely |
| named `tool_name`, annotated non-destructive (write/idempotent) | **approve** | reversible platform writes (write_artifact, save_memory…) |
| named `tool_name`, annotated `destructive` | **approve** (defer) | the destructive tool ALREADY self-gates via `request_confirmation` (fail-closed, HH-2) — the handler must NOT double-gate or it deadlocks the confirmation card |
| shell command (`commands`/`full_command_text`) | **policy** | approve unless it matches a dangerous-command denylist (rm -rf /, mkfs, dd to a device, curl|sh, fork bombs, shutdown) |
| file write (`has_write_file_redirection`/`new_file_contents`) with a path OUTSIDE the agent workspace | **deny** | writing outside `repos/{agent}` is out-of-bounds; in-workspace writes approve |
| network (`url`/`possible_urls`) | **approve** | open_world is expected for agents; blocking web breaks normal use. Logged for audit (exfil visibility), not blocked |
| unknown / unclassifiable | **approve + WARN-log** | fail *open* but *loud* — this is the near-term slice; a stricter default-deny is a follow-up once we've observed what real runs request. Every decision is logged with the run correlation (E2) so we can tighten from data |

**Fail-open-but-logged, not fail-closed, for unknowns** — deliberately. A hard
default-deny on an in-process model that already runs arbitrary agent code would
break far more than it protects and give false assurance; the honest near-term
win is (a) kill the truly-dangerous shell/out-of-workspace-write cases, (b)
make every privileged op *observable* (logged + attributable via E2), so the
Phase-5 container work and any tightening is driven by real data, not guesses.
The dangerous-shell denylist + out-of-workspace-write denial ARE fail-closed.

Config: env `AGENT_PERMISSION_MODE` = `enforce` (default — apply the policy) |
`audit` (log the decision the policy WOULD make, but always approve — a safe
rollout mode to see what would be denied before turning it on) | `approve_all`
(the old behaviour, escape hatch). Denylist patterns overridable via env.

The handler consults `tool_annotations.get_annotations` for named tools and the
workspace root from `write_artifact._WRITE_ARTIFACT_CONTEXT` for the
file-write-scope check (the same plain-dict context the tools already use).

## Wiring
Replace `_PH.approve_all` at all five executor sites with our handler (guarded:
if `AGENT_PERMISSION_MODE=approve_all`, keep `_PH.approve_all`). Handler lives
in `acb_skills` (importable by the executor; no new dep). Native-MAF tool calls
already flow through `_make_tool_shim` — a lighter tool-name allowlist check
goes there too (belt-and-suspenders for the non-Copilot path), but the primary
win is the Copilot `PermissionRequest` handler because that's where raw
shell/file/network requests surface.

## Tests
- Unit (`tests/unit/test_permission_policy.py`): read-only approve; annotated
  reversible approve; destructive approve (defers to request_confirmation);
  dangerous shell (rm -rf /) deny; benign shell approve; out-of-workspace write
  deny, in-workspace write approve; network approve+logged; unknown
  approve+warn; `audit` mode always approves but logs the would-be decision;
  `approve_all` mode bypasses.
- Trajectory (`evals/trajectories/test_permission_trajectory.py`): the policy
  decision table is locked as the contract.

## Status
- 2026-07-03 — Design from the B6/HH-6 audit. Building the handler + wiring.
- 2026-07-03 — **Shipped.** `acb_skills/permission_policy.py`
  (`decide` pure fn + `risk_aware_permission_handler`). Wired into all FIVE
  Copilot `_permission_handler` sites in `executor.py` via a
  `_copilot_permission_handler()` helper (mode-guarded: `approve_all` mode keeps
  the SDK's blanket handler). Native-MAF Tier-2 `_make_tool_shim` also gates +
  logs by tool name. 30 unit tests + 4 trajectory (decision-table contract);
  full suite 701 green, zero regressions. Recon confirmed the native-MAF
  **Tier-1 streaming** path has NO tool choke point (`agent.run(stream=True)`
  calls tools directly) — gating it needs wrapping callables at injection in
  `_inject_agent_tools`; deferred as a follow-up (the Copilot handler is where
  raw shell/file/network surface, so it's the primary win). Container isolation
  for normal runs stays the Phase-5 item.
- 2026-07-03 — **Production verification (live VPS) + 3 follow-up fixes.**
  Ran `scripts/feature_check.py` against the live gateway (4/4 PASS) and drove
  real tool-calling runs. Key discovery: the initial wiring did NOT actually
  gate the primary live tool path. On the **Copilot-MAF-BYOK** path (the common
  runtime), platform tools (`web_search`, …) and the agent's OWN repo-baked
  tools are executed as **agent-framework function-tools**, NOT through the
  Copilot SDK's `on_permission_request` hook (that fires only for the SDK's
  built-in shell/file/fetch) — so the 5-site handler never saw them. Fixes:
  (1) `_gate_injected_tool` wraps every tool we inject; (2) `_inject_agent_tools`
  RE-WRAPS the agent's existing `_tools[*].func` too (repo-baked tools land there
  via the `GitHubCopilotAgent(tools=…)` ctor → `self._tools = normalize_tools`);
  (3) the gate logs EVERY decision (approve + deny), because it only logged
  denials before — which made a silent approval indistinguishable from "gate
  never ran" and blinded audit mode. **Verified live:** a `web_search` run now
  emits `permission.decision {tool:web_search, approved:true,
  reason:tool_read_only, surface:injected_tool, mode:audit}`. Also fixed E2
  `duration_ms` (was null — now derived from event stream-ids; live run shows
  ~9s) and set `LOG_FORMAT=json` on the VPS (logs are now JSON, run-correlated).
  Prod is in `AGENT_PERMISSION_MODE=audit` (log-only) pending review of the
  decision stream before flipping to `enforce`.

---

# B6 Phase 5 — Isolation for normal agent runs

> **Status:** In progress (2026-07-04). This is the deferred deep-isolation
> work — the "real residual excessive-agency exposure" the module map flags.
> The near-term permission handler above is the *policy* layer inside the
> process; Phase 5 adds the *boundary*.

## The exposure, precisely (audited 2026-07-04)

Everything about a normal agent run executes **in the single gateway/orchestrator
interpreter**, and that interpreter's `os.environ` holds **every decrypted
integration secret**. Concretely, from the recon:

1. **Shared ambient credentials — the top standing exposure.**
   `executor._inject_integrations_to_env` (`executor.py:4509`) writes every
   resolved credential into `os.environ` (`ZOHO_REFRESH_TOKEN`,
   `CLICKUP_API_TOKEN`, `SMTP_PASSWORD`, `APIFY_API_TOKEN`, `INSTANTLY_API_KEY`,
   the Gmail/Sheets SA-json paths, …). It's called on all three run paths
   (sub-agent `:1419`, streaming `:2769`, batch `:4655`) and the guard is only
   `if val and not os.environ.get(env_var)` — so creds are written once and
   **never cleared**. They **accumulate globally** across every run and every
   agent for the process lifetime. **Any agent — or any prompt-injected agent —
   can read any other integration's secret today** with `os.getenv(...)` or a
   shell `env`, regardless of its own `config.json` scope.
2. **Arbitrary code in-process.** `loader._import_module_file`
   (`loader.py:1240-1247`) `exec_module`s the agent repo's `agents.py` in the
   gateway interpreter; imported modules persist process-wide (cleanup only pops
   the run module + sys.path entries).
3. **Shared venv.** `_install_agent_deps` (`loader.py:1095`) and the runtime
   `install_dependency` tool (`dep_tools.py:79`) both `uv pip install --python
   sys.executable` — into the gateway's own interpreter. One agent's deps can
   shadow/break another agent's or the gateway's.
4. **No resource/network limits anywhere** — even the *mutation* container
   (our only existing isolation) runs with **zero** `--memory`/`--cpus`/
   `--pids-limit`/`--network`/`--cap-drop`/`--read-only` flags (grep-confirmed).

The one clean seam: the **model call already goes over loopback HTTP** to the
gateway `/v1` (native MAF `OpenAIChatCompletionClient(base_url=…/v1)`;
Copilot-SDK BYOK force-routed to the same). So a sandbox doesn't need the
provider keys — it needs egress to the gateway `/v1` with a **scoped** key.

## Why not "container-per-run" as the first move

The obvious SOTA answer — run each agent in a `Dockerfile.mutation`-style
container — is the *destination*, but shipping it as step 1 is wrong here:

- **4GB VPS reality.** The box already runs systemd (`acb-gateway`) + Docker
  infra (`acb-postgres`, `acb-redis`). A cold container per run costs hundreds of
  MB + seconds of startup; naive container-per-run would OOM or serialize under
  any real concurrency. A production model needs a **warm pool** or subprocess
  tier — non-trivial infra.
- **The tool boundary is the hard part, not the container.** ~12 injected tools
  are **in-process closures** over gateway state (recon (c)): `call_agent`
  re-enters the executor; `query_history` opens a Postgres session; memory tools
  hit Mem0/Graphiti; `write_artifact`/`share_artifact` close over
  `_WRITE_ARTIFACT_CONTEXT` + the live SSE queue; `install_dependency` mutates
  `sys.executable`. Moving the run across a process boundary means **proxying
  every one of these back over RPC** — that's the bulk of the work and it's
  orthogonal to which isolation mechanism wraps it.
- **The mutation container is batch-only.** It communicates by parsing stdout
  sentinels after the process *exits* (`mutation.py:665`); normal runs need the
  **live AG-UI SSE relay** (`stream_relay.py`). So even reusing the skeleton, we'd
  be building a new live host↔sandbox event channel.

So Phase 5 is **tiered** — ordered by (exposure removed) ÷ (infra cost), so each
step is independently shippable and de-risks the next.

## Tiered plan

### Tier 0 — Per-run credential scoping (kill the shared-env exposure) ← **Phase-5 step 1, implementing now**
The single highest-value slice, and it needs **no container at all** — it
directly closes exposure #1 above, which is the concrete "any agent reads any
secret" hole.

Replace the write-and-never-clear `_inject_integrations_to_env(os.environ)` with
a **scoped, per-run** materialization that is torn down when the run ends:

- Only export the credentials for **this run's** resolved integrations (the
  executor already has the per-run `integrations` dict — it's the argument).
- **Restore `os.environ` to its prior state when the run completes** (context
  manager / try-finally): capture the pre-existing value of each var, set ours,
  and on exit restore the captured value (or delete if it wasn't set). So creds
  for run A are gone before run B (or a concurrent idle agent) can read them.
- **Concurrency caveat, stated honestly:** `os.environ` is process-global, so
  under *concurrent* in-process runs this scoping is best-effort — two runs
  overlapping still share the env for the overlap window. This is a real limit of
  the in-process model and is exactly what Tier 2+ (a real process/container
  boundary, each with its **own** env) fixes permanently. Tier 0's win is
  removing the **permanent accumulation** (the steady-state where every secret
  ever used is always present) and scoping to the run's own declared
  integrations — a large, real reduction, not a complete fix. The residual
  concurrent-overlap window is logged as a known limit here so it isn't mistaken
  for closed.
- Prefer, where the tool supports it, passing creds **per-call** (the structured
  `state["integrations"]` dict the tools are *documented* to read —
  `integrations.py:8-11`) over the env at all; the env export exists only for
  subprocess skill scripts that call `os.getenv` directly. Audit which tools
  actually need the env vs. which can take the dict, and shrink the env surface
  to only the subprocess-callers.

This is a contained executor change with unit-test coverage and no infra
dependency — ships first.

### Tier 1 — Egress-scoped model key + resource ceilings on the mutation container
Before generalizing the container, **harden the one we already have** (it's the
template Tier 2 reuses, and it currently has zero limits):
- Add `--memory`, `--cpus`, `--pids-limit`, `--cap-drop=ALL`
  (+ re-add only what's needed), and a `--read-only` rootfs with a writable
  workspace mount, to the `docker run` in `mutation.py:626`. Sane defaults tuned
  for the 4GB box, env-overridable.
- Give the sandbox a **scoped gateway key** (not the `sk-local` master key) with
  a short TTL / run-scoped identity, so a leaked sandbox key can't act as the
  gateway. (Ties to B5 on-behalf-of vs fixed-credential.)
- Constrain egress: the sandbox needs the gateway `/v1` + (for the self-heal
  agent) GitHub; everything else can go through a default-deny with an allowlist.
These flags are pure additions to the existing invocation and carry into Tier 2.

### Tier 2 — Generalize the container to a live, streaming run sandbox (the big lift)
Lift a **normal** Copilot/MAF run into the (now hardened) container:
- New `sandbox_runner.py` (generalize `mutation_runner.py`) that runs the agent
  turn and **streams AG-UI events live** to the host over a real channel
  (Redis Stream keyed by thread_id — reuse `stream_relay.py`'s contract directly,
  rather than post-exit stdout sentinels).
- A **tool-proxy RPC**: the in-process tool closures stay host-side; the sandbox
  calls them over the boundary (the host already owns Postgres/Redis/Mem0/the SSE
  queue). Model calls stay HTTP-to-gateway (already the pattern).
- **Per-agent venv/image** so dep installs can't collide (removes the
  `--python sys.executable` shared-venv risk).
- **Warm-pool** execution model for the 4GB box (a small pool of pre-started
  sandbox containers claimed per run), not cold-container-per-run.
This is genuinely multi-step infra and is scoped as its own sub-project; Tier 0
+ Tier 1 remove the concrete standing exposures and de-risk it.

### Tier 3 — Default-deny tightening + intent-level auth
Once Tier 2 gives real isolation, flip the near-term handler's *unknown →
approve-open-but-logged* to *default-deny* (the honest reason it's fail-open
today, per the near-term section, is that a hard deny on an in-process model that
already runs arbitrary code gives false assurance — a real boundary removes that
objection). Layer intent-level authorization over allow-everything.

## Grade movement
Tier 0 alone: B6 stays **B−** but closes the single worst concrete hole (shared
ambient secrets). Tier 0+1: **B** (limits + scoped key + no permanent cred
accumulation). Tier 2: **B+/A−** (real isolation boundary for normal runs). The
map's "container isolation for normal runs" open item is fully closed only at
Tier 2; Tiers 0–1 are the shippable de-risking that gets us there safely.

## Status (Phase 5)
- 2026-07-04 — Design from the B6 Phase-5 recon (mutation-container primitive +
  in-process/credential boundary analysis). Tiered plan authored. Implementing
  **Tier 0** (per-run credential scoping) first — the highest exposure-removed ÷
  infra-cost slice, no container dependency.
