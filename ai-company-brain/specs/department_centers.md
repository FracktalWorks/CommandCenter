# Department Centers — one platform, many projections

**Status:** Phase A shipped (UI scaffold + feature gating); Phase B groups admin UI + seed shipped pending review (2026-08-01 — directory read view still open) · **Date:** 2026-08-01 · **Owner:** vjvarada

The commitment this document records: **CommandCenter stays one deployment, and
departments get Centers — scoped projections of the same platform, never
separate systems.** A "Sales Center" is the sales team's slice of the one
platform's apps, agents, memory, and workflows; it is not a second product that
"feeds data back."

This supersedes the earlier informal framing of per-department apps as separate
systems. It does not change the tenant rule: a *separate deployment* is reserved
for a separate organization (the multi-tenant path in
`multi_user_organization_research.md` §17), never for a department.

**Why not separate systems.** Every load-bearing capability shipped in July is
cross-cutting and assumes one deployment: intersection authority
(`groups_sessions_authority.md` §3), agent delegation at intersected clearance
(`agent_architecture.md` §8), cross-system workflows (`workflows_app.md` §1.1),
`org:global` memory readable from every scope (`memory_architecture.md`,
`agent-kinds.md` §5), and the single Action Broker / approvals / audit path.
Splitting by department severs all five.

---

## 1. Nomenclature — the words we commit to

UI copy and specs use these terms consistently. Renames are cheap now and
expensive after the team learns the wrong word.

| Term | Meaning | Never call it |
|---|---|---|
| **Center** | A scoped projection of the platform for an audience: Personal, a department, or the Company. | portal, workspace, hub, module (in UI) |
| **Personal Center** | The signed-in user's own slice: apps mapped one-to-one with the person. | "My apps" |
| **Company Center** | The founder/exec projection: org-wide dashboard, live activity, approvals, digests. | Executive Center (audience is exec; *content* is the company) |
| **module** | The **backend** container primitive from research §5 (org_access Phase 2). UI says "Center"; schema and specs say `module`. | — |
| **group** | `org_group` — the scoping primitive. **Group slug = center slug, 1:1** (`sales`, `marketing`, `finance`, `operations`, `people`, `company`). UI copy may say "team" when addressing humans. | department (in schema) |
| **Workshop** | A builder surface: **App Workshop** (`/build/apps`), **Agent Workshop** (`/build/agents`). | Workbench, Creator, Studio (for items) |
| **Studio** | The nav *section* holding cross-cutting creation surfaces (Chat, Workflows, the Workshops). | — |
| **app / sub-app** | An app is a first-party vertical surface (Email, Tasks). A **sub-app is an (app, scope) pair** — the same app projected into a Center, never a fork. | — |
| **Agent Registry** | The admin page for registered agents (`/agents`). Renamed from "Agents" to stop colliding with Agent Workshop. | — |

Naming rules:

1. **Feature slugs:** `center.<slug>`; **routes:** `/centers/<slug>`; **group
   slugs:** `<slug>`. One slug, three namespaces, zero mapping tables.
2. **A Center item is (app + scope).** Sales→Tasks is the Tasks app filtered to
   `group:sales`; the shared mailbox is the Email app on a team-owned account.
   Forking an app per department is the bloat failure mode — refuse it in review.
3. **Live vs planned is stated, not implied.** Scaffold surfaces carry their
   build status (`lib/centers.ts` statuses; "Scaffold" badge on landing pages).
   A card that opens an unscoped surface says so in its caveat.

## 2. The information architecture (shipped)

Sidebar and home page (source of truth: `workbench/control_plane/src/lib/nav.ts`,
deriving Centers from `src/lib/centers.ts`):

1. **Personal Center** — Dashboard¹ · Email · WhatsApp · Tasks · Notes ·
   Memories · Artifacts. All personally instanced (`agent-kinds.md` §6).
2. **Centers** — Sales · Marketing · Finance · Operations · People · Company.
   Each is one nav item landing on `/centers/<slug>`; as sub-apps go live a
   Center's landing page remains its front door.
3. **Studio** — Chat · Workflows · App Workshop · Agent Workshop. Everyone can
   hold these tools (feature-gated); every *object* made with them (session,
   workflow, app, agent) is personally or team scoped and optionally shared.
4. **Admin** — Models · Agent Registry · Approvals · Integrations ·
   Live Activity · Members & Roles (admin-flag gated).

¹ `/dashboard` renders the company overview today; the personal rollup replaces
it here in Phase D, and the company view becomes the Company Center dashboard.

**Access:** migration `140_center_features.sql` seeds `center.*` rows
(category `centers`, none member-default). Owners/admins see every Center via
`feature:*`; everyone else sees a Center only when a role or override grants
it. Granting a department = `allow feature:center.sales` (+ group membership,
once groups have a UI). Route guards: `lib/access.ts` maps `/centers/<slug> →
center.<slug>`.

**Center rosters** (sub-apps + status) live in `lib/centers.ts` — that file is
the registry; this spec deliberately does not duplicate it. Highlights: Sales
(proposal generator, Zoho pipeline, shared mailbox, lead-intake workflow),
Operations (production tracker, inventory/BOM, dispatch, service & AMC — the
strongest early candidate for a hardware company), Company (dashboard, live
activity, approvals live today; digests + reviewed org knowledge planned).

## 3. Work plan — Phases B–E

Phase A (this scaffold) is shipped. Each later phase is independently
shippable and folds in the pending items from earlier plans it depends on.

### Phase B — Groups become real *(the unlock; do first)*

> **Update 2026-08-01: first two bullets shipped pending review.** Gateway
> `/admin/groups` CRUD + membership (`routes/admin/groups.py`, gated on the
> members-admin permissions; the center-feature grant additionally requires
> `admin:access:manage`), the `/settings/groups` admin surface ("Teams" in UI
> copy, per §1), and a seed migration for the six groups (idempotent,
> DO NOTHING so admin edits survive redeploys). Verified by
> `tests/unit/test_admin_groups.py`. The directory read view (bullet 3) is
> still open.

- ✅ **Groups admin UI** over `org_group` / `org_group_member` (mig 138) — CRUD +
  membership + lead role. Was flagged as the gap in `groups_sessions_authority.md` §6.
- ✅ Seed the six groups (slug = center slug). Backfill: adding a member grants
  their department's `center.*` feature alongside group membership (one admin
  action — an allow override with reason `group membership: <slug>`; removing
  membership deliberately does NOT auto-revoke it).
- People Center's "Directory & org chart" is the same data rendered — build the
  read view here, not a parallel store.

### Phase C — Scoping deepens (org_access Phase 2, applied per Center)
- **Tasks team slice**: `/tasks` scoped to the group's projects — the first
  (app + scope) sub-app, proving rule 2.
- **Shared mailboxes**: `email_account_member` by group (research §16.7);
  "this mailbox belongs to the Sales team" ownership surfaced in UI.
- **Team-instanced agents**: sales/billing/delivery per the `agent-kinds.md` §6
  roster — `sharing.instancing: team`, memory `agent:<name>#t:<slug>`, blob
  instance `t:<slug>`. The blob/memory substrate is live (mig 136 + run-path
  wiring), but the **`dynamic_agents` sharing columns do not exist yet** —
  agent-kinds' planned migration was never built. This phase includes that
  migration (next free number at build time), per `work_plan.md` D3: columns
  now, derived from `agent_defs` manifests when agent-architecture Phase A lands.
- **Per-Center approvals routing**: approvals inbox filterable by originating
  group (org_access open Q2).

### Phase D — Dashboards and the Company Center
- **Center dashboards**: per-department rollup pages replacing the "planned"
  cards, fed by app queries + digest workflows (`workflows_app.md` G1 names
  report digests as a launch goal).
- **Personal dashboard**: the Personal Center rollup (footnote ¹).
- **Fix the two flagged defects under the founder view**:
  orchestrator runs without org-scope memory (`agent_architecture.md` §11.1.2),
  and per-agent observability totals are misleading once instancing lands
  (`agent-kinds.md` §9.4 — per-instance cost attribution).
- **Weekly executive digest**: a scheduled workflow per Center → one Company
  Center brief.

### Phase E — AI budgets and governance
- **Per-member AI budgets**: monthly token/cost caps enforced at the gateway's
  LLM choke points (all traffic already flows through them with cost recorded
  per run). Soft-warn at 80%, downgrade-to-fast-tier or block at 100%
  (owner-configurable), exec exempt. Surfaced in Models settings + per-member
  admin view + observability. Depends on Phase D's attribution fix.
- Attribution and subject ordering per `work_plan.md` D1/D2: one attribution
  record — (run, member, agent, instance) stamped at the choke points — with
  per-member caps first; the multiplayer plan's per-room `token_budget` +
  degrade-to-read-only builds later on the same records.
- Later, per-group budgets roll up the same data by Center.

### Deliberately not in this plan
- Floor control / steer / observer lane — multiplayer workstream
  (`docs/multiplayer/README.md` §8), tracked there.
- Entity-graph RLS and consent records — org_access Phases 4–5.
- Multi-tenant / SaaS — research §17; untouched by Centers.

## 4. Open questions

1. ~~**"Pomad Centre."**~~ **Resolved 2026-08-01.** Owner confirmed the name
   was a stray (should have read Command Center), not a planned venture. All
   twelve sites across eight files were rewritten as "a second tenant
   deployment" — preserving each sentence's meaning, including the T2
   security gate in `agent_platform_hardening_2026-07.md` §64. Decision
   record: `work_plan.md` D9.
2. **R&D / Engineering Center?** Fracktal is a product company; a seventh
   Center (projects, test logs, design docs) is plausible. Deferred until a
   real workflow demands it — adding one is a `lib/centers.ts` edit + one
   feature row.
3. **Support: Operations sub-app or own Center?** Service & AMC starts inside
   Operations; if the support team grows its own membership and mailbox, it
   graduates to a Center by the same one-edit path.
4. **Guest access to Centers** — org_access open Q4; a guest with
   `center.sales` only is a plausible contractor shape and needs a decision
   before external sharing.
