# CRM App — Master Plan (native CRM; Zoho CRM retirement path)

> **Product:** CommandCenter · **Feature:** CRM (Sales Center's primary module) · **Created:** 2026-08-05
> **Status:** 🟢 **WS-26a + WS-26b + WS-26c BUILT AND DEPLOYED** (2026-08-05/06) ·
> 🟢 **WS-26d read half BUILT** (2026-08-06). 26a–c merged together on branch
> `ws-26-crm-app`.
> **26a** — migration `144_crm.sql` (§3.1–§3.10), `feature:crm`
> registered on both sides, `gateway/db.py` engine seam with `routes/tasks/core.py` converted
> as its proof, and the `routes/crm/` API (§4 minus `import_zoho.py`) live behind the feature
> gate.
> **26b** (merged from `ws-26b-zoho-sync`, PR #363) — the two-way Zoho sync: `list_leads` +
> `list_deleted` on the read client, the single write client
> `ingestion/sources/zoho/writer.py` (one caller, grep-asserted), migration
> `145_crm_zoho_sync.sql` (dirty columns + `crm_zoho_tombstones` + `crm_sync_cursors`),
> `routes/crm/{import_zoho,sync_zoho,broker_handlers}.py`, the `crm.zoho_*` Action-Broker
> handlers registered from `main.py`, and `CRM_ZOHO_SYNC` (ships **OFF**) gating only the
> lifespan loop.
> **26c** (merged from `ws-26c-crm-ui`) — the `/crm` app (`src/app/crm/` + BFF proxy), the three
> frontend registration points with a `live ⇒ href` fence on `CenterApp`, the deal-contacts
> endpoints (`routes/crm/deal_contacts.py`, one primary per deal enforced on the shared
> `core.link_deal_contact` seam), `organization_name` on the deal list + board payloads, the
> `NOT_NULL_DEFAULTED` null guard, and the three review residuals.
> **26d (read half)** (branch `ws-26d-agent-crm`) — `apps/agents/agent-crm/` (`crm-assistant`,
> `runtime:"maf"`, `OpenAIChatCompletionClient`, `X-CC-Agent`) with four READ tools
> (`search_crm`, `get_pipeline`, `get_record`, `get_timeline`) over the existing `/crm` routes,
> registered in `_KNOWN_AGENTS` + `_AGENT_REGISTRY` + `agent_registry.json`; and `"crm"` added
> to the WhatsApp `_KNOWN_SYSTEMS` allowlist **parse-only** (§6). The email-thread timeline
> join, `CRM_AUTO_LEAD`, and every write tool are explicitly NOT in it — see §9.
>
> **Deployment state, measured 2026-08-06:** migrations **144 and 145 are applied on prod**
> and `/crm` is **live**. The Zoho backfill has been **run and is complete** — 737
> organizations, 1,189 contacts, 1,516 leads, 551 deals, 1,909 notes; **zero dirty rows and
> zero unmatched owners**. §7.1's pre-flip curl check was verified against the tenant: the
> RFC-1123 `If-Modified-Since` header is honored (304). **Nothing has ever written the Zoho
> tenant** — that is still true, and stays true until the owner flips `CRM_ZOHO_SYNC`:
> enabling the flag and any hand-run push cycle against prod remain OWNER-GATE
> (`work_plan.md` §6).
> · **WS-26d write half + email join: 🟡 SPEC.** · **WS-26e: 🟡 SPEC, nothing built.**
> · **Owner:** vjvarada · **Board row:** WS-26
>
> ⚠️ **`.env.example` cannot carry `CRM_ZOHO_SYNC`** — plan-guard blocks agent writes to it, so
> the variable is documented here and in `acb_common/settings.py` only. Same for the
> `.claude/hooks/plan-guard.mjs` OWNER_GATES entry WS-26b's ticket asks for: `.claude/` is
> untracked, so that edit lands on the box-side copy, not in this change.
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
- Zoho write support **outside the sync engine**. *(Amended 2026-08-05, owner-directed —
  D-CRM-7.)* The original non-goal ("no Zoho write path at all; we are leaving, not
  deepening") is overruled: while Zoho is still in use, WS-26b runs a **faithful two-way
  sync**, which requires a write client. The boundary that survives: the sync engine is the
  **single writer** — no route handler, agent tool, or skill calls Zoho directly, the write
  client has exactly one caller (grep-asserted), and the whole write path retires with
  WS-26e. ✅ **Built 2026-08-05**; WS-1's "no Zoho write path exists" clause and the §4
  registry row were corrected in the same change (board Authority rule: fix the mirror).

---

## 2. Current state — the Zoho mirror, measured 2026-08-05

**Zoho is read-only batch ingestion into three Phase-0 graph tables. There is no CRM UI, no
Zoho agent tool that calls the API, no write path, and no `lead` table anywhere.**

| What | Where |
|---|---|
| Client (OAuth refresh + paginated `GET /crm/v2/*`) | `apps/services/ingestion/ingestion/sources/zoho/client.py` — `list_accounts/deals/contacts/notes/tasks/users`, plus `list_leads` + `list_deleted` **added by WS-26b**. Still read-only. |
| Write client (**added by WS-26b**, D-CRM-7) | `apps/services/ingestion/ingestion/sources/zoho/writer.py` — create/update/upsert/delete per module. Exactly ONE caller (`routes/crm/sync_zoho.py::execute_push`), grep-asserted; every call arrives broker-gated; retires with WS-26e. |
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
- **Leads were never mirrored** — WS-26b added the read-only `list_leads` to the existing
  client (one `GET`, same shape as its siblings).
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
Index: `status_id`, `lower(owner_email)`, `lower(email)`, `last_activity_at`. Default lists
filter `converted_deal_id IS NULL` (**B6** — the FK link, not the timestamp: deleting the
deal SET-NULLs the link and the lead returns to the working list; `converted_at` survives
as history).

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
| `deal_contacts.py` *(WS-26c)* | `GET/POST /crm/deals/{id}/contacts` · `DELETE /crm/deals/{id}/contacts/{contact_id}`. §3.5's "at most one primary per deal, enforced in code" lives on `core.link_deal_contact`, which the convert path also goes through — promoting demotes the incumbent first, in the same transaction. A **new module** rather than more of `records.py`: the package's stated layout is one feature module per concern, and deal-contacts are a sub-resource with their own invariant (build-time decision C1). |
| `admin.py` | `GET/POST/PATCH/DELETE /crm/statuses/{lead,deal}` + `/crm/lost-reasons` (reorder = PATCH `position`). Gated `feature:crm` (v1 decision D-CRM-3: the sales team manages its own pipeline; revisit when WS-24 admits colleague #1). `DELETE` on an in-use status → 409 (FK RESTRICT surfaces it). |
| `import_zoho.py` | `POST /crm/import/zoho` — **gated `require_permission("admin:access:manage")`** (existing admin capability; minting nothing per `user_management_contract.md` §3). ⚠️ `integrations:use:zoho-crm` was the first choice and is **wrong**: `131_integration_memory_permissions.sql` grants `member` `integrations:use:*`, so under `permission_matches` every member would hold it — the code floor must be an admin capability; the §6 owner gate governs the *run* on top of it. §7.1. Also owns the Zoho→native **field mapping**, which `sync_zoho.py` imports rather than re-deriving. |
| `sync_zoho.py` | The two-way sync engine (§7.1's seven bullets) + `POST /crm/sync/zoho` (same `admin:access:manage` floor; runs one cycle **with or without** `CRM_ZOHO_SYNC`) + the gateway-lifespan loop, flag-gated. `execute_push` is the writer's only caller. |
| `broker_handlers.py` | The Action-Broker gate every push crosses and the three `crm.zoho_*` handlers, registered from `main.py` exactly like `register_task_broker_handlers` (D-CRM-8). **Registers no routes** — deliberately not imported from `__init__.py`. |

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

**As built (WS-26c).** `lib/` holds everything server-shaped and pure, and each file is
unit-tested: `urlState.ts` (the URL grammar — `?deal=` opens the sheet over the list,
`?sort=`/`?dir=` make a sorted list shareable, and `selectTab` drops the filters that do not
travel, `sort` included because the keys are a **per-entity server allowlist** and a stale
one is a 422 that empties the list), `board.ts` (lane order, tone, the move plan, the
optimistic re-tally, and `needsLostReason`), `filters.ts` (the list contract,
including *never* sending `?status_id` to an entity without a pipeline), `convert.ts`
(§3.7's match rules, mirrored so the modal pre-selects what the server would do),
`format.ts` (₹ in `en-IN` lakh/crore grouping, stage age, dwell) and `api.ts` (the BFF
client; refusals keep their status so a 409 can be explained rather than reported as a
failure). `store.ts` is a thin zustand store whose one rule is that a **write re-reads what is on
screen, whatever the response was** — a stale row after a 409 reads as success, and a
created record that is invisible until somebody hits refresh is the same lie told the other
way round. It keeps the last loaded view so `refreshCollection()` can re-read the board or
the list without every caller threading the view back in.
`components/` is composition only. ⚠️ `CenterApp` in `lib/centers.ts` is a union
discriminated on `status`, so a `live` entry without an `href` is a **compile** error: the
existing `test_centers_registry_matches_the_feature_vocabulary` reads each Center's
`feature:` field and nothing else, so it cannot see a mistake in `apps[]` at all.
Runtime twin: `src/lib/centers.test.ts`.

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
  `"crm"` — **BUILT 2026-08-06, and PARSE-ONLY.** That constant is an allowlist read by
  `parse_entity_ref`, so adding `"crm"` changes exactly one behaviour: a
  `crm:<kind>:<uuid>` ref that somebody sets by hand parses into an `EntityRef` instead of
  being discarded as an unknown system. **Nothing writes `wa_contacts.entity_ref` — for any
  system, anywhere in the repo** (pinned structurally by `tests/unit/test_crm_agent.py`), so
  there is no CRM linker yet; and the `crm` block on `ChatContextModel` is still `None`,
  which is the other half of parse-only. Writing the ref and filling that block is a later
  slice, and it owes both halves together — a link the drawer cannot render is not a link.
- **Agent (Phase D):** `apps/agents/agent-crm/` (name `crm-assistant`; `runtime:"maf"`,
  `OpenAIChatCompletionClient`, `X-CC-Agent` headers — the `agent-email-assistant` template,
  **including its `_headers()` fail-closed identity rule**: a run that cannot resolve its
  acting user refuses rather than calling the gateway with the bearer alone, which
  `acb_auth/deps.py` §1b would read as SERVICE_ACCESS).
  **READ half BUILT 2026-08-06** — `search_crm`, `get_pipeline`, `get_record`,
  `get_timeline`, each a thin wrapper over the existing `/crm` routes (the agent never
  queries the DB). Read-only is enforced at the transport: `_ALLOWED_METHODS = {"GET"}`,
  checked inside the single round-trip helper every tool goes through, and the module
  deliberately ships no `_post`/`_patch`/`_delete` helper at all.
  **Write half STILL SPEC** — `create_lead`, `update_deal_status`, `log_activity`,
  `convert_lead`; writes risk-annotated, deletes confirmation-gated fail-closed. Blocked on
  the spec naming that confirmation mechanism (§9, blocker B5).
  Registered in `_KNOWN_AGENTS` + `_AGENT_REGISTRY` (`routes/agent.py`) +
  `agent_registry.json`. **Orchestrator routability comes from `_AGENT_REGISTRY`** —
  `orchestrator/agents.py:303-307` imports it directly (plus `_load_dynamic_agents()`); no
  runtime code reads `agent_registry.json`, which is kept for the catalog only.
  The existing `agent_registry.json` `sales` entry (codeless) and `agents.json`
  `agent-sales-assistant` (external repo) are untouched — different names, no collision.
- **Graph mirror consumers (Phase E):** `orchestrator/sales_views.py` and
  `scripts/reconciler.py` re-read from `crm_*`; `acb_graph/resolver.py`'s Zoho ingest path
  and the six shadow sales skills follow the repoint or retire with the mirror.

---

## 7. The Zoho migration path

### 7.1 Backfill + two-way sync (Phase B — building AGENT-SAFE; enabling against prod OWNER-GATE)

*(Re-scoped 2026-08-05, owner-directed — D-CRM-7: "while we are using Zoho, ensure we do a
faithful two-way sync, until we do away with Zoho entirely.")*

**Bootstrap:** `POST /crm/import/zoho {dry_run: bool}` performs the initial backfill —
pulls via the existing client (adding `list_leads`), maps:

| Zoho | Native | Notes |
|---|---|---|
| Accounts | `crm_organizations` | Account_Name, Website, Industry, Annual_Revenue, Phone, Billing_* → `address` |
| Contacts | `crm_contacts` | names, Email, Phone, Mobile, Title, Account link |
| Leads | `crm_leads` | names, Company→`organization_name`, Lead_Status→status (auto-created), Lead_Source |
| Deals | `crm_deals` | Deal_Name, Amount, **Stage→status auto-created** (position appended; type guessed: name ~ won/lost, else open), Closing_Date, Account + Contact links, Probability |
| Notes | `crm_activities type='note'` | parented via `$se_module` |
| Tasks | `crm_activities type='task'` | Subject, Due_Date, What_Id/Who_Id |
| Users | owner mapping | Zoho owner id → email via `list_users`; unmatched → import actor |

Idempotent: upsert `ON CONFLICT (zoho_id)`. Report:
`{module: {fetched, created, updated, skipped, errors[]}}`; `dry_run` fetches and reports
without writing.

**Continuous sync (the coexistence mode):** after backfill, a sync engine keeps both sides
faithful until cutover:

- **Single-writer seam, THROUGH the broker gate (D-CRM-8):** all Zoho write calls live in
  one writer module beside the client (`ingestion/sources/zoho/writer.py`), called from
  exactly one place — the sync engine in `routes/crm/sync_zoho.py` — grep-asserted. Every
  push routes through an Action-Broker gate exactly the way the tasks app's ClickUp writes
  do (`routes/tasks/providers.py::_broker_gate` — *"the single audited chokepoint for
  source-of-truth writes"*, default disposition auto-applies while `ACTION_BROKER_ENFORCE`
  is off): registered `crm.zoho_*` broker handlers, an audit row per push. This satisfies
  root `AGENTS.md` constraints #4/#8 instead of departing from them. Consequence, accepted
  deliberately: if the owner ever flips broker enforcement ON, sync pushes queue for
  approval and the sync becomes supervised rather than continuous. No agent tool, route
  handler or skill reaches Zoho directly; agents write the native CRM and the sync
  propagates.
- **Zoho → native:** incremental pull (`If-Modified-Since` — `client._list_module` already
  takes `modified_since`) for the four record modules + Notes/Tasks, plus Zoho's
  **deleted-records API** (a new read function beside `list_*`); Zoho deletes become
  native deletes (cascading activities per the FK graph, loudly counted in the sync
  report). Pulled rows carry `source='import'` — the existing CHECK vocabulary needs **no**
  new value and no ALTER. **Echo suppression is a stated rule:** a pull-applied write goes
  through `update_row(..., touch=False)` and never sets `zoho_dirty` — a two-cycle
  fake-client test must converge to zero pushes.
- **Native → Zoho:** dirty-tracking on the four record tables (`zoho_dirty` set by native
  writes to zoho-linked and native-new rows; `zoho_synced_at`); the engine pushes dirty
  rows (create ⇒ acquires `zoho_id`, update ⇒ upsert by id). Native deletes of
  zoho-linked rows write a **`crm_zoho_tombstones` row inside the delete transaction**
  (`module`, `zoho_id`, `entity_type`, `deleted_by`, `deleted_at`, `pushed_at NULL until
  pushed`) — a tombstone cannot be a column on a row that no longer exists. Native
  `note`/`task` activities push as Zoho Notes/Tasks; `status_change`/`system` activities
  never push (no Zoho analog — Zoho keeps its own stage history).
- **Pull cursors are schema too:** `crm_sync_cursors` (`module` PK, `last_pulled_at`,
  `last_run_at`, `last_status`) — incremental pull without a persisted per-module cursor
  re-reads the world after every restart. Both new tables + the dirty columns land in one
  migration at the next free number (landed as `145_crm_zoho_sync.sql`), with 26a's static
  idempotency fence extended to it — found by CONTENT, never by number (R1).
  **Two rules the cursor has to obey, both found by the 26b verifier:**
  1. **One snapshot per cycle, read before anything moves.** The pull phase writes cursors
     as it goes, so a deleted-records read that fetched the cursor *afterwards* would get
     the watermark that very cycle just wrote — and Zoho would answer "nothing deleted"
     for every deletion older than this cycle's newest `Modified_Time`. Those deletions are
     missed **permanently**: the cursor only moves forward, so no later cycle asks about
     that window again. `read_cursors()` snapshots once and both phases take it as an
     argument.
  2. **The watermark is the newest record that APPLIED, capped below the OLDEST that
     failed.** `If-Modified-Since` is a single instant, so a failed record stays retryable
     only while the cursor is strictly below it — and the failure may well be *older* than
     a success in the same batch, which is why the ceiling is the oldest failure and not
     simply "don't use the newest fetched". Full rule: nothing fetched ⇒ **keep** the
     existing watermark, adopting the cycle start only when there isn't one (so an unchanged
     module stops re-reading its table, while a momentarily empty window does not drag the
     cursor forward to now); nothing applied ⇒ stand
     still; a failure we cannot place in time (no readable `Modified_Time`) ⇒ stand still,
     because "we do not know" must not read as "nothing failed"; otherwise the newest
     applied, never backwards. **Accepted cost:** a record that fails every cycle pins that
     module's cursor and its window is re-read every ten minutes until it applies. That is
     the deliberate direction — the pull is idempotent, so a repeated window is wasted work
     while an advanced cursor is lost data — and it is never silent: `pull_record_errors`
     is non-zero and `last_status` stays `'partial'` on every such cycle. Per-record apply
     failures are also folded into the cycle summary count; a cycle that dropped nine
     records must not log `errors=0`.
  3. **The pull asks for `sort_by=Modified_Time&sort_order=asc`.** Zoho's default order is
     that key DESCENDING, so a record edited between page 1 and page 2 — by anyone, our own
     push included — jumps to the front and shifts every later record back one slot, and the
     record that sat on the page boundary is never returned. Ascending makes the sequence
     append-only for the duration of the pull.
- **Transaction shape — one bad record must not lose the batch, and Postgres does not
  agree by default.** A statement error aborts the whole transaction, not the statement, so
  a per-record `try/except` "survives" a bad row while in fact losing every row after it,
  the cursor write and the commit — and the next cycle repeats it identically forever.
  Every applied record and every push therefore runs inside a **SAVEPOINT**
  (`core.savepoint`), each phase commits its own work, and each pull module commits WITH its
  cursor. `_number()` additionally clamps values outside `NUMERIC(14,2)` to NULL, because
  Zoho's currency fields have no such ceiling and one fat-fingered amount is otherwise a
  poisoned transaction rather than a bad row.
- **The external write is committed before anything else runs.** Zoho's API has no
  idempotency token, so the window between "the create returned 200" and "the `zoho_id` is
  durable locally" is a duplicate factory: a crash or an aborted transaction in it loses the
  id while the record exists upstream, and every later cycle creates ANOTHER. Push → stamp →
  **commit**, per record. For the same reason `stop_crm_zoho_sync` signals and waits
  (`STOP_GRACE_SECS`) rather than cancelling: a cancel lands wherever the cycle happens to
  be, including inside that window.
- **One cycle at a time.** `run_cycle` takes a process-wide lock and a second caller gets
  **409** (`POST /crm/sync/zoho`) or skips (the loop). Two overlapping cycles see the same
  dirty rows and both create them upstream. ⚠️ The lock is in-process, which is correct only
  while the gateway runs as a single worker — a second worker needs
  `pg_advisory_xact_lock` on the same key.
- **Failure has a ceiling.** Both push queues (records + activities, and tombstones) carry
  `attempts` / `last_error` / `next_attempt_at`: exponential backoff, and after
  `MAX_PUSH_ATTEMPTS` the row is parked, counted in `pushed.given_up` and logged at ERROR.
  Without it a row Zoho will never accept sits at the front of an oldest-first `LIMIT` queue
  forever and starves everything behind it. A tombstone whose record Zoho no longer has
  (404, or a 200 carrying `RECORD_NOT_IN_MODULE`) is a **success** — the goal state holds.
- **Approval writes state back.** Under broker enforcement the queued push, when approved,
  runs through the same `apply_push_result` the inline path uses — otherwise every approval
  performs the write and records nothing, so the row stays dirty and each approval mints
  another copy upstream. The gate also refuses to enqueue a second proposal for an
  `(action, target)` already pending: the row is re-offered every cycle by design, which at
  ten-minute ticks is 144 identical inbox rows per day per stuck record.
- **Conflicts:** record-level last-writer-wins comparing Zoho `Modified_Time` against
  native `updated_at`; both-changed conflicts are counted and logged per cycle, never
  silent. No field-level merge in v1 (D-CRM-6 amended).
- **The sync must not mutate native data by echoing itself.** Three rules, all learned
  from the 26b verifier's round-trip reading:
  - **`source` is provenance and is written on INSERT only.** It is deliberately excluded
    from the `ON CONFLICT` arm (`core.INSERT_ONLY_COLUMNS`), so a row typed into this app
    stays `'manual'` after the sync pushes it up and pulls it back. Rewriting it would flip
    every native-origin row to `'import'` on its first echo — a silent one-way rewrite of
    the column the `?source=` filter reads.
  - **Zoho's required fields are PADDED on push and un-padded on pull.** Zoho makes fields
    NOT NULL that §3.2/§3.3 allow to be blank (a Contact needs `Last_Name`; a Lead needs
    `Last_Name` and `Company`), so the push fills them from a field that is always
    populated. `import_zoho.strip_padding_echo` drops a pulled value when — and only when —
    the native column is NULL *and* the value is exactly what we would have padded it from.
    Accepted cost, stated: a human in Zoho who genuinely types `Last_Name` = the first name
    onto a contact whose native surname is blank is indistinguishable from our padding, and
    the native column stays NULL. `PADDED_FROM` is held to `to_zoho_*` by a test that reads
    the builders' **source** (AST-walks each for the `or`-fallback that IS a pad) rather
    than restating the map — a pad added without a guard entry fails there.
  - **Anything DERIVED from a padded field is derived after the strip, never inside the
    mapper.** `crm_leads.lead_name` is §3.3's fallback chain over first/last/organization —
    two of which the push pads — so deriving it in `map_lead` folded our own padding into
    the display name: a lead called "Asha" came back "Asha Asha", and `lead_name` is on the
    conflict arm, so every cycle rewrote it. `map_lead` therefore does **not** emit
    `lead_name`; `apply_record` computes it after `strip_padding_echo`.
  - **Activity DELETES sync in NEITHER direction, while activity creates do.** A note
    deleted here survives in Zoho; one deleted in Zoho survives here. **Accepted v1 cost**
    (P2, 2026-08-05 review): an activity is an append-mostly log entry whose stale copy
    misleads nobody about the pipeline, Zoho is being retired, and closing it means a second
    tombstone path plus a delete predicate over a table with four nullable parents. Records —
    where a stale copy IS misleading — propagate deletes both ways. `apply_zoho_deletes`
    iterates `RECORD_MODULES` only and says so; `activities.delete_activity` says so too.
    ⚠️ Do not close one direction alone: a native tombstone without the matching Zoho→native
    delete makes the two sides disagree in a NEW way.
  - **A native field CLEAR does not reach Zoho, and the next pull restores the old value.**
    The push prunes `None` (sending it would CLEAR the field at Zoho, so a column we simply
    do not carry would blank the tenant's copy every cycle) — which means "user emptied
    this field" and "we have nothing for this field" are the same wire state, and Zoho's
    surviving value comes back on the next pull. **Accepted, not fixed:** distinguishing
    them needs per-field dirty tracking, i.e. exactly the field-level merge D-CRM-6 rules
    out for v1. Clearing a field on both sides, or clearing it in Zoho, both work.
- **Pipeline vocabulary flows DOWN only** while sync is on: stage/status picklists are
  managed in Zoho and auto-created natively (as backfill already does); native status
  creation is not pushed (Zoho picklist mutation needs settings-API writes — out of scope,
  and the vocabulary dies with Zoho anyway).
- **Cadence + switches:** the scheduled loop runs only when **`CRM_ZOHO_SYNC=1`** (ships
  OFF; flip is OWNER-GATE, §6; the flag reads from `acb_common` settings like its
  siblings). The loop follows the **gateway's own in-process scheduler pattern**
  (`routes/workflows/scheduler.py` / `routes/tasks/scheduler.py`, started in `main.py`'s
  lifespan) — NOT `ingestion/scheduler.py`: ingestion's pyproject cannot depend on the
  gateway, so a `routes/crm/` engine cannot be driven from there. Interval ~10 min.
  `POST /crm/sync/zoho` (same `admin:access:manage` floor) runs one cycle on demand and
  works regardless of the flag, because a hand-run cycle is an explicit admin act. The
  nightly graph-mirror sync in `ingestion/scheduler.py::_run_zoho` is untouched either way
  (Phase E retires it) — ⚠️ audit note 2026-08-05: no `deploy/` unit references the
  ingestion scheduler, so whether that 02:50 job actually runs on the box is unverified
  from the repo.

### 7.2 Coexistence (Phases B–D)
Both sides stay writable and faithful (§7.1). Native records without a `zoho_id` exist in
Zoho within one sync cycle of creation. The team can move to the native UI (Phase C) at
its own pace instead of on a cutover day.

### 7.3 Cutover (Phase E, OWNER-GATE)
Final sync cycle → parity check (per-module Zoho counts vs `crm_*` counts, plus owner spot
checks) → `CRM_ZOHO_SYNC` off → team stops writing to Zoho → sync engine, writer and
backfill endpoint retired with the rest of §7.4.

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
- **D-CRM-6 — ~~Import is last-import-wins until cutover~~ superseded by D-CRM-7's sync;
  the surviving half:** conflicts resolve at record level (last-writer-wins on modified
  timestamps), never field-level merge — complexity without a customer until colleagues
  are in the app.
- **D-CRM-7 — `DECISION (owner-answered 2026-08-05)`: coexistence is a faithful TWO-WAY
  sync, not a one-way import.** Owner's words: *"while we are using Zoho, ensure we do a
  faithful two way sync, until we do away with Zoho entirely."* This overrules the
  original §1 non-goal (no Zoho write path) and re-scopes WS-26b per §7.1. The agent-held
  boundary that survives: **the sync engine is the single Zoho writer** and the whole
  write path retires with WS-26e. Retirement stays the end state.
- **D-CRM-8 — sync pushes route through the Action-Broker gate** (agent-proposed,
  audit-forced 2026-08-05). The first draft claimed the ClickUp sync bypasses the broker
  as precedent — **the audit measured the opposite**: `_broker_gate` is the tasks app's
  single audited chokepoint and auto-applies while enforcement is off. The Zoho writer
  follows it: `crm.zoho_*` broker handlers, one audit row per push, auto-apply default.
  This also re-opens WS-1's struck clause on our terms — the "Zoho write client" its row
  said didn't exist is now specced here, and its broker handlers are WS-26b's, not BO-1's.
  Accepted consequence: broker enforcement ON turns the sync supervised.
- **D-CRM-9 — `DECISION (owner, 2026-08-06)`: agent-originated CRM writes enter the Zoho
  push queue exactly like human ones.** Agent-originated and (future)
  `CRM_AUTO_LEAD`-originated CRM writes are treated identically to a person's: every native
  write is born `zoho_dirty = true` (`routes/crm/core.py::mark_dirty_on_insert` /
  `mark_dirty_on_update`) and pushes on the next sync cycle, which `POST /crm/sync/zoho` runs
  with or without `CRM_ZOHO_SYNC`. Faithful two-way sync (D-CRM-7) applies to every native
  write regardless of author — **no special case, no held-back tier.** The safety boundary
  for agent writes is the confirmation gate on the tools themselves (the future write-tools
  slice), not a fork in the sync semantics. Read together with the create-half rule the
  mechanism already has: a row arriving WITH a `zoho_id` came from Zoho and is not born
  dirty, so "native write" here means exactly what the code already keys on. This resolves
  the WS-26d audit's push-queue blocker; the confirmation mechanism (B5) is still open.

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
- **B6** *(adversarial review P1, 2026-08-05)* — "converted" is keyed on
  `converted_deal_id IS NOT NULL`, never on `converted_at`: both the lead-list filter and
  the re-convert 409. The timestamp version stranded a lead invisibly forever when its deal
  was deleted (FK SET-NULLs the link, the timestamp survives), with SQL as the only
  recovery. Deleting a converted deal now returns its lead to the working list,
  re-convertible.
- **Review repairs, same pass** — `record_activity` keeps its own docstring's promise and
  bumps the target's `last_activity_at` itself (the next caller — WS-26b's importer,
  WS-26d's agent tools — cannot ship records that sort as never-touched);
  `PATCH /crm/activities/{id}` refuses `status_change`/`system` rows exactly as DELETE does
  (one rule, both verbs); the three `owner_email` indexes are `lower(owner_email)` to match
  the only predicate that reads them (R10), and contacts gained the missing one.
- **Open question for the owner (deliberately unimplemented):** reopening a won/lost deal
  leaves `closed_at` stale — §3.4 stamps and never clears. Clearing on a move back to a
  non-terminal type is one line in `apply_status_transition` once decided.

**Build-time decisions, WS-26c implementer (2026-08-05 — owner may overrule any of them):**
- **C1 — the deal-contacts endpoints are a NEW module (`routes/crm/deal_contacts.py`), not
  more of `records.py`.** The package's layout convention is one feature module per concern
  registering on `core.router`, and a deal's people are a sub-resource with an invariant of
  their own. It also keeps WS-26c's gateway diff off `records.py`, which WS-26b is editing
  in parallel. Rejected: `records.py` (a fifth concern in a file whose whole shape is "four
  entities × five verbs").
- **C2 — "at most one primary per deal" is enforced on the shared seam
  `core.link_deal_contact`, not per route.** 26a recorded the rule as convention with one
  writer; adding endpoints would have made it two opinions. The convert path was moved onto
  the same function (its bare `insert_row` is gone), and the demote-before-promote order is
  deliberate — the intermediate state is "no primary", never "two". Pinned structurally: no
  module outside `core.py` may INSERT into `crm_deal_contacts`.
- **C3 — `organization_name` is projected by wrapping the base SELECT in a derived table**
  (`core.project_joined`), not by inlining the join into `FROM`. `crm_organizations` also
  carries `owner_email`, `source`, `name` and the timestamp trio, so an inlined join makes
  every unqualified predicate `list_contract` renders ambiguous — the fix would be to
  qualify all of them, in all four entities, to serve one. Wrapping also means the join runs
  over one page rather than the table. The outer `ORDER BY` is not decoration: a join over
  an ordered subquery does not preserve its order.
- **C4 — "was the lead name hand-edited?" is answered by recomputing, not by a column.**
  `core.lead_name_is_derived` compares the stored name to what the fallback chain would
  produce; a `lead_name_is_custom` flag would have to be maintained by every writer (the
  importer, the sync engine, the agent tools) and the one that forgets it silently reverts a
  typed name. Accepted cost: typing exactly what the chain would have produced leaves the
  name derived — which produces the same string, so nobody can tell.
- **C5 — the explicit-`null` guard is a per-table map of NOT NULL **defaulted** columns**
  (`core.NOT_NULL_DEFAULTED`), checked inside `insert_row`/`update_row` so a route added
  later inherits it. Keyed by table because `probability` is NOT NULL DEFAULT 0 on
  `crm_deal_statuses` and nullable on `crm_deals` — a flat column set would refuse a
  legitimate "clear the probability". The map is derived from the migration and pinned both
  ways by `test_crm_migration.py`, which caught `crm_status_changes` missing from the first
  version.
- **C6 — the frontend keeps the wire's snake_case.** The tasks app maps snake→camel at its
  client boundary; the CRM's field names ARE its column names (`row_to_model` maps
  generically by field name), so a rename layer would be a second vocabulary to keep in step
  with migration 144 — and the copy is what drifts.
- **C7 — the board asks for a lost reason BEFORE sending the move.** The gateway answers 422
  before writing any of the transition's three effects, and the reason travels *with* the
  `PATCH` rather than in a second request, so the move either lands whole or not at all.

**Adversarial-review repairs, same branch (2026-08-05 → 06). Three changed a decision:**
- **C8 — `sort`/`dir` are VIEW state, in the URL, not component state.** The first pass held
  them in `useState`, `listQuery` never sent them and the load effect never watched them, so
  a column header flipped its own arrow and re-issued an identical request — a control that
  changes its appearance and nothing else, which reads as working. Putting them in `CrmView`
  fixes all three at once (the effect already keys on view fields), makes a sorted list
  shareable, and lets `selectTab`'s existing "filters that do not travel" rule clear a stale
  key — which matters more here than for the others, because sort keys are a per-entity
  server allowlist and a carried-over key is a 422, not an odd order. `canSortBy` is
  belt-and-braces behind it for the hand-edited-URL case.
- **C9 — `similarOrganizations` excludes the exact match by IDENTITY, not by comparing
  strings.** The review found the exact match rendered twice (both entries carrying the same
  id, so both drew selected) because the filter compared a lowercased candidate against a
  non-lowercased lead name. The suggested fix — fold both sides — also removes the duplicate,
  but it hides every case-variant: `matchOrganization` is case-SENSITIVE, so "bosch india" is
  *not* the exact match and is precisely the near-miss the list exists to surface. Excluding
  `o.id === exact?.id` fixes the duplicate and keeps the near-miss.
- **C10 — `link_deal_contact`'s `is_primary` is tri-state (`None` = leave it alone), like
  `role`.** `DealContactIn.is_primary` defaulted to `False`, so "set this contact's role"
  demoted the deal's primary as a side effect: a field the caller never mentioned deciding
  something. Explicit `false` still demotes — a deal may legitimately have no primary.

The other four were straight defects, fixed without a decision: `createRecord` and a
*successful* `patchRecord` now re-read the collection (`refreshCollection`); `moveDeal`'s
post-move re-read carries the board's owner filter instead of widening it to the whole
pipeline; the kanban's `dragstart` sets a `dataTransfer` payload, without which Firefox
never starts the drag at all; and `api.moveDeal` now consumes `board.moveRequest` (extended
to carry the lost fields) rather than building a second, diverging shape beside a function
whose comments claimed to be the only one.

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

### WS-26b — Zoho two-way sync · ✅ **BUILT 2026-08-05** / 🔴 **OWNER-GATE to enable against prod**
*(Re-scoped 2026-08-05 per D-CRM-7; audited GO-NARROWED the same day and repaired —
blockers 1–9 folded in below. Landed on branch `ws-26b-zoho-sync` as
`ingestion/sources/zoho/{client.py→list_leads+list_deleted, writer.py}` +
`infra/postgres/145_crm_zoho_sync.sql` +
`apps/services/gateway/gateway/routes/crm/{import_zoho,sync_zoho,broker_handlers}.py` +
the `core.py` dirty-marking choke point and `records.py` tombstone-in-delete, fenced by
`tests/unit/test_crm_zoho_{import,sync}.py` — 129 new cases, zero DB and zero network, plus
26a's migration fence extended to the second migration. **Built, not run:** no backfill and
no cycle has ever executed against the tenant.)*

**Build-time decisions, recorded post-hoc (WS-26b implementer — owner may overrule):**
- **C1** — the dirty-marking choke point is `core.insert_row`/`core.update_row`, keyed on
  the EXISTING `touch` flag. A pull applies with `touch=False`, which already meant "do not
  bump `updated_at`"; reusing it means "is this a real edit" and "should this be pushed back"
  are one switch that cannot disagree, and a route added later inherits both. The create half
  keys on the payload instead — a row arriving with a `zoho_id` came FROM Zoho and is not born
  dirty — so no caller has to remember a flag.
- **C2** — **activities carry no dirty column.** Their push signal is a NULL `zoho_id`: an
  activity is a log entry, so "has it been pushed" and "has it changed" are the same question,
  and stamping the id on success is what makes the push idempotent. This is why migration 145
  alters only the four record tables.
- **C3** — the Zoho→native field mapping lives in `import_zoho.py` and the sync engine
  imports it. A backfill and a pull that map `Deal_Name` differently is a divergence nobody
  notices until the counts stop matching.
- **C4** — the broker gate + `crm.zoho_*` handlers live in `routes/crm/broker_handlers.py`,
  which deliberately does **not** import the writer: an approved queued push re-enters through
  `sync_zoho.execute_push`, so the writer keeps exactly one import site and the grep assertion
  stays meaningful.
- **C5** — a **queued** push (broker enforcement ON) leaves the row dirty and stamps nothing.
  BO-1b is the same bug on the ClickUp side: treating the `pending` marker as success shows a
  row as synced that exists in no tenant.
- **C6** — a Zoho→native delete bypasses `records.delete_record` and therefore writes **no**
  tombstone. A tombstone there would push the deletion straight back at the tenant that just
  reported it — an echo in the most destructive direction available.
- **C7** — `DELETE /crm/<entity>/{id}` now takes the acting user (for `deleted_by`) and its
  response gained `zoho_delete_queued`, so a caller is told the deletion leaves this app.

**Verifier repairs (2026-08-05, same branch — five findings, all taken):**
- **V1 (was a FAIL)** — the deleted-records read took its cursor *after* `pull_phase` had
  already advanced it, so any Zoho deletion older than that cycle's newest `Modified_Time`
  was silently and **permanently** missed. Cursors are now snapshotted once
  (`read_cursors()`) before either phase and passed to both. Pinned by a test asserting the
  `<module>/deleted` read's `since` equals the PRE-cycle cursor and is strictly older than
  the cursor the same cycle wrote.
- **V2** — the pull cursor advanced to the newest *fetched* record even when some records
  failed to apply, dropping them permanently; and the cycle summary counted only the
  cycle-level and push-level error lists, logging `errors=0` over a batch that lost rows.
  Now `advance_cursor()` watermarks on the newest successfully **applied** record and
  `SyncCycleReport.pull_record_errors` folds the per-record failures into the summary.
  *(Re-verification: the first repair was still wrong when the failure was **older** than a
  success — `apply_module` now returns a `ModulePass` carrying both `newest_applied` and
  `oldest_failed`, and the cursor may only move strictly below the oldest failure. The
  pinned-cursor cost of that is recorded in §7.1.)*
- **V3** — three echo mutations. `source` is now insert-only (see §7.1); the push's padding
  of Zoho's required fields is stripped on the way back in (`strip_padding_echo`), with the
  one indistinguishable case recorded in §7.1 rather than hidden; and `lead_name` — which is
  DERIVED from two padded fields — is computed after the strip instead of inside `map_lead`,
  which had it round-tripping "Asha" into "Asha Asha" on the conflict arm.
  *(Re-verification found that third one, and that the map-vs-padder drift test restated
  `PADDED_FROM` instead of reading `to_zoho_*`; it now AST-walks the builders.)*
- **V4** — a native field clear never reaching Zoho is **documented as an accepted cost** of
  D-CRM-6's no-field-level-merge (§7.1), not changed.
- **V5** — `writer.upsert_record` was exported and never called (`execute_push` branches the
  verb itself). Deleted: the single write surface should stay countable, and "upsert by id"
  is a decision in `push_records`, not a verb.

**Adversarial-review repairs (2026-08-05, same branch — six findings, all real
Postgres/Zoho semantics the unit fakes cannot see):**
- **A1 (P1)** — the cycle was ONE transaction with no savepoints, so a single statement
  error (a Zoho amount overflowing `NUMERIC(14,2)`) aborted it, took every later statement,
  rolled back the cursor, and made the next cycle die identically forever. Now: a SAVEPOINT
  per applied record and per push (`core.savepoint`), a commit per phase and per pull
  module, and `_number()` clamps out-of-range values to NULL.
- **A2 (P1)** — Zoho writes happened inside the transaction that recorded them, so an abort
  after a successful create discarded the stamped `zoho_id` and the next cycle made a
  DUPLICATE (Zoho has no idempotency token). Now: write → stamp → **commit** per record, and
  `stop_crm_zoho_sync` signals + waits instead of cancelling mid-cycle.
- **A3 (P1)** — the broker approval path never wrote state back, so under enforcement every
  approval minted another duplicate and nothing converged; and nothing deduped the queue.
  Now: the handler shares `apply_push_result` with the inline path, and the gate skips
  enqueueing when an identical `(action, target)` is already pending.
- **A4 (P1)** — no failure ceiling: poison rows starved both oldest-first queues forever.
  Now: `attempts`/`last_error`/`next_attempt_at` on all three push queues (migration 145,
  edited in place — still unapplied), exponential backoff, a give-up threshold counted in
  `pushed.given_up` and logged at ERROR, and a tombstone whose Zoho record is already gone
  counts as success.
- **A5 (P1)** — `POST /crm/sync/zoho` had no reentrancy guard, so overlapping cycles
  double-created. Now a process-wide lock: 409 for a second caller, skip for the loop.
- **A6 (P2)** — activity deletes sync in neither direction while creates do. **Documented as
  an accepted v1 cost** (§7.1) rather than built, with both `apply_zoho_deletes` and
  `activities.delete_activity` stating it; closing one direction alone would be worse.
- Mirror nits taken with them: the "adopt cycle start" prose now matches the code (nothing
  fetched KEEPS the previous watermark), the RFC-1123-vs-ISO `If-Modified-Since` question is
  recorded as an owner pre-flip `curl`, and the pull asks for
  `sort_by=Modified_Time&sort_order=asc` to close the page-shift window.
- **Also, from 26c's verifier** — `import_zoho`'s deal-contact link inserted a literal
  `is_primary = true`, so a deal with a hand-set primary A whose Zoho record names B ended
  up with **two** primaries (the one-primary rule is code, not a constraint). `is_primary` is
  now computed inside the INSERT from `NOT EXISTS (… WHERE deal_id = :deal_id AND
  is_primary)`, which also closes the read-then-write race and stays correct under the
  one-primary seam WS-26c adds.

Done when:
1. `list_leads` **and a deleted-records read function** added to the client; Zoho **write**
   functions exist only in `ingestion/sources/zoho/writer.py` (create/update/delete per
   module), the writer has exactly **one** caller — the sync engine — and every push
   routes through the registered `crm.zoho_*` broker handlers (D-CRM-8). All
   grep-asserted the way §9 WS-26a's seam checks are.
2. Backfill `POST /crm/import/zoho` per §7.1 behind `admin:access:manage` (see §4's
   warning — `integrations:use:*` is member-wide); `dry_run` writes nothing (asserted);
   statuses auto-created idempotently — **pinned statically against the statement text**
   (`ON CONFLICT` present on the status upserts, the `test_crm_migration.py` technique):
   `_crm_fakes.py` models no `ON CONFLICT`, so a fake-only "second run creates 0" is a
   mirror agreeing with itself.
3. The sync engine implements §7.1's **seven** sync bullets: broker-gated dirty-push
   (native create acquires `zoho_id`), incremental pull with **persisted `crm_sync_cursors`**,
   **`crm_zoho_tombstones`** written inside the native delete transaction and pushed as
   Zoho deletes, Zoho deletes applied natively with loud counts, record-level LWW with a
   per-cycle conflict count, **echo suppression** (pull-applied writes never set
   `zoho_dirty`; a two-cycle fake-client test converges to zero pushes), vocabulary
   down-only. The migration (next free number, 145 free at audit time) carries the two new
   tables + the dirty columns under 26a's static idempotency fence.
4. `CRM_ZOHO_SYNC` ships OFF, and the OFF-state assertion **fails against today's tree**:
   with the flag off, the gateway lifespan registers no CRM sync loop AND a native write
   sets `zoho_dirty` while leaving `zoho_synced_at` NULL (both asserted). The manual cycle
   endpoint works without the flag.
5. `tests/unit/test_crm_zoho_import.py` + `tests/unit/test_crm_zoho_sync.py` cover
   mapping, idempotency, owner-mapping, dirty-push, LWW both directions, tombstones, echo
   suppression, and the single-writer + broker seams — against a fake client, no network.
6. **Both** stale mirrors are updated in the same PR: the WS-1 row's *"There is no Zoho
   write path anywhere in the repo to route through the broker…"* sentence, and the §4
   registry row's *"the CRM never adds one"* clause (already softened 2026-08-05; finish
   it when the writer lands).
**Enabling the flag, the first backfill, and any hand-run cycle against prod Zoho+DB are
registered in §6 — the sync WRITES the live Zoho tenant.**

⚠️ **Owner pre-flip check, one `curl` (unverifiable from the repo).** The client sends
`If-Modified-Since` in **RFC 1123** (`Tue, 01 Jan 2026 00:00:00 +0000`) — the form the
existing `_list_module` has always used. Zoho's v2 docs also describe an **ISO-8601**
`If-Modified-Since`, and the two are not interchangeable: if the tenant ignores an
unparseable header it returns EVERYTHING, and the pull is silently full rather than
incremental (correct, idempotent, and far more expensive) — while if it errors, the pull
fails loudly and is caught. Before the first enable, confirm which form the tenant honours:

    curl -sD- -o/dev/null "$ZOHO_API_DOMAIN/crm/v2/Accounts?per_page=1" \
      -H "Authorization: Zoho-oauthtoken $TOKEN" \
      -H "If-Modified-Since: $(date -R -d '1 hour ago')"

A `304` (or a short body) means RFC 1123 is honoured. A full first page means it is being
ignored — switch the format in `client._with_modified_since`, which is the single place
both readers build it. ⚠️ `.env.example` cannot
document the new flag (plan-guard protects it); the PR body must carry the var for the
owner. Also owed by this ticket: add `CRM_ZOHO_SYNC` (and `CRM_AUTO_LEAD`) to
`.claude/hooks/plan-guard.mjs` OWNER_GATES per that file's own "§6 changes update
OWNER_GATES in the same PR" rule — noting `.claude/` is untracked, so this lands on the
box-side copy, not in the PR.

### WS-26c — UI (+ the API addendum the surfaces need) · ✅ **BUILT 2026-08-05**
*(Audited GO-NARROWED 2026-08-05; blockers folded in below. Landed on branch
`ws-26c-crm-ui` as `workbench/control_plane/src/app/crm/{page.tsx,components/,lib/}` +
`src/app/api/crm/[...path]/route.ts`, the three registration edits in
`src/lib/{nav,access,centers}.ts` with `CenterApp` re-typed so `live ⇒ href` is a compile
error, and the gateway addendum
`apps/services/gateway/gateway/routes/crm/deal_contacts.py` + `core.link_deal_contact` /
`core.project_joined` / `core.reject_null_on_defaulted` / `core.lead_name_is_derived`.
Fenced by 103 new vitest cases and 41 new pytest cases (the four `test_crm_*.py` files go
191 → 232); **zero DB, zero network.** Adversarial review returned REQUEST-CHANGES on the
first pass; all seven findings repaired in the same branch — see C8–C10 in §8.
**Built, not deployed:** migrations 144 and 145 have still not been applied anywhere.
Merged into `ws-26-crm-app` alongside 26b on 2026-08-06 — every resolution there was the
union of both slices, so 26b's Zoho fields and 26c's join/null-guard fields coexist on the
same `Entity` and both guards run on every write.)*
Notes: until an admin grants `feature:crm`, the UI is visible to owner/admin only (§5).
**Migration 144 has not been applied anywhere**, so live rendering, drag persistence and
deep links are **owner-verified after the migration applies** — the agent builds and
tests against fixtures and must not reach for a DB. Registration is **three** frontend
files, not five — `FEATURES` and the `feature_catalog` row already shipped with 26a.
The `test_centers_registry_matches_the_feature_vocabulary` invariant reads only each
Center's `feature:` field — it CANNOT detect a mistake in the apps[] flip, so don't cite
it as a fence; the real fence to add is `live ⇒ href` on `CenterApp`.
Done when:
1. `nav.ts` pane, `access.ts` `HREF_FEATURES` `["/crm","crm"]`, and the `centers.ts`
   Sales "Pipeline (Zoho CRM)" entry flipped to `{label:"CRM", status:"live",
   href:"/crm"}` — plus a `live ⇒ href` invariant (type-level or a small test) so a live
   entry without an href cannot ship.
2. **API addendum (gateway, small):** deal-contacts endpoints exist
   (`GET /crm/deals/{id}/contacts`, `POST`/`DELETE .../contacts/{contact_id}` with
   `is_primary` handling enforcing one primary per deal — closing the "by convention
   only" gap 26a recorded), and deal list/pipeline payloads carry `organization_name`
   via LEFT JOIN (kanban cards must not client-side-join a ≤100-page org list).
3. **Review residuals closed, each with a test:** `?status_id` on contacts/organizations
   → 422 (not silently ignored); an explicit body `null` on a defaulted NOT NULL column
   (`source`, status `color`) → 422 (not a driver 500); PATCH preserves a hand-edited
   `lead_name` (re-derive only when the name fields change AND `lead_name` wasn't
   custom-set).
4. The four surfaces + convert modal render through the BFF proxy against fixture data;
   kanban drag issues the `PATCH`; `?deal=` deep link opens the sheet (fixture-level
   assertions; live behavior owner-verified post-migration).
5. Pure helpers tested in colocated vitest (`src/app/crm/lib/*.test.ts`); `tsc` and
   `npm test` green; the gateway addendum's tests join the named `test_crm_*.py` files.

### WS-26d — Integrations · 🟢 AGENT-SAFE except the flag
**Audited 2026-08-06 → GO-NARROWED.** The ticket as written bundled four independent
things behind one done-when, and three of them were not dispatchable: the email-thread
join had no testable, caller-scoped done-when; `CRM_AUTO_LEAD` named no hook to attach to;
and the write tools named no confirm/risk mechanism. So the slice was narrowed to the two
halves that were fully specified.

**BUILT 2026-08-06 (branch `ws-26d-agent-crm`):**
1. **`agent-crm` — the READ half.** `apps/agents/agent-crm/` (`crm-assistant`,
   `runtime:"maf"`, `OpenAIChatCompletionClient`, `X-CC-Agent`) on the
   `agent-email-assistant` template **including its `_headers()` fail-closed identity
   rule**; four read tools — `search_crm`, `get_pipeline`, `get_record`, `get_timeline` —
   each a thin wrapper over the existing `/crm` routes carrying the caller's
   `X-User-Email`, so the agent inherits the route's authorization instead of holding a
   second opinion about it. Registered in `_KNOWN_AGENTS`, `_AGENT_REGISTRY` and
   `agent_registry.json`; `build_agents()` constructs one native MAF `Agent`. Read-only is
   a property of the transport (`_ALLOWED_METHODS = {"GET"}` checked in the one round-trip
   helper), asserted three ways in the test file: behaviourally (a POST raises before the
   request is built), structurally (no verb helper exists), and by observation (every call
   the four tools make is a GET).
   ⚠️ **Diff review found the method allowlist was only half the boundary, and the other
   half was missing.** `record_id` went into the path unvalidated, and httpx removes `..`
   segments before sending, so `get_record("deals", "../../admin/members")` issued
   `GET /admin/members` carrying the internal bearer and the caller's `X-User-Email`;
   `/admin/members/{email}/access`, `/email/messages`, `/whatsapp/chats` and
   `/memory/agent:<name>` were all reachable. Identity was preserved, so it was scope
   escape rather than privilege escalation — but "cannot see outside the CRM" is a claim
   this spec, the `_AGENT_REGISTRY` description and `apps/AGENTS.md` all make. Fixed by
   `_record_uuid`, which validates AND canonicalises at the same layer `_entity_slug`
   validates the entity (every CRM table keys on `CAST(:id AS uuid)`, so a non-UUID id is
   never legitimate — which also stops a hallucinated `"ACME-123"` producing a driver 500).
   The trigger is what this slice creates: `record_id` is LLM-filled and the model's
   context is counterparty-authored CRM text, so a system-prompt rule was the wrong control
   class. **A future tool must route path segments through `_entity_slug`/`_record_uuid`** —
   an AST fence over every `/crm` f-string enforces it, and it caught a deliberately
   half-applied mutation during review.
2. **WhatsApp `_KNOWN_SYSTEMS` gains `"crm"` — PARSE-ONLY**, per §6. Nothing writes
   `wa_contacts.entity_ref` yet and the `crm` context block stays `None`; both halves are
   pinned by test so "we added the constant" is never mistaken for "the link works".

**Build-time decision, this slice:** `config.json` declares `sharing.shareable: false`,
matching both sibling assistants. Inert today (`is_shareable()` has no runtime consumer),
but it is the safe default to record now rather than to discover later: when sharing is
wired, `assert_can_run_agent_in_session` folds on `can_run_agent` — i.e. `agents:run:*`,
which every member holds — and **never on `feature:*`**, while `feature:crm` is
`is_default false` (migration 144). A shareable CRM agent would therefore put CRM records
into a transcript a non-`feature:crm` member can read. Revisit together with D-CRM-3's
`group:` grants at WS-14, not before.

**STILL OPEN, and why** (audit doc-blocker IDs — distinct from §8's build-time decisions
B1–B6, which are a different numbering):
- **B3 — email-thread timeline join.** Needs a testable, caller-scoped done-when: which
  mailbox is joined, whose access decides it, and what the join returns for a CRM record
  whose `email` matches nothing. D-CRM-5 says read-time address join, no link table; it
  does not say what that means for a colleague who cannot read the mailbox it joins.
- **B4 — `CRM_AUTO_LEAD`.** Names no hook. The settings field is deliberately NOT added:
  a flag with nothing behind it is worse than no flag. Owes the named email-app seam it
  attaches to, plus the regression that proves its OFF-state is byte-identical.
- **B5 — write tools** (`create_lead`, `update_deal_status`, `log_activity`,
  `convert_lead`). Owes a NAMED confirm/risk mechanism — `request_confirmation` on the
  tool, the Action-Broker gate, or both, and which one covers which verb. "Confirmation-
  gated fail-closed" is a property, not a mechanism.
- **B7 — test-file naming** for those slices, so the §10 verify line can be written before
  the code rather than after.
- **B6/D-CRM-9 — RESOLVED 2026-08-06.** The push-queue question ("do agent writes reach
  Zoho like human writes?") is owner-answered: yes, identically. See §8 D-CRM-9. It no
  longer blocks the write half; B5 still does.

**Flipping `CRM_AUTO_LEAD` = OWNER-GATE (§6)** — and per D-CRM-9 the ON-state queues each
auto-created lead for push into the live Zoho tenant.

### WS-26e — Cutover + retirement · 🔴 OWNER-GATE end-to-end
Final import + parity report; §6 consumers repointed; §7.4 inventory retired; Zoho refresh
token revoked (executes part of WS-2); spec status header + board row updated in the same
PR (R4).

---

## 10. Verification

    # WS-26a + WS-26b + WS-26c — all six CRM files plus the access pair:
    uv run pytest tests/unit/test_crm_zoho_import.py tests/unit/test_crm_zoho_sync.py \
                  tests/unit/test_crm_routes.py tests/unit/test_crm_pipeline.py \
                  tests/unit/test_crm_convert.py tests/unit/test_crm_migration.py \
                  tests/unit/test_org_access_control.py \
                  tests/unit/test_org_access_enforcement.py -q

    # WS-26d read half — the agent, the parse-only WhatsApp constant, AND the
    # four registration fences the slice leans on. Run all seven together: a
    # new agent's failure mode is not a broken tool, it is silently never
    # loading, and only the fences can see that. test_crm_agent.py alone goes
    # green on an agent that no run path can reach.
    uv run pytest tests/unit/test_crm_agent.py \
                  tests/unit/test_agent_gateway_identity.py \
                  tests/unit/test_whatsapp_context.py \
                  tests/unit/test_agent_manifest.py \
                  tests/unit/test_orchestrator_registration.py \
                  tests/unit/test_resolve_agent_for_run.py \
                  tests/unit/test_default_deny_auth.py -q

    cd workbench/control_plane && npx tsc --noEmit && npm test

⚠️ The WS-26d block takes **~5 minutes**, nearly all of it in `test_agent_manifest.py`
(it parametrises over every first-party `config.json` and imports the real
orchestrator resolver). It is not hung — do not interrupt it and do not drop the
slow file to make the command feel faster. What each fence catches, since a
green run tells you nothing about why they are listed: `test_agent_manifest.py`
— the new `config.json` must resolve the same tool surface the executor
injects, and its `sharing.instancing` must stay `shared` or the
`PENDING_INSTANCE_MIGRATION` canary fires (declaring `personal` would
re-partition memory with no migration behind it); `test_orchestrator_registration.py`
— the `_AGENT_REGISTRY` shape that makes an agent delegatable at all;
`test_resolve_agent_for_run.py` — that a stored session name still resolves;
`test_default_deny_auth.py` — that no route escaped the app-wide auth guard.

**Owner-verified — migrations 144 and 145 are applied on prod as of 2026-08-06** (none of
this can be checked from the repo, and WS-26c deliberately did not reach for a database):
the board renders real lanes in `position` order with their ₹ totals; dragging a card
persists and the card stays put on reload; `?deal=<id>` opens the sheet on a real record and
Back closes it; the convert modal's matches are the ones the server picks; a lost move is
refused without a reason and accepted with one.

⚠️ Never `uv run pytest tests/unit/` bare — whole-directory collection hangs on the Windows
box against the live DB. Name the files. The pr-check gates that bind: ruff
`--select F821,F601,F602,F502,F7,B006` (blocking), xenon max-absolute F (blocking),
frontend tsc + vitest (blocking).
