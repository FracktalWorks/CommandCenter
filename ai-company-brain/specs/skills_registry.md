# Skills Registry + per-agent skill toggles (WS-23)

**Status:** S1 + S2 shipped pending review 2026-08-01 (catalog + toggles + enforcement); S3 generation half + scope-out + prepared default profile shipped pending review 2026-08-01 — **the fail-closed flip itself remains OWNER-GATED and OFF** · **Owner:** vjvarada · verified against code 2026-08-01
**Owning workstream:** `work_plan.md` WS-23 (sequenced with WS-12 context discipline)

## 0. Thesis

Integrations settings answer "what can agents *reach*"; nothing answers "what
can agents *do*". The platform injects tool families into every agent from
`_tool_injection.py`, governed only by code-authored `config.json: tool_scope`
— invisible to admins, and the injected tools addendum costs ~7,800 tokens of
every run's context (WS-12 Phase 1's target: under 2,000). This feature makes
the injected skill surface **visible, toggleable per agent, and priced in
tokens** — turning the context-discipline work into a product surface instead
of a one-off trim.

## 1. Scope and non-goals

**In scope:** a read-only skills catalog grouped into named **skill families**
with measured token cost; per-agent enable/disable of families stored in
Postgres; enforcement at the existing injection seam; the tools addendum
generated from the enabled set (kills the hand-maintained-prose drift flagged
in `core_module_map.md` B2).

**Non-goals (v1):** not a skill marketplace or community intake (CH-9 gate
stands); no per-user toggles (per-*instance* profiles arrive with Centers,
§6); does not replace the B6 runtime permission policy (risk gating at call
time stays); does not touch agents' repo-baked own tools beyond the existing
`own_tool_scope`; **never widens** an agent's surface beyond what its code or
manifest declares.

## 2. The three rules

1. **Intersection, never union.** Effective injected set =
   `(declared tool_scope ∪ CORE) ∩ (tools of enabled families ∪ CORE)`.
   A toggle can only narrow within what the agent's repo/manifest declares —
   a UI switch must never grant a tool the code never asked for
   (`agent_platform_hardening_2026-07.md` C2: manifest *requests*, a grant
   table *authorizes*).
2. **The core floor is not toggleable.** `_CORE_STANDARD_TOOL_NAMES`
   (delegation/reporting family) is injected regardless — a toggle that can
   strand an agent unable to delegate or report is a debugging trap, not a
   setting.
3. **No rows ⇒ today's behavior.** Absent settings change nothing. The
   separate decision to flip fail-open (`no tool_scope` ⇒ everything, C1) to
   fail-closed rides this feature *deliberately* as S3, never implicitly.

**Decision note — scope-independent injections (S2, decided default, for
owner review 2026-08-01).** Two families are injected after (and regardless
of) `tool_scope` filtering; S1 flagged the question of whether toggles govern
them. The S2 default: the **`workflows`** family toggle IS honored — an
explicit admin disable removes the list/run/status trio at its append site
(that is narrowing, which rule 1 permits). Granted **Custom-App action tools**
(`app_<slug>_<action>`) are NOT governed by skill toggles: an app grant is an
explicit per-agent permission with its own management surface (`app_grants`),
so the `apps` family is excluded from toggling in the API (422) and shown as
"managed via App grants" in the UI.

## 3. Design

**Families are code-declared data.** A `SKILL_FAMILIES` registry in
`packages/acb_skills/` maps family slug → {label, description, tool names}.
Families: `core` (floor), `files-artifacts`, `memory`, `email`, `whatsapp`,
`tasks-gtd`, `calendar`, `notes`, `workflows`, `apps`, `diagrams` (future),
`web-research`, `coding` (`code_task`/`run_script`). One registry, consumed by
injection, the catalog API, and addendum generation — the single-source rule
that killed the six history-slicers (C2 precedent).

**Token cost is measured, not estimated.** At catalog build, render each
family's addendum section + JSON schemas and count tokens (same tokenizer as
`assemble_run_context`); cache per (family, registry hash). The UI shows
"WhatsApp · 14 tools · ~1.9k tokens".

**Settings table** (migration: next free number at build time), mirroring the
org-access override shape — the *why* is a column:

```sql
CREATE TABLE agent_skill_setting (
    agent_name  TEXT NOT NULL,
    instance    TEXT NOT NULL DEFAULT '',   -- '' = agent-wide; 't:<slug>'/'u:<email>' later (§6)
    family      TEXT NOT NULL,
    enabled     BOOLEAN NOT NULL,
    reason      TEXT NOT NULL DEFAULT '',
    set_by      TEXT NOT NULL,
    set_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_name, instance, family)
);
```

**API** (gateway, `require_permission` per org-access seams; admin write):
`GET /integrations/skills` (catalog: families, tools, token costs, per-agent
enabled matrix) · `GET/PUT /agent/{name}/skills` (settings; PUT is
`admin:access:manage`-gated).

**Enforcement seam:** `_resolve_injected_scope()` in `_tool_injection.py`
gains the family intersection (one function, both runtimes — same choke-point
principle as D8). Settings resolved once at run start alongside integrations.

**UI:** (a) Integrations → new **Skills** tab: the catalog with token costs
and a which-agent-has-what matrix; (b) Agent Registry (`/agents`) per-agent
panel: family checklist with a live context-cost meter ("enabled: 5 families ·
~3.1k tokens of tool context").

## 4. Phases + acceptance

- **S1 — catalog (read-only).** Registry + token measurement + GET API + tab.
  *Done when:* every injected platform tool appears in exactly one family; the
  tab renders costs; a drift test fails CI if a tool is injected but missing
  from the registry (extends `test_tool_addendum_drift_trajectory.py`).
  **SHIPPED pending review 2026-08-01.** `acb_skills/skill_families.py`
  (registry + DI'd `build_catalog`), `_collect_injectable_platform_tools()`
  extracted verbatim in `_tool_injection.py` (injection unchanged), gateway
  `routes/integrations_skills.py` (`GET /integrations/skills`, same gate as
  the sibling endpoints), Integrations → Skills tab, drift + route tests in
  `tests/unit/test_skills_registry.py` / `test_integrations_skills_route.py`.
  *Family set corrected to the code* (§3's list predated the grown core
  floor): `core` (= the 19-tool `_CORE_STANDARD_TOOL_NAMES` floor — it
  subsumes files-artifacts / notes / web-research / most coding), `memory`
  (8), `history` (1), `coding` (3: install_dependency + GitHub code search),
  `workflows` (3, scope-independent), `apps` (dynamic per-grant). email /
  whatsapp / tasks-gtd / calendar are agents' OWN repo-baked tools (never
  injected) and join the registry only via the WS-8 manifest work. Measured
  baseline (chars/4 run-context tokenizer): full unscoped addendum ≈5.7k
  tokens; addendum + all 34 static tool schemas ≈19.3k, of which the core
  floor is ≈15.1k — the WS-12 Phase-1 instrument now exists.
- **S2 — toggles + enforcement.** Table, PUT API, per-agent panel,
  intersection in `_resolve_injected_scope`. *Done when:* disabling a family
  removes its tools AND its addendum section from the next run (assert on the
  stored run context, mig 50); core family is unlisted in the UI and
  un-disableable in the API (422); no-rows agents byte-identical to today
  (regression test on injected set).
  **SHIPPED pending review 2026-08-01.** `agent_skill_setting` migration
  (next-free number at build; the org-access override shape — reason/set_by
  provenance columns, `instance=''` agent-wide, PK ready for §6 profiles) ·
  `GET/PUT /agent/{name}/skills` in gateway `routes/agent_skills.py` (PUT
  `admin:access:manage`-gated, replace-wholesale like member overrides;
  core/apps/unknown → 422) · enforcement in `_resolve_injected_scope`
  (settings resolved once at run start in `_inject_agent_tools` via the same
  best-effort sync-DB mechanism as app grants/MCP; workflows honored at its
  append site per the §2 decision note) · S1 catalog matrix now shows the
  effective surface (declared scope ∩ enabled families, + per-row
  `disabled_families`) · Agents-page side-panel Skills checklist with live
  cost meter ("enabled: N families · ~X.Xk tokens") and a reason field ·
  tests: `test_agent_skills_route.py` + `test_skill_toggle_enforcement.py`
  incl. the byte-identical no-rows regression against
  `_collect_injectable_platform_tools()`. *Deferred to S3:* the "addendum
  section removed from the next run" half is asserted against the addendum
  BUILDER (it already branches per tool, so a disabled family's section drops
  from the rendered prose) — the stored-run-context (mig 50) assertion lands
  with S3's generated addendum, not faked here. UI shows core locked rather
  than unlisted (the cost meter needs the floor visible — its ≈15k tokens are
  most of the story WS-12 cares about).
- **S3 — generated addendum + fail-closed decision.** Addendum assembled from
  enabled families only; then (OWNER-GATE decision) flip absent-`tool_scope`
  from inject-everything to a named default profile.
  *Done when:* addendum prose for a scoped agent contains no disabled-family
  sections; email-assistant under its Phase-7 target scope measures ≤2k tool
  tokens (`llm_caching_memory.md` Phase 7 gets its instrument).
  **Generation half SHIPPED pending review 2026-08-01; flip PREPARED, OFF,
  owner-gated.** The addendum prose moved verbatim into
  `packages/acb_skills/acb_skills/addendum.py` as ordered, **family-tagged
  section registries** (`FULL_SECTIONS` / `COMPACT_SECTIONS` /
  `MANDATORY_LINES`) rendered by one
  `render_injected_tools_addendum()`; `_build_injected_tools_addendum` in
  `_tool_injection.py` is now a thin cached wrapper around it, and the S1
  catalog measures through that same wrapper — measured cost = real cost by
  construction. Gating stays PER TOOL (injection is per-tool; family tags are
  the drift-checked provenance), so a disabled family's sections drop with
  its tools — asserted end-to-end on the injected system message in
  `tests/unit/test_generated_addendum.py`, which is also the drift gate
  (every section's gate tools must belong to its declared family).
  *Byte-identity note (deliberate):* the S2 "no rows ⇒ byte-identical"
  guarantee is unchanged for the injected TOOL SET; the addendum TEXT is
  generated and byte-identical to the S2 prose **except one fix** — the old
  f-string rendered "`export default function App()Ellipsis`" (a literal
  `{...}` evaluated as Python `Ellipsis`); the generated text says
  `App(){...}` as always intended. Content was otherwise not rewritten.
  *Known gap kept:* the `workflows` trio has never had addendum prose (tools
  carry their own docstrings) — S3 preserved that; adding a section is a
  content decision, pinned by the drift test until made.
  **Scope-out + default profile:** the evidence-based general-vs-specialised
  classification lives in [`skills_scope_out.md`](skills_scope_out.md)
  (per-agent table, GENERAL = core/memory/workflows/apps, SPECIALISED =
  history→orchestrator, coding→apis-config). Prepared mechanism:
  `DEFAULT_PROFILE` + `default_profile_tools()` in `skill_families.py`, and
  the `SKILLS_FAIL_CLOSED` env switch in `_tool_injection.py` — **ships OFF**
  (no behaviour change while OFF: the S2 no-rows regression still passes);
  when ON, unscoped agents resolve to core ∪ DEFAULT_PROFILE instead of
  everything. The flip = owner action (work_plan.md §6), with the checklist
  in `skills_scope_out.md` §4 (review dynamic agents first; revisit the
  catalog's `all_families` flag at flip time).
  **Measured (chars/4 tokenizer):** all families 19,259 tokens
  (addendum 5,697 + schemas 13,562) · DEFAULT_PROFILE 17,757 ·
  email-assistant today (declared scope resolved) 16,520 · core floor alone
  15,446. **The ≤2k email-assistant target is NOT met and cannot be met by
  family toggles**: the non-toggleable core floor alone is ≈15.4k (≈10.3k of
  it the 19 core tools' schemas). The instrument now exists; hitting ≤2k is a
  core-floor diet (leaner schemas / progressive disclosure), tracked as its
  own follow-up, not a toggle matter.

**Verification:** `pytest tests/unit/test_tool_injection*.py tests/unit/test_skills_registry.py`
(new) · trajectory evals stay green (`evals/trajectories/`) ·
`cd workbench/control_plane && npx tsc --noEmit && npm test` ·
`scripts/feature_check.py --only skills` (add probe).

## 5. Gates

AGENT-SAFE: S1, S2, S3's generation half. **OWNER-GATE:** the S3 fail-closed
default flip (behavior change for every agent without a `tool_scope`).

## 6. Later (explicitly deferred)

Per-instance profiles keyed by the same `instance` column (`t:sales` gets the
CRM family, a personal instance doesn't) — lands with Centers Phase C; the
WS-8 declarative manifest's `capabilities.skills` becomes the *declared* side
of the intersection when agent_defs ship (same columns-now-manifest-later
shape as decision D3).
