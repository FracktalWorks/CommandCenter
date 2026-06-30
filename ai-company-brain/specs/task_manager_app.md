# Task Manager App — Project Plan (GTD philosophy)

> **Product:** CommandCenter · **Feature:** Task Manager App (Getting Things Done) · **Updated:** 2026-06-30 · **Version:** 0.2 (planning — reviewed)
> **Status:** 🔄 UI-first build in progress on `main` — frontend slices 1–2 (Shell + Browse, Clarify) shipped against mock data; **backend not started.** Builds on the existing `agent-task-manager` + `skill-clickup-sync` scaffolding. **Resume point: Slice 3 — Engage "Now" (F4).** See §9.1.
> **v0.2 review pass:** reconciled the GTD "lightweight project" vs "first-class project" framing (§5.1); clarified the delegation-write vs Action-Broker sequencing (§6, Phase 3); pinned the migration (`48_*`, idempotent, FK-dependency apply order — §4); placed the new GTD tools in `skill-task-gtd` over the canonical store and demoted `skill-clickup-sync` to the reference connector (§3.1); matched the gateway route to the `routes/<app>/` package precedent (§8); de-duplicated horizon levels vs projects/items (§4); aligned F1 capture channels with the phasing (Q3); added a build-order summary (§9).
> **Sibling spec:** [`email_ai_assistant.md`](email_ai_assistant.md) — the Task Manager app deliberately mirrors its architecture (multi-panel client + AI assistant + provider abstraction + Postgres sync + automation engine + follow-up tracking). Read it first; this doc reuses its patterns by reference.

---

## 0. One-paragraph thesis

The Task Manager app is the **"Getting Things Done" operating layer** on top of *whatever* project-management tool(s) the company connects — ClickUp, Asana, Jira, Linear, Monday, or anything that exposes an MCP server — through a single **provider interface layer** (§5.2). The app is the *methodology surface* — capture, clarify, organize, reflect, engage. The **`task-manager` MAF agent** is the *cognitive engine* — it does the GTD "clarify/organize" thinking a person normally does by hand (define the next action, detect projects, assign contexts, run the weekly review, draft delegation follow-ups). For **collaborative** work, ClickUp/Asana/Jira remain the **source of truth** (per CommandCenter constraint #8) and CommandCenter is a read-mostly mirror with approval-gated writes through the Action Broker; for **personal/solo** work, projects can be **LOCAL** — stored and owned entirely in CommandCenter Postgres — and both sources render in one unified interface (see §5.1). The relationship is exactly the email app's: *client UI + AI assistant + provider backend* — here the "providers" are PM tools instead of mailboxes, and "inbox zero" becomes **"mind like water."**

---

## 1. Part One — Understanding Getting Things Done (the method)

GTD (David Allen, 2001/2015) is a system for keeping commitments out of your head and in a **trusted external system**, so the mind is free to *engage* rather than *remember*. The goal state is **"mind like water"** — appropriate, proportional response to whatever shows up, no nagging background loops. Everything below is the canonical model the app must implement faithfully; the feature set in Part Two maps 1:1 onto it.

### 1.1 The five steps of workflow (the engine)

GTD is a pipeline. Each captured "thing" flows left to right exactly once.

```
 CAPTURE  →  CLARIFY  →  ORGANIZE  →  REFLECT  →  ENGAGE
(collect)  (process)   (put away)   (review)    (do)
```

1. **Capture** — Collect everything that has your attention ("open loops" / "stuff") into trusted *inboxes*. The only rule: get it 100% out of your head. Capture must be frictionless and ubiquitous (paper, voice, email-to-self, quick-add). Fewer inboxes is better; all must be emptied regularly.

2. **Clarify** — Process each inbox item to decide *what it is* and *what, if anything, to do about it*. This is the decision tree at the heart of GTD:
   - **Is it actionable?**
     - **No →** one of: **Trash** (no longer needed) · **Incubate** (Someday/Maybe — might do later) · **Reference** (no action, but useful info to file).
     - **Yes → What is the very next physical, visible action?** Then:
       - **< 2 minutes? → Do it now** (the *two-minute rule* — cheaper to do than to track).
       - **Someone else's? → Delegate it**, and put a marker on your **Waiting For** list.
       - **Longer, yours? → Defer it** — onto a **Next Actions** list (by context) or, if it's day/time-specific, the **Calendar**.
   - **Will the outcome take more than one action?** → It's a **Project**. Capture the desired outcome on the **Projects** list; the project itself is not "doable," only its next action is.

3. **Organize** — Put each clarified item where it belongs. The canonical lists/buckets:
   | Bucket | Holds | Notes |
   |---|---|---|
   | **Projects** | Every outcome needing >1 action | A GTD project is *lightweight* — "more than one step," not a formal PM project. |
   | **Next Actions** | Single physical next steps, **grouped by context** | The workhorse list. |
   | **Calendar** | Day/time-specific actions + day-specific info | The "hard landscape" — only things that *must* happen on that day/time. |
   | **Waiting For** | Things delegated / blocked on others | Each entry: who, what, since-when. |
   | **Someday/Maybe** | Incubated, not committed | Reviewed weekly so nothing is lost. |
   | **Reference** | Non-actionable info worth keeping | Not a task system — a filing system. |
   | **Project Support** | Material attached to a project | Notes, docs, links per project. |

   **Contexts** (the `@` lists) are the GTD innovation that makes Next Actions usable: actions are grouped by *what you need to perform them* — `@calls`, `@computer`, `@errands`, `@office`, `@home`, `@agenda-[person]`, `@waiting`. You work a context list when you're in that context.

4. **Reflect** — Review the system often enough to *trust* it. The cornerstone is the **Weekly Review**, three movements:
   - **Get Clear** — empty all inboxes, process notes, get to zero.
   - **Get Current** — review Next Actions, Calendar (past + upcoming), Waiting For, and the Projects list; make sure every active project has a next action.
   - **Get Creative** — review Someday/Maybe and add new ideas; review higher horizons.

5. **Engage** — Choose what to do *now* with confidence. Three models guide the choice:
   - **Four-criteria model** for the moment: **Context** (where am I / what tools) → **Time available** → **Energy available** → **Priority**.
   - **Threefold model** of daily work: doing *predefined* work (your lists), doing work *as it shows up* (ad hoc), and *defining* work (processing inboxes).
   - **Six Horizons of Focus** for perspective (review altitudes):

     | Altitude | Horizon | Meaning |
     |---|---|---|
     | Runway | **Ground** | Current next actions |
     | 10,000 ft | **H1** | Current projects |
     | 20,000 ft | **H2** | Areas of focus & accountability (roles you maintain) |
     | 30,000 ft | **H3** | Goals (1–2 years) |
     | 40,000 ft | **H4** | Vision (3–5 years) |
     | 50,000 ft | **H5** | Purpose & principles (why you exist) |

### 1.2 The Natural Planning Model (how GTD plans a project)

For any project that needs thought, GTD plans the way the mind naturally does:
**Purpose & principles → Outcome / vision (wild success) → Brainstorm → Organize → Identify the next action.** The app's "define a project" flow should follow these five steps, and the agent is well suited to drive the brainstorm/organize steps.

### 1.3 Key principles the app must honor

- **Capture friction = system failure.** If capture isn't trivial, people keep loops in their head and trust collapses.
- **"Next action" is the unit of execution.** Every active project must always have a defined, physical next action — the single most common GTD failure is a project with no next action.
- **The system must be trusted, complete, and current** — otherwise the mind won't let go. The Weekly Review is what sustains trust.
- **Outcomes vs. actions** are tracked separately (Projects list vs. Next Actions list) but linked.
- **Contexts over priorities** for selection in the moment; priority is only the 4th of the four criteria.

---

## 2. Part Two — High-level feature set (GTD → app)

Each GTD step becomes a first-class surface in the app. This is the product's feature spine.

| # | Feature (app surface) | GTD step it implements | Email-app analogue |
|---|---|---|---|
| **F1** | **Capture Bar / Universal Inbox** — frictionless quick-add from anywhere (v1: global hotkey + chat-to-task + email-to-task; voice + mobile later — see Q3); one unified inbox aggregating every connected workspace plus LOCAL. | Capture | Compose / unified inbox |
| **F2** | **Clarify (AI triage)** — the agent walks each inbox item through the GTD decision tree and *proposes* the disposition: trash / reference / someday / next-action / project / delegate / do-now, with a concrete **next action** and **outcome** drafted. User approves or edits. | Clarify | AI Rules engine + "Clarify" classifier |
| **F3** | **Organize (Lists & Contexts)** — Next Actions by `@context`, Projects, Waiting For, Calendar, Someday/Maybe, Reference. Drag/keyboard reorganize; context & energy tagging. | Organize | Folders / labels / categories |
| **F4** | **Engage ("Now" view)** — focused execution surface that filters by Context + Time + Energy + Priority and shows "what should I do right now." | Engage | (new — no email analogue) |
| **F5** | **Reflect (Weekly Review wizard)** — an agent-guided three-phase review (Get Clear / Current / Creative) that walks every list, flags projects with no next action, surfaces stale waiting-fors, and produces a review summary. | Reflect | Digest |
| **F6** | **Delegate & Monitor ("Waiting-For Zero")** — delegate a task to a teammate (creates + assigns it in the PM tool), track it on Waiting For, monitor others' tasks/projects, detect blockers/overdue, and draft follow-up nudges. | Clarify→Delegate + Reflect | Reply Zero + follow-up drafting |
| **F7** | **Horizons of Focus** — Areas of Focus, Goals, Vision, Purpose; connect daily next actions up the altitude ladder, and review them on a cadence. | Engage/Reflect (higher altitudes) | (new) |
| **F8** | **Natural Planning** — "define a project" flow (purpose → outcome → brainstorm → organize → next action), agent-assisted. | (project planning) | Composer AI |
| **F9** | **Assistant chat + quick actions** — right-rail agent chat with GTD quick actions: *Process my inbox*, *What's my next action?*, *Run weekly review*, *What am I waiting on?*, *Plan this project*, *What's overdue across the team?* | all | AI Chat panel + quick actions |

---

## 3. Architecture

The Task Manager app reuses the email app's three-tier shape verbatim: **Control Plane app** → **Gateway routes** → **task ingestion/provider layer** → **Postgres canonical store**, with the **`task-manager` MAF agent** as the assistant. Writes to source systems go through the **Action Broker** (approval-gated; constraints C-03/C-04).

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONTROL PLANE (Next.js)                       │
│  /tasks — Task Manager App (GTD)                                 │
│  ┌──────────┬───────────────┬─────────────────┬──────────────┐  │
│  │ Lists &  │ Item List     │ Item Detail /   │  AI Chat     │  │
│  │ Contexts │ (Inbox / Next │ Clarify panel / │  Assistant   │  │
│  │ sidebar  │  / Waiting /  │ Project planner │  + quick     │  │
│  │ + Horizon│  Projects…)   │                 │  actions     │  │
│  └──────────┴───────────────┴─────────────────┴──────────────┘  │
│  /integrations — connect ANY PM workspace (API key/OAuth or MCP) │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP/SSE
┌──────────────────────────▼──────────────────────────────────────┐
│                     GATEWAY (FastAPI)                            │
│  /tasks/accounts      — CRUD PM-tool workspace connections       │
│  /tasks/items         — list/search/clarify/organize GTD items   │
│  /tasks/contexts      — context & list management                │
│  /tasks/projects      — projects + natural-planning              │
│  /tasks/waiting       — Waiting-For + delegation monitoring      │
│  /tasks/review        — weekly review run + summary              │
│  /tasks/sync          — manual sync trigger                      │
│  /tasks/ai/chat       — assistant chat (→ orchestrator, SSE)     │
│  /tasks/ai/quick-action — clarify-inbox / next-action / review…  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│         PROVIDER INTERFACE LAYER (apps/task_ingestion/)          │
│  ONE canonical contract: BaseTaskProvider (GTD model ↔ native)  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Connector kinds (a PM tool plugs in via EITHER):        │    │
│  │   • API connector  — REST/OAuth adapter per tool         │    │
│  │       e.g. ClickUp v2 (reuses skill-clickup-sync), Asana,│    │
│  │       Jira, Linear, Trello, Monday … (registry-driven)   │    │
│  │   • MCP connector  — generic adapter over the tool's MCP │    │
│  │       server; maps MCP tools → BaseTaskProvider methods  │    │
│  │  Per-provider descriptor: capabilities + field-map JSON  │    │
│  └─────────────────────────────────────────────────────────┘    │
│  Sync engine: polling + incremental (webhooks later), maps      │
│  provider tasks → gtd_items; two-way write-back via Action Broker│
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                     DATA STORE (Postgres)                        │
│  task_accounts · gtd_items · gtd_projects · gtd_contexts        │
│  gtd_waiting · gtd_horizons · gtd_reviews                       │
└─────────────────────────────────────────────────────────────────┘
```

> **PM-agnostic by design.** Nothing above the interface layer knows which PM tool is connected. A new backend is added by registering a **connector** (API or MCP) plus a **provider descriptor** (capabilities + field-map) — no changes to the schema, gateway, agent, or UI. ClickUp is the **first reference connector**, not the model.

### 3.1 Agent architecture (`agent-task-manager`, extended)

The agent already exists (`apps/agent-task-manager/`, read-only status Q&A over the first connected PM tool). We extend its tool surface from read-only status queries to the full GTD engine — mirroring how `agent-email-assistant` grew the inbox-zero tool surface. **The agent calls the canonical GTD tools, never a specific PM tool's API** — the interface layer resolves which connector (API or MCP) actually serves each call, so the agent is provider-agnostic.

**Where the tools live (so this is unambiguous to build):** the new GTD tools (`capture`/`clarify`/`organize`/`list_*`/`weekly_review`/…) are a **new skill, `skill-task-gtd`**, that operates on **our canonical store** (`gtd_*` tables) through the gateway `/tasks` API + the interface layer — *not* on any PM REST API. The **existing `skill-clickup-sync`** is *not* called directly by the agent for GTD operations any more; it is **wrapped as the reference ClickUp API connector inside the interface layer** (the layer is what syncs `gtd_items` ↔ ClickUp). The two legacy read-only tools (`get_task_status`, `list_project_tasks`) remain available for direct status Q&A during the transition.

```
EXISTING tools (first reference connector):
  get_task_status(task_id)              list_project_tasks(project_name)

NEW GTD tools (provider-agnostic — resolved by the interface layer):
  capture(text, source)                 → create inbox item (LOCAL or synced)
  clarify(item_id)                      → GTD decision-tree proposal (structured)
  organize(item_id, disposition, fields)→ apply clarify decision
  next_action(context?, time?, energy?) → recommend what to do now (4-criteria)
  list_inbox() / list_next(context)     list_waiting() / list_someday() / list_projects()
  define_project(outcome)               → natural-planning → outcome + next actions
  delegate(item_id, assignee)           → assign in the connected PM tool + add to Waiting For
  monitor_delegated(person?)            → status of delegated/others' tasks + blockers
  draft_follow_up(waiting_id)           → nudge message for a stale waiting-for
  weekly_review()                       → 3-phase review, returns structured summary
  review_horizons(level)                → surface Areas/Goals/Vision items

Injected tools (from executor): memory (Mem0/Graphiti), web_search, call_agent
  → hand-off to `email-assistant` (send a nudge), `sales`, etc.
```

All writes (create/assign/move/close in the connected PM tool) flow through the **Action Broker** once it's live; until then they are **suggest-only** (draft the change, user applies) — consistent with C-04 and the email app's "create drafts, never auto-send" stance. Writes to **LOCAL** items/projects are direct (CommandCenter owns them).

---

## 4. Canonical GTD data model (Postgres)

The core decision (same as email): **sync provider tasks into a canonical Postgres store with a GTD-semantic overlay**, rather than proxying the PM API on every render. GTD semantics (disposition, context, energy, horizon link) live in *our* columns; for synced items the provider task is the source of truth for title/status/assignee/dates. **The schema is provider-agnostic** — `provider` is a free string registered at connect time, not an enum.

> **Implementation note (per `infra/postgres/README.md`).** This ships as **one** numbered migration — **`48_task_manager_gtd.sql`** (next free number; verify before writing) — and **must be idempotent**: every statement uses `CREATE TABLE/INDEX IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` because `apply_migrations.sh` re-runs all `02+` migrations on every deploy. After writing it, run `scripts/dump_schema.sh` and commit the refreshed `schema.generated.sql`. The DDL below is **grouped by concern for readability, not apply order** — the real migration must create tables in **FK-dependency order**: `gtd_contexts` → `gtd_horizons` → `gtd_projects` (FK→horizons) → `gtd_items` (FK→projects, horizons) → `gtd_waiting` (FK→items) → `task_accounts` (independent) → `gtd_reviews` (independent). (`IF NOT EXISTS` is shown only on the first table below to keep the listing readable; apply it to every object.)

```sql
-- A connected PM-tool workspace (multi-account, multi-provider, like email_accounts)
CREATE TABLE IF NOT EXISTS task_accounts (   -- apply IF NOT EXISTS to every object below too
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,              -- free string: 'clickup' | 'asana' | 'jira' | 'linear' | 'monday' | …
    connector_kind TEXT NOT NULL DEFAULT 'api', -- 'api' (REST/OAuth adapter) | 'mcp' (talks to the tool's MCP server)
    workspace_id TEXT NOT NULL,          -- provider-native workspace/team/cloud id
    label TEXT,                          -- display name e.g. 'Fracktal ClickUp'
    credentials_encrypted TEXT NOT NULL, -- AES-256-GCM JSON blob (api key / oauth / mcp endpoint+auth)
    capabilities JSONB DEFAULT '{}',     -- what this backend supports (create, assign, custom_fields, members, webhooks…)
    field_map JSONB DEFAULT '{}',        -- canonical GTD field ↔ native field mapping (status, context, project, assignee)
    sync_enabled BOOLEAN DEFAULT true,
    sync_interval_secs INTEGER DEFAULT 300,
    last_synced_at TIMESTAMPTZ,
    last_delta_token TEXT,               -- provider incremental cursor
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, provider, workspace_id)
);

-- The unified GTD item cache (the "task_messages" of this app)
CREATE TABLE gtd_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source TEXT NOT NULL DEFAULT 'LOCAL',-- 'LOCAL' (GTD-only, we own it) | 'SYNCED' (mirrors a connected provider)
    account_id UUID REFERENCES task_accounts(id) ON DELETE CASCADE, -- NULL for LOCAL; which provider for SYNCED
    provider_task_id TEXT,               -- native id; NULL for LOCAL items (we are source of truth)
    provider_url TEXT,
    title TEXT NOT NULL,
    description TEXT,
    -- GTD overlay (ours)
    disposition TEXT DEFAULT 'INBOX',    -- INBOX | NEXT | WAITING | SOMEDAY | PROJECT | REFERENCE | DONE | TRASH
                                         -- (no CALENDAR bucket: the Calendar is a VIEW over date-specific actions —
                                         --  a calendar item keeps its disposition + carries is_hard_date=true & due_at)
    next_action TEXT,                    -- the clarified physical next action
    context TEXT,                        -- '@computer' | '@calls' | '@errands' | '@agenda:<person>' ...
    energy TEXT,                         -- 'low' | 'medium' | 'high'
    time_estimate_mins INT,
    is_two_minute BOOLEAN DEFAULT false,
    project_id UUID REFERENCES gtd_projects(id) ON DELETE SET NULL,
    horizon_id UUID REFERENCES gtd_horizons(id) ON DELETE SET NULL,
    -- Mirrored from provider (provider is source of truth)
    provider_status TEXT,
    assignee JSONB,                      -- {name, email, provider_user_id}
    is_mine BOOLEAN DEFAULT true,        -- false = someone else's task we monitor
    due_at TIMESTAMPTZ,
    is_hard_date BOOLEAN DEFAULT false,  -- true → belongs on the Calendar (hard landscape)
    completed_at TIMESTAMPTZ,
    clarified_at TIMESTAMPTZ,            -- when it left the inbox
    synced_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
-- Provider items are unique by native id; LOCAL items are identified by the UUID PK.
CREATE UNIQUE INDEX uq_gtd_items_provider ON gtd_items(account_id, provider_task_id)
    WHERE source <> 'LOCAL';
CREATE INDEX idx_gtd_items_inbox ON gtd_items(disposition, synced_at);
CREATE INDEX idx_gtd_items_context ON gtd_items(context, disposition) WHERE disposition = 'NEXT';
CREATE INDEX idx_gtd_items_search ON gtd_items USING GIN(to_tsvector('english', coalesce(title,'')||' '||coalesce(description,'')));

-- GTD projects (lightweight: an outcome needing >1 action)
CREATE TABLE gtd_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source TEXT NOT NULL DEFAULT 'LOCAL',-- 'LOCAL' (GTD-only, we own it) | 'SYNCED' (mirrors a connected provider)
    account_id UUID REFERENCES task_accounts(id) ON DELETE CASCADE, -- NULL for LOCAL projects
    provider_ref TEXT,                   -- native project/list/epic id; NULL for LOCAL
    outcome TEXT NOT NULL,               -- the "wild success" statement
    purpose TEXT,                        -- natural-planning: why
    status TEXT DEFAULT 'ACTIVE',        -- ACTIVE | SOMEDAY | DONE | DROPPED
    horizon_id UUID REFERENCES gtd_horizons(id) ON DELETE SET NULL,
    has_next_action BOOLEAN DEFAULT false, -- the cardinal GTD health check
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Waiting-For (delegated / blocked items) — the delegation+monitoring core
CREATE TABLE gtd_waiting (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES gtd_items(id) ON DELETE CASCADE,
    waiting_on JSONB NOT NULL,           -- {name, email, provider_user_id}
    delegated_at TIMESTAMPTZ NOT NULL,
    expected_by TIMESTAMPTZ,
    last_nudged_at TIMESTAMPTZ,
    resolved BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_gtd_waiting_open ON gtd_waiting(resolved, expected_by) WHERE resolved = false;

-- Contexts, Horizons of Focus, Weekly Reviews
CREATE TABLE gtd_contexts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL, name TEXT NOT NULL, icon TEXT, sort_order INT DEFAULT 0,
    UNIQUE(user_id, name)
);
CREATE TABLE gtd_horizons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    level INT NOT NULL,                  -- 2=Areas · 3=Goals · 4=Vision · 5=Purpose
                                         -- (Ground=current actions=gtd_items; H1=Projects=gtd_projects — not duplicated here)
    title TEXT NOT NULL, notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE gtd_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    ran_at TIMESTAMPTZ DEFAULT now(),
    summary JSONB,                       -- counts cleared, projects w/o next action, stale waiting-fors
    created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 5. Backend integration — the provider interface layer (PM-agnostic)

This is the crux of the "brainstorm." GTD is a *semantic* model; every PM tool has a *different* native schema and a *different* way in (REST, OAuth, or an MCP server). We do **not** build the app around any one tool. Instead we define **one canonical contract — `BaseTaskProvider` — and an interface layer that adapts any backend to it**, via either an API connector or an MCP connector. Everything above the interface layer (schema, gateway, agent, UI) is provider-agnostic. ClickUp is simply the first connector we ship.

### 5.1 Dual-source model — LOCAL vs SYNCED, one interface

**Projects and tasks come from two sources, rendered in a single unified interface.** GTD projects are **first-class and at the same level as a provider's projects** — not subtasks.

> **Reconciling with §1.1.** GTD *semantically* defines a project as merely "any outcome needing >1 action" (lightweight). That is the **clarify-time test** the agent applies — it does **not** mean a GTD project is a sub-object. Once something is a project, we **store** it as a first-class `gtd_projects` row at the same level as a provider's project object. So: lightweight *concept*, first-class *representation*. The two statements are not in conflict.

The difference between the two sources is *where the project/task is stored and who is the source of truth*:

| Source | Source of truth | When | Storage |
|---|---|---|---|
| **LOCAL** (GTD-only) | **CommandCenter Postgres** | Personal / solo work only *I* touch | `gtd_projects`/`gtd_items` with `source='LOCAL'`, no provider ref. Full CRUD locally. |
| **SYNCED** (mirrored) | **The connected PM tool** (whichever) | Collaborative work involving other people | The provider is authoritative; a local copy in `gtd_*` **auto-syncs** both ways through the interface layer. |

Rules of the model (from the product owner):
- **Default sync target by collaboration.** Anything collaborated on → **the connected PM tool**. Anything purely personal/solo → **LOCAL**. The agent applies this default; the user can override.
- **Decide at add-time.** When a task or project is captured/created, the app resolves its **sync target** (LOCAL vs which connected provider). Captured *inbox* items can stay LOCAL until clarified, then commit to a target. If several PM tools are connected, the target includes *which* provider/workspace.
- **Projects not in any connected tool are created and tracked locally** — they live entirely in Postgres and never leave CommandCenter unless promoted.
- **Promotion (LOCAL → SYNCED).** A personal project that gains collaborators can be **pushed to a connected PM tool**: create it there (Action-Broker-gated), flip `source` to `SYNCED`, set `account_id` + `provider_ref`, and start two-way sync. (Demotion is possible but rare; not v1.)
- **Unified queries.** Every list/view (`Inbox`, `Next`, `Projects`, `Waiting`, …) reads across all sources; `source`/provider is just a badge/filter, not a separate app.

```
                    ┌──────────── /tasks unified interface ────────────┐
   capture/clarify  │  Inbox · Next@ctx · Projects · Waiting · Someday  │
        │           └───────────────┬───────────────┬──────────────────┘
        ▼                           │               │
  decide sync target          LOCAL projects   SYNCED projects (any connected tool)
  (collab? → PM tool)         (Postgres only)  (provider = SoT, local mirror auto-syncs)
                                                      ▲
                              interface layer ── two-way sync via Action Broker
```

### 5.2 The interface layer — connect any PM tool via API or MCP

A backend is plugged in by registering a **connector** plus a **provider descriptor**. The connector is one of two kinds; the descriptor tells the layer what the backend can do and how its fields map to GTD.

**Connector kinds:**

| Kind | How it connects | Implementation | Use when |
|---|---|---|---|
| **API connector** | The tool's REST API + OAuth/API-key | A per-tool adapter implementing `BaseTaskProvider` with `httpx` (ClickUp v2 reuses `skill-clickup-sync/core.py`; Asana, Jira, Linear, Monday … each add an adapter). | The tool has a documented REST API and we want full control / webhooks. |
| **MCP connector** | The tool's **MCP server** | A single **generic `MCPTaskProvider`** that connects to the MCP endpoint, discovers its tools, and maps them onto the `BaseTaskProvider` methods (list/create/update/assign/members). Reuses CommandCenter's existing MCP plumbing (`mcp_servers=` config, ToolSearch). | The tool ships an MCP server, or we want zero-code onboarding of a new backend. |

**Provider descriptor** (stored per connection in `task_accounts.capabilities` + `field_map`):
- **`capabilities`** — what the backend supports: `{list, create, update, assign, custom_fields, members, others_tasks, webhooks, …}`. The layer reads this and **degrades gracefully** — e.g. a read-only or no-custom-fields backend still works as a GTD lens; missing capabilities just disable the corresponding write paths.
- **`field_map`** — the canonical GTD field ↔ native field mapping (which native status = `NEXT`/`WAITING`/`DONE`, which field carries `@context`, what object is a "project", how an assignee is referenced). This is what makes the mapping in §5.3 *configuration*, not code.

```
   agent / gateway / UI  ─────────────►  BaseTaskProvider (canonical contract)
                                                 │
                 ┌───────────────────────────────┼───────────────────────────────┐
                 ▼                                ▼                               ▼
        API connector (ClickUp)         API connector (Asana/Jira/…)      MCP connector (generic)
         httpx + OAuth/key                 httpx + OAuth                  talks to tool's MCP server
                 └───── descriptor: capabilities + field_map per connection ──────┘
```

A connection is created from `/integrations`: pick a provider (or "Generic MCP"), choose connector kind, supply credentials (API key/OAuth, or MCP endpoint+auth), and the layer probes capabilities + seeds a default field-map the user can tweak.

### 5.3 Construct mapping (examples — driven by each connection's field-map)

The GTD↔native mapping below is **illustrative**; the real mapping for each connection lives in its `field_map`. Columns show how three common tools *could* map — a new tool just supplies its own.

| GTD construct | ClickUp (example) | Asana (example) | Jira (example) | Notes |
|---|---|---|---|---|
| **Inbox** | status `Inbox` / custom field `gtd_disposition=INBOX` | "Inbox" section / `gtd` field | triage status / `gtd` field | Prefer a **custom field** `gtd_disposition` so we don't fight the tool's own statuses. |
| **Next Action** | status `Next` + dropdown `@context` | "Next" section + tag | status `Selected` + label | Context as **tag/label** or dropdown custom field. |
| **Context (`@`)** | Tag or dropdown custom field | Tag | Label / component | Free-form, user-defined set. |
| **Project (GTD)** | a **List/Project** (same level as a native project) | a **Project** | an **Epic** | First-class, *same level* as the tool's project object. A **LOCAL** project has no provider ref; a **SYNCED** project mirrors a real one. See §5.1. |
| **Waiting For** | status `Waiting` + assignee = other person | "Waiting" section + assignee | `Waiting`/`In Review` + assignee | Delegation = assign to someone else and mirror into `gtd_waiting`. |
| **Calendar (hard date)** | Due date + `is_hard_date` field | Due date | Due date | Only *must-happen-that-day* items. |
| **Someday/Maybe** | status `Someday` / "Someday" List | "Someday" section | Backlog status | Reviewed weekly. |
| **Reference** | Doc / not a task | doc/attachment | Confluence/attachment | Non-actionable → route to Docs or the entity graph / Mem0 memory, **not** the task list. |
| **Areas of Focus (H2)** | **Space** / Folder | Team / Portfolio | Project category | The roles you maintain. |
| **Goals (H3)** | **Goals** feature | **Goals** | (custom / Advanced Roadmaps) | Native goal objects where they exist; else `gtd_horizons`. |
| **Vision/Purpose (H4/H5)** | Doc / `gtd_horizons` | Doc | Doc | Mostly lives in our `gtd_horizons`; PM tools have no native slot. |

### 5.4 Why a canonical overlay (not raw pass-through)

The GTD layer (`disposition`, `context`, `energy`, `next_action`, horizon links) is **not natively representable** the same way across tools — and we don't want to pollute the customer's workspace with CommandCenter-only fields beyond a couple of opt-in custom fields. So:

- **Canonical store (`gtd_items`) holds the GTD overlay.** The provider holds title/status/assignee/dates as source of truth (for SYNCED items).
- **Two-way sync:** provider → canonical on every sync (status, assignee, dates); canonical → provider for the *few* fields we write back (a `gtd_disposition`/`@context` custom field if the user opts in, plus assignment on delegate, plus close/move on do/complete). All write-back is **Action-Broker-gated** and **capability-gated** (skipped if the backend doesn't support it).
- **Graceful degradation:** if a backend forbids custom fields or is read-only, the GTD overlay stays purely in CommandCenter and we never write it back — the app still works as a GTD lens over read-only data (the existing `agent-task-manager` already does read-only).

### 5.5 The canonical contract (`BaseTaskProvider`, mirrors `BaseEmailProvider`)

Both connector kinds (API and MCP) implement the *same* interface, so nothing upstream cares which is in play.

```python
class BaseTaskProvider:                                   # implemented by API adapters AND MCPTaskProvider
    descriptor: ProviderDescriptor                        # capabilities + field_map for this connection
    async def list_tasks(self, since: str | None) -> list[CanonicalTask]: ...
    async def get_task(self, provider_task_id: str) -> CanonicalTask: ...
    async def create_task(self, task: CanonicalTask) -> str: ...          # via Action Broker
    async def update_task(self, id: str, patch: dict) -> None: ...         # status/move/dates
    async def assign_task(self, id: str, assignee: str) -> None: ...       # delegation
    async def list_members(self) -> list[Member]: ...                      # for delegation+monitoring
    async def list_others_tasks(self, person: str) -> list[CanonicalTask]: # monitoring
    async def list_projects(self) -> list[CanonicalProject]: ...
# API: ClickUpProvider builds on skill-clickup-sync/core.py; AsanaProvider/JiraProvider/… add adapters.
# MCP: MCPTaskProvider connects to the tool's MCP server and maps discovered tools → these methods.
```

---

## 6. Delegation & monitoring — "Waiting-For Zero"

This is the explicitly-requested capability: not just *my* tasks, but **delegating to and monitoring other people's tasks/projects** from the central PM tool. It's the GTD **Waiting For** list, scaled to a team, and it mirrors the email app's **Reply Zero + follow-up drafting**.

| Capability | How it works |
|---|---|
| **Delegate** | `delegate(item_id, assignee)` → assign the task to a teammate in the PM tool (Action-Broker-gated write) → create a `gtd_waiting` row with `waiting_on`, `delegated_at`, `expected_by`. The item leaves my Next Actions, appears on my **Waiting For**. |
| **Monitor others' tasks** | Sync pulls tasks where `assignee != me` (`gtd_items.is_mine = false`) for the people/projects I track. A **Delegated / Team** view shows their status, due dates, and movement since last sync. |
| **Blocker & overdue detection** | Background pass flags `gtd_waiting` rows past `expected_by`, and others' tasks that are overdue or stalled (no status change in N days). Surfaced in the Weekly Review and as "What am I waiting on?" |
| **Follow-up drafting** | `draft_follow_up(waiting_id)` → agent drafts a nudge (chat / email / a comment on the task in whatever PM tool holds it). Hand-off to `email-assistant` via `call_agent` to actually send (draft-only until approved — same posture as Reply Zero). |
| **Project monitoring** | Roll up a tracked project's tasks: % done, overdue count, next milestone, who's blocking. The agent answers "What's the status of the Alpha project and who's behind?" with citations (extends the existing `list_project_tasks`). |

**Waiting-For Zero** is the goal state: every delegated item is either progressing, nudged, or escalated — nothing silently rotting.

> **What lands when (sequencing).** *Monitoring* others' tasks, *Waiting-For tracking*, blocker/overdue detection, and follow-up **drafting** are read-only/local and ship in **Phase 3**. The *delegation write* — actually assigning the task to a teammate in a connected PM tool — is a write to a source system, so it is **suggest-only until the Action Broker is live (Phase 4)**: until then we stage the assignment for one-click apply and record the Waiting-For locally. Delegating inherently makes work collaborative, so a delegated **LOCAL** item promotes to **SYNCED** — and that promotion write is gated the same way.

---

## 7. Frontend (mirrors `/email`, GTD-shaped)

Same four-panel philosophy as the email app; different content.

```
src/app/tasks/
├── page.tsx                  — 4-panel GTD layout
├── components/
│   ├── ListsSidebar.tsx      — Inbox · Next (by @context) · Waiting · Projects · Calendar · Someday · Horizons
│   ├── CaptureBar.tsx        — universal quick-add (global hotkey)
│   ├── ItemList.tsx          — current list (inbox / context / project)
│   ├── ItemDetail.tsx        — item view + edit
│   ├── ClarifyPanel.tsx      — GTD decision-tree UI (agent proposal + approve/edit)
│   ├── ProjectPlanner.tsx    — natural-planning flow
│   ├── EngageView.tsx        — "Now": filter by context/time/energy/priority
│   ├── WeeklyReview.tsx      — 3-phase guided review wizard
│   ├── WaitingForView.tsx    — delegation + monitoring + follow-up drafts
│   ├── HorizonsView.tsx      — Areas / Goals / Vision / Purpose
│   ├── AssistantChat.tsx     — right-rail agent chat (reuse email's pattern)
│   └── QuickActions.tsx      — Process inbox · Next action · Weekly review · What am I waiting on?
├── hooks/  (useItems, useTaskAccounts, useAIChat — mirror email hooks)
└── lib/    (types, store (Zustand), api, utils)
```

UI must follow `workbench/control_plane/DESIGN_SYSTEM.md` and reuse shared components (`Tabs`, `FilterPills`, page headers) — no ad-hoc bars (AGENTS.md global convention).

---

## 8. API endpoints (gateway `routes/tasks/` package)

> Follows the email precedent — `routes/email/` is a package (`core.py`, `automation/`, `digest.py`, `transport/`), not a single file. `routes/tasks/` should likewise be a package (e.g. `core.py` for items/lists, `accounts.py`, `review.py`, `ai.py`).

| Method | Path | Description |
|---|---|---|
| `GET/POST/DELETE/PATCH` | `/tasks/accounts[/{id}]` | CRUD PM-tool connections (multi-account, multi-provider; connector_kind `api`\|`mcp`) |
| `GET` | `/tasks/providers` | Registered connector types + capability probe for a candidate connection |
| `GET` | `/tasks/items` | List/search items (disposition, context, account, page) |
| `POST` | `/tasks/items` | Capture a new inbox item |
| `GET/PATCH` | `/tasks/items/{id}` | Detail / organize (set disposition, context, next_action…) |
| `POST` | `/tasks/items/{id}/clarify` | Run agent clarify → proposal |
| `POST` | `/tasks/items/{id}/delegate` | Delegate + create Waiting-For |
| `GET` | `/tasks/contexts` · `/tasks/projects` · `/tasks/waiting` | List surfaces |
| `POST` | `/tasks/projects/plan` | Natural-planning for a project |
| `POST` | `/tasks/review` | Run weekly review → summary |
| `POST` | `/tasks/sync` | Manual sync trigger |
| `POST` | `/tasks/ai/chat` | Assistant chat (SSE) |
| `POST` | `/tasks/ai/quick-action` | clarify-inbox / next-action / review / monitor |
| `GET` | `/tasks/oauth/{provider}/authorize` · `/callback` | OAuth connect for API connectors (provider is dynamic) |

---

## 9. Implementation phases

### 9.1 UI-first build progress (frontend slices, on `main`)

> **Decision (2026-06-30):** build the `/tasks` Control Plane app **UI-first against mock data**, feature by feature, before any backend — mirroring how the email app was built (`lib/mockData` + Zustand store + components, wired to the gateway later). All frontend code lives in **`workbench/control_plane/src/app/tasks/`** (`lib/{types,mockData,taskStore,utils}.ts`, `components/`, `page.tsx`). No backend, schema, or gateway work has started yet.

| Slice | Feature(s) | Status | Key files |
|---|---|---|---|
| 0 — Shell | 4-panel layout | ✅ done | `page.tsx`, `ListsSidebar`, `AssistantRail` (framed) |
| 1 — Browse | F1 capture · F3 lists/contexts | ✅ done | `CaptureBar`, `ItemList`/`ItemRow`, `ProjectsList`, `ItemDetail`, `SourceBadge` |
| 2 — Clarify | F2 decision tree | ✅ done | `ClarifyPanel` + `taskStore.clarify` + mocked `suggestClarification` |
| 3 — Engage "Now" | F4 | 🔲 **NEXT** | filter Next Actions by context + time + energy; unlocks the `Engage · Now` nav (currently "soon") |
| 4 — Weekly Review | F5 | 🔲 | get-clear / get-current / get-creative wizard; surface no-next-action projects + stale waiting-fors |
| 5 — Waiting-For / Delegate | F6 | 🔲 | dedicated monitoring view (delegation already partly in Clarify) |
| 6 — Plan / Horizons | F8 · F7 | 🔲 | natural-planning project flow + Horizons (currently "soon") |
| 7 — Assistant wired | F9 | 🔲 | replace the mocked suggestion + rail with the live `task-manager` agent (stream + quick actions) |

**Commits on `main`:** shell+browse `9dfa571` · clarify `c26890f`.
**Resume here →** Slice 3 (Engage "Now"). After the UI slices feel right, start the backend at §9.2 Phase 1 (migration `48_*` + interface layer + gateway), then wire the mock store to the live API.

### 9.2 Backend phases (after the UI slices)

**Build order at a glance** — strictly dependency-ordered, so each step is independently shippable:
1. **Migration `48_task_manager_gtd.sql`** (the canonical store) → 2. **interface layer + ClickUp API connector** (read-only sync into `gtd_items`) → 3. **gateway `/tasks/` read endpoints** → 4. **`/tasks` UI shell** (ported from `/email`, read-only lens) → 5. **`skill-task-gtd` + extend `agent-task-manager`**. Everything in Phase 1 is **read-only**; no writes to source systems, so nothing is blocked on the Action Broker. Capture/LOCAL-CRUD/clarify (Phase 2) and delegation-write (Phase 4) come after.

### Phase 1 — Foundation (interface layer + read-only GTD lens)
- [ ] This plan (done) + DOX index updates.
- [ ] `task_accounts` + `gtd_items` + `gtd_projects` + `gtd_waiting` + `gtd_contexts`/`gtd_horizons`/`gtd_reviews` schema (numbered migration), incl. the `source` (LOCAL/SYNCED) discriminator, nullable provider linkage, and the per-connection `capabilities`/`field_map` descriptor.
- [ ] Gateway `routes/tasks/` package skeleton + `/tasks/providers` capability probe.
- [ ] `apps/task_ingestion/` **interface layer**: `BaseTaskProvider` contract + connector registry + provider descriptor (capabilities + field-map).
- [ ] **First API connector — ClickUp** (reuse `skill-clickup-sync/core.py`) as the reference implementation; sync → `gtd_items` (read-only; `is_mine` + others' tasks).
- [ ] `/tasks` Control Plane app ported from the email 4-panel shell (mock → live).
- [ ] Extend `agent-task-manager` instructions/tools toward the (provider-agnostic) GTD surface.

### Phase 2 — Capture + Clarify + Organize + generic MCP connector
- [ ] Capture bar + universal inbox (F1).
- [ ] **LOCAL project/task CRUD** — create & track personal/solo projects entirely in Postgres (`source='LOCAL'`).
- [ ] **Sync-target resolution** at add/clarify time — default LOCAL vs a connected provider by collaboration; user override; **promotion** LOCAL→SYNCED when a project gains collaborators (§5.1).
- [ ] **Generic `MCPTaskProvider`** — connect any PM tool that exposes an MCP server; map its tools → `BaseTaskProvider`; `/integrations` "Generic MCP" connect flow + capability probe.
- [ ] Agent **clarify** tool + ClarifyPanel — GTD decision tree with structured output (F2). Pattern-match the email AI-rules engine's "NL → structured" design.
- [ ] Organize: Next-Actions-by-context, Projects, Calendar, Someday, Reference routing (F3).
- [ ] Assistant chat + quick actions (F9).

### Phase 3 — Engage + Reflect + Delegate
- [ ] Engage "Now" view — 4-criteria selection (F4).
- [ ] Weekly Review wizard + `gtd_reviews` summary (F5).
- [ ] **Delegate & Monitor / Waiting-For Zero** (F6): monitor others' tasks, Waiting-For tracking, blocker/overdue detection, follow-up drafting via `call_agent` → `email-assistant`. *(Delegation write-back to a connected PM tool is suggest-only here — full write lands with the Action Broker in Phase 4. See §6.)*
- [ ] Natural-planning project flow (F8).

### Phase 4 — Horizons, more connectors, write-back
- [ ] Horizons of Focus (F7) + Goals mapping.
- [ ] Additional **API connectors** (Asana / Jira / Linear / Monday …) — each just an adapter + default field-map.
- [ ] Two-way write-back through the **Action Broker** (capability-gated: assignment, status/move, opt-in custom fields). Until then: suggest-only.
- [ ] Webhook/push sync (per-provider, where the descriptor advertises `webhooks`) replacing polling.

> **Sequencing note:** autonomous write-back to any connected PM tool is **blocked on the Action Broker** (project plan Phase 4 / WBS 2.4). Phases 1–3 here are read + suggest-only, which fits the current platform state and constraints C-03/C-04. This app is a natural **M3 (Full Agent Ecosystem)** workstream alongside the email app.

---

## 10. Key design decisions

| Decision | Rationale |
|---|---|
| **PM-agnostic interface layer; connect via API or MCP** | One `BaseTaskProvider` contract; a backend plugs in as an **API connector** (REST/OAuth adapter) or a generic **MCP connector** (talks to the tool's MCP server), described by a per-connection `capabilities`+`field_map`. Nothing upstream knows which tool is connected. ClickUp is the first connector, not the model. See §5.2. |
| **Dual-source, one interface: LOCAL (Postgres SoT) vs SYNCED (mirrored)** | Personal/solo projects live only in CommandCenter; collaborative projects mirror whichever PM tool holds them. Sync target chosen at add-time, default by collaboration, promotable LOCAL→SYNCED. All sources render in one unified `/tasks` UI. See §5.1. |
| **GTD overlay in canonical Postgres; for synced projects, the PM tool = source of truth** | Same as email (`email_messages`): fast queries, FTS, offline, and GTD semantics that don't exist natively. Honors constraint #8 (read-mostly mirror) for SYNCED items; LOCAL items are wholly ours. |
| **Mapping is config (`field_map`), not code** | Each connection declares how GTD fields map to its native schema, so new tools need no schema/UI/agent changes — just an adapter (or nothing, for MCP) + a default field-map. |
| **Agent does Clarify/Organize cognition** | The GTD "thinking" (next action, project detection, context tagging) is exactly an LLM strength; user stays in approve/edit control — same posture as the email AI-rules engine. |
| **Writes via Action Broker, suggest-only until then** | Constraints C-03/C-04. Mirrors email's "create drafts, never auto-send." |
| **Reuse `agent-task-manager` + `skill-clickup-sync` as the first connector** | Don't fork; extend the existing agent's tool surface (like `agent-email-assistant` grew) and wrap the existing ClickUp skill as the reference API connector. |
| **Delegation = Waiting-For + monitoring, modeled on Reply Zero** | Proven pattern in the email app; "Waiting-For Zero" is "Reply Zero" for tasks. |
| **Custom field `gtd_disposition`/`@context` is opt-in** | Avoid polluting customer workspaces; degrade to CC-only overlay if disallowed. |

---

## 11. Risks & open questions

| Risk / question | Note |
|---|---|
| **R1 — GTD project granularity (RESOLVED 2026-06-30)** | GTD projects are **first-class, same level as a provider's projects** — not subtasks. Each project/task has a **source**: `LOCAL` (personal/solo, Postgres = SoT) or `SYNCED` (collaborative, mirrors a connected PM tool). Both render in one unified interface; sync target is chosen at add-time, default by collaboration, promotable. See §5.1. |
| **R2 — Multi-user tool scoping** | Same caveat the email app hit: agent tools must resolve "which user" reliably (ContextVar + `ACB_AGENT_USER_EMAIL` fallback). Fine single-user; needs work for multi-user. |
| **R3 — Write-back depends on Action Broker** | Phases 1–3 are read/suggest-only by design; full two-way write is gated on WBS 2.4. |
| **R4 — Capability variance across backends** | Tools differ wildly (custom fields, members, others'-tasks, webhooks). Handled by the per-connection `capabilities` descriptor + graceful degradation — missing capabilities disable only the matching write paths. |
| **R5 — MCP-server quality varies** | A tool's MCP server may expose an incomplete/unstable tool surface (e.g. no assignment or no incremental list). The capability probe must detect this and fall back to read-only; prefer an API connector when the MCP surface is too thin. |
| **R6 — Provider API/MCP quota + rate limits** | All backends rate-limit; reuse the email app's incremental-sync + backoff approach per connector. |
| **Q1 — Which API connectors after ClickUp?** | Asana / Jira / Linear / Monday — driven by which tools we actually connect. (Codebase currently ClickUp-only.) |
| **Q2 — Calendar source** | Hard-date items → Google Calendar sync, or stay in-app? |
| **Q3 — Capture channels for v1** | Global hotkey + chat-to-task are cheap; email-to-task reuses the email app; voice/mobile later. |
| **Q4 — Default field-maps** | Ship curated default `field_map`s per known tool, or always probe + let the user confirm the mapping on connect? |

---

## 12. Success criteria (v1 — through Phase 3)

- [ ] User connects a PM workspace (ClickUp via API connector); their tasks + teammates' tracked tasks sync into `/tasks` within 5 min.
- [ ] **A second backend connects with no app changes** — via the generic MCP connector (or a second API adapter), proving the interface layer is provider-agnostic.
- [ ] **Dual source works in one view:** a personal LOCAL project and a collaborative SYNCED project both appear in the unified Projects list, badged by source; a LOCAL project can be promoted to a connected PM tool.
- [ ] **Capture** an item in < 5 seconds from a global hotkey; the app resolves its sync target (LOCAL vs which connected provider) with a sensible default.
- [ ] **Clarify**: the agent proposes a correct GTD disposition + a concrete next action for an inbox item; user approves with one click.
- [ ] **Organize**: Next Actions are browsable by `@context`; every active project shows whether it has a next action.
- [ ] **Engage**: "Now" view returns a sensible action given context + time + energy.
- [ ] **Reflect**: the Weekly Review wizard empties the inbox, flags projects with no next action, and lists stale waiting-fors.
- [ ] **Delegate & Monitor**: delegate a task to a teammate, see it on Waiting For, get an overdue flag, and get an agent-drafted follow-up nudge.
- [ ] Assistant answers "what's my next action?", "what am I waiting on?", and "what's overdue across the team?" with citations to the PM tool.
```
