# SaaS multi-tenancy — selling CommandCenter to other companies

**Status:** Architecture of record (owner-requested 2026-08-08) · **Owner:** vjvarada ·
**Supersedes:** `tenancy_and_visibility.md` §1 and §6 · **Verified against code:** 2026-08-08,
working tree at `b09093a`

> **This document re-takes a decision that was deliberately taken the other way.**
> `tenancy_and_visibility.md` §1 (owner-answered 2026-08-03) set the tenant boundary at
> **the deployment** — one VM, one database, one credential set per customer — and §6 put
> row-level multi-tenancy, an org switcher, and multi-org users explicitly out of scope.
> That document's own §6 states the procedure: *"If any of these is ever wanted, the
> correct move is to re-take the §1 decision first, in this document, with a date and a
> reason — not to build one of them as a side effect of an app ticket."*
>
> **The reason: the business model changed.** CommandCenter is being sold to external
> customers, priced **per module, per user, per month**, plus metered AI. That price point
> and one-VM-per-customer are arithmetically incompatible (§1.4). This document is the
> re-take. `tenancy_and_visibility.md` §1/§6 are amended to point here; **everything else
> in that document — the visibility ladder in §3, the project-grant decision in §4, the
> gap table in §5 — survives unchanged and is still binding.** Tenancy and visibility are
> different axes: tenancy is *which company*, visibility is *who inside that company*.

**Purpose.** Answer four owner questions with decisions, not options:

1. What is the tenant boundary, and how does the system scale? (§1)
2. How are modules sold and enforced per company? (§2)
3. How is LLM access resold and metered? (§3)
4. How are accounts, subscriptions and billing managed? (§4)

§5 is the phased plan and §6 is what must be fixed **before the second tenant exists at
all** — those are correctness blockers, not features.

---

## 0. What already exists (measured 2026-08-08)

Read this first. Three of these findings are what make the recommendation below cheap
rather than a rewrite, and one is what makes it currently unsafe.

| Fact | Anchor | Why it matters |
|---|---|---|
| **One engine, one session factory, one `get_db()`** on the gateway **request path**, plus **six enumerable non-request paths** (§0.1) | `packages/acb_common/acb_common/db.py:107-136`; `tests/unit/test_db_engine_seam.py` fails the build if a new `create_async_engine` appears outside its allow-list | **The single most important finding.** Tenant scoping installs at a *named, bounded* set of connection sites, not at 3,000 query sites. ⚠️ **Not literally one — read §0.1 before quoting "one seam".** §1.3 |
| **`EffectiveAccess.intersect()` already exists** and is already used to narrow an agent's access to its member's | `packages/acb_auth/acb_auth/permissions.py:366-374` | Module entitlements are an intersection with a mask. The mechanism is already written and already tested. §2.4 |
| **`/v1/chat/completions` is the single LLM choke point**, and `_emit_usage()` already computes tokens + cache stats + USD cost per call, including for streamed responses | `apps/services/gateway/gateway/routes/v1_compat.py`; `packages/acb_llm/acb_llm/client.py:552-612`, rebuilt-from-chunks path at `v1_compat.py:563-573` | Reselling AI is ~4 additions to a seam that already meters. It is not a new subsystem. §3 |
| **`organization_id` is on 3 of 143 tables** and is read by **zero** authorization decisions | `130_org_access_control.sql:56,86`; `138_…sql:42`; `tenancy_and_visibility.md` §1.1 | The retrofit is 140 tables — but see §1.3 for why that is a generated migration, not 140 tickets |
| **`provider_keys` is keyed `provider TEXT PRIMARY KEY`** — one key per provider for the whole box | `infra/postgres/08_provider_keys.sql:6-7` | Must become `(organization_id, provider)` before a second tenant. §6 |
| ⚠️ **Integration credentials reach agents through process-global `os.environ`**, and the code says so itself: *"`os.environ` is process-global, so under concurrent [runs]…"* | `apps/services/orchestrator/orchestrator/executor.py:4335-4411` (write at `:4388`, restore at `:4409`) | **This is the one hard blocker.** In a pooled process, tenant A's Zoho token is visible to tenant B's concurrently-running agent. §6.1 |
| **`require_llm_api_auth` accepts one shared box-wide token** (`LITELLM_MASTER_KEY` or the internal token) | `packages/acb_auth/acb_auth/deps.py:448-472` | There is no per-customer attribution at the LLM layer today. §3.2 |
| **Roles, permissions, per-user overrides, feature catalog, groups, invites, audit — all shipped** | `130_org_access_control.sql`, `packages/acb_auth/`, `routes/admin/` | The *intra*-company model is done and good. This document does not touch it. |

Scale of the tree, for cost estimates below: **156 migrations · 143 tables · 209 gateway
Python files · ~142k Python LOC · ~149k TypeScript LOC.**

### 0.1 The connection inventory — correction, 2026-08-08

> ⚠️ **The first draft of this document said "one engine, one `get_db()`" without
> qualification. That was overstated and is corrected here.** It is true of the gateway
> request path and false of the process as a whole. An implementer who took the
> unqualified claim at face value would bind the tenant in `get_db()`, see the request
> path work, and ship six unbound connection paths.

Every path that opens a database connection, measured repo-wide:

| # | Path | Driver | Carries tenant data? | Tenant binding needed |
|---|---|---|---|---|
| 1 | `acb_common/db.py` — the shared async seam | SQLAlchemy/asyncpg | **Yes** — the whole request path | `SET LOCAL app.tenant_id` from the session |
| 2 | `email_ingestion/scheduler.py:160,545,578` | SQLAlchemy | **Yes** | Per-run binding from the job's org. Allow-listed in the seam test as *"separate process; per-run engines"* |
| 3 | `email_ingestion/inbound.py:271` | SQLAlchemy | **Yes** | Per-call binding. Same allow-list entry |
| 4 | `acb_graph/db.py:32` — entity graph | SQLAlchemy **sync** `create_engine` | **Yes** | Binding required. ⚠️ **The seam test only inspects `create_async_engine`, so this file is unguarded by it** |
| 5 | `acb_llm/key_store.py:83-108` | raw `psycopg` | Provider keys | Becomes per-org (§6.3) |
| 6 | `acb_llm/model_config.py:52-76` | raw `psycopg` | Model config | Becomes per-org (§6.3) |
| 7 | `acb_common/org_settings.py:55-81` | raw `psycopg` | Org settings | Already org-shaped; must bind |
| 8 | `acb_memory/mem0_client.py:99` | hands a conninfo to **Mem0's own** pgvector client | **Yes** — all memory | Binding must reach Mem0's connections, or memory is scoped by the scope string alone |

**This makes RLS more important, not less — and it is the reason to prefer RLS over
application-level filtering or `search_path`.** A policy is enforced by the *server*,
so it covers paths 4–8 no matter which driver opens them and no matter what any
future package forgets. And it **fails closed**: with `app.tenant_id` unset,
`current_setting('app.tenant_id', true)` is NULL, `organization_id = NULL` is NULL, and
the query returns **zero rows**. An unconverted path breaks loudly in testing instead of
silently serving another tenant's data in production.

**Consequences for Phase 1 (§5), which are now explicit acceptance criteria:**

1. All eight paths bind a tenant. Paths 2–4 bind from the **job's** org, not a session.
2. **Extend `test_db_engine_seam.py` to `create_engine` as well as
   `create_async_engine`** — path 4 exists today precisely because the ratchet does not
   cover the sync call.
3. Add a companion ratchet for **`psycopg.connect`**, with the same allow-list-with-a-reason
   discipline. Paths 5–7 were invisible to the existing test.
4. **Mem0 (path 8) is the genuinely awkward one** — the connection is opened by a
   third-party library from a conninfo string. Either bind via connection options in the
   conninfo, or give Mem0 its own tenant-scoped database role per tenant, or accept that
   memory isolation rests on the scope string and pin that decision here. **Do not leave
   it undecided.**

---

## 1. DECISION — the tenant boundary is a ROW, and the deployment is a placement

> ### `Tenant = organization_id, enforced by Postgres RLS at the connection seam.`
> ### `Deployment = a placement decision (region / tier), not a tenant boundary.`
> *(owner-requested 2026-08-08)*
>
> Standard customers are **pooled**: one app fleet, one database, isolation enforced by
> the database itself. A dedicated database or a dedicated stack is a **priced tier** for
> customers who ask for it — the same code path, a different row in the tenant catalog.

### 1.1 The question the owner asked, answered directly

> *"Should we spin up new containers with a completely different database for each
> customer so that everything is isolated and separate?"*

**No — not as the default.** Do it for the handful of customers who pay for it.

The instinct is right about the *goal* (a customer must never see another customer's
data) and wrong about the *mechanism*. Container-per-customer buys isolation against a
threat that is not the real one, at a cost that breaks the price point.

**The real leak vector in this system is the application, not the database engine.**
CommandCenter's dangerous surfaces are an agent with broad tool access, a missing
predicate in one of 209 gateway files, a prompt injection arriving through an ingested
email, and process-global credentials (§0). A separate Postgres container stops none of
those. A tenant-scoped connection that the *database* refuses to widen stops the first
two, and per-run credential scoping (§6.1) stops the fourth. Spend the isolation budget
where the leaks actually are.

### 1.1a "One database for everyone" — where pooled systems actually get their safety

Owner question, 2026-08-08: *isn't it dangerous that Google Workspace keeps every
organization in one database?* Recorded because the premise contains a category error
that is worth fixing permanently, and because the correction produces a Phase-5 item this
document was missing.

**First, the premise.** Workspace is not "one database" in any physical sense. It is **one
logical namespace, physically sharded by customer across thousands of machines** —
Spanner and Colossus, with customer/domain as the partition key. *"Pooled" is a statement
about the schema, not about the hardware.* One customer's data occupies its own contiguous
key range on its own machines; it is simply addressed through one logical system rather
than N administratively separate ones. That is exactly what §1.8a's distribution-key
discipline buys, in miniature.

**Second, the honest part: yes, pooling concentrates consequence.** A single
authorization bug in a pooled system is potentially every customer, where in a silo it is
one. That is real, and no amount of architecture argument makes it not real.

**Third — and this is the load-bearing observation — Google's safety does not come from
its storage topology. It comes from two layers deliberately built because the storage is
pooled:**

1. **One central authorization service that every product must ask.** Zanzibar stores
   ACLs as `user U has relation R to object O` tuples and answers permission checks for
   Drive, Docs, Calendar, Photos, Maps, YouTube and Cloud — **trillions of ACLs, millions
   of checks per second, sub-10 ms p95, >99.999% availability**, published in Google's
   2019 paper. No product re-implements access control; there is exactly one place to get
   it right, and it cannot be forgotten because there is no other way to answer the
   question.
2. **Per-customer encryption keys underneath.** Google's storage layer splits data into
   chunks and encrypts each with keys **separate from those used for other customers** —
   and separate even from other chunks of the same customer's data. Pooled storage is
   therefore not pooled *plaintext*: a compromise at the storage layer does not yield
   readable cross-tenant data.

> **The transferable rule: safety in a multi-tenant system comes from a single
> un-forgettable enforcement point plus a layer beneath it that fails safe — not from how
> many database processes are running.** Silo is one way to buy a weak version of that
> guarantee; a policy the database enforces is a stronger version, and it is the version
> that survives a developer forgetting.

**What this changes in this document.** RLS (§1.3) is CommandCenter's Zanzibar-analogue at
its scale: one enforcement point, on the server, that no route can forget. **The second
layer is missing and is now a Phase 5 item:**

> **Per-tenant envelope encryption for the sensitive columns** — integration credentials,
> provider keys, message bodies, transcripts — with a per-tenant DEK wrapped by a master
> KEK. It makes a raw storage or backup compromise tenant-scoped rather than global, which
> is the specific residual risk pooling introduces and the only one silo genuinely
> answered. **Retrofitting encryption to populated columns is materially harder than
> adding it at rest-write time**, so if any of these columns are being touched during
> Phase 1, do it then instead.

**What it does not change.** The comparison in §1.4 stands: silo shrinks one category of
bug, does nothing about the categories that cause most real breaches (session and
credential handling, SSRF, dependency compromise, a phished admin, an exposed backup), and
adds one of its own — **wrong-database routing, plus N versions of the access-control code
in production** (§1.4). Concentrated consequence is a real cost, paid for with a
lower probability of the bug occurring at all.

### 1.2 How the companies you named actually do it

The pattern is consistent across all of them, and it is the opposite of
container-per-customer:

| Company | Tenant boundary | Deployment boundary |
|---|---|---|
| **Salesforce** | `OrgId` column on shared tables; one shared, metadata-driven schema serving 150k+ tenants. The canonical proof that pooled scales. | Regional "instances"/pods. A customer is *placed* on a pod; they do not get one. |
| **Microsoft 365 / Entra** | Entra **tenant ID**. Users, licences and policy all key off it in a shared directory service. | Regional scale units and forests. Dedicated stacks exist only as **sovereign/government clouds** — top of the price list, not the default. |
| **Google Workspace** | Customer ID / verified domain. Gmail, Drive and Calendar are massively pooled systems; your company's data is a partition key, not a server. | Data-residency *policy* on a pooled fleet (Assured Controls), not a per-customer deployment. |
| **Zoho** | Pooled per data centre. The customer's choice is *which DC* — US, EU, IN, AU. | The DC is the placement. Zoho One's per-module licensing (§2) rides on top of that pooled base. |

**The rule they all follow:** *the tenant is a row-level concept; the deployment is a
region/tier concept.* Nobody at scale gives a 10-seat customer their own database,
because the marginal cost of a small customer must be near zero or the SMB tier cannot
exist.

The industry names these shapes **pool / bridge / silo** (AWS's SaaS terminology). The
2026 consensus for B2B SaaS is: **pool for the standard tier, bridge or silo for
enterprise customers who pay for it.**

### 1.3 Why this is affordable HERE — the seam that changes the arithmetic

`tenancy_and_visibility.md` §1.2 rejected row-level tenancy on the grounds that it would
*"put a `WHERE organization_id = ?` on 111 tables and every query in the gateway."*
**That objection is wrong, and the reason is `acb_common/db.py`.**

Because the connection sites are a **bounded, named set of eight** (§0.1) rather than
3,000 query sites, tenancy installs at those eight plus three structural changes — and
**zero existing `SELECT`/`INSERT` statements are rewritten**:

**(a) One migration, generated — not 140 hand-written ones.**
```sql
ALTER TABLE <t> ADD COLUMN organization_id UUID
    NOT NULL DEFAULT current_setting('app.tenant_id', true)::uuid
    REFERENCES organization(id) ON DELETE CASCADE;
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;   -- ← without this the owner bypasses it
CREATE POLICY tenant_isolation ON <t> USING (
    organization_id = current_setting('app.tenant_id', true)::uuid
);
CREATE INDEX <t>_org_idx ON <t> (organization_id);
```
The column **default** is what means `INSERT` statements do not change either. The
existing single org backfills every row.

**(b) One seam edit.** `get_db()` binds the tenant onto the session:
```python
async def get_db(tenant_id: str | None = None) -> AsyncSession:
    s = get_session_factory()()
    await s.execute(text("SET LOCAL app.tenant_id = :t"), {"t": tenant_id or _ctx_tenant()})
    return s
```
> ⚠️ **`SET LOCAL`, never `SET`.** The pool recycles connections across requests
> (`pool_size` + `max_overflow`, `db.py:114-120`). A session-scoped `SET` survives the
> connection's return to the pool and becomes a cross-tenant read on the next borrower.
> `SET LOCAL` is transaction-scoped and resets on commit/rollback. This is the single
> highest-consequence line in the whole migration and it needs its own test.

**(c) One role change.** The app must connect as a **non-owner, non-superuser** role.
Postgres RLS is bypassed by superusers, by `BYPASSRLS`, and by the table owner unless
`FORCE ROW LEVEL SECURITY` is set. Migrations keep running as the owner; the gateway
gets `acb_app`.

**(d) One build-failing test**, in the spirit of `test_db_engine_seam.py`: enumerate
`pg_tables`, assert every application table has `organization_id`, `FORCE` RLS, and a
policy. A table added tomorrow is covered without anyone remembering — the same
by-construction discipline root `AGENTS.md` constraint 10 already applies to auth.

That converts a 6-month rewrite into roughly **3–4 weeks**. It is still the largest
single piece of work in this document, and §1.5 lists what it does *not* cover.

### 1.4 Why container-per-customer fails this business — priced at 10–50 seats

> **Owner input, 2026-08-08: every customer is a company of 10–50 users**, not an
> individual. This section was first written against a 10-seat single-module customer and
> **its lead argument does not survive that input.** Corrected here rather than quietly
> left standing, because the corrected version is what makes the recommendation honest.

**What no longer holds — the infrastructure-cost argument.** A 25-user company on three
modules at ~₹500/user/module is ~₹37,500/month (≈$450). A VPS able to run a full stack is
~$30–40/month — roughly **8% of revenue**. That is affordable. The original claim that
*"the SMB tier does not exist under this model"* was priced for a customer a quarter this
size and **is withdrawn.** At this ACV, dedicated infrastructure is not what breaks.

**What holds, and holds harder — the cost that scales in people, not servers.**

- **156 migrations × N customers × every deploy.** This is the binding constraint and it
  gets *worse* as the customer base grows, because it is linear in N and paid by a small
  team every week. At 20 customers, deploy babysitting, per-box backup verification and
  N incident surfaces realistically consume **half an engineer** — permanently.
- **N boxes means N versions of your access-control code in production.** A migration that
  fails on customer 14 leaves customer 14 running the old permission check. With
  `130_org_access_control.sql` and its successors defining who can see what, **version
  skew is a security defect, not an ops annoyance** — and it is a defect that pooled
  cannot have.
- **Self-service signup is impossible.** Onboarding becomes DNS, TLS, systemd units and
  credential sets — `tenancy_and_visibility.md` §1.2 priced it at *"roughly a day of
  owner-gated work and a permanent second thing to patch."*
- **Cross-tenant product features need fan-out across N databases** — the Operator Console
  (§4.1), aggregate usage, benchmarks, a shared agent marketplace.

**The crossover, stated as a number so the decision is checkable.** Silo's cost is
**linear in customers**; pooled's is a **one-time 4–5 weeks** (§5 Phase 1). They cross at
roughly **8–12 customers**. Below that, silo is genuinely cheaper *and* faster to revenue.
Above it, silo compounds. See §5.1 for what to do with that.

**Where silo is still right:** a customer with a genuine regulatory or contractual
requirement, paying for it, onboarded by hand — and the first handful of customers, as a
deliberate bridge (§5.1). Price it. Don't build the product on it.

### 1.4a The WordPress analogy — why hosting and SaaS answer this differently

Raised by the owner 2026-08-08, and worth recording because the intuition is common,
reasonable, and points the opposite way once followed through.

Hostinger gives every WordPress install its own database. **That is correct for
Hostinger and irrelevant to CommandCenter, because Hostinger is a host, not a SaaS.**
The determining question is:

> **Who controls the schema and the upgrade cadence — you, or the customer?**

| | Customer controls the app | **You** control the app |
|---|---|---|
| Examples | WordPress on shared hosting · self-hosted Odoo · Jira Data Center | Salesforce · Google Workspace · Slack · Zoho · **CommandCenter** |
| Consequence | The host cannot know or migrate the schema; customer A may run WP 5.8 while B runs 6.4; the customer installs arbitrary plugins that alter tables | You ship one version to everyone; customers cannot fork the schema or install plugins into your Postgres |
| Correct model | **Database per install — mandatory** | **Pooled — the norm** |

**WordPress's own answer, when WordPress is the SaaS, is not database-per-customer.**
WordPress Multisite puts every site in **one database**, adding a per-site *table prefix*
(`wp_2_`, `wp_3_`, …) over a set of shared network-wide tables — users among them. And at
WordPress.com scale the fix was **hash-based sharding into 16 / 256 / 4096 shards**, not a
database per site.

Two things follow, and both support this document's decisions:

1. **Same software, different business model, different answer.** Hostinger silos because
   the customer owns the install. WordPress.com pools because WordPress.com owns it. You
   own CommandCenter. You are on the WordPress.com side of that line, not Hostinger's.
2. **Multisite's per-site table prefix is schema-per-tenant in a different costume — and
   it hits exactly the failure §1.8 predicts.** Per-site table sets multiply the catalog
   (a 1,000-site network is tens of thousands of tables), which is *why* large networks
   shard. That is independent real-world confirmation of §1.8's catalog-pressure argument,
   arriving from the very example that seemed to argue the other way.

### 1.5 The target architecture, concretely

**Three tiers, one codebase.** The tenant resolver returns `(organization_id,
connection_target)`; everything downstream is identical.

| Tier | Data | Compute | Onboarding | Who |
|---|---|---|---|---|
| **Standard (pool)** | Shared Postgres, RLS | Shared fleet | Self-service, seconds | ~95% of customers |
| **Dedicated data (bridge)** | Own Postgres DB (or own schema) | Shared fleet | Semi-automated, hours | Compliance-sensitive mid-market |
| **Dedicated stack (silo)** | Own everything | Own VM/namespace | Manual, days | Enterprise, regulated, data residency |

**The tenant catalog.** A small **control-plane database, separate from tenant data**,
holding: `organization`, `tenant_placement` (which shard/DB/region), billing, entitlements
and usage. It must be readable *across* tenants — which is exactly what RLS is designed to
prevent — so it does not belong in the pooled tenant DB. It also has a different backup
and retention profile, and keeping revenue data out of the tenant DB means a tenant-side
compromise does not expose every customer's contract. (Microsoft's sharded-multitenant
reference architecture calls this the catalog database; it is a standard component, not an
invention.)

**Tenant resolution — subdomain, bound to the session.**
`acme.commandcenter.app` → workbench middleware resolves the slug → the **session** carries
the tenant claim → the gateway reads it from the authenticated identity.

> **Binding rule, extending `user_management_contract.md` rule 10** (*"never take the
> acting identity from a query parameter or request body"*): **never take the acting
> tenant from a header, query parameter or request body either.** The tenant is derived
> from the authenticated session or from a tenant-scoped API key (§3.2), and from nowhere
> else. An `X-Organization-Id` header that the client can set is a one-line
> cross-tenant read. (`multi_user_organization_research.md` §17.3 proposes exactly that
> header — **that proposal is rejected here.**)

**Multi-org users become supported.** `tenancy_and_visibility.md` §6.3 ruled them out
because `app_user.email` is globally unique. For SaaS this must change: partners,
consultants, and *your own support staff* need to be in more than one tenant. The standard
shape (Clerk, Auth0, Slack, Google Workspace all converge on it):

```
user_identity(id, email UNIQUE, name, …)        -- global, one row per human
org_membership(user_id, org_id, status, …)      -- the tenant-scoped membership
```
Today's `app_user` becomes `org_membership`; the email-keyed columns across the schema
(`app_grants.subject`, `apps.owner_email`, `gtd_items.user_id`, `meeting.owner_email`, …)
stay email-keyed and become correct automatically, because RLS already constrains the row
set to one tenant. **That is a second reason to do RLS first** — it makes the identity
split cheap instead of a re-key of 31 columns.

**What is NOT the tenant boundary.** Centers/departments are *inside* a tenant and are
already answered by `tenancy_and_visibility.md` §3 — `private → Center → org`, expressed
as `email | group:<slug> | org`. **That ladder is unchanged and still binding.** A tenant
is not a Center; a Center is never a deployment. Do not introduce a third scoping doctrine
(§3.2's standing rule).

### 1.6 Physical layout at multi-GB per tenant *(added 2026-08-08, owner question)*

Pooling is a **logical** isolation decision. It says nothing about physical layout, and at
several GB per customer the physical layout is a separate design problem that must be
answered whichever tenancy model wins. Answered here so "pooled" is not mistaken for "one
undifferentiated heap".

**Where the gigabytes actually are, measured:**

| Store | Shape | Weight |
|---|---|---|
| **pgvector embeddings** | `email_embeddings.embedding vector(1536)` (`73_…sql:29`), `whatsapp_embeddings vector(1536)` (`111_…sql:31`), `transcript_segment.embedding vector(1024)` (`95_…sql:79`), `entity.embedding vector(1024)` (`01_schema.sql:86`), plus Mem0's own | **Dominant term.** A 1536-dim float32 vector is ~6 KB; with an HNSW index the on-disk cost is roughly double. 100k embedded emails ≈ **1–1.5 GB for one tenant's email index alone** |
| **`agent_blob.content BYTEA`** | Blobs stored **inside Postgres** (`71_agent_blob_store.sql:30`), plus a versioned history table | Grows without bound; the natural first candidate to evict |
| **Email bodies + FTS** | `email_messages` + GIN `to_tsvector` indexes (`72_email_search_fts.sql:31`) | Large, but ordinary relational data |
| **Meeting media** | `meeting_media.artifact_path TEXT` → filesystem (`NOTES_MEDIA_DIR`, `95_…sql:56`) | ✅ **Already outside Postgres.** Good — keep it that way |

> **The reframe that matters:** for most tenants the "multiple GB" is **embeddings and
> blobs, not rows.** Move `agent_blob` to object storage keyed by `<org_id>/…` and the
> relational working set per tenant drops to the hundreds of MB. **Do that regardless of
> tenancy model** — a BYTEA column is the wrong home for file content in any topology.

**What actually constrains a single Postgres — and it is not total size.** Postgres runs
multi-TB routinely; 100 tenants × 5 GB is 500 GB, which is unremarkable. The three real
constraints are:

1. **Working set vs RAM.** One instance with a large `shared_buffers` serves the union of
   all tenants' hot pages better than N instances that each reserve their own and cannot
   lend. This is the single strongest efficiency argument for pooling and it is the one
   that container-per-tenant-on-one-VPS gets exactly backwards (§1.7).
2. **HNSW index memory.** The vector indexes are the memory-hungry part, and a pooled
   index means every tenant's search shares one structure. **This is the one place where
   per-tenant physical separation is worth considering on merit rather than on fear** —
   see the partitioning rule below.
3. **Restore time (RTO).** A multi-TB `pg_restore` is measured in hours. This is a real
   argument for keeping the pooled instance from growing unboundedly, and it is
   independent of isolation.

**Three rules that make pooled work at this data size:**

- **Partition the heavy tables by tenant.** Declarative partitioning on `organization_id`
  for `email_messages`, `email_embeddings`, `chat_message`, `audit_event` and the vector
  tables. Partition pruning means a query for tenant A never touches tenant B's pages —
  most of the locality and noisy-neighbour benefit of separate databases, inside one
  instance. **Use LIST partitions for the few largest tenants and a HASH/default partition
  for the long tail**; one partition per tenant across all tenants recreates the catalog
  pressure that sinks schema-per-tenant (§1.8).
- **Per-tenant logical backup is a required capability, not a tenancy-model side effect.**
  "Restore this one customer to yesterday" must be answerable, and in a pooled instance
  `pg_restore` cannot answer it. Build a per-tenant logical export/import job in Phase 1.
  Note this is the one genuine capability that database-per-tenant gives for free — and
  buying it costs one job, not N databases.
- **Keep an eviction path.** `tenant_placement` (§1.5) is what makes a large tenant
  movable: export, load into its own database, flip the row. **A tenancy model you cannot
  reverse is the actual risk**, and this is the cheapest insurance against picking wrong.

### 1.7 Rejected — one container per organization on the same VPS

Considered explicitly (owner question, 2026-08-08) because it is a different proposal from
one VPS per customer and deserves its own answer. **It is the worst of the three options**,
and this is not a close call:

1. **It fragments the one resource that matters.** N Postgres containers each hold their
   own `shared_buffers`, WAL, autovacuum workers and connection slots, and **cannot lend
   memory to each other**. Twenty containers on a 16 GB box get well under 1 GB of cache
   each; one pooled instance gives the *union* of hot working sets the whole cache. At
   multi-GB tenants with HNSW indexes (§1.6), this is decisive.
2. **It does not deliver the isolation it appears to.** Same kernel, same page cache
   pressure, same disk queue. A tenant running a heavy import still starves the others on
   IOPS. Container boundaries do not partition a shared spindle.
3. **It keeps the entire operational cost of database-per-tenant.** N migration runs, N
   backup jobs, N restore procedures, N monitoring targets, N connection pools — all
   unaffected by whether the containers share a VPS.
4. **It adds a failure mode neither other option has:** one box's resource exhaustion or
   reboot takes down *every* tenant, so the blast radius is silo's ops cost with pool's
   blast radius.

**The honest summary:** dedicated containers only buy something when they are on
**dedicated hardware** — which is the silo tier in §1.5, priced accordingly. On shared
hardware they are ceremony.

### 1.8 Rejected — schema-per-tenant *(the closest alternative; recorded properly)*

This is the strongest option **not** chosen, and it was under-weighted in the first draft.
It deserves a real entry rather than a dismissal.

**What is genuinely good about it:** one Postgres instance, so §1.7's memory-pooling
argument is preserved; `pg_dump -n <schema>` gives per-tenant backup for free; moving a
tenant out later is mechanical; and the isolation story is easier to explain to a
procurement team than an RLS policy.

**Why it still loses, on one decisive property:**

> **RLS fails closed. `search_path` fails open.**
>
> With RLS, an unset or wrong `app.tenant_id` yields **zero rows** — a loud, obvious,
> immediate failure that surfaces in the first test. With schema-per-tenant, a wrong
> `search_path` yields **a complete, valid-looking result set belonging to another
> tenant** — silently, with no error, indistinguishable from correct behaviour until a
> customer reports seeing someone else's data.

Both models concentrate the trust in one per-request binding. They differ entirely in what
happens when that binding is wrong, and for a system where §0.1 shows eight distinct
connection paths, the failure mode is the whole argument.

Two secondary costs: **catalog pressure** — 143 tables × N schemas, where the practical
ceiling is in the low hundreds to low thousands of tenants before `pg_dump`, autovacuum
and query planning degrade — and **migrations run N times** (better than N instances, but
still N, against 156 files today).

**Where it would win, stated so the call can be re-taken:** if the target is a few dozen
large customers rather than many small ones, catalog pressure never arrives, per-tenant
backup matters more than onboarding speed, and the procurement conversation is easier.

> **Tested against the owner's answer, 2026-08-08 — the condition is NOT met.**
> 10–50 users per customer is **mid-market, not enterprise**: it is Slack's, Notion's,
> HubSpot's, Freshworks' and Zoho's core segment, and every one of them is pooled. The
> flip condition needs *few customers*, and 10–50 seats implies the opposite — a customer
> base counted in dozens-to-hundreds, where catalog pressure (143 tables × N schemas) does
> arrive and onboarding speed does matter. **Pooled stands.** Re-take this only if the
> plan changes to topping out at ~20–30 accounts at high ACV, which is a different
> business, not a bigger version of this one.

### 1.8a Greenfield check — which arguments here are design, and which are retrofit

Owner question, 2026-08-08: *would this still be the recommendation if it were not
anchored to what CommandCenter already is?* Recorded because a reader two years from now
must be able to tell **"we chose this"** from **"we inherited this"**, and because the
audit produced two changes to Phase 1.

**Arguments that are pure design — they hold for any greenfield system with this customer
profile, and nothing in them depends on this tree:**

- Pooled over silo for 10–50-seat B2B customers (§1.4). The comparison set — Slack,
  Notion, HubSpot, Freshworks, Zoho — did not inherit anything from us.
- RLS over application filtering, on **fails-closed vs fails-open** (§0.1, §1.8). That is
  a property of the mechanisms.
- Container-per-org on shared hardware being the worst option (§1.7) — resource arithmetic.
- Entitlements ≠ permissions (§2.1), credits not tokens (§3.2), assigned seats not active
  users (§2.2). Three business principles with no code dependency.

**Arguments that are retrofit reasoning, and must not be mistaken for design:**

- *"The seam already exists"* — `get_db()`, `EffectiveAccess.intersect()`, `_emit_usage()`.
  These make the migration cheap. **Greenfield they carry zero weight**, because greenfield
  you simply write the tenant column into the first migration and the whole question
  evaporates.
- **The 4–5 week Phase 1 estimate is entirely a retrofit number.** Greenfield, multi-tenancy
  is roughly three days of schema discipline. ⚠️ **This is the largest single distortion in
  the document:** the pooled-vs-silo debate is expensive *here* only because 143 tables were
  built without a tenant column. It is not evidence that the decision is hard in general.
- **§3.1's "don't add a proxy" is ~60% retrofit.** Greenfield, buying an AI gateway
  (LiteLLM, Portkey, Helicone) versus building metering into the app is close to a coin
  flip. The one argument that survives greenfield is that a separate proxy must **re-resolve
  the tenant**, creating a second boundary to get right, and that it lacks the app context
  (which module, which agent) that per-module margin analysis needs. Buy it if the routing
  and dashboards are worth more than that. **The conclusion is unchanged; the confidence
  should be lower than §3.1 implies.**

**Two things a greenfield design would include that this document did not — both cheap
now, both expensive later, and both therefore added to Phase 1:**

1. **Treat `organization_id` as a distribution key, not just a filter column.** Put it in
   every primary key and every index prefix, and colocate related tables on it. Costs
   nothing today and is the precondition for sharding — Citus and every distributed
   Postgres take tenant-id colocation as their flagship multi-tenant pattern. Retrofitting
   a distribution key after the fact means rewriting every primary key. **Adopt the
   discipline; do not adopt Citus, which is unnecessary complexity at this scale.**
2. **Evaluate an external identity provider for organizations, memberships and SSO**
   (WorkOS, Clerk, Keycloak) rather than growing `app_user` into it. Enterprise B2B
   eventually demands SAML and SCIM, and building those is a tar pit. This is a genuine
   *"greenfield I would not build this myself"* — but note the honest counterweight: the
   shipped RBAC (`org_access_control.md`) is good, and the migration cost may already
   exceed the benefit. **Decide deliberately rather than by default.**

**The argument this document under-weighted, and it is independent of the codebase:**
CommandCenter's agents execute model-generated tool calls over content ingested from
untrusted sources (email, WhatsApp). That is a **materially higher risk profile than
ordinary SaaS**, and it is a real point in silo's favour that §1.1 waved past. It does not
flip the decision — an injected agent already holds its own tenant's data, and RLS blocks
the incremental "read *other* tenants" step at the server — but it raises the bar on two
things that are now non-negotiable rather than merely advisable:

> **No agent ever gets a raw-SQL tool, and no agent-reachable code path can set
> `app.tenant_id`.** The agent must inherit a session already bound by the request or job
> and must never open a connection of its own. If either of those is violated, pooled
> tenancy is not defensible and §1 should be re-taken.

**The one go-to-market risk that no architecture answers:** if two customers are
competitors — plausible when selling manufacturing software from a manufacturer — *"is my
data in the same database as theirs?"* is a procurement question, and *"no, separate
database"* is a far easier answer than explaining a row-level policy. That is a **sales**
argument for the dedicated-data tier (§1.5), not a technical one, and it is the reason
`tenant_placement` and the eviction path (§1.6) earn their keep on day one.

### 1.9 The surfaces RLS does NOT cover — decide each, or they leak

Postgres RLS protects Postgres. These do not run on Postgres:

| Surface | Today | Required |
|---|---|---|
| **Redis** | `cc:*` keys carry no tenant (`cc:activity`, `cc:room`, `cc:cost`, `cc:presence`, …) | Prefix every key `cc:<org_id>:…`; separate consumer groups per tenant on the Streams bus |
| **Background jobs** | Ingestion scheduler, reconciler, orchestrator runs — no request, so no session tenant | Every job carries an explicit `organization_id` and binds it before `get_db()`. **This is where pooled systems actually leak.** A job that forgets is unbounded, not one row wide. |
| **Neo4j / Graphiti** | Single Community instance, one database | Tenant property + mandatory filter, or (better) accept that Neo4j Community allows one DB and move the graph behind a tenant-aware service |
| **Agent workspaces / blobs** | Filesystem paths, `agent_blob.instance ∈ ''\|u:<email>\|t:<team>` | Tenant becomes the outermost path/prefix segment: `<org_id>/<agent>/…`; object storage (S3/MinIO) rather than VM disk |
| **Mem0 memory scopes** | `<email>` · `prefs:` · `room:` · `agent:` · `org:global` | `org:global` is currently *deployment*-global. Must become tenant-scoped. Coordinate with WS-10 S1 — do not add a sixth scope shape independently. |
| **Langfuse / observability** | One project | Tenant tag on every trace, or a project per tenant |
| **Self-mutation** | Native-MAF agents open PRs against **this monorepo** (root `AGENTS.md` constraint 3) | **Hard-blocked for third-party tenants.** See §6.2. |

---

## 2. DECISION — modules are ENTITLEMENTS, and entitlements are not permissions

> ### `access = entitled(org, module) AND permitted(user, feature)`
> Two layers, two owners, evaluated in that order. Never conflated.

### 2.1 Why the distinction is load-bearing

CommandCenter already has a permission layer: `feature:whatsapp`, roles, per-user
overrides with deny-wins-by-specificity (`permissions.py`). That answers **"is this user
allowed?"** and its owner is the *customer's* admin.

Entitlement answers **"did this company buy it?"** and its owner is **you**.

Collapse them and two things break immediately: a customer's admin can grant themselves a
module they never paid for (they control the role table), and a downgrade at renewal has
to rewrite everyone's roles — losing the customer's own access configuration in the
process. Every mature per-module product (Microsoft 365 licences, Zoho One, Atlassian,
Salesforce feature licences) keeps these separate for exactly these two reasons.

### 2.2 Schema — in the control-plane DB, not the tenant DB

```sql
-- What you sell. A SKU, product-facing.
module_catalog(
    slug            TEXT PRIMARY KEY,     -- 'crm', 'email', 'whatsapp', 'finance'
    display_name    TEXT NOT NULL,
    feature_slugs   TEXT[] NOT NULL,      -- which feature_catalog rows it unlocks
    requires        TEXT[] NOT NULL DEFAULT '{}',   -- e.g. finance requires core
    is_core         BOOLEAN NOT NULL DEFAULT false, -- always on, never sold separately
    list_price_per_seat_month NUMERIC(12,2),
    currency        TEXT NOT NULL DEFAULT 'INR'
);

-- What a company currently owns. The CACHE OF BILLING TRUTH, written by webhooks.
org_module_entitlement(
    organization_id UUID NOT NULL,
    module_slug     TEXT NOT NULL REFERENCES module_catalog(slug),
    state           TEXT NOT NULL CHECK (state IN
                      ('trial','active','past_due','suspended','cancelled')),
    seats_purchased INT  NOT NULL DEFAULT 0,
    effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_until TIMESTAMPTZ,
    source          TEXT NOT NULL,         -- 'stripe' | 'razorpay' | 'manual'
    PRIMARY KEY (organization_id, module_slug)
);

-- Which named user holds a seat. This is what "per module per user" means.
user_module_seat(
    organization_id UUID NOT NULL,
    user_id         UUID NOT NULL,
    module_slug     TEXT NOT NULL,
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by     TEXT,
    PRIMARY KEY (organization_id, user_id, module_slug)
);
```

**Why an explicit seat assignment rather than counting active users.** This is the
Microsoft 365 model and it is the right one for a per-user-per-module price:

- The invoice is **explainable and predictable** — "you assigned 12 CRM seats" beats "13
  people opened CRM in June, one of them once."
- **Unassigned seats are visible**, to you and to the customer. "You are paying for 3
  unassigned CRM seats" is a retention conversation; "you have 4 users without WhatsApp"
  is an upsell. Active-user billing surfaces neither.
- It is **auditable**. Assignment is an act with an actor and a timestamp; usage is a
  side effect.

**Never bill on active users.** Customers cannot forecast it, so they distrust it, and
every quiet month becomes a support ticket. Put predictability in seats and variability in
metered AI (§3) — that is the hybrid model the market has settled on.

### 2.3 Enforcement — one seam, zero route edits

`EffectiveAccess.intersect()` **already exists** (`permissions.py:366-374`) and already
does exactly this job for agents ("an agent acts on behalf of a member and must never
exceed them"). Entitlements are the same operation with a different mask:

```python
effective = role_and_override_access.intersect(entitlement_mask(org_id))
```

Compute `entitlement_mask` once per request from `org_module_entitlement` (cached in
Redis, invalidated by the billing webhook — never a Stripe call on the request path), and
**every existing `require_permission("feature:crm")` call site and the entire nav gating
inherit entitlement enforcement with no route changes.** Same trick as §1.3: find the one
seam.

**Distinguish the two failures on the wire:**
- **403 Forbidden** — you are signed in, your org owns this module, your admin has not
  granted it to you. *Action: ask your admin.*
- **402 Payment Required** — your org does not own this module. *Action: upgrade.*

`/auth/me` returns **both** `features` (what you may use) and `modules` (what the org
owns, with state and trial expiry) so the frontend can tell these apart.

### 2.4 "Comprehensive even with a fraction of the modules" — the degradation contract

This is the owner's real requirement and it is a **design rule**, not a feature. A locked
module must be **absent-but-legible**, never broken:

1. **A locked module shows an upsell, not a 404.** `<ModuleGate module="crm"
   fallback={<Upsell/>}>` in the workbench. A module the customer cannot see, they cannot
   buy. This is a revenue lever, not a courtesy — it is how Zoho One and Atlassian
   cross-sell.
2. **Cross-module surfaces degrade, never error.** The Company Center rolls up every
   Center; with Finance unowned, the Finance tile renders empty-with-CTA. A CRM deal
   linked to an email thread renders as plain text when Email is unowned.
3. **A `core` module is always on** — auth, chat, admin, dashboard shell, memory. The
   product is never empty, and there is always a surface on which to sell the rest.
4. **Modules declare dependencies** (`module_catalog.requires`). Buying Finance without
   Core is rejected at checkout, not discovered at runtime.
5. **Gate the non-HTTP surfaces too — this is the one people forget.** An unowned module
   must not: register its agents, run its ingestion schedulers, consume its Redis streams,
   or fire its workflow triggers. Otherwise the module is dark in the UI while its email
   sync still polls every five minutes and **still costs you provider spend for a customer
   who is not paying for it.**

**Mapping today's features to sellable modules** (`FEATURES` at
`packages/acb_auth/acb_auth/permissions.py:73`, `feature_catalog` seeded by migrations
130 and 140):

| Module | Features it unlocks | Note |
|---|---|---|
| `core` | chat, memory, dashboard, artifacts, settings | Always on |
| `email` | email + `center.marketing` mail surfaces | Heaviest ingestion cost |
| `whatsapp` | whatsapp | Per-number provider cost — price accordingly |
| `crm` | crm, `center.sales` | |
| `projects` | projects, tasks | |
| `people` | people, `center.people` | |
| `finance` | `center.finance` | Not yet built — the catalog row can exist before the module does |
| `notes` | notes, meeting bot | Per-minute STT cost |
| `automation` | workflows, approvals, observability | |
| `builder` | build.apps, build.agents | Highest-risk module; gate hardest |

**Adding a module must stay a data change.** A new SKU is a `module_catalog` row plus a
`feature_catalog` row plus a `FEATURES` tuple entry — never a code path per customer. Note
today's trap, documented in the `FEATURES` docstring at `permissions.py:65-72`: a slug
seeded in SQL but missing from
the `FEATURES` tuple is **invisible even to an owner holding `*`**. Keep the pinning test.

---

## 3. DECISION — resell AI through the existing `/v1` choke point, priced in CREDITS

> ### `Do not reintroduce a separate proxy. The gateway's /v1 already IS the proxy.`
> ### `Sell internal credits, not provider tokens.`

### 3.1 Why not a separate LLM proxy process

The obvious move is to put LiteLLM Proxy (or similar) in front of everything and use its
virtual keys, team budgets and spend tracking — which are genuinely good features.
**Don't**, and the reason is in this repo: the proxy process was already removed
(`infra/litellm/config.yaml`: *"The gateway uses the litellm Python SDK directly (no proxy
process)"*), and `/v1/chat/completions` in `v1_compat.py` is now the documented choke point
*"every agent runtime POSTs through"* — already authenticated, already computing
per-call cost, already handling the streaming case.

Adding a proxy back would create a **second** key store, a **second** database, and a
**second** place where tenant identity must be enforced correctly. You would be buying 80%
of something you have already built, at the cost of a second tenancy boundary to get
right. Keep metering in your own code, where the tenant is already resolved.

*(If you would rather buy than build, LiteLLM's virtual-keys/team-budget model is the
right thing to buy and the design below maps onto it one-for-one — key → org, team budget
→ credit balance. Decide once; do not run both.)*

### 3.2 The four additions

**(1) Per-organization virtual keys — the load-bearing change.**
Today `require_llm_api_auth` accepts a single box-wide token (`deps.py:448-472`), so there
is **no per-customer attribution at the LLM layer at all**. Replace with:

```sql
llm_api_key(
    id UUID PK, organization_id UUID NOT NULL, prefix TEXT NOT NULL,  -- 'cc_live_a8f3…'
    key_hash TEXT NOT NULL, label TEXT, scopes TEXT[], 
    created_by TEXT, revoked_at TIMESTAMPTZ
);
```
Match on `prefix`, verify the hash. **The key resolves the tenant**, and everything
downstream — budget gate, metering, model policy, rate limits — hangs off that one
resolution. Nothing else in §3 works without it.

**(2) Pre-flight budget gate — in Redis, not Postgres.**
Before the provider call, check the org's balance against a Redis counter and reject with
**402** if exhausted. This is on the hot path of every token; Postgres is the ledger,
Redis is the gate. Include a **per-run spend circuit breaker**: an agent in a tool loop can
burn a large amount in minutes, and this codebase has retry loops and a 32k default output
ceiling (`v1_compat.py:_DEFAULT_MAX_OUTPUT_TOKENS`).

**(3) Post-flight metering — `_emit_usage` already has the numbers.**
`client.py:552-612` already computes prompt/completion/cached tokens and USD cost, and
`v1_compat.py:563-573` already rebuilds usage from streamed chunks. Add: write a
`usage_event` row and decrement the Redis counter.

```sql
usage_event(
    id UUID PK, organization_id UUID NOT NULL, user_email TEXT, agent TEXT,
    module_slug TEXT,                       -- which module drove the spend → per-module margin
    model TEXT, tier TEXT,
    prompt_tokens INT, completion_tokens INT, cached_tokens INT,
    provider_cost_usd NUMERIC(14,8),        -- what it cost YOU
    billed_credits NUMERIC(14,4),           -- what you charge THEM
    request_id TEXT UNIQUE NOT NULL,        -- ← idempotency; retries must not double-bill
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
`request_id UNIQUE` is not decoration. Retries, reconnects and the streaming rebuild path
all create double-write opportunities, and a customer billed twice for one call is a
credibility event.

**(4) A rate card — and sell credits, not tokens.**

```sql
model_rate_card(model TEXT, input_credits_per_1k NUMERIC, output_credits_per_1k NUMERIC,
                cached_input_credits_per_1k NUMERIC, effective_from TIMESTAMPTZ,
                PRIMARY KEY (model, effective_from));
```

**This is the most important commercial decision in §3.** Do not bill customers in raw
provider tokens:

- Tokens are **provider-specific and model-specific**. Bill in tokens and you have
  promised a price on DeepSeek that you cannot honour on Anthropic.
- **Providers reprice under you.** With a rate card, your margin is a table edit; without
  one, it is a code change and a customer conversation.
- **You can price cache hits lower.** `prompt_cache.py` already ships. "Cached context is
  billed at 25%" is a real, differentiated selling point — and it costs you almost nothing
  because it reflects your actual cost.
- Customers **cannot reason about tokens** but can reason about "10,000 credits ≈ a month
  of normal email triage."

This is what OpenRouter, Cursor and Vercel's AI Gateway all do, and for these reasons.

### 3.3 Failure semantics — decide now, not at 2 a.m.

**Soft-block with a grace overdraft.** At zero balance, LLM calls return a specific 402
that the UI renders as "out of credits — top up", the **non-AI parts of every module keep
working**, and a ~10% overdraft prevents a hard stop mid-sentence. Auto-top-up is the
default for paid plans; alert at 80%.

A hard cut-off mid-workflow generates a support ticket and a refund request that together
cost more than the overdraft. This is a business decision encoded in a config value —
write it down.

### 3.4 BYOK is a tier, not an exception

Some customers will insist on their own Anthropic/OpenAI key (data policy, existing
committed spend). Support it: `provider_keys` becomes `(organization_id, provider)` (§6),
and a BYOK org is **metered but not charged for tokens** — you charge the platform fee
only. This also caps *your* financial exposure on your largest accounts, which is why
nearly everyone in this space offers both.

### 3.5 "Will an LLM be able to do that?"

**No LLM is involved, and none should be.** Metering is deterministic bookkeeping: count
tokens, multiply by a rate, decrement a balance, write a row. The only judgement call is
the rate card, and that is a business decision made once by a human. Never let a model
decide what to bill.

---

## 4. DECISION — billing architecture

> ### `Your database is the source of truth for entitlements and usage.`
> ### `The payment processor is the source of truth for money.`
> Never call the processor on the request path. Never recompute an invoice it has issued.

### 4.1 Components

**(a) The Operator Console — build this early.** A separate surface (`/operator`) that
**only your staff** can reach, never bundled into the tenant UI, showing per company:
plan and MRR · seats purchased vs **assigned** per module · credit balance and burn rate ·
last invoice status · trial expiry · activity (last login, 7/30-day actives).

This answers the owner's question directly — *"depending on what modules, how many users
are using in that particular company"* — and it is simultaneously your revenue instrument,
your churn radar and your support tool. Unassigned seats and unowned-but-viewed modules
are your upsell queue.

**(b) Billing tables** (control-plane DB, alongside §2's):
```sql
org_subscription(organization_id PK, provider, provider_customer_id,
                 provider_subscription_id, plan, status, trial_ends_at,
                 current_period_start, current_period_end);

credit_ledger(id, organization_id, delta NUMERIC, reason, ref, balance_after,
              created_at);        -- APPEND-ONLY. Balance is SUM(delta), cached in Redis.
                                  -- Never UPDATE a balance column: you lose the audit
                                  -- trail exactly when a customer disputes a charge.

usage_rollup(organization_id, period DATE, dimension, quantity,
             PRIMARY KEY (organization_id, period, dimension));
             -- nightly from usage_event; raw kept ~90d, rollups forever

invoice(id, organization_id, provider, provider_invoice_id, period,
        amount, currency, status, hosted_url);   -- mirror, so the customer sees
                                                 -- invoices without a provider round-trip
```

**(c) The reconciliation loop — the part that always bites.** Webhooks get lost, cards
fail, admins downgrade mid-cycle. A nightly job compares your `org_module_entitlement` and
seat counts against the processor's subscription items and **alerts on drift**. This repo
already has a `reconciler` service — same pattern, new subject.

**(d) Lifecycle state machine**, written once, read by every module via
`entitlement.state`:
```
trial → active → past_due (grace: warnings, still working)
      → suspended (login works · modules locked · DATA RETAINED)
      → cancelled (export window) → deleted
```
> **Never delete customer data on non-payment without an export window.** It is a trust
> matter, a DPDP/GDPR matter, and the difference between a churned customer who might come
> back and one who tells people not to buy from you.

### 4.2 How the seat charge is actually computed

Per module: `quantity = COUNT(*) FROM user_module_seat WHERE module_slug = ?`, pushed to
the processor as the subscription item quantity on assignment/unassignment, with
proration. For mid-cycle changes, charge on **peak assigned seats in the period** or the
processor's standard prorated behaviour — **pick one and state it in the contract.**
Ambiguity here is the single most common source of B2B billing disputes.

### 4.3 Payment processor — and the India question

Stripe supports this shape natively: **Billing Meters + meter events** for usage,
subscription items for seats. Note the current API reality: the legacy usage-records API
was removed in API version `2025-03-31.basil`, so **every metered price now requires a
backing Meter**, and the v2 Meter Event Stream handles high-volume ingestion (~10k
events/sec) if you ever meter per-call rather than per-rollup.

Two models, and the recommendation is to run both:

| Model | Mechanism | Use for |
|---|---|---|
| **Prepaid credits** *(default)* | Customer buys a credit pack; you decrement the ledger. Processor sells a one-off/top-up product. | **Recommended default.** No bill shock, no collections risk, best fit for SMB and for India. |
| **Postpaid metered** | Report meter events; processor invoices at cycle end with graduated tiers. | Enterprise on invoice terms. |

> ⚠️ **India-specific, and it matters because you are billing from India.** For domestic
> INR recurring collection, RBI's e-mandate rules make recurring card auto-debit
> genuinely painful above the additional-factor threshold, and Stripe's India coverage is
> narrower than its international coverage. **Razorpay/Cashfree** handle UPI Autopay and
> e-NACH properly. **Recommendation: a `payment_provider` seam** — Stripe for
> international, Razorpay for India — with **both writing the same
> `org_subscription` / `org_module_entitlement` / `credit_ledger` tables.**
>
> **Do not let the processor's data model become your data model.** Entitlements are yours;
> the processor is a device for collecting money. That indirection is also what makes
> prepaid credits and manual/enterprise invoicing work without a second code path.

**Accounting.** Invoices, GST/VAT/sales tax and dunning belong to the processor (Stripe
Tax or the Razorpay equivalent), not to your app. Export to books (Zoho Books is the
natural choice — you already integrate Zoho CRM) **nightly, not per transaction**.
Deferred-revenue recognition on annual prepay lives in the accounting system, never in
CommandCenter.

---

## 5. Phasing — what to build, in order

Each phase is independently shippable and each one is sellable before the next exists.

| Phase | Work | Est. | Gate |
|---|---|---|---|
| **0 — Blockers** | §6: per-run credential scoping, per-org provider keys, self-mutation containment | 1–2 wk | **Nothing ships to a second customer before this** |
| **1 — Tenancy** | org_id + FORCE RLS on all tables (generated), **org_id in every PK and index prefix** (§1.8a), tenant binding at **all eight connection paths** (§0.1), `acb_app` role, `create_engine` + `psycopg.connect` ratchets, Mem0 decision, **no raw-SQL tool for agents** (§1.8a), Redis prefixing, subdomain resolution, identity/membership split (+ the external-IdP call, §1.8a), per-tenant logical backup job, partitioning for the heavy tables, build-failing coverage test | 4–5 wk | The big one. §0.1, §1.3, §1.6, §1.8a, §1.9 |
| **2 — Entitlements** | module catalog, entitlement + seat tables, `intersect()` mask, 402 vs 403, `ModuleGate` + upsell, non-HTTP gating | 2–3 wk | **Sell here.** Invoice by hand while proving the model. |
| **3 — AI credits** | per-org virtual keys, Redis budget gate, rate card, `usage_event`, credit ledger, top-up | 2–3 wk | §3 |
| **4 — Billing automation** | Stripe + Razorpay seam, webhooks → entitlements, dunning, Operator Console, reconciler | 3–4 wk | §4 |
| **5 — Tiers & compliance** | Dedicated-DB tier, **per-tenant envelope encryption for sensitive columns** (§1.1a — pull into Phase 1 if those columns are being touched anyway), residency, SOC 2 groundwork, DPA/DPDP | ongoing | Sell before you build this |

**Do not reorder 1 before 0, or 3 before 1** — metering without tenant resolution meters
nothing, and entitlements over unisolated data are a UI convention rather than a control.

**You can sell during Phase 2.** Manual invoicing for the first ten customers is normal
and is how you learn whether the module split and the price points are right, before
automating them.

### 5.1 Start siloed, cut over at the crossover *(owner input 2026-08-08: 10–50 seats)*

The phases above describe the destination. They do **not** require waiting 4–5 weeks
before the first customer, and at 10–50 seats per company they should not.

> **Customers 1–5: run them as silos. Build Phase 1 in parallel. Cut over at 8–12.**

**Why this is right rather than a compromise.** §1.4's crossover is ~8–12 customers, so
below it silo is genuinely cheaper *and* reaches revenue sooner. Five hand-run
deployments teach you which modules customers actually buy and what they pay — the two
inputs §8 says are still open — and that learning is worth more than a month of
architecture built against guesses.

**The four conditions that make it a bridge rather than a trap.** Without these it is
not a staged rollout, it is silo-by-default arrived at by drift:

1. **Phase 0 is non-negotiable even for silos.** Process-global credentials (§6.1) leak
   *between concurrent runs* — the second tenant needn't be on the same database for
   that to matter, only in the same process. Self-mutation containment (§6.2) likewise.
2. **Every silo runs the pooled schema**, with `organization_id` populated and RLS
   enabled from day one, even though the database holds one tenant. A silo is then a
   pooled deployment with N=1, and cutover is a data move rather than a migration.
   **Skipping this is what turns the bridge into a rewrite.**
3. **One deploy pipeline, parameterised by target** — never a per-customer script. The
   moment two boxes deploy differently, §1.4's version-skew defect has arrived.
4. **A written cutover trigger**, checked monthly: customer count ≥ 8, *or* deploy
   overhead exceeding roughly a day a month, *or* the first version-skew incident —
   whichever comes first. **A bridge with no trigger is a destination.**

---

## 6. Blockers — fix before a second tenant exists

These are not features. Each is a live cross-tenant defect the moment a second company's
data is on the box, and each is cheap now and expensive later.

### 6.1 Process-global credential injection ⚠️ **HARD BLOCKER**

`orchestrator/executor.py:4335-4411` writes every run's resolved integration credentials
into `os.environ` (`:4388`) and restores afterwards (`:4409`). **The code already documents
the flaw** at `:4364`: *"`os.environ` is process-global, so under concurrent [runs]…"*.

Under one tenant this is a within-org concern that `tenancy_and_visibility.md` §1.1
correctly deferred. **Under two tenants it is a credential leak**: tenant A's Zoho/Gmail
token is readable by tenant B's concurrently-executing agent — and agents run
model-generated tool calls, which is precisely the code you must assume is hostile.

**Fix:** pass credentials through the run context / a per-run scoped environment
(subprocess env, contextvar-backed resolver), never the process environment. This is
BO-7-adjacent and is the prerequisite for every other item here.

### 6.2 Self-mutation writes to the shared monorepo ⚠️ **HARD BLOCKER**

Root `AGENTS.md` non-negotiable #3 already flags this: native-MAF agents land approved
self-mutations by opening a PR **against this monorepo**, and the constraint says it
*"MUST be swapped for a tenant-isolated mechanism before any multi-tenant/customer
deployment — third parties must never push to the shared monorepo."*
See `docs/DESIGN_LIMITATION_native_maf_mutation.md`.

**Fix, in ascending order of effort:** (a) disable self-mutation for non-first-party
tenants — a config gate, days; (b) per-tenant agent repositories; (c) a mutation sandbox
whose output is a tenant-scoped artifact, never a push. **(a) is sufficient to unblock
Phase 1 and should be taken first.**

### 6.3 Deployment-singleton credentials

`provider_keys` is `provider TEXT PRIMARY KEY` (`08_provider_keys.sql:6-7`);
`mcp_servers`, `plugins` and `model_config` have no owner or org column. All must become
tenant-keyed. `tenancy_and_visibility.md` §1.1 called deployment-wide credentials *"exactly
the right shape"* — **true under its §1 decision, false under this one.**

### 6.4 The `org` subject means "every active user on the box"

`packages/acb_auth/acb_auth/access.py:400-402`: `_ORG_MEMBER_SQL` is `SELECT email FROM
app_user WHERE status = 'active'` — **no org filter**. Under pooled tenancy the `org`
subject would expand across every customer. Leak sites 1–10 in
`tenancy_and_visibility.md` §1.1 were *"moot by definition"* under deployment-per-tenant;
**this decision un-moots all of them.** RLS makes most of them correct automatically (the
row set is already tenant-constrained) — but each must be *verified*, not assumed, and
site 9 (`_HAS_OWNER_SQL`, `:522`, with no org filter, which makes
`ensure_owner_bootstrap()` a permanent no-op once any owner exists anywhere) is a
**lockout that RLS does not fix** and must be repaired by hand.

> ⚠️ **Re-derive these anchors before editing.** `tenancy_and_visibility.md` §1.1
> publishes `access.py:338-340` and `:460-464` for these two constants; measured
> 2026-08-08 they are at `:400` and `:522`. That document has already been through two
> anchor-correction passes for the same reason — use the §9 commands, not the numbers any
> document quotes.

### 6.5 TV-1 still applies, and now leaks for real

The three `org_group` slug-only joins (`tenancy_and_visibility.md` §2 / board **WS-14a**)
are cross-organization matches by construction. That document rated them "wrong within one
org too, nothing leaks today." **Under this decision they leak.** WS-14a's priority rises
from cleanup to prerequisite.

---

## 7. Explicitly rejected

Recorded so they are not re-proposed, and so the reasoning survives:

1. **Container/database per customer as the default tier.** §1.4. Kept as a priced
   enterprise tier only.
1b. **One container per organization on the same VPS.** §1.7 — it fragments the memory
   that pooling exists to share, delivers no real isolation on shared hardware, keeps
   every operational cost of database-per-tenant, and makes one box's failure everyone's.
   Dedicated containers only buy something on dedicated hardware.
1c. **Schema-per-tenant.** §1.8 — the strongest rejected alternative, and rejected on one
   property: **RLS fails closed (zero rows), `search_path` fails open (another tenant's
   rows, silently).** Re-take it if the market turns out to be a few dozen large accounts.
2. **`X-Organization-Id` as the tenant source** (proposed in
   `multi_user_organization_research.md` §17.3). Client-settable tenancy is a one-line
   cross-tenant read. The tenant comes from the authenticated session or a tenant-scoped
   API key. §1.5.
3. **A separate LLM proxy process.** §3.1 — the gateway `/v1` already is one.
4. **Billing customers in provider tokens.** §3.2(4) — sell credits.
5. **Billing on active users.** §2.2 — sell assigned seats; put the variability in AI
   credits.
6. **Entitlements expressed as roles/permissions.** §2.1 — the customer's admin owns roles;
   you own entitlements.
7. **Per-query `WHERE organization_id = ?` as the isolation mechanism.** RLS at the
   connection seam. A predicate you must remember is a predicate someone will forget across
   209 files; a database policy is not forgettable. Hand-written predicates are permitted
   as an *optimisation* (index selectivity), never as the control.
8. **A second scoping doctrine.** `tenancy_and_visibility.md` §3.2's standing rule is
   unchanged and extends here: tenant isolation is `organization_id` + RLS, visibility
   inside a tenant is `email | group:<slug> | org`. Two mechanisms, two axes, no third.

---

## 8. Open — owner decisions still needed

1. **Price points and module boundaries.** §2.4's module split is a proposal drawn from
   today's `FEATURES`; the SKU list is a business call.
2. **Credit-to-rupee conversion and target gross margin on AI.** Determines the rate card.
3. **Payment provider split.** Razorpay-for-India + Stripe-for-international is the
   recommendation (§4.3); a single provider is simpler and worth considering if the initial
   market is one geography.
4. **Data residency commitments.** Whether to promise India-only data at launch. This is
   cheap to promise now (one region) and expensive to add later.
5. ~~**Whether first customers get the pooled tier or hand-run silos.**~~
   **ANSWERED 2026-08-08** by the owner's seat-count input (10–50 users per customer):
   **silo customers 1–5, build Phase 1 in parallel, cut over at 8–12.** The reasoning,
   the crossover arithmetic and the four conditions that keep it a bridge rather than a
   drift are in **§5.1**.

---

## 9. Verification

```bash
# §0 — one engine, one session seam
grep -n "create_async_engine\|def get_db\|async_sessionmaker" packages/acb_common/acb_common/db.py

# §0 — the intersect() seam entitlements will reuse
grep -n "def intersect" -A 12 packages/acb_auth/acb_auth/permissions.py

# §0/§3 — the LLM choke point and the existing per-call cost computation
grep -n "def _emit_usage" -A 30 packages/acb_llm/acb_llm/client.py
grep -n "_emit_usage\|require_llm_api_auth" apps/services/gateway/gateway/routes/v1_compat.py

# §0/§6.3 — deployment-singleton credentials
grep -n "PRIMARY KEY" infra/postgres/08_provider_keys.sql

# §6.1 — process-global credential injection, and its own admission
sed -n '4335,4415p' apps/services/orchestrator/orchestrator/executor.py

# §6.4 — the org subject with no org filter
grep -n "_ORG_MEMBER_SQL\|_HAS_OWNER_SQL" -A 6 packages/acb_auth/acb_auth/access.py

# §1 — the retrofit surface
grep -rn "organization_id" infra/postgres/*.sql | grep -ci "add column\|organization_id UUID"
ls infra/postgres/[0-9]*_*.sql | wc -l
```

---

## 10. References

**Internal (binding):** `tenancy_and_visibility.md` (visibility ladder §3, project grants
§4, gap table §5 — all still current; §1 and §6 superseded here) ·
`user_management_contract.md` (the ten rules; §1.5 adds an eleventh for tenant
resolution) · `org_access_control.md` (the shipped RBAC model) ·
`multi_user_organization_research.md` §17 (prior research — §17.2's pooled-first
recommendation is adopted; §17.3's header-based tenant resolution is rejected) ·
`department_centers.md` · root `AGENTS.md` non-negotiables 2, 3 and 10 ·
`docs/DESIGN_LIMITATION_native_maf_mutation.md`

**External:** [AWS — SaaS tenant isolation strategies: the bridge
model](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/the-bridge-model.html) ·
[AWS Database Blog — multi-tenant data isolation with PostgreSQL row-level
security](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security) ·
[AWS SaaS multi-tenant architecture guide — pool/silo, onboarding,
metering](https://hidekazu-konishi.com/entry/aws_saas_multi_tenant_architecture_guide.html) ·
[Multi-tenant SaaS architecture patterns
(2026)](https://architecturediagram.ai/blog/multi-tenant-architecture) ·
[Stripe — analyze and query meter usage](https://docs.stripe.com/billing/subscriptions/usage-based/analytics) ·
[Stripe — usage metering guide](https://stripe.com/resources/more/usage-metering) ·
[Stripe — Langfuse: subscription + metered hybrid at billions of
events](https://stripe.com/customers/langfuse) ·
[LiteLLM — multi-tenant architecture](https://docs.litellm.ai/docs/proxy/multi_tenant_architecture) ·
[LiteLLM — virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys) ·
[LiteLLM — budgets and rate limits](https://docs.litellm.ai/docs/proxy/users) ·
[Revenera — SaaS licensing models](https://www.revenera.com/blog/software-monetization/saas-licensing-models-guide/) ·
[Nalpeiron — SaaS licensing and entitlement management](https://docs.nalpeiron.com/education-and-training/licensing-education/learn-about-software-licensing-models/saas-licensing-and-entitlement-management)
