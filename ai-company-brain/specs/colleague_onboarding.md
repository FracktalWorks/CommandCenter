# Colleague onboarding — the readiness gate, the runbook, and the capability matrix

**Status:** 🔴 NOT READY — four blocking items open (§1) · **Board row:** WS-24 ·
**Owner:** vjvarada · **Date:** 2026-08-04 ·
**Verified against code on 2026-08-04** (branch `ws-24-onboarding-readiness`,
cut from `ws-14-doc-remediation` @ `ed785bea`).

**What this doc is for.** Exactly one person is signed in to this deployment.
The question "is it safe to invite colleagues yet" has been re-derived in
conversation more than once and answered nowhere durable. This spec is the
durable answer, in three parts:

| § | Section | Kind |
|---|---|---|
| §1 | **The readiness gate** — what must be true before colleague #1 | checklist with per-item done-whens + gate labels |
| §2 | **The onboarding runbook** — invite → role → Center group → verify | procedure, grounded in real endpoints |
| §3 | **The capability matrix** — what a colleague on each role can actually see | evidence table, every cell carries `file:line` |
| §4 | **The Notes/actions holes PR #346 left open** — blocking items with sizes | tickets |

**Executable half.** `scripts/onboarding_preflight.py` implements §1's
machine-checkable criteria. Run it **on the box** before inviting anyone; run
it `--mode local` anywhere else and it refuses the box-only checks rather than
guessing. If a criterion changes here, change it there in the same PR.

**Scope.** This doc owns the *gate* and the *matrix*. It does not own the
access model (`org_access_control.md`), the visibility doctrine
(`tenancy_and_visibility.md` — D11/D12), or the Centers IA
(`department_centers.md`). Where they disagree with a cell here, re-measure and
fix whichever is stale.

**Non-goals.** Not an HR onboarding process. Not a rollout plan for a second
tenant (D11: the tenant boundary is the deployment). Not a fix for §4's open
holes — this is the gate that says they must be fixed, and sizes them.

---

## 1. The readiness gate

**The verdict today: NOT READY.** Four items block colleague #1. Two are
AGENT-SAFE and can be built now; two are OWNER-GATE and an agent must refuse
them by name.

Nothing in this section is a preference. Each one is a live path by which a
colleague sees, changes, or destroys something that is not theirs, or by which
the owner loses work that has no backup.

### 1.1 The blocking items

| # | Item | Gate | Done when |
|---|---|---|---|
| **G1** | **Caddy strips inbound identity headers on the API vhost** | 🔴 **OWNER-GATE** (installing it on the box changes auth behaviour — `work_plan.md` §6) | `deploy/hostinger/caddy/Caddyfile`'s `api.*` `reverse_proxy` block contains **both** `header_up -X-User-Email` and `header_up -X-User-Role`; the same is true of `/etc/caddy/Caddyfile`; and `scripts/onboarding_preflight.py` reports `[PASS] Caddy strips inbound identity headers`. Writing the repo file is AGENT-SAFE; installing + reloading is not. |
| **G2** | **`GATEWAY_INTERNAL_TOKEN` is provisioned and is not `LITELLM_MASTER_KEY`** | 🔴 **OWNER-GATE** (a credential provisioned on the box, in two places) | The preflight reports `[PASS] Service identity is its own secret` in **box** mode, i.e. the value is set in `/opt/acb/app/.env` **and** in the workbench's `.env.local`, and differs from the LLM key. |
| **G3** | **Backups exist** (BO-23) | 🟢 **AGENT-SAFE** to build the timer + dump + runbook; 🔴 **OWNER-GATE** to install the unit and schedule it | The preflight reports `[PASS] Backups run, land, and are recent` in box mode: `acb-backup.timer` active, ≥1 directory under `/opt/acb/backups`, its `MANIFEST.txt` readable, newest < 48h old. **Nothing of this exists today** — a repo-wide grep for `acb-backup` returns zero hits, and the only DB script that dumps anything is `scripts/dump_schema.sh` (`pg_dump --schema-only` — structure, zero rows). See `work_plan.md` §2 exception 2. |
| **G4** | **§4's Notes/actions read paths are closed** | 🟢 **AGENT-SAFE**, three PRs (§4) | Each of §4's three tickets meets its own done-when, and `tests/unit/test_notes_owner_scoping.py` covers the newly-closed paths. Latent with one user; live the moment a colleague signs in. |

### 1.2 Already true — do not re-litigate

| Item | Evidence |
|---|---|
| PR #348 (the WS-13 Centers feature-vocabulary fix) is in this branch's ancestry | `acb_auth/permissions.py:95-100` carries the six `center.*` slugs; the preflight's check 6 passes locally against `140_center_features.sql`. |
| PR #346 (the Notes owner filter) is merged as `d2ef7fa0` | `routes/notes/core.py:192-217` — `OWNED_MEETING_PREDICATE` + `load_owned_meeting`. |
| A bare `X-User-Email` with no Bearer establishes nothing | `acb_auth/deps.py:356-361` — with an internal token configured, an unaccompanied identity header resolves to `NO_ACCESS`. The exposure G1/G2 close is narrower and specific: the token that *is* configured may be the LLM key every agent holds. |
| Default-deny for an unknown email | `acb_auth/access.py:257-263` — an authenticated stranger with no `app_user` row resolves to `is_active=False`. Pinned by `tests/unit/test_default_deny_auth.py`. |
| The six system roles seed themselves idempotently | `infra/postgres/130_org_access_control.sql:180-260`, extended by `131_integration_memory_permissions.sql`. |

### 1.3 Known-and-accepted, not blocking

| Item | Why it does not block |
|---|---|
| Workflows are org-wide | A recorded v1 decision (`routes/workflows/crud.py:1-5`, spec Q3). It is not a defect; it is a **consequence of granting `feature:workflows`** — see §3.4. `member` does not hold it. |
| `main` has no branch protection | `work_plan.md` §2 exception 1. Real, OWNER-GATE, and about the repo rather than about who can read whose mail. |
| Custom-App grants do not honour `group:` | WS-14; `routes/apps/grants.py:68-85`. Narrower access than intended, not wider. |

---

## 2. The onboarding runbook

Prerequisite: §1 is green (run `scripts/onboarding_preflight.py` on the box).
Every step below is a real, shipped endpoint. Sign-in is Entra ID SSO — there
is no invitation email; "inviting" means **provisioning the row that turns a
directory identity into a member**.

### Step 1 — Invite

    POST /admin/members     { "email": "…", "display_name": "…", "roles": ["member"] }

* Gate: `admin:members:invite` — `routes/admin/members.py:145-146`.
* Package floor: the whole `/admin` surface additionally requires
  `admin:members:read` (`routes/admin/_common.py:77-91`).
* Behaviour: inserts (or re-activates) `app_user` in the `invited` state and
  assigns the requested roles (`members.py:158-192`). Roles default to
  `["member"]` when omitted (`:165`).
* UI: `/settings/members`.

> **Choose the role deliberately.** `member` is the default and is the right
> answer for a new employee. Read §3 first — `manager` is not "member plus a
> bit"; it hands over the entire member directory and both org-memory rights.

### Step 2 — Assign the role (if it is not the default)

    PUT /admin/members/{email}/roles     { "roles": ["member"] }

* Gate: `admin:members:manage` — `members.py:370-371`.
* Assignable set excludes `agent_service` — `permissions.py:146-148`.

### Step 3 — Assign the Center group

    POST /admin/groups/{slug}/members    { "email": "…", "role": "member",
                                           "grant_center_access": true }

* Gate: `admin:members:manage`, **plus** `admin:access:manage` when
  `grant_center_access` is true — `routes/admin/groups.py:336-337, 358-367`.
* What it writes: the membership row in `org_group_member`
  (`groups.py:375-383`) and, for one of the six Center slugs, an
  `allow feature:center.<slug>` row in `user_permission_override`
  (`groups.py:386-397`).
* `ON CONFLICT DO NOTHING` is deliberate: an existing override — **including an
  explicit deny** — is an admin decision this shortcut must not silently flip
  (`groups.py:350-352`). The response's `center_access_granted` is `false` in
  that case, and in two others (not a Center group; the admin opted out), so
  do not read `false` as failure without checking which.
* Removing the membership does **not** revoke the override
  (`groups.py:417-425`) — revoke it on the member's access screen.

### Step 4 — Verify, before telling them it is ready

1. **Read back the resolved answer, not the inputs:**

        GET /admin/members/{email}/access

   `routes/admin/members.py:512`. This returns the same computation
   `/auth/me` performs for the member themselves — roles, granted patterns,
   overrides, and the resolved yes/no per capability. Comparing it against §3's
   row for that role is the check.

2. **Confirm the nav they will see.** `/auth/me` returns
   `list(access.allowed_features())` (`routes/admin/me.py:84`), and
   `allowed_features()` iterates the literal tuple
   `acb_auth.permissions.FEATURES` — *not* the `feature_catalog` table. A slug
   seeded in SQL but absent from that tuple is invisible even to an owner
   holding `*`. The preflight's check 6 is that invariant.

3. **Confirm what they can run.** `/auth/me`'s `agents` array is the list of
   agents `assert_can_run_agent` will accept (`acb_auth/deps.py:613-626`). A
   `guest` gets `feature:chat` and **no** `agents:run:*`, so the chat pane opens
   and every run 403s — see §3.

4. **Confirm what they should NOT see.** Sign in as them (or ask them) and open
   `/notes`, `/tasks`, `/artifacts`. §3.3 says what each of those actually
   scopes and what it does not. **Hiding a control in the UI is a courtesy, not
   a boundary** — `workbench/control_plane/src/lib/access.ts:126-129` says so in
   its own comment. Verify against the API, not the sidebar.

### Step 5 — Off-boarding (the other half, recorded here so it is not invented later)

    PATCH  /admin/members/{email}   { "status": "suspended" }   # members.py:202-203
    DELETE /admin/members/{email}                               # members.py:263-264

`resolve_access` treats status as a property of the *result*, not a filter on
the query, so a suspended member resolves to no access within the 60s cache TTL
at worst (`acb_auth/access.py:209-215`).

---

## 3. THE CAPABILITY MATRIX

> **How to read this.** Every cell was verified against code on 2026-08-04 and
> carries the `file:line` that settles it. Where a cell could not be
> established, it says **UNVERIFIED** and why. A confident wrong cell here is
> worse than an admitted gap — this is what the owner relies on when deciding
> to let real people in.

### 3.0 Two corrections to the received account — read these first

**(a) Role grants come from TWO migrations, not one.** Every summary of these
roles circulating in the corpus quotes `130_org_access_control.sql` alone.
`131_integration_memory_permissions.sql` adds more, and it changes the answer:

| Role | 130 | 131 adds |
|---|---|---|
| `owner` | `*` (`130:183-190`) | nothing — `*` already covers it (`131:42`) |
| `admin` | `130:198-207` | `integrations:use:*`, `memory:read_org`, `memory:write_org` (`131:45-53`) |
| `manager` | `130:210-223` | `integrations:use:*`, `memory:read_org`, `memory:write_org` (`131:57-65`) |
| `member` | `130:228-239` | `integrations:use:*`, **`memory:read_org`** (`131:70-78`) |
| `guest` | `130:242-249` | **nothing** (`131:80`) |
| `agent_service` | `130:252-259` | `integrations:use:*`, `memory:read_org`, `memory:write_org` (`131:85-93`) |

So a `member` **can read organisation memory** and cannot write it — the exact
split `131:67-69` argues for. Quoting `130` alone gets that cell wrong.

**(b) `data:org:read` grants nothing. It has zero consumers.** It is declared
in `permissions.py:132`, granted to `admin`, `manager` and `agent_service`, and
referenced in `access.py:148`'s legacy-fallback list — and **no route, query or
predicate in the repository ever checks it.** A repo-wide search for
`data:org:read` outside the vocabulary, the seed migrations and the specs
returns nothing.

This matters because `manager` is routinely described as "the role with org-wide
visibility, which contradicts department privacy". The contradiction is real but
it is **not** `data:org:read` — that permission is a name with no mechanism.
What actually widens a manager is: the whole `/admin` read surface
(`admin:members:read`), `feature:approvals`, `feature:observability`,
`feature:whatsapp`, and `memory:write_org`. See **D14** in `work_plan.md` §3.

### 3.1 Where a feature is actually enforced

A `feature:` grant is only a boundary where a route checks it. Measured:

| Surface | Server-side gate | Anchor |
|---|---|---|
| Chat + Rooms | `require_feature_router("chat")` | `routes/chat.py:36`; `routes/rooms.py:56` |
| Email | `require_feature_router("email", exempt=[…])` | `routes/email/core.py:39` |
| Tasks | `require_feature_router("tasks")` | `routes/tasks/core.py:29` |
| Notes | `require_feature_router("notes", exempt=[2 bot-token routes])` | `routes/notes/core.py:33-40` |
| WhatsApp | `require_feature_router("whatsapp", exempt=[…])` | `routes/whatsapp/core.py:35` |
| Workflows | `require_feature_router("workflows", exempt=EXEMPT_ROUTES)` | `routes/workflows/core.py:34` |
| Approvals | `require_feature_router("approvals")` | `routes/actions.py:34` |
| Integrations | `require_feature_router("integrations")` | `routes/integrations.py:37`; `routes/integrations_skills.py:31` |
| Custom Apps | **not** a feature gate — `apps:use:*` to open, `feature:build.apps` to author | `routes/apps/_common.py:32, 129-146, 149-169` |
| **Memory** | ⚠️ **no `feature:memory` check anywhere.** Router requires the internal Bearer; authorization is per-scope | `routes/memory.py:45-48`, `_authorize_scope` `:128-167` |
| **Artifacts / workspace** | ⚠️ **no `feature:artifacts` check anywhere.** `get_current_user` only | `routes/workspace.py:53` |
| **Observability** | ⚠️ **no `feature:observability` check.** Any authenticated caller | `routes/observability.py:46-51` — the comment says this is deliberate: operational metadata, never message content |
| **Dashboard** | no backend at all | `workbench/control_plane/src/app/dashboard/page.tsx:1-14` is a `ComingSoon` stub |

**Consequence, and it is the single most load-bearing line in this document:**
for Memory, Artifacts and Observability the `feature:` grant hides the nav pane
and nothing more. A member denied `feature:memory` can still reach `/api/memory/…`
through the BFF; what stops them reading a colleague's memories is
`_authorize_scope`, not the feature. Scope everything you reason about here on
the per-object rule, not on the nav.

### 3.2 Role × surface

`✅` = reachable · `—` = not granted · `⚠️` = reachable but see the note.

| Surface (feature) | owner | admin | manager | member | guest | Settles it |
|---|---|---|---|---|---|---|
| Chat / Rooms (`chat`) | ✅ | ✅ | ✅ | ✅ | ✅ | `130:189, 203, 217, 235, 248` |
| Email (`email`) | ✅ | ✅ | ✅ | ✅ | — | `130:203, 217, 235`; guest list `130:248` |
| Tasks (`tasks`) | ✅ | ✅ | ✅ | ✅ | — | `130:217, 235` |
| Notes (`notes`) | ✅ | ✅ | ✅ | ✅ | — | `130:218, 235` |
| Memory pane (`memory`) | ✅ | ✅ | ✅ | ✅ | — | `130:218, 236` |
| Dashboard (`dashboard`) | ✅ | ✅ | ✅ | ✅ | — | `130:218, 236` — **a stub page**, `dashboard/page.tsx:1-14` |
| Artifacts (`artifacts`) | ✅ | ✅ | ✅ | ✅ | — | `130:219, 236` |
| Observability (`observability`) | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | Feature at `130:219` (manager) — but the API is open to **any authenticated caller**, `observability.py:51` |
| Approvals (`approvals`) | ✅ | ✅ | ✅ | — | — | `130:219`; absent from member `130:234-237` |
| WhatsApp (`whatsapp`) | ✅ | ✅ | ✅ | — | — | `130:217`; member list omits it, and `130:226-227` says so explicitly |
| **Workflows** (`workflows`) | ✅ | ✅ | — | — | — | Only `feature:*` covers it: `130:203`. Absent from manager `130:216-221` and member `130:234-237`. **Granting it has a consequence — §3.4.** |
| Integrations (`integrations`) | ✅ | ✅ | — | — | — | `130:203`; `integrations:manage` at `130:205` |
| Models (`models`) | ✅ | ✅ | — | — | — | `feature:*` only |
| Agent Registry (`agents`) | ✅ | ✅ | — | — | — | `feature:*` only; `agents:manage` at `130:203` |
| Build panes (`build.agents`, `build.apps`) | ✅ | ✅ | — | — | — | `feature:*` only; `130:226-227` names both as deliberate member omissions |
| Centers (`center.*`) | ✅ | ✅ | — | — | — | `feature:*` covers them since `permissions.py:95-100`; nobody else gets one without a grant (`140_center_features.sql:19-25`, all `is_default=false`) |
| Custom Apps — **use** (`apps:use:*`) | ✅ | ✅ | ✅ | ✅ | ✅ | `130:204, 220, 237, 248`; enforced `_common.py:129-146` |
| Custom Apps — **author** (`feature:build.apps`) | ✅ | ✅ | — | — | — | `_common.py:149-169` |
| Run any agent (`agents:run:*`) | ✅ | ✅ | ✅ | ✅ | **—** | `130:203, 220, 237`. **Guest has none** (`130:248`), so a guest opens `/chat` and every run 403s at `deps.py:613-626` |
| Admin surface (`admin:members:read` floor) | ✅ | ✅ | ✅ | — | — | `130:200, 221`; floor at `admin/_common.py:77-91`. **A manager reads the whole member directory** and `/auth/me` returns `is_admin: true` for them (`me.py:96`) |
| Admin writes (`admin:*:manage`) | ✅ | ✅ | — | — | — | `130:200-202`; manager's list `130:216-221` has only `admin:members:read` |
| Org memory — read (`memory:read_org`) | ✅ | ✅ | ✅ | ✅ | — | `131:50, 62, 75`; guest excluded `131:80` |
| Org memory — write (`memory:write_org`) | ✅ | ✅ | ✅ | — | — | `131:50, 62` vs member's `131:75` |
| `data:org:read` | ✅ | ✅ | ✅ | — | — | `130:205, 221` — **grants nothing; zero consumers.** §3.0(b) |

### 3.3 What a grant actually exposes, per app

This is the half that matters. A `feature:` grant opens a surface; the
per-object rule decides whose rows you see through it.

| App | The scoping rule | Verified at | What a `member` sees |
|---|---|---|---|
| **Notes** | Owner-scoped. One predicate, written once, case-insensitive; `NULL` owner = pre-migration-95 legacy, visible to all | `routes/notes/core.py:192-194` (`OWNED_MEETING_PREDICATE`), `:197-217` (`load_owned_meeting`, 404-not-403), bound in `routes/notes/meetings.py:77` | **Their own meetings only** — on the list/get/patch/delete/dispatch paths. ⚠️ **Six other route families are NOT owner-scoped** — §4. |
| **Tasks** | Per-user rows: **27** `user_id = :uid` predicates | `routes/tasks/items.py` (measured: 27 occurrences of the exact predicate) | Their own items only. No team/Center sharing exists yet — that is WS-14 C1 / D13 (`gtd_project_grant`). |
| **Email** | Per-account ownership, asserted on both the message-scoped and account-scoped loaders | `routes/email/core.py:168-180` (`_provider_for_account`), `:576-580` (`_assert_account_owner`) | Only accounts they own. Today there is exactly one account (`vjvarada@fracktal.in`), so a colleague's `/email` is empty until they connect their own. Shared mailboxes are ownerless work — `work_plan.md` §4. |
| **Memory** | One rule per scope shape; an unrecognised shape is refused | `routes/memory.py:128-167` | Their own `<email>` scope (`_authorize_person` `:112-125` — **explicitly not readable by admins**); their own `prefs:` (`:95-100`); rooms they can read (`:82-92`); org memory read-only (`:73-79` + `131:75`); and — see below — **every shared agent's compartment**. |
| **Memory, the wide edge** | `agent:<name>` is gated on `can_run_agent(name)`, and `member` holds `agents:run:*` | `routes/memory.py:103-109` + `130:237` | **A member can read and write the memory compartment of every agent they can run**, which is every agent. Documented as by-design ("shared across the agent's users"), but it means an agent that remembers something from the owner's conversation is readable by any member. |
| **Chat sessions / Rooms** | `visibility` defaults to `private`; five explicit ways in | `138_groups_and_session_participants.sql:71` (default `'private'`); `gateway/rooms.py:368-403` (`SESSION_VISIBLE_SQL`) | Their own sessions, plus any where they are a participant directly, via a `group:` they belong to, via an `org` participant row, or where `visibility='org'`. Default is closed. |
| **Custom Apps** | `visibility` defaults to `private`; org-visible **and** live apps are open to every app viewer | `114_custom_apps.sql:30`; `routes/apps/_common.py:290-315` (`can_view`) | Their own + apps explicitly granted to their email + **every org-visible published app**. Note `guest` is in that last set too. |
| **Artifacts** | Partitioned by the agent's own `sharing.instancing`, resolved per viewer | `routes/workspace.py:230-260` (`_agent_instance_for`) → `acb_skills/manifest.py:235-246` (`instance_key`) | **Depends on the agent, and for most agents it is shared.** Four of the six first-party agents declare `instancing: "shared"` (`agent-orchestrator`, `agent-task-manager`, `agent-app-builder`, `agent-apis-config`), which yields `''` — **one workspace for everybody**. Only `agent-email-assistant` and `agent-whatsapp-assistant` declare `personal` (→ `u:<email>`). So a colleague with `feature:artifacts` sees the owner's orchestrator outputs. |
| **Dashboard** | none — there is nothing to scope | `dashboard/page.tsx:1-14` | A "coming soon" card. Granting or denying `feature:dashboard` changes nothing but the sidebar. |
| **Observability** | none — any authenticated caller | `routes/observability.py:46-51` | Run metadata for the whole deployment: agent, model, tokens, cost, status, duration. **Not** message content (the comment at `:46-50` states the split deliberately). The `feature:observability` grant is nav-only. |
| **Workflows** | **org-wide by design** | `routes/workflows/crud.py:1-5` verbatim: "any member holding the `workflows` feature sees and edits every workflow … `owner_email` is attribution, not access" | Nothing — `member` does not hold the feature. See §3.4 before granting it. |
| **Admin** | `admin:members:read` floor for the whole package | `routes/admin/_common.py:77-91` | Nothing. A **manager** sees the entire member directory, the role catalogue and the group list; writes stay behind the `*:manage` permissions (`members.py:203, 264, 371`; `roles.py:147, 226, 293`; `groups.py:199, 244, 281, 337, 419`). |

### 3.4 Granting `feature:workflows` hands over a permanent unauthenticated trigger

Recorded as a **labelled consequence, not a defect** — the org-wide read is a
recorded v1 decision (`workflows_app.md` Q3), and the hook design is deliberate.

The chain, verified:

1. `feature:workflows` ⇒ see and edit **every** workflow, whoever made it —
   `routes/workflows/crud.py:1-5`.
2. The detail response returns the workflow's `hook_token` in the body —
   `crud.py:230`.
3. `POST /workflows/hooks/{hook_token}` is **unauthenticated by design**: it is
   in the router's exempt set (`routes/workflows/core.py:29`) and in
   `main.PUBLIC_ROUTES`. `routes/workflows/hooks.py:3` states the model: *"the
   token IS the credential"*.

So granting `feature:workflows` to a colleague gives them a **permanent,
copyable, unauthenticated trigger credential for every workflow in the
deployment**, which survives suspending or removing them, because revoking a
member does not rotate a token they already read. Rotating hook tokens is
therefore part of off-boarding anyone who ever held this feature — and there is
no rotate endpoint today.

**Before granting it:** decide whether that is acceptable, or mint a ticket for
per-workflow ACLs + hook-token rotation first. This spec does not decide it.

### 3.5 UNVERIFIED cells — admitted gaps

| Cell | Why it is not settled |
|---|---|
| Whether `feature:models`, `feature:agents`, `feature:build.agents` are enforced server-side | `routes/settings.py:23` and `routes/agent.py:49` carry no router-level feature dependency, and I did not enumerate every route under them. The **role** answer is certain (only `feature:*` covers them, so only owner/admin hold them); the **enforcement** answer is not. Treat these as nav-only until someone measures them. |
| Whether the BFF blocks a member from calling an un-gated gateway route directly | The BFF forwards without re-checking features (`lib/gateway.ts:217-240`, `proxyToGateway`), and `lib/access.ts:126-129` says route-level `require_permission` is the boundary. I did not test the full `/api/[...path]` set for a route that gates in the UI and not at the gateway. Assume nav-only gating is not a boundary. |
| Per-Center data scoping | `140_center_features.sql:9-12` is explicit that Center features gate **navigation and the landing pages**, not data. There is no per-Center data predicate anywhere yet (that is WS-14 / WS-15). A `center.finance` grant does not hide anything from anyone. |
| `/debug` routes | Described as EXECUTIVE-only in `observability.py:46-50`'s comment; not measured here. |
| What a **suspended** member can still reach within the 60s access cache | `access.py:209-215` describes the TTL bound; not exercised. |

---

## 4. The open holes PR #346 named rather than fixed — blocking items

PR #346 (`d2ef7fa0`) closed the Notes list/get/patch/delete/dispatch paths and
**explicitly named** what it left open, in its own commit body and in
`apps/services/gateway/AGENTS.md:30`. Every one of them is latent with one user
and live the moment a colleague signs in. All three require `feature:notes`,
which `member` holds by default (`130:235`).

**These are the gate's G4. They are sized here and built elsewhere — this
ticket does not fix them.** All three are 🟢 **AGENT-SAFE**.

### N1 — Notes read paths outside the owner predicate · size: M (one PR, ~6 files)

Six route families reach a meeting by id with no ownership predicate. Verified
2026-08-04:

| File | Route(s) | The unguarded read |
|---|---|---|
| `recordings.py` | `POST /meetings/{id}/upload` `:64`, `POST /meetings/{id}/recordings/start` `:159`, `POST …/chunk` `:228`, `POST …/complete` `:267`, `GET /meetings/{id}/audio` `:377` | `SELECT id FROM meeting WHERE id = :id` (`:101`, `:183`) and `SELECT * FROM meeting_recording WHERE meeting_id = :id` (`:386`) — existence only. `retranscribe` `:321` is the one that *is* guarded (`load_owned_meeting` at `:337`), which is the shape the rest should copy. |
| `qa.py` | `POST /meetings/{id}/ask` `:82` | Reads the **whole transcript** — `SELECT … FROM transcript_segment WHERE meeting_id=:id` `:95-99` — and answers questions about it. |
| `share.py` | `POST /meetings/{id}/share/email/draft` `:25` | `SELECT title, summary_md, attendees FROM meeting WHERE id=:id` `:33-36` — drafts a recap of a colleague's meeting. |
| `copilot.py` | `GET /meetings/{id}/copilot/stream` `:484`, `GET …/copilot/events` `:501` | Live copilot stream for any meeting id. |
| `live.py` | `GET /meetings/{id}/live/wanted` `:256` | Bot-token authed (`_check_bot_auth`), not member-authed — a different shape from the rest; confirm before "fixing" it into member auth. |
| `actions.py` | see N2 | |

**Done when:** every route above loads its meeting through
`core.load_owned_meeting` (or binds `OWNED_MEETING_PREDICATE`) and returns
**404, never 403**, for a meeting the caller does not own; `live.py:256` is
either left machine-authed with a comment saying why or moved to the same rule;
and `tests/unit/test_notes_owner_scoping.py` gains one red-first case per route
family asserting 404 for a non-owner.

### N2 — `actions.py` single-item approve / reject · size: S (one file)

`_load_action` (`actions.py:62-75`) selects `FROM action_item WHERE id = :id`
with no join to `meeting` and no owner predicate. Both callers act on it:

* `POST /actions/{id}/approve` `:78-111` — creates a `gtd_items` row with
  `user_id` set to **the caller's** email (`_create_task_from_action` `:46-58`,
  bound at `:90`) and copies `action.description` into its title (`:54`). So
  any member can lift a colleague's action item into their own GTD list, and
  the colleague's item flips to `status='created'` (`:91-97`).
* `POST /actions/{id}/reject` `:114-130` — flips a colleague's item to
  `rejected` (`:125-128`).

`approve-all` (`:141`) is *not* in scope: it goes through
`dispatch.cross_owner_refusal`, which is the seam PR #346 hardened.

**Done when:** `_load_action` joins `meeting m ON m.id = action_item.meeting_id`
and binds `OWNED_MEETING_PREDICATE`, raising 404 for a non-owner; both routes
inherit it; and two tests (one approve, one reject) fail red before the change.

### N3 — `meeting_bot.bot_join` with a `meeting_id` · size: S (one route)

`POST /meetings/bot-join` (`meeting_bot.py:691`) accepts an optional
`body.meeting_id` and, when present, runs
`UPDATE meeting SET status='recording', platform=…, start_at=now(), title=… WHERE id = CAST(:id AS UUID)`
(`:728-737`) with **no owner predicate**. Any member holding `feature:notes`
who knows a colleague's prepared meeting id can flip it into `recording`, mutate
its title and start time, attach a bot to it, and register live presence under
their own identity (`live_session.begin(meeting_id, "bot", user.email)` `:817`).

Note the deliberate asymmetry that must be preserved: the bot pipeline carries
`meeting_bot.requested_by` — the member who sent the notetaker — as
`triggered_by`, **not** the meeting's owner, precisely so the requester's
authority is not laundered into the owner's (PR #346's commit body;
`gateway/AGENTS.md:30`).

**Done when:** the attach branch loads the meeting through
`load_owned_meeting` first and 404s for a non-owner; the create branch
(`:741-752`, which already stamps `owner_email = user.email` at `:749`) is
unchanged; and a test asserts 404 when a non-owner supplies another member's
`meeting_id`.

---

## 5. Verification

    # The gate's machine-checkable half. On the box:
    cd /opt/acb/app && uv run python scripts/onboarding_preflight.py
    # Anywhere else (box-only checks report SKIP, never PASS):
    uv run python scripts/onboarding_preflight.py --mode local

    # The access model this document describes:
    uv run pytest tests/unit/test_org_access_control.py \
                  tests/unit/test_admin_groups.py \
                  tests/unit/test_default_deny_auth.py -q
    # Baseline on ws-24-onboarding-readiness: 85 passed.

    # §4's holes, once they are closed:
    uv run pytest tests/unit/test_notes_owner_scoping.py -q

    uv run ruff check . --select F821,F601,F602,F502,F7,B006
    python -m py_compile scripts/onboarding_preflight.py

**Never** run the preflight against production from an agent session. The DB
checks read the live database; `--mode local` is the agent's only mode.
