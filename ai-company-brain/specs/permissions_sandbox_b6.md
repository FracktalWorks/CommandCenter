# B6 — Permissions & Sandboxing (HH-6, near-term)

> **Status:** **Shipped (2026-07-03)** — B6 grade C → B−. (Container isolation for normal runs remains the deferred Phase-5 item.)
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
