# CRM App — Master Plan (native CRM; Zoho CRM retirement path)

> **Product:** CommandCenter · **Feature:** CRM (Sales Center's primary module) · **Created:** 2026-08-05
> **Status:** 🟢 **WS-26a BUILT** (2026-08-05, branch `ws-26-crm-app`) — migration `144_crm.sql`
> (§3.1–§3.10), `feature:crm` registered on both sides, `gateway/db.py` engine seam with
> `routes/tasks/core.py` converted as its proof, and the `routes/crm/` API (§4 minus
> `import_zoho.py`) live behind the feature gate. **Not deployed** — the migration has not been
> applied anywhere. · **WS-26b–e: 🟡 SPEC, nothing built.** · **Owner:** vjvarada · **Board row:** WS-26
>
> **Not in WS-26a, on purpose:** `schema.generated.sql` was NOT regenerated (struck from
> done-when 1 by the 2026-08-05 audit — it needs a migrated live DB and is ~43 migrations stale
> repo-wide, so refreshing it here would bundle an unrelated resync into this change). It stays
> an owner-run chore.
>
> **Research provenance (2026-08-05):**
> - `frappe/crm` @ develop — **AGPL-3.0: no code may be copied.** Data-model facts, enum
>   vocabularies, and workflow concepts below are unprotectable facts, reimplemented fresh.
> - `trycompai/crm` @ main — **MIT: code may be copied**, but the stack (NestJS/tRPC/Prisma/
>   Eve/Better Auth) doesn't survive translation; we take design patterns, not code.
> - CommandCenter full-tree sweep — every Zoho touchpoint and app-convention anchor cited
>   below was verified in-tree on the date above.

---

## 1. Product vision and scope

**Who this is for:** Fracktal Works sales — today effectively the owner plus the sales
colleagues WS-24 will eventually admit. The company sells hardware (3D printers), filament,
service contracts (AMCs), and projects. Deals are INR, phone/email/WhatsApp-driven, modest
volume (thousands of records, not millions).

**What it replaces:** Zoho CRM. Today Zoho is the system of record and CommandCenter holds a
read-only nightly mirror of it (§2). The native CRM inverts that: **CommandCenter becomes the
system of record, Zoho becomes an import source, then Zoho is retired.**

**What "done" means (end state, Phase E):**
1. Leads, deals, contacts, organizations live in `crm_*` tables with a working pipeline UI
   (list + kanban + record page + timeline).
2. All Zoho data is imported with provenance (`zoho_id`), counts verified.
3. The email app, the tasks app, WhatsApp and the agent platform *bind to* CRM records
   instead of duplicating them (§6) — the platform already owns email sync, tasks,
   notifications, and agents; **the CRM delegates those concerns, never rebuilds them.**
   (This is Frappe CRM's structural lesson: it stays small by delegating email, contacts,
   files, and audit to its framework. Same move here.)
4. The Zoho mirror, its cron, webhook, credentials and config are retired (§7.4), closing
   part of WS-2's standing credential exposure.

**Non-goals (v1 — record departures here per `user_management_contract.md` §7):**
- Multi-currency and exchange rates. INR only; a `currency` column exists with default
  `'INR'` so this is additive later.
- Territories, sales hierarchies, per-team record visibility. Single org (D11); §8 D-CRM-3.
- SLA/response-time engine, assignment rules, sequences/campaigns, marketing automation.
- No-code custom-field or layout editors. Fields live in migrations; layouts in code.
- Quoting/invoicing/taxes. Deal line items only (Phase C); billing stays out of scope.
- Telephony SDKs (Twilio/Exotel). Manual call logging only.
- A saved-views table. v1 view state lives in the URL (trycompai pattern); canned views are
  code.
- Zoho **write** support. There is deliberately no Zoho write path in the repo (WS-1 struck
  it); we are leaving, not deepening.

---

## 2. Current state — the Zoho mirror, measured 2026-08-05

**Zoho is read-only batch ingestion into three Phase-0 graph tables. There is no CRM UI, no
Zoho agent tool that calls the API, no write path, and no `lead` table anywhere.**

| What | Where |
|---|---|
| Client (OAuth refresh + paginated `GET /crm/v2/*`) | `apps/services/ingestion/ingestion/sources/zoho/client.py` — `list_accounts/deals/contacts/notes/tasks/users`. **No `list_leads`.** |
| Normaliser (Accounts→Customer, Contacts/Users→Person, Deals→Deal) | `apps/services/ingestion/ingestion/sources/zoho/normaliser.py` |
| Webhook receiver (shared-secret, fail-closed, enqueue-only) | `apps/services/ingestion/ingestion/sources/zoho/webhook.py`; registered `gateway/main.py` (`/webhooks/zoho` in `PUBLIC_ROUTES`) |
| Nightly sync (02:50) + manual script | `ingestion/scheduler.py::_run_zoho` · `scripts/zoho_sync.py` |
| Mirror tables (`zoho_id TEXT UNIQUE` on each) | `person`, `customer`, `deal` in `infra/postgres/01_schema.sql`; ORM `packages/acb_graph/acb_graph/models.py`; upserts `acb_graph/repo.py` |
| Mirror consumers | `apps/services/orchestrator/orchestrator/sales_views.py` (customer-360/pipeline read models) · `scripts/reconciler.py` (quiet-deal escalation) · `acb_graph/resolver.py` (entity resolution) · six `skills/sales|reconciler/*` skills (all `rollout_stage: shadow`, read the graph, never Zoho) |
| Credentials/config | `acb_common/settings.py` (`zoho_*`) · `.env.example` · `acb_llm/key_store.py` (`zoho-crm`) · `acb_skills/integrations.py` (`_zoho_crm`) · `gateway/routes/integrations.py` (catalog card, health check) · `gateway/routes/oauth.py` (`zoho-crm` provider) |
| Feature gating helper | `require_feature_router` — `packages/acb_auth/acb_auth/deps.py` (re-exported from `acb_auth`); FEATURES tuple in `acb_auth/permissions.py` |
| Frontend | **No Zoho data rendered anywhere.** `lib/centers.ts` Sales Center lists "Pipeline (Zoho CRM)" `status:"planned"`, no href |

Consequences that shape this plan:
- **Migration is import-and-retire, not a live cutover.** Nothing user-facing breaks when
  Zoho goes away; only the mirror consumers above need repointing (Phase E).
- **Leads were never mirrored** — the importer must add a read-only `list_leads` to the
  existing client (one `GET`, same shape as its siblings; still zero write functions).
- The graph mirror keeps running untouched through Phases A–D; retiring it is Phase E.

---

## 3. Data model

All tables in one migration at the **next free number at build time** (R1 — resolve from
`infra/postgres/`, never from a spec; 144 was free on 2026-08-05). Idempotent per
`infra/postgres/README.md`: `CREATE TABLE IF NOT EXISTS`, `INSERT … ON CONFLICT DO NOTHING`,
guarded `DO $$`. PKs `UUID DEFAULT gen_random_uuid()`, timestamps `TIMESTAMPTZ DEFAULT now()`,
indexes `idx_<table>_<cols>`. ~~Refresh `schema.generated.sql` in the same PR~~ — **struck by
the 2026-08-05 audit** (needs a migrated live DB; stays an owner-run chore, see §9 dw 1).

The spine is Frappe's four-entity shape (battle-tested; maps 1:1 onto Zoho's modules) with
trycompai's activity spine and provenance columns.

### 3.1 `crm_organizations` (Zoho: Accounts)
`id` · `name TEXT NOT NULL` · `website` · `industry` · `no_of_employees` · `annual_revenue
NUMERIC(14,2)` · `phone` · `email` · `address JSONB` · `description` · `linkedin_url` ·
`owner_email TEXT` · `source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN
('manual','import','email','agent'))` · `zoho_id TEXT UNIQUE` · `last_activity_at TIMESTAMPTZ`
· `created_at` · `updated_at`. Index: `name`, `owner_email`, `last_activity_at`.

### 3.2 `crm_contacts` (Zoho: Contacts)
`id` · `first_name TEXT NOT NULL` · `last_name` · `email` · `phone` · `mobile` · `title` ·
`organization_id UUID REFERENCES crm_organizations ON DELETE SET NULL` · `description` ·
`linkedin_url` · `owner_email` · `source` (as above) · `zoho_id TEXT UNIQUE` ·
`last_activity_at` · `created_at` · `updated_at`.
Index: `lower(email)` (plain, **not** unique — Zoho data has duplicates and blanks; dedup is
enforced at conversion time by code, §3.7), `organization_id`, `last_activity_at`.

### 3.3 `crm_leads` (Zoho: Leads) — person+company denormalized inline, **no FKs until conversion**
`id` · `first_name` · `last_name` · `lead_name TEXT NOT NULL` (computed fallback chain:
names → organization_name → email local-part → 'Unnamed lead') · `email` · `phone` · `mobile`
· `organization_name TEXT` (free text — becomes a `crm_organizations` row only on conversion)
· `website` · `industry` · `no_of_employees` · `annual_revenue NUMERIC(14,2)` ·
`status_id UUID NOT NULL REFERENCES crm_lead_statuses ON DELETE RESTRICT` · `lead_source TEXT`
· `owner_email` · `description` · `lost_reason_id UUID REFERENCES crm_lost_reasons ON DELETE
SET NULL` · `lost_note TEXT` · conversion provenance: `converted_at TIMESTAMPTZ` ·
`converted_contact_id / converted_organization_id / converted_deal_id` (each `UUID … ON DELETE
SET NULL`) · `source` · `zoho_id TEXT UNIQUE` · `last_activity_at` · `created_at` · `updated_at`.
Index: `status_id`, `owner_email`, `lower(email)`, `last_activity_at`. Default lists filter
`converted_at IS NULL`.

### 3.4 `crm_deals` (Zoho: Deals)
`id` · `name TEXT NOT NULL` · `organization_id UUID REFERENCES crm_organizations ON DELETE SET
NULL` · `status_id UUID NOT NULL REFERENCES crm_deal_statuses ON DELETE RESTRICT` ·
`status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now()` (stage-age clock) · `amount
NUMERIC(14,2)` · `currency TEXT NOT NULL DEFAULT 'INR'` · `probability SMALLINT` (auto-filled
from status default when NULL) · `expected_close_date DATE` · `closed_at TIMESTAMPTZ` (stamped
when status.type becomes won/lost) · `lost_reason_id … SET NULL` · `lost_note` · `next_step
TEXT` · `lead_id UUID REFERENCES crm_leads ON DELETE SET NULL` (provenance; powers timeline
inheritance §5.3) · `owner_email` · `description` · `source` · `zoho_id TEXT UNIQUE` ·
`last_activity_at` · `created_at` · `updated_at`.
Index: `status_id`, `organization_id`, `owner_email`, `expected_close_date`, `last_activity_at`.

### 3.5 `crm_deal_contacts` — M:N with role
`deal_id UUID REFERENCES crm_deals ON DELETE CASCADE` · `contact_id UUID REFERENCES
crm_contacts ON DELETE CASCADE` · `role TEXT` · `is_primary BOOLEAN NOT NULL DEFAULT false` ·
`PRIMARY KEY (deal_id, contact_id)`. Code enforces at most one primary per deal.

### 3.6 Statuses as data (Frappe's model; **not** an enum — trycompai's frozen enum is the anti-lesson)
`crm_lead_statuses` and `crm_deal_statuses`, same shape:
`id` · `name TEXT NOT NULL UNIQUE` · `color TEXT NOT NULL DEFAULT 'gray'` · `position INT NOT
NULL` (kanban lane order) · `type TEXT NOT NULL CHECK (type IN
('open','ongoing','on_hold','won','lost'))` · `is_default BOOLEAN NOT NULL DEFAULT false` ·
deal statuses additionally `probability SMALLINT NOT NULL DEFAULT 0`.
Semantics: kanban lanes = rows ordered by `position`; `type` is the machine-readable class —
entering a `lost` status **requires** a lost reason (422 otherwise); entering `won`/`lost`
stamps `closed_at`. Seeds (`ON CONFLICT DO NOTHING`; the importer appends Zoho's real stage
names, §7.1): leads `New/Contacted/Nurture/Qualified/Lost`; deals
`Qualification/Needs Analysis/Proposal/Negotiation/Closed Won/Closed Lost`.

### 3.7 Lead → deal conversion (one endpoint, Frappe's flow)
`POST /crm/leads/{id}/convert` with optional `{contact_id?, organization_id?, deal?{...}}`:
1. **Contact:** caller-chosen, else matched by `lower(email)` (the one dedup rule: email
   identifies a person), else created from the lead's person fields.
2. **Organization:** caller-chosen, else matched by exact `name` = `organization_name`, else
   created from the lead's org fields. Skipped entirely when `organization_name` is empty.
3. **Deal:** created carrying name (= organization_name or lead_name), owner, amount if
   given, `lead_id` provenance, contact as primary; status = default deal status.
4. Lead: stamped `converted_*`, status → the first `won`-type lead status if one exists.
   Converting an already-converted lead → 409.

### 3.8 `crm_activities` — the single timeline spine (trycompai's shape)
`id` · `type TEXT NOT NULL CHECK (type IN
('note','call','meeting','task','status_change','system'))` · `subject TEXT` · `body TEXT` ·
`occurred_at TIMESTAMPTZ` · `due_at TIMESTAMPTZ` · `completed_at TIMESTAMPTZ` (tasks) ·
target FKs, all nullable, at least one required (`CHECK`): `lead_id / deal_id / contact_id /
organization_id`, each `ON DELETE CASCADE` · `created_by TEXT NOT NULL` (email or
`agent:<name>`) · `meta JSONB` · `zoho_id TEXT UNIQUE` (imported Notes/Tasks) · `created_at`.
Indexes: `(deal_id, created_at)`, `(lead_id, created_at)`, `(contact_id, created_at)`,
`(organization_id, created_at)`, `due_at` partial `WHERE completed_at IS NULL`.
Every write to an activity target also bumps that row's `last_activity_at` (denormalized,
trycompai discipline). Status transitions write a `status_change` activity **and** a
`crm_status_changes` row.

### 3.9 `crm_status_changes` — funnel/dwell analytics for free (Frappe's status-change log)
`id` · `entity_type TEXT CHECK (entity_type IN ('lead','deal'))` · `entity_id UUID` ·
`from_status TEXT` · `to_status TEXT NOT NULL` · `changed_by TEXT NOT NULL` · `changed_at
TIMESTAMPTZ DEFAULT now()` · `dwell_seconds BIGINT` (time in `from_status`).
Index: `(entity_type, entity_id, changed_at)`.

### 3.10 `crm_lost_reasons`
`id` · `label TEXT NOT NULL UNIQUE` · `position INT NOT NULL DEFAULT 0`. Seeded:
`Price / Competitor / No budget / No response / Requirement dropped / Other`.

**Phase-C tables** (own migration, next free number at build time): `crm_products`
(`code UNIQUE`, `name`, `rate NUMERIC(14,2)`, `active`) and `crm_deal_line_items`
(`deal_id CASCADE`, `product_id SET NULL`, `name`, `qty NUMERIC(10,2)`, `rate`,
`discount_pct`, `amount`, `position`) — Fracktal sells printers + filament + AMCs; line
items with totals, no taxes.

---

## 4. API surface — `routes/crm/` package in the gateway

**Layout convention** (mirror `routes/tasks/`): `core.py` is the leaf owning the shared
`router`, Pydantic models, and row→model mappers; feature modules register routes on
`core.router` as an import side effect; `__init__.py` imports them in order and re-exports
`router`. Registered in `gateway/main.py` in its own fail-soft `try/except` block like every
other app router.

```python
router = APIRouter(prefix="/crm", tags=["crm"],
                   dependencies=[require_feature_router("crm")])
```

**Engine seam (BO-10 — this is load-bearing):** the gateway has 12 `create_async_engine`
call sites and the board's standing instruction is *"the next app should extend a shared
seam, not add engine 13."* Phase A therefore adds `gateway/db.py::get_engine()` (module-level
cached, the `routes/tasks/core.py` pattern lifted verbatim), `routes/crm` consumes **only**
that, and `routes/tasks/core.py` is converted to it as the proof the seam works. Converting
the other ten call sites is explicitly out of scope (D-CRM-4).

Modules and endpoints (all under `feature:crm` unless noted):

| Module | Endpoints |
|---|---|
| `core.py` | router, engine import, models, `list_contract()` helper |
| `records.py` | CRUD ×4: `GET/POST /crm/{leads,deals,contacts,organizations}`, `GET/PATCH/DELETE /crm/<entity>/{id}`. List contract: `q, sort, dir, page, page_size≤100`, per-entity filters (`status_id, owner, source`) → `{rows, total}`. Sort via **allowlist**, never interpolated (trycompai's `resolveOrderBy` rule). |
| `pipeline.py` | `GET /crm/pipeline` (deals grouped by status: rows ordered per-lane, count + `SUM(amount)` per lane) · `POST /crm/leads/{id}/convert` (§3.7) · status transition inside `PATCH` writes dwell log + activity + `status_changed_at` + probability default |
| `activities.py` | `GET /crm/<entity>/{id}/timeline` (merged: activities ∪ status changes ∪ — Phase D — linked email threads; a deal's timeline unions its `lead_id`'s history, labeled) · `POST /crm/<entity>/{id}/activities` · `PATCH/DELETE /crm/activities/{aid}` (complete task, edit note) |
| `admin.py` | `GET/POST/PATCH/DELETE /crm/statuses/{lead,deal}` + `/crm/lost-reasons` (reorder = PATCH `position`). Gated `feature:crm` (v1 decision D-CRM-3: the sales team manages its own pipeline; revisit when WS-24 admits colleague #1). `DELETE` on an in-use status → 409 (FK RESTRICT surfaces it). |
| `import_zoho.py` | `POST /crm/import/zoho` — **gated `require_permission("admin:access:manage")`** (existing admin capability; minting nothing per `user_management_contract.md` §3). ⚠️ `integrations:use:zoho-crm` was the first choice and is **wrong**: `131_integration_memory_permissions.sql` grants `member` `integrations:use:*`, so under `permission_matches` every member would hold it — the code floor must be an admin capability; the §6 owner gate governs the *run* on top of it. §7.1. |

Rules that bind (from `user_management_contract.md`): identity from
`X-User-Email` only (R3); no `PUBLIC_ROUTES` additions — the BFF proxies everything (R2);
server-side checks first, UI hiding second (R9); email comparisons case-insensitive (R10);
destructive deletes report what cascaded (R7/R8 — deleting a deal reports its activities and
line-item counts).

---

## 5. UI — `/crm` app in the control plane

**Files:** `workbench/control_plane/src/app/crm/{page.tsx, components/, lib/}` + BFF proxy
`src/app/api/crm/[...path]/route.ts` (the `tasks` proxy pattern: `gatewayHeaders()`,
`force-dynamic`, 30s timeout). Registration (the five-place checklist,
`department_centers.md` §2): `FEATURES` += `"crm"` (`acb_auth/permissions.py`) ·
`feature_catalog` row — **all seven columns** per `130_org_access_control.sql`'s insert
shape: `('crm','CRM','Pipeline, leads and customers','/crm','apps', 55, false)` —
`sort_order` 55 (beside Tasks at 50, not defaulted to last), `is_default` **false**
deliberately: `feature:crm` reaches only `*`-holders (owner) and `admin` (`feature:*`)
until an admin grants it, because `manager`/`member` feature grants are enumerated in 130.
That is consistent with D-CRM-3 and stated again in WS-26c · `nav.ts` pane (Personal→no; **Centers**: it is the Sales Center's
module; also a flat `PANES` entry `/crm`) · `access.ts` `HREF_FEATURES` `["/crm","crm"]` ·
`centers.ts`: Sales Center's "Pipeline (Zoho CRM)" `planned` entry becomes
`{label:"CRM", status:"live", href:"/crm"}` · `test_org_access_control.py` invariants extend.

**Surfaces (Phase C):**
1. **Deals kanban** (the landing tab): lanes = `crm_deal_statuses` by `position`, colored;
   cards show name/org/amount/owner/stage-age; drag → `PATCH status_id`; per-lane count +
   ₹ total. List view toggle with the shared list contract (sortable columns, filter chips —
   the email app's QuickFilters pattern).
2. **Leads / Contacts / Organizations lists** — same list engine, `converted` filter chip on
   leads.
3. **Record sheet** — URL-as-state (`?deal=<id>`), opened over the list, no `/[id]` routes
   (trycompai pattern; back button closes). Left: timeline (newest-first, status changes and
   notes/tasks/calls inline, quick composer for note/task/call). Right: fields panel with
   inline edit, org/contact cards, owner, status pill dropdown, Convert button on leads.
4. **Convert modal** — resolves dedup interactively: pick matched contact/org or create new
   (§3.7's caller-chosen ids).
5. **Quick-create modals** (~6 fields) per entity.

Theming: Tailwind v4 semantic tokens (`bg-background`, `text-muted-foreground`, …), Lucide
icon names as strings, `useViewMode()` for mobile. State: zustand store + pure helpers in
`lib/` with colocated vitest tests (the `tasks` layout).

---

## 6. Integrations — bind, don't rebuild

- **Email (Phase D, highest leverage):** timeline resolution joins existing email tables by
  address — a CRM contact/lead with `email` shows its threads read-time from the email app's
  store (single Outlook account today; account-scoped). **No link table in v1** (D-CRM-5).
  Optional `CRM_AUTO_LEAD` (default **OFF**, flip = OWNER-GATE §6): unknown inbound sender →
  draft lead with `source='email'`, honoring the email app's suppression doctrines. Respect
  the auto-drafting directive: this creates CRM rows, never email drafts.
- **Tasks:** v1 keeps CRM follow-ups as `crm_activities type='task'` (due date, completion,
  timeline-visible). Deep `gtd_items` linking is deferred — recorded future work, not v1.
- **WhatsApp (Phase D):** `routes/whatsapp/transport/context.py::_KNOWN_SYSTEMS` gains
  `"crm"`; `wa_contacts.entity_ref` can then point at CRM records (the "crm" block there is
  documented as an unfilled later phase — this fills it).
- **Agent (Phase D):** `apps/agents/agent-crm/` (name `crm-assistant`; `runtime:"maf"`,
  `OpenAIChatCompletionClient`, `X-CC-Agent` headers — the `agent-email-assistant` template).
  Tools: `search_crm`, `get_pipeline`, `get_record`, `get_timeline`, `create_lead`,
  `update_deal_status`, `log_activity`, `convert_lead`; writes risk-annotated, deletes
  confirmation-gated fail-closed. Registered in `_KNOWN_AGENTS` + `_AGENT_REGISTRY`
  (`routes/agent.py`) + `agent_registry.json`, which also makes it orchestrator-routable.
  The existing `agent_registry.json` `sales` entry (codeless) and `agents.json`
  `agent-sales-assistant` (external repo) are untouched — different names, no collision.
- **Graph mirror consumers (Phase E):** `orchestrator/sales_views.py` and
  `scripts/reconciler.py` re-read from `crm_*`; `acb_graph/resolver.py`'s Zoho ingest path
  and the six shadow sales skills follow the repoint or retire with the mirror.

---

## 7. The Zoho migration path

### 7.1 Import (Phase B — building AGENT-SAFE, running OWNER-GATE)
`POST /crm/import/zoho {dry_run: bool}` pulls via the **existing read-only client** (adding
`list_leads`; still zero write functions), maps:

| Zoho | Native | Notes |
|---|---|---|
| Accounts | `crm_organizations` | Account_Name, Website, Industry, Annual_Revenue, Phone, Billing_* → `address` |
| Contacts | `crm_contacts` | names, Email, Phone, Mobile, Title, Account link |
| Leads | `crm_leads` | names, Company→`organization_name`, Lead_Status→status (auto-created), Lead_Source |
| Deals | `crm_deals` | Deal_Name, Amount, **Stage→status auto-created** (position appended; type guessed: name ~ won/lost, else open), Closing_Date, Account + Contact links, Probability |
| Notes | `crm_activities type='note'` | parented via `$se_module` |
| Tasks | `crm_activities type='task'` | Subject, Due_Date, What_Id/Who_Id |
| Users | owner mapping | Zoho owner id → email via `list_users`; unmatched → import actor |

Idempotent: upsert `ON CONFLICT (zoho_id)`. **Last-import-wins on Zoho-sourced rows** —
during coexistence Zoho stays the system of record; a re-import overwrites native edits to
imported rows, by design, until cutover (§7.3). Report:
`{module: {fetched, created, updated, skipped, errors[]}}`; `dry_run` fetches and reports
without writing.

### 7.2 Coexistence (Phases B–D)
Nightly graph sync keeps running untouched. Native records (`zoho_id IS NULL`) are never
touched by import. Team works in Zoho until the UI (Phase C) is judged usable.

### 7.3 Cutover (Phase E, OWNER-GATE)
Final import → parity check (per-module Zoho counts vs `crm_*` counts, plus owner spot
checks) → team stops writing to Zoho → import endpoint disabled.

### 7.4 Retirement inventory (Phase E — exact paths, verified 2026-08-05)
`ingestion/sources/zoho/` (client kept if any consumer remains, else all four files) ·
`scripts/zoho_sync.py` · `scheduler._run_zoho` + its 02:50 cron · `queue.STREAM_ZOHO` +
consumer mapping · `main.py` zoho router include + `PUBLIC_ROUTES` `/webhooks/zoho` ·
`routes/integrations.py` Zoho card/health/test · `routes/oauth.py` `zoho-crm` ·
`settings.py` `zoho_*` · `key_store.py` `zoho-crm` · `acb_skills/integrations.py` `_zoho_crm`
+ `FIELD_TO_ENV` · `.env.example` Zoho block (**OWNER-GATE — plan-guard blocks agent
writes**) · `TriggerPanel.tsx` zoho option · tests `test_zoho_normaliser.py`,
`test_phase0_zoho_reconciler.py` · `agents.json`/`agent_registry.json` `zoho-crm`
integration declarations. Then **revoke the Zoho refresh token** — this executes part of
WS-2 (the standing "rotate Zoho token" P0 becomes "revoke", strictly better).

---

## 8. Decisions — `DECISION (agent-proposed, owner may overrule)`

- **D-CRM-1 — New `crm_*` tables; the Phase-0 graph tables are not extended.**
  `person`/`customer`/`deal` are a cross-system entity-resolution mirror (ClickUp/Odoo ids
  on the same rows) with different semantics from an operational CRM (no statuses-as-data,
  no activities, no leads). Rejected: growing the mirror in place — it would couple the CRM
  to `acb_graph`'s resolver semantics and every mirror consumer at once. Cost: Phase E owes
  the §6 repoint.
- **D-CRM-2 — Statuses are rows, not enums** (color/position/type/probability). The importer
  must represent Zoho's actual stage names, and the owner reshapes the pipeline without a
  deploy. Rejected: trycompai's hardcoded enum — their own docs show it froze their process
  into code.
- **D-CRM-3 — CRM data is org-visible to `feature:crm` holders in v1; `owner_email` is
  assignment, not ACL.** A CRM is a shared team surface (both reference products agree);
  D11 records one org, and the workflows app's org-wide-read v1 is the shipped precedent
  (`routes/workflows/crud.py` records it). 404-not-403 owner scoping (R5) deliberately does
  **not** apply — recorded departure per contract §7. Revisit with WS-14's `group:` grants
  when colleague #1 lands.
- **D-CRM-4 — Engine seam:** `gateway/db.py::get_engine()`; `crm` consumes it, `tasks` is
  converted as proof, the other ten call sites are out of scope. Rejected: importing another
  app's `core` (cross-app coupling) and a 13th module-level engine (the exact BO-10
  anti-pattern).
- **D-CRM-5 — Email binding is a read-time address join, no link table in v1.** One account,
  modest volume; a link table adds a sync obligation with no v1 payoff. Cost: no manual
  "attach this thread to that deal" — deferred with the link table.
- **D-CRM-6 — Import is last-import-wins until cutover** (§7.1). Rejected: field-level merge
  rules — complexity without a customer until colleagues are in the app.

**Build-time decisions, recorded post-hoc (WS-26a implementer, 2026-08-05 — owner may
overrule any of them):**
- **B1** — `POST` defaults `owner_email` to the acting user when the field is absent
  (explicit `null` stays unassigned); without this the `owner` filter matches nothing and
  WS-26a ships no owner picker.
- **B2** — lead `dwell_seconds` derives from `max(crm_status_changes.changed_at)` falling
  back to `created_at` (leads deliberately carry no `status_changed_at` column).
- **B3** — the lost-reason requirement applies on **create into** a lost-type status, not
  only on transition — the rule belongs to the status type. *(Verifier addendum
  2026-08-05: the sibling §3.6 rule follows the same reach — creating a deal directly in a
  won/lost status stamps `closed_at`, matching what the transition path does.)*
- **B4** — `insert_row`/`update_row` coerce JSONB + temporal params explicitly (bare
  `text()` declares no column types to asyncpg); read half mirrors
  `routes/tasks/core.py::_parse_jsonb`.
- **B5** — `crm_status_changes.entity_type`/`changed_at` and the `crm_activities` target
  CHECK gained NOT NULL where §3.8/§3.9 were silent (strengthening only).
- **Open question for the owner (deliberately unimplemented):** reopening a won/lost deal
  leaves `closed_at` stale — §3.4 stamps and never clears. Clearing on a move back to a
  non-terminal type is one line in `apply_status_transition` once decided.

---

## 9. Tickets — WS-26a…e (every item AGENT-SAFE unless labeled)

### WS-26a — Schema + feature registration + core API · ✅ **BUILT 2026-08-05**
*(Audited GO-NARROWED 2026-08-05; blockers A/B folded in below. Landed as
`infra/postgres/144_crm.sql` + `apps/services/gateway/gateway/db.py` +
`apps/services/gateway/gateway/routes/crm/{core,records,pipeline,activities,admin}.py`,
fenced by `tests/unit/test_crm_{routes,pipeline,convert,migration}.py` — 185 cases, zero DB
and zero network. **Built, not deployed:** applying the migration is the owner's move.)*
Done when:
1. The Phase-A migration (next free number) creates §3.1–§3.10; idempotency is **statically
   asserted** in `tests/unit/test_crm_migration.py` (every `CREATE TABLE`/`CREATE INDEX`
   carries `IF NOT EXISTS`, every seed `INSERT` carries `ON CONFLICT`) — §10 runs no DB, so
   inspection-only idempotency doesn't count. **`schema.generated.sql` is out of scope**:
   its resync needs a migrated live DB (`scripts/dump_schema.sh`), it is ~43 migrations
   stale repo-wide, and regenerating it here would bundle an unrelated schema resync into
   this PR — it is a separate owner-run chore.
2. `"crm"` is in `FEATURES` and the `feature_catalog` row exists — fenced by a **new**
   invariant in `tests/unit/test_org_access_control.py` that derives every
   `feature_catalog` INSERT slug from `infra/postgres/*.sql` (the `_schema_cascade.py`
   technique) and pins it against `FEATURES` both ways; any pre-existing drift goes in an
   explicit commented exceptions literal, never a silent filter. The existing invariants
   are `center.*`-only by construction and fence nothing for an `apps`-category slug.
3. `routes/crm/` exists per §4, registered fail-soft in `main.py`; `gateway/db.py` exists;
   `routes/crm` contains **zero** `create_async_engine` calls and `routes/tasks/core.py`
   consumes `gateway.db` (grep-assertable both ways).
4. CRUD + list contract works per §4 (sort allowlist rejects unknown keys with 422);
   status transition writes `crm_status_changes` + `status_change` activity +
   `status_changed_at`, fills probability default, requires lost reason on `lost`-type
   (422), stamps `closed_at`.
5. Convert implements §3.7 including email-match dedup, 409 on re-convert.
6. `tests/unit/test_crm_routes.py`, `tests/unit/test_crm_pipeline.py`,
   `tests/unit/test_crm_convert.py` pass **named** (never bare `tests/unit/`), no
   DB/network; the wiring fence is a `"gateway.routes.crm"` entry in `GATED_ROUTERS`
   (`tests/unit/test_org_access_enforcement.py`), added deliberately — that registry is
   the test's opinion, not the router's.

### WS-26b — Zoho importer · 🟢 build / 🔴 **OWNER-GATE to run against prod**
Done when: `list_leads` added (client still has zero write functions — grep-assertable);
`POST /crm/import/zoho` per §7.1 behind `admin:access:manage` (see §4's warning — the
`integrations:use:*` family is member-wide); `dry_run` writes
nothing (asserted); statuses auto-created once (idempotent re-import: second run reports
`created: 0`); `tests/unit/test_crm_zoho_import.py` covers mapping/idempotency/owner-mapping
against a fake client, no network. **Running it against prod Zoho+DB is registered in §6.**

### WS-26c — UI · 🟢 AGENT-SAFE
Note: until an admin grants `feature:crm`, the UI is visible to owner/admin only (§5) —
demonstrating it to a `member` requires a grant first.
Done when: the five registration places (§5) updated; the four surfaces + convert modal
render against the API through the BFF proxy; kanban drag persists a status change;
`?deal=` deep link opens the sheet; pure helpers tested in colocated vitest
(`src/app/crm/lib/*.test.ts`); `tsc` and `npm test` green; the `centers.ts` Sales entry
flips to `live` (its vocabulary invariant test keeps passing).

### WS-26d — Integrations · 🟢 AGENT-SAFE except the flag
Done when: email threads appear in contact/lead/deal timelines by address join;
`CRM_AUTO_LEAD` exists, defaults OFF, and its OFF-state is byte-identical email-app
behavior (regression-tested); WhatsApp `_KNOWN_SYSTEMS` includes `"crm"`; `agent-crm`
builds via `build_agents()`, registered in both registries, discoverable by the
orchestrator; write tools risk-annotated; delete tools confirmation-gated fail-closed.
**Flipping `CRM_AUTO_LEAD` = OWNER-GATE (§6).**

### WS-26e — Cutover + retirement · 🔴 OWNER-GATE end-to-end
Final import + parity report; §6 consumers repointed; §7.4 inventory retired; Zoho refresh
token revoked (executes part of WS-2); spec status header + board row updated in the same
PR (R4).

---

## 10. Verification

    # WS-26a (test_crm_zoho_import.py exists only from WS-26b onward — add it then):
    uv run pytest tests/unit/test_crm_routes.py tests/unit/test_crm_pipeline.py \
                  tests/unit/test_crm_convert.py tests/unit/test_crm_migration.py \
                  tests/unit/test_org_access_control.py \
                  tests/unit/test_org_access_enforcement.py -q

    cd workbench/control_plane && npx tsc --noEmit && npm test

⚠️ Never `uv run pytest tests/unit/` bare — whole-directory collection hangs on the Windows
box against the live DB. Name the files. The pr-check gates that bind: ruff
`--select F821,F601,F602,F502,F7,B006` (blocking), xenon max-absolute F (blocking),
frontend tsc + vitest (blocking).
