# Task Manager App — Project Plan (GTD philosophy)

> **Product:** CommandCenter · **Feature:** Task Manager App (Getting Things Done) · **Updated:** 2026-06-30 · **Version:** 0.1 (planning)
> **Status:** 🔲 Planned — design only. No code yet. Builds on the existing `agent-task-manager` + `skill-clickup-sync` scaffolding.
> **Sibling spec:** [`email_ai_assistant.md`](email_ai_assistant.md) — the Task Manager app deliberately mirrors its architecture (multi-panel client + AI assistant + provider abstraction + Postgres sync + automation engine + follow-up tracking). Read it first; this doc reuses its patterns by reference.

---

## 0. One-paragraph thesis

The Task Manager app is the **"Getting Things Done" operating layer** on top of the company's real project-management tool (ClickUp first; Asana / Jira later). The app is the *methodology surface* — capture, clarify, organize, reflect, engage. The **`task-manager` MAF agent** is the *cognitive engine* — it does the GTD "clarify/organize" thinking a person normally does by hand (define the next action, detect projects, assign contexts, run the weekly review, draft delegation follow-ups). For **collaborative** work, ClickUp/Asana/Jira remain the **source of truth** (per CommandCenter constraint #8) and CommandCenter is a read-mostly mirror with approval-gated writes through the Action Broker; for **personal/solo** work, projects can be **LOCAL** — stored and owned entirely in CommandCenter Postgres — and both sources render in one unified interface (see §5.1). The relationship is exactly the email app's: *client UI + AI assistant + provider backend* — here the "providers" are PM tools instead of mailboxes, and "inbox zero" becomes **"mind like water."**

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
| **F1** | **Capture Bar / Universal Inbox** — frictionless quick-add from anywhere (global hotkey, chat-to-task, email-to-task, voice, mobile); one unified inbox aggregating every connected workspace. | Capture | Compose / unified inbox |
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
│  /integrations — connect ClickUp / Asana / Jira workspaces       │
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
│            TASK INGESTION (apps/task_ingestion/)                 │
│  Providers (canonical GTD model ↔ native PM schema):            │
│  ├── ClickUpProvider   (ClickUp REST v2 — builds on skill-clickup-sync) │
│  ├── AsanaProvider     (Asana REST)                             │
│  └── JiraProvider      (Jira Cloud REST)                        │
│  Sync engine: polling + incremental (webhooks later), maps      │
│  provider tasks → gtd_items, two-way write-back (via Action Broker)│
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                     DATA STORE (Postgres)                        │
│  task_accounts · gtd_items · gtd_projects · gtd_contexts        │
│  gtd_waiting · gtd_horizons · gtd_reviews                       │
└─────────────────────────────────────────────────────────────────┘
```

### 3.1 Agent architecture (`agent-task-manager`, extended)

The agent already exists (`apps/agent-task-manager/`, ClickUp Q&A only). We extend its tool surface from read-only status queries to the full GTD engine — mirroring how `agent-email-assistant` grew the inbox-zero tool surface.

```
EXISTING tools (skill-clickup-sync):
  get_task_status(task_id)              list_project_tasks(project_name)

NEW GTD tools (skill-task-gtd / extended skill-clickup-sync):
  capture(text, source)                 → create inbox item
  clarify(item_id)                      → GTD decision-tree proposal (structured)
  organize(item_id, disposition, fields)→ apply clarify decision
  next_action(context?, time?, energy?) → recommend what to do now (4-criteria)
  list_inbox() / list_next(context)     list_waiting() / list_someday() / list_projects()
  define_project(outcome)               → natural-planning → outcome + next actions
  delegate(item_id, assignee)           → assign in PM tool + add to Waiting For
  monitor_delegated(person?)            → status of delegated/others' tasks + blockers
  draft_follow_up(waiting_id)           → nudge message for a stale waiting-for
  weekly_review()                       → 3-phase review, returns structured summary
  review_horizons(level)                → surface Areas/Goals/Vision items

Injected tools (from executor): memory (Mem0/Graphiti), web_search, call_agent
  → hand-off to `email-assistant` (send a nudge), `sales`, etc.
```

All writes (create/assign/move/close in ClickUp/Asana/Jira) flow through the **Action Broker** once it's live; until then they are **suggest-only** (draft the change, user applies) — consistent with C-04 and the email app's "create drafts, never auto-send" stance.

---

## 4. Canonical GTD data model (Postgres)

The core decision (same as email): **sync provider tasks into a canonical Postgres store with a GTD-semantic overlay**, rather than proxying the PM API on every render. GTD semantics (disposition, context, energy, horizon link) live in *our* columns; the provider task is the source of truth for title/status/assignee/dates.

```sql
-- A connected PM-tool workspace (multi-account, like email_accounts)
CREATE TABLE task_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,              -- 'clickup' | 'asana' | 'jira'
    workspace_id TEXT NOT NULL,          -- ClickUp team / Asana workspace / Jira cloud id
    label TEXT,                          -- display name e.g. 'Fracktal ClickUp'
    credentials_encrypted TEXT NOT NULL, -- AES-256-GCM JSON blob (token/oauth)
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
    source TEXT NOT NULL DEFAULT 'LOCAL',-- 'LOCAL' (GTD-only) | 'CLICKUP' | 'ASANA' | 'JIRA'
    account_id UUID REFERENCES task_accounts(id) ON DELETE CASCADE, -- NULL for LOCAL items
    provider_task_id TEXT,               -- native id; NULL for LOCAL items (we are source of truth)
    provider_url TEXT,
    title TEXT NOT NULL,
    description TEXT,
    -- GTD overlay (ours)
    disposition TEXT DEFAULT 'INBOX',    -- INBOX | NEXT | WAITING | SOMEDAY | PROJECT | REFERENCE | CALENDAR | DONE | TRASH
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
    source TEXT NOT NULL DEFAULT 'LOCAL',-- 'LOCAL' (GTD-only) | 'CLICKUP' | 'ASANA' | 'JIRA'
    account_id UUID REFERENCES task_accounts(id) ON DELETE CASCADE, -- NULL for LOCAL projects
    provider_ref TEXT,                   -- ClickUp List/Project · Asana Project · Jira Epic; NULL for LOCAL
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
    level INT NOT NULL,                  -- 1=Projects .. 5=Purpose (see horizon table)
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

## 5. Backend integration — mapping GTD ↔ ClickUp / Asana / Jira

This is the crux of the "brainstorm." GTD is a *semantic* model; each PM tool has a *different* native schema. A **provider abstraction** (exactly like `BaseEmailProvider`) maps the canonical GTD model to each tool. The agent does the fuzzy translation; the provider does the API mechanics.

### 5.1 Dual-source model — LOCAL vs ClickUp, one interface

**Projects and tasks come from two sources, rendered in a single unified interface.** GTD projects are **first-class and at the same level as ClickUp projects** — not subtasks. The difference is *where the project/task is stored and who is the source of truth*:

| Source | Source of truth | When | Storage |
|---|---|---|---|
| **LOCAL** (GTD-only) | **CommandCenter Postgres** | Personal / solo work only *I* touch | `gtd_projects`/`gtd_items` with `source='LOCAL'`, no provider ref. Full CRUD locally. |
| **CLICKUP** (mirrored) | **ClickUp** | Collaborative work involving other people | ClickUp is authoritative; a local copy in `gtd_*` **auto-syncs** both ways. |

Rules of the model (from the product owner):
- **Default sync target by collaboration.** Anything collaborated on → **ClickUp**. Anything purely personal/solo → **LOCAL**. The agent applies this default; the user can override.
- **Decide at add-time.** When a task or project is captured/created, the app resolves its **sync target** (LOCAL vs ClickUp). Captured *inbox* items can stay LOCAL until clarified, then commit to a target.
- **Projects not in ClickUp are created and tracked locally** — they live entirely in Postgres and never leave CommandCenter unless promoted.
- **Promotion (LOCAL → ClickUp).** A personal project that gains collaborators can be **pushed to ClickUp**: create it there (Action-Broker-gated), flip `source` to `CLICKUP`, store the `provider_ref`, and start two-way sync. (Demotion is possible but rare; not v1.)
- **Unified queries.** Every list/view (`Inbox`, `Next`, `Projects`, `Waiting`, …) reads across both sources; `source` is just a badge/filter, not a separate app.

```
                    ┌──────────── /tasks unified interface ────────────┐
   capture/clarify  │  Inbox · Next@ctx · Projects · Waiting · Someday  │
        │           └───────────────┬───────────────┬──────────────────┘
        ▼                           │               │
  decide sync target          LOCAL projects   CLICKUP projects
  (collab? → ClickUp)         (Postgres only)  (ClickUp = SoT, local mirror auto-syncs)
                                                      ▲
                                          two-way sync via Action Broker
```

### 5.2 Construct mapping

| GTD construct | ClickUp | Asana | Jira | Notes |
|---|---|---|---|---|
| **Inbox** | Tasks with status `Inbox` in a dedicated "Inbox" List, or a custom field `gtd_disposition=INBOX` | Tasks in an "Inbox" section / `gtd` custom field | Issues in a triage status / `gtd` field | Recommend a **custom field** `gtd_disposition` so we don't fight the tool's own statuses. |
| **Next Action** | status `Next` + custom dropdown `@context` | section "Next" + tag context | status `Selected` + label context | Context as **tag/label** or dropdown custom field. |
| **Context (`@`)** | Tag or dropdown custom field | Tag | Label / component | Free-form, user-defined set. |
| **Project (GTD)** | A **List/Project** (same level as a ClickUp project) | A **Project** | An **Epic** | First-class, *same level* as a ClickUp project. A **LOCAL** GTD project has no provider ref and lives only in Postgres; a **CLICKUP** project mirrors a real ClickUp project. See §5.1. |
| **Waiting For** | status `Waiting` + assignee = other person | section "Waiting" + assignee | status `Waiting`/`In Review` + assignee | Delegation = assign to someone else and mirror into `gtd_waiting`. |
| **Calendar (hard date)** | Due date + `is_hard_date` custom field | Due date | Due date | Only *must-happen-that-day* items; sync to actual calendar later. |
| **Someday/Maybe** | status `Someday` or a "Someday" List | "Someday" section | Backlog status | Reviewed weekly. |
| **Reference** | ClickUp **Doc** / not a task | Asana doc/attachment | Confluence/attachment | Non-actionable → route to Docs or the entity graph / Mem0 memory, **not** the task list. |
| **Areas of Focus (H2)** | **Space** / Folder | Team / Portfolio | Project category | The roles you maintain. |
| **Goals (H3)** | ClickUp **Goals** feature | Asana **Goals** | (custom / Advanced Roadmaps) | Native goal objects where they exist. |
| **Vision/Purpose (H4/H5)** | Doc / `gtd_horizons` table | Doc | Doc | Mostly lives in our `gtd_horizons`; PM tools have no native slot. |

### 5.3 Why a canonical overlay (not raw pass-through)

The GTD layer (`disposition`, `context`, `energy`, `next_action`, horizon links) is **not natively representable** the same way across three tools — and we don't want to pollute the customer's ClickUp with CommandCenter-only fields beyond a couple of opt-in custom fields. So:

- **Canonical store (`gtd_items`) holds the GTD overlay.** Provider holds title/status/assignee/dates as source of truth.
- **Two-way sync:** provider → canonical on every sync (status, assignee, dates); canonical → provider for the *few* fields we write back (a `gtd_disposition` / `@context` custom field if the user opts in, plus assignment on delegate, plus close/move on do/complete). All write-back is **Action-Broker-gated**.
- **Graceful degradation:** if a workspace forbids custom fields, the GTD overlay stays purely in CommandCenter and we never write it back — the app still works as a GTD lens over read-only data (the existing `agent-task-manager` already does read-only).

### 5.4 Provider abstraction (mirrors `BaseEmailProvider`)

```python
class BaseTaskProvider:
    async def list_tasks(self, since: str | None) -> list[CanonicalTask]: ...
    async def get_task(self, provider_task_id: str) -> CanonicalTask: ...
    async def create_task(self, task: CanonicalTask) -> str: ...          # via Action Broker
    async def update_task(self, id: str, patch: dict) -> None: ...         # status/move/dates
    async def assign_task(self, id: str, assignee: str) -> None: ...       # delegation
    async def list_members(self) -> list[Member]: ...                      # for delegation+monitoring
    async def list_others_tasks(self, person: str) -> list[CanonicalTask]: # monitoring
# ClickUpProvider builds directly on the existing skill-clickup-sync core.py (already hits ClickUp v2).
```

---

## 6. Delegation & monitoring — "Waiting-For Zero"

This is the explicitly-requested capability: not just *my* tasks, but **delegating to and monitoring other people's tasks/projects** from the central PM tool. It's the GTD **Waiting For** list, scaled to a team, and it mirrors the email app's **Reply Zero + follow-up drafting**.

| Capability | How it works |
|---|---|
| **Delegate** | `delegate(item_id, assignee)` → assign the task to a teammate in the PM tool (Action-Broker-gated write) → create a `gtd_waiting` row with `waiting_on`, `delegated_at`, `expected_by`. The item leaves my Next Actions, appears on my **Waiting For**. |
| **Monitor others' tasks** | Sync pulls tasks where `assignee != me` (`gtd_items.is_mine = false`) for the people/projects I track. A **Delegated / Team** view shows their status, due dates, and movement since last sync. |
| **Blocker & overdue detection** | Background pass flags `gtd_waiting` rows past `expected_by`, and others' tasks that are overdue or stalled (no status change in N days). Surfaced in the Weekly Review and as "What am I waiting on?" |
| **Follow-up drafting** | `draft_follow_up(waiting_id)` → agent drafts a nudge (chat/email/ClickUp comment). Hand-off to `email-assistant` via `call_agent` to actually send (draft-only until approved — same posture as Reply Zero). |
| **Project monitoring** | Roll up a tracked project's tasks: % done, overdue count, next milestone, who's blocking. The agent answers "What's the status of the Alpha project and who's behind?" with citations (extends the existing `list_project_tasks`). |

**Waiting-For Zero** is the goal state: every delegated item is either progressing, nudged, or escalated — nothing silently rotting.

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

## 8. API endpoints (gateway `routes/tasks.py`)

| Method | Path | Description |
|---|---|---|
| `GET/POST/DELETE/PATCH` | `/tasks/accounts[/{id}]` | CRUD PM-tool workspace connections (multi-account) |
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
| `GET` | `/tasks/oauth/{provider}/authorize` · `/callback` | OAuth connect (ClickUp/Asana/Jira) |

---

## 9. Implementation phases

### Phase 1 — Foundation (boilerplate + read-only GTD lens)
- [ ] This plan (done) + DOX index updates.
- [ ] `task_accounts` + `gtd_items` + `gtd_projects` + `gtd_waiting` + `gtd_contexts`/`gtd_horizons`/`gtd_reviews` schema (numbered migration), incl. the `source` (LOCAL/CLICKUP/…) discriminator and nullable provider linkage.
- [ ] Gateway `routes/tasks.py` skeleton.
- [ ] `apps/task_ingestion/` provider abstraction + **ClickUpProvider** (reuse `skill-clickup-sync/core.py`).
- [ ] ClickUp sync → `gtd_items` (read-only; `is_mine` + others' tasks).
- [ ] `/tasks` Control Plane app ported from the email 4-panel shell (mock → live).
- [ ] Extend `agent-task-manager` instructions/tools toward the GTD surface.

### Phase 2 — Capture + Clarify + Organize (the GTD core)
- [ ] Capture bar + universal inbox (F1).
- [ ] **LOCAL project/task CRUD** — create & track personal/solo projects entirely in Postgres (`source='LOCAL'`).
- [ ] **Sync-target resolution** at add/clarify time — default LOCAL vs CLICKUP by collaboration; user override; **promotion** LOCAL→ClickUp when a project gains collaborators (§5.1).
- [ ] Agent **clarify** tool + ClarifyPanel — GTD decision tree with structured output (F2). Pattern-match the email AI-rules engine's "NL → structured" design.
- [ ] Organize: Next-Actions-by-context, Projects, Calendar, Someday, Reference routing (F3).
- [ ] Assistant chat + quick actions (F9).

### Phase 3 — Engage + Reflect + Delegate
- [ ] Engage "Now" view — 4-criteria selection (F4).
- [ ] Weekly Review wizard + `gtd_reviews` summary (F5).
- [ ] **Delegate & Monitor / Waiting-For Zero** (F6): delegate, monitor others' tasks, blocker/overdue detection, follow-up drafting via `call_agent` → `email-assistant`.
- [ ] Natural-planning project flow (F8).

### Phase 4 — Horizons, multi-provider, write-back
- [ ] Horizons of Focus (F7) + Goals mapping.
- [ ] **AsanaProvider** + **JiraProvider**.
- [ ] Two-way write-back through the **Action Broker** (assignment, status/move, opt-in custom fields). Until then: suggest-only.
- [ ] Webhook/push sync (ClickUp webhooks) replacing polling.

> **Sequencing note:** autonomous write-back to ClickUp/Asana/Jira is **blocked on the Action Broker** (project plan Phase 4 / WBS 2.4). Phases 1–3 here are read + suggest-only, which fits the current platform state and constraints C-03/C-04. This app is a natural **M3 (Full Agent Ecosystem)** workstream alongside the email app.

---

## 10. Key design decisions

| Decision | Rationale |
|---|---|
| **Dual-source, one interface: LOCAL (Postgres SoT) vs CLICKUP (mirrored)** | Personal/solo projects live only in CommandCenter; collaborative projects mirror ClickUp. Sync target chosen at add-time, default by collaboration, promotable LOCAL→ClickUp. All sources render in one unified `/tasks` UI. See §5.1. |
| **GTD overlay in canonical Postgres; for synced projects, PM tool = source of truth** | Same as email (`email_messages`): fast queries, FTS, offline, and GTD semantics that don't exist natively. Honors constraint #8 (read-mostly mirror) for the CLICKUP source; LOCAL items are wholly ours. |
| **Provider abstraction (ClickUp/Asana/Jira)** | Direct parallel to `BaseEmailProvider`. ClickUp first (skill + agent already exist). |
| **Agent does Clarify/Organize cognition** | The GTD "thinking" (next action, project detection, context tagging) is exactly an LLM strength; user stays in approve/edit control — same posture as the email AI-rules engine. |
| **Writes via Action Broker, suggest-only until then** | Constraints C-03/C-04. Mirrors email's "create drafts, never auto-send." |
| **Reuse `agent-task-manager` + `skill-clickup-sync`** | Don't fork; extend the existing agent's tool surface (like `agent-email-assistant` grew). |
| **Delegation = Waiting-For + monitoring, modeled on Reply Zero** | Proven pattern in the email app; "Waiting-For Zero" is "Reply Zero" for tasks. |
| **Custom field `gtd_disposition`/`@context` is opt-in** | Avoid polluting customer workspaces; degrade to CC-only overlay if disallowed. |

---

## 11. Risks & open questions

| Risk / question | Note |
|---|---|
| **R1 — GTD project granularity (RESOLVED 2026-06-30)** | GTD projects are **first-class, same level as ClickUp projects** — not subtasks. Each project/task has a **source**: `LOCAL` (personal/solo, Postgres = SoT) or `CLICKUP` (collaborative, mirrored). Both render in one unified interface; sync target is chosen at add-time, default by collaboration, promotable. See §5.1. |
| **R2 — Multi-user tool scoping** | Same caveat the email app hit: agent tools must resolve "which user" reliably (ContextVar + `ACB_AGENT_USER_EMAIL` fallback). Fine single-user; needs work for multi-user. |
| **R3 — Write-back depends on Action Broker** | Phases 1–3 are read/suggest-only by design; full two-way write is gated on WBS 2.4. |
| **R4 — Custom-field availability** | Some workspaces restrict custom fields → GTD overlay stays CC-only. Handled by graceful degradation. |
| **R5 — Provider API quota / rate limits** | ClickUp/Asana/Jira all rate-limit; reuse the email app's incremental-sync + backoff approach. |
| **Q1 — Which provider after ClickUp?** | Asana vs Jira first? (Codebase currently ClickUp-only.) |
| **Q2 — Calendar source** | Hard-date items → Google Calendar sync, or stay in-app? |
| **Q3 — Capture channels for v1** | Global hotkey + chat-to-task are cheap; email-to-task reuses the email app; voice/mobile later. |

---

## 12. Success criteria (v1 — through Phase 3)

- [ ] User connects a ClickUp workspace; their tasks + teammates' tracked tasks sync into `/tasks` within 5 min.
- [ ] **Dual source works in one view:** a personal LOCAL project and a collaborative ClickUp project both appear in the unified Projects list, badged by source; a LOCAL project can be promoted to ClickUp.
- [ ] **Capture** an item in < 5 seconds from a global hotkey; the app resolves its sync target (LOCAL vs ClickUp) with a sensible default.
- [ ] **Clarify**: the agent proposes a correct GTD disposition + a concrete next action for an inbox item; user approves with one click.
- [ ] **Organize**: Next Actions are browsable by `@context`; every active project shows whether it has a next action.
- [ ] **Engage**: "Now" view returns a sensible action given context + time + energy.
- [ ] **Reflect**: the Weekly Review wizard empties the inbox, flags projects with no next action, and lists stale waiting-fors.
- [ ] **Delegate & Monitor**: delegate a task to a teammate, see it on Waiting For, get an overdue flag, and get an agent-drafted follow-up nudge.
- [ ] Assistant answers "what's my next action?", "what am I waiting on?", and "what's overdue across the team?" with citations to the PM tool.
```
