# Organization Access Control — implementation spec

> **Status:** 🔄 Phase 1 shipping.
> **Created:** 2026-07-29
> **Scope:** Turning the single-tenant deployment into a real multi-user organization: named members, roles, per-user feature/agent access, and one enforcement path the whole platform shares.
> **Parent research:** [`multi_user_organization_research.md`](multi_user_organization_research.md) — the *why* and the long-horizon (SaaS, memory scoping, entity-graph RLS) design. This document is the *what we are building now*, and it deliberately implements a subset.
> **Companion:** [`permissions_sandbox_b6.md`](permissions_sandbox_b6.md) (tool-level risk gating — orthogonal: that answers "may this *tool call* proceed", this answers "may this *person* reach this feature at all").

---

## 1. What this spec covers

The research doc scopes a 22–32 week programme across identity, memory, credentials, the entity graph, and the Action Broker. That is the right destination, but nothing in it is enforceable until there is a **principal with a resolvable set of permissions**. Everything else hangs off that.

So Phase 1 is deliberately narrow and load-bearing:

**In scope**
- One organization row; every member belongs to it. Schema carries `organization_id` so a second org is a data change, not a migration.
- A member lifecycle: invited → active → suspended → removed.
- Roles as named permission bundles, seeded with five system roles, extendable with custom roles.
- **Per-user grants and denials on top of roles** — this is the specific ask: "some users don't get WhatsApp, don't get the app creator, but do get certain agents."
- One resolution algorithm (deny-wins) in one package, used by the gateway, the Next.js proxy layer, and the UI.
- Admin screens to do all of the above without SQL.

**Explicitly out of scope for Phase 1** (tracked in the research doc, not regressed by anything here)
- Memory scoping (`personal` / `team` / `organization`) — §7 of the research doc.
- Per-user integration credential scoping — §8.
- Entity-graph row visibility + Postgres RLS — §9, §16.5.
- Modules/teams as a first-class container — §5. Phase 1 uses flat org membership; the `module` concept is what Phase 2 adds when "the sales team" needs to mean something.
- Everything SaaS (§17): subdomains, billing, tenant isolation of agent runtimes.

**Why this order.** Modules, memory scoping, and credential scoping are all *consumers* of a resolved principal. Building them first means building three private half-implementations of the same permission check. Phase 1 is that check.

---

## 2. Current state (verified against code, 2026-07-29)

| Concern | Today | File |
|---|---|---|
| Sign-in | NextAuth v5 + Microsoft Entra ID, tenant-gated. Session carries `email` and `name` only. | `workbench/control_plane/src/auth.ts` |
| Role assignment | **An env var.** `EXECUTIVE_EMAILS` is parsed into a `Set` and compared against the session email. | ~50 copies of `buildGatewayHeaders()` across `src/app/api/**/route.ts` |
| Role transport | `X-User-Email` + `X-User-Role` headers alongside the internal bearer token. | `packages/acb_auth/acb_auth/deps.py` |
| Roles | `executive` \| `employee` \| `agent` (StrEnum, no DB backing). | `packages/acb_auth/acb_auth/roles.py` |
| Enforcement | `require_role(UserRole.EXECUTIVE)` — a binary gate. | `deps.py:189` |
| User table | `app_user(id, email, display_name, avatar_url, role, last_login_at, …)`. No org, no status, no invite trail. | `infra/postgres/09_app_user.sql` |
| Feature visibility | **None.** `NAV_SECTIONS` is a static array; every signed-in user sees every pane. | `workbench/control_plane/src/lib/nav.ts` |
| Agent visibility | **None.** Any registered agent is listable and runnable by anyone who can reach the gateway. | `agent_registry.json`, gateway `_AGENT_REGISTRY` |
| Nearest working precedent | Custom Apps: `apps.visibility ∈ (private, people, org)` + `app_grants(app_id, subject, role)` where subject is an email / `agent:<name>` / `agents:*`. | `infra/postgres/114_custom_apps.sql` |

Two observations drive the design:

1. **The app-grants model already works and users already understand it.** Phase 1 generalises its shape (a subject, a resource, a role) rather than inventing a second vocabulary. `app_grants` stays as-is; it is the per-app rung below org-level access.
2. **`EXECUTIVE_EMAILS` duplicated across ~50 route files is the actual blocker.** Adding a role today means editing an env var and redeploying, and any route that forgets the helper silently downgrades the caller to `employee`. Phase 1 collapses this to one DB-backed helper.

---

## 3. Model

### 3.1 Principals

A **principal** is whoever a request acts as. Three kinds:

| Kind | Identified by | Source |
|---|---|---|
| Member | `app_user.id`, addressed by email | Entra ID sign-in |
| Service | the internal bearer token | `GATEWAY_INTERNAL_TOKEN` |
| Agent | `agent:<name>` | agent runtime, acting **on behalf of** a member |

**Email stays the wire identity.** `app_user.id` is the FK target, but every existing table that scopes by user does so by email (`app_tool_grants.user_email`, `app_grants.subject`, `app_audit.user_email`, `apps.owner_email`). Re-keying them all to UUID is a large, risky, and — for Phase 1 — pointless migration. `UserContext` carries both.

**An agent never gains authority by existing.** An agent run inherits the invoking member's resolved permission set, intersected with the agent's own declared scope. It cannot exceed its caller. This is the same rule the research doc states in §11.1 (sub-agent inheritance) and it is why the permission set — not just the role name — has to travel with the request.

### 3.2 Roles

A role is a named bundle of permissions, scoped to an organization. Five are seeded as `is_system` (not deletable, not editable) and admins can create more.

| Role | Intent | Grants |
|---|---|---|
| `owner` | The person who owns the deployment. | `*` |
| `admin` | Runs the platform day to day. | `admin:*`, `feature:*`, `agents:*`, `apps:*`, `integrations:*`, `data:org:read` |
| `manager` | Sees org-wide data, cannot change platform config. | all `feature:*` except `build.*`, `agents:run:*`, `apps:use:*`, `data:org:read`, `admin:members:read` |
| `member` | Default for a new employee. | `feature:` chat, email, tasks, notes, memory, artifacts, dashboard; `agents:run:*`; `apps:use:*` |
| `guest` | Contractor / external collaborator. | `feature:chat`, `apps:use:*` |

Plus one non-assignable service role, `agent_service`, for the internal bearer path.

A member may hold several roles; grants are the **union**. Note what `member` deliberately omits: WhatsApp, Approvals, Integrations, Models, and both Build panes. The default is the conservative one, and access is added rather than taken away.

### 3.3 Permission vocabulary

Colon-separated, with `*` legal **only as the final segment**, where it matches any non-empty suffix.

```text
# Feature / module access — drives nav, route guard, and API gating
feature:chat            feature:email           feature:whatsapp
feature:tasks           feature:notes           feature:memory
feature:dashboard       feature:observability   feature:artifacts
feature:agents          feature:approvals       feature:integrations
feature:models          feature:build.agents    feature:build.apps

# Agents
agents:run:*            # run any agent
agents:run:<name>       # run one named agent
agents:manage           # register / update / remove

# Custom Apps (org level; app_grants remains the per-app rung)
apps:use:*              apps:create             apps:publish

# Administration
admin:members:read      admin:members:invite    admin:members:manage
admin:roles:manage      admin:access:manage     admin:settings:manage
admin:audit:read

# Data + platform
data:org:read           integrations:manage
```

`feature:*` matches `feature:whatsapp`; `agents:run:*` matches `agents:run:agent-sales`; a bare `*` matches everything. `*` in a non-final position is rejected at write time — wildcards that match *inward* (`feature:*:read`) make the grant set impossible to reason about, and nothing needs them.

The two examples from the original ask land like this:

- *"no WhatsApp"* → deny `feature:whatsapp`.
- *"no app creator"* → deny `feature:build.apps`.
- *"but these agents"* → the role's `agents:run:*` is denied, and `agents:run:agent-email-assistant` is allowed per-user.

### 3.4 Overrides and the resolution rule

Per-user overrides sit in `user_permission_override(user_id, permission, effect)` where effect is `allow` or `deny`.

Resolution is **two layers**. Roles are the baseline; overrides are exceptions layered on top, and only overrides compete with one another:

```
has(user, required):
    if membership is not active                      → False

    # Layer 1 — overrides. Most specific wins; a tie goes to deny.
    A := most specific override pattern matching required with effect=allow
    D := most specific override pattern matching required with effect=deny
    if A or D:
        return False if D and (no A or specificity(D) >= specificity(A)) else True

    # Layer 2 — the role baseline.
    if any role-granted pattern matches required     → True
    otherwise                                        → False      # default deny
```

Specificity: an exact match outranks every wildcard; among wildcards the longer literal prefix wins; bare `*` is the floor.

**Why specificity rather than flat deny-wins.** The product's actual request — "only these two agents" — is expressed as a blanket deny plus named allows:

```
role:     agents:run:*                        the baseline: every agent
override: agents:run:*                 deny   take the blanket away
override: agents:run:email-assistant   allow  hand two back
```

Under AWS IAM's flat "deny always wins" (research doc §3.3), the specific allow could never surface, and an admin would have to clone a role per person — the failure mode roles exist to prevent.

**Why roles stay out of that comparison.** An override of `feature:*` = deny must switch *everything* off. If a role's exact `feature:chat` could out-specify it, "revoke this person's access" would silently leave holes. An admin's explicit exception always outranks the role; specificity only orders exceptions against each other.

A suspended or removed membership resolves to the empty set regardless of roles held.

Every override row records `reason`, `set_by`, `set_at`. A permission model nobody can explain six months later gets switched off, so the *why* is a column, not tribal knowledge.

---

## 4. Schema

`infra/postgres/128_org_access_control.sql`, idempotent per `infra/postgres/README.md`.

```sql
organization(id, slug UNIQUE, display_name, domain, settings JSONB, created_at, updated_at)

-- app_user gains, without dropping the legacy `role` column (back-compat, §7):
app_user + organization_id, status ∈ (invited|active|suspended|removed),
           invited_by, invited_at, joined_at, last_active_at

org_role(id, organization_id, slug, display_name, description,
         is_system BOOL, rank INT, created_at, updated_at,
         UNIQUE(organization_id, slug))

org_role_permission(role_id, permission, granted_at, PRIMARY KEY(role_id, permission))

user_role(user_id, role_id, assigned_by, assigned_at, PRIMARY KEY(user_id, role_id))

user_permission_override(user_id, permission, effect ∈ (allow|deny),
                         reason, set_by, set_at, PRIMARY KEY(user_id, permission))

feature_catalog(slug PK, label, description, nav_href, category, sort_order, is_default)
```

`feature_catalog` exists so the admin UI can render a checklist of real features without importing `nav.ts` into the gateway, and so a new pane is one seeded row rather than a code change in three places.

The migration seeds the default organization from `ALLOWED_EMAIL_DOMAIN`, seeds the five system roles with their permission sets, backfills every existing `app_user` into the org as `active`, and maps the legacy column: `role='executive'` → `admin`, `role='employee'` → `member`. Existing users keep working; nobody is locked out by deploying this.

**Ownership bootstrap:** if no member holds `owner` after backfill, the first address in `EXECUTIVE_EMAILS` (else the oldest `app_user`) is promoted. A deployment with no owner is one where nobody can grant themselves access back.

---

## 5. Enforcement

Five seams. The first three are security, the last two are UX — a hidden nav item is not a permission check.

| # | Seam | Where | Enforces |
|---|---|---|---|
| 1 | `require_permission(...)` | gateway route dependencies | API access — **the boundary of record** |
| 2 | Agent-run gate | `/agent/run/stream` + `agents:run:<name>` | which agents a member may invoke |
| 3 | Agent context assembly | orchestrator | an agent run cannot exceed its caller's set |
| 4 | Route guard | Next.js middleware / layout | direct URL navigation |
| 5 | Nav filter | `NAV_SECTIONS` filtered by effective access | what the sidebar shows |

Phase 1 ships 1, 2, 4, 5 and the plumbing for 3. Seam 3's full form (per-user credential and memory scoping) is research-doc §7–§8 and stays queued.

`require_role()` is **kept and reimplemented** on top of the permission engine — `UserRole.EXECUTIVE` resolves as `admin:*`-equivalent — so no existing route changes behaviour on deploy. New routes use `require_permission()`.

### Resolution and caching

The gateway resolves `(roles, permissions)` from Postgres on first use per email and caches for 60s (in-process, invalidated on any admin write). Permissions are **not** put in the NextAuth JWT: a JWT outlives an access change, and "I revoked WhatsApp an hour ago and they still have it" is exactly the failure that makes people distrust the whole system. The session carries identity; access is resolved server-side per request.

---

## 6. API + UI

**Gateway** (`apps/services/gateway/gateway/routes/admin/`):

```
GET    /auth/me                             effective access for the caller (no admin perm needed)
GET    /admin/members                       list + roles + status
POST   /admin/members                       invite
PATCH  /admin/members/{email}               status, display name
DELETE /admin/members/{email}               remove (soft)
PUT    /admin/members/{email}/roles         set role assignment
GET    /admin/members/{email}/access        resolved set + overrides + provenance
PUT    /admin/members/{email}/overrides     set allow/deny overrides
GET    /admin/roles                         list with permissions
POST   /admin/roles                         create custom role
PATCH  /admin/roles/{slug}                  edit (system roles: 403)
DELETE /admin/roles/{slug}                  delete custom role
GET    /admin/features                      feature catalog
```

**Control Plane** — `/settings/members` (roster, invite, status, role), `/settings/members/[email]` (per-user access editor: feature toggles, agent list, effective-permission preview showing *why* each is on or off), `/settings/roles` (role editor).

The per-user editor shows the resolved outcome and its provenance — "WhatsApp: **off** — denied for this user, overriding role `member`". Admins should never have to simulate the resolution algorithm in their heads.

---

## 7. Back-compat and rollout

The change is additive and reversible:

1. `app_user.role` is retained and dual-written. Rollback is redeploying the previous build.
2. `require_role()` semantics are preserved exactly.
3. `EXECUTIVE_EMAILS` continues to work as the bootstrap path but stops being the source of truth once roles are assigned.
4. If the access tables are missing or unreachable, the resolver falls back to the legacy `executive`/`employee` mapping and logs a warning — a migration that has not run yet must not brick sign-in.

**Fail-open is a deliberate, bounded choice here** and worth stating plainly: it applies only to the *resolver's* fallback when the tables are absent, i.e. before the migration lands. It does not apply to a member whose row exists — an unknown user resolves to the empty set and gets nothing. This matches the fail-open contract `deps.py` already documents for an unprovisioned gateway, and it is the same trade-off flagged in `FOUNDATION_BUILDOUT_CHECKLIST.md` BO-2 (enforce auth: never-reject → require). When BO-2 lands, this fallback should be removed with it.

---

## 8. Phases

| Phase | Content | State |
|---|---|---|
| **1** | Schema, permission engine, admin API, member/role/access UI, nav + route gating, agent-run gate | 🔄 this spec |
| **2** | Modules/teams (research §5) — team-scoped visibility; shared mailboxes; `email_account_member` | 🔲 |
| **3** | Memory + credential scoping (research §7–§8) — the real seam-3 work | 🔲 |
| **4** | Entity-graph visibility + RLS safety net (research §9, §16.5) | 🔲 |
| **5** | Consent records, access reviews, audit completeness (research §11.3) | 🔲 |

---

## 9. Open questions

1. **Agent visibility vs. runnability.** Phase 1 gates *running* an agent. Should a member also be unable to *see* that an agent exists? Listing is currently a weaker signal than running, but agent names leak org structure.
2. **Approval routing.** When a member lacking `admin:*` triggers an action needing approval, who is asked? Phase 1 routes to anyone with `feature:approvals`; per-module approvers is a Phase 2 question.
3. **Departure.** A removed member's private apps, chat sessions, and agent workspaces currently persist unowned. Transfer-on-removal is unbuilt (research §13 Q4).
4. **Guest scope.** Does `guest` ever need email or tasks, or is chat-plus-shared-apps the whole product surface for externals?
5. **Custom role ceiling.** Clerk caps at 10. Unbounded custom roles tend to produce one role per person, which is what overrides are for.
