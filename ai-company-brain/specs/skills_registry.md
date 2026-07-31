# Skills Registry + per-agent skill toggles (WS-23)

**Status:** Proposed 2026-08-01 · **Owner:** vjvarada · verified against code 2026-08-01
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
- **S2 — toggles + enforcement.** Table, PUT API, per-agent panel,
  intersection in `_resolve_injected_scope`. *Done when:* disabling a family
  removes its tools AND its addendum section from the next run (assert on the
  stored run context, mig 50); core family is unlisted in the UI and
  un-disableable in the API (422); no-rows agents byte-identical to today
  (regression test on injected set).
- **S3 — generated addendum + fail-closed decision.** Addendum assembled from
  enabled families only; then (OWNER-GATE decision) flip absent-`tool_scope`
  from inject-everything to a named default profile.
  *Done when:* addendum prose for a scoped agent contains no disabled-family
  sections; email-assistant under its Phase-7 target scope measures ≤2k tool
  tokens (`llm_caching_memory.md` Phase 7 gets its instrument).

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
