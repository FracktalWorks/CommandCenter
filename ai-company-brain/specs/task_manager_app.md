# Task Manager App — Project Plan (GTD philosophy)

> **Product:** CommandCenter · **Feature:** Task Manager App (Getting Things Done) · **Updated:** 2026-06-30 · **Version:** 0.2 (planning — reviewed)
> **Status:** 🔄 build in progress on `main` — frontend slices 1–2.5 (Shell/Browse, Clarify, Inbox depth) **plus the capture/clarify backend**: migration `48_task_manager_gtd.sql`, the provider interface layer with the **ClickUp connector** (multi-workspace `task_accounts`), the **gateway `/tasks` API**, **`skill-task-gtd` + the rewritten `task-manager` agent**, and the frontend wired live (mock fallback when the gateway is absent). **Resume point: Slice 3 — Engage "Now" (F4) · sync-pull of existing provider tasks.** See §9.1/§9.2.
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

### 2.1 The Capture stage — deep design (GTD-aligned)

> Added 2026-07-01 after a GTD Capture-stage study ([Collect best practices](https://gettingthingsdone.com/2011/10/gtd-best-practices-collect-part-1-of-5/), [Mind Sweep](https://facilethings.com/blog/en/the-mind-sweep), [Incompletion Trigger List](https://gettingthingsdone.com/wp-content/uploads/2014/10/Mind_Sweep_Trigger_List.pdf)). The **Inbox** is where Capture happens; GTD is opinionated about this stage. Items below marked **[plumbing]** are frontend elements that will need backend functionality we bundle later.

**GTD principles the Inbox must honor**
1. **Capture without thinking; never clarify while capturing.** Capture and Clarify are separate stages — combining them is explicitly discouraged.
2. **Ubiquitous capture** — reachable from anywhere, not just the inbox screen.
3. **As few in-baskets as you can get away with** — unify all sources into one trusted inbox.
4. **Empty regularly** — "empty" = clarify+organize to zero, *not* "finish the work". A stale, un-emptied inbox loses trust and becomes mere storage.
5. **Hard rules:** the inbox is not a to-do list; never put clarified items *back* into the inbox.
6. **Mind Sweep + Incompletion Trigger List** — periodic full brain-dump into the one in-basket, prompted by trigger categories (projects started/not-finished, promises to others, calls/emails to make, decisions pending, waiting-fors, home, finances, health…).

**Capture features (F1, expanded)**

| # | Feature | What it does | Status | Needs |
|---|---|---|---|---|
| C1 | Quick capture | frictionless single-line add, Enter to file | ✅ built | — |
| C2 | Ubiquitous capture (hotkey / palette) | open a capture box from any view via keyboard (`C`, `⌘/Ctrl-K`) | ✅ built *within Tasks* | app-wide across Command Center → **[plumbing]** persisted store + AppShell-level listener |
| C3 | Brain-dump / Mind Sweep | multi-line box → parsed into candidate items | ✅ built (UI, mock) | AI atomization → **[plumbing]** (see pipeline below) |
| C3b | **Sweep review gate** | write → **review** (edit/remove each parsed item) → add; nothing is filed until confirmed | ✅ built | — |
| C4 | Trigger-list guided sweep | show the Incompletion Trigger List as memory-joggers during a sweep | ✅ built (static prompts) | conversational AI sweep → **[plumbing]** agent |
| C5 | Empty-regularly signals | "N to process" + oldest-item age + aging nudge | ✅ built | — |
| C6 | Undo capture | remove the last capture batch (protects trust) | ✅ built | — |
| C9 | **Scale + filtering** | search box, date filter pills (All/Today/Yesterday/This week/Older) + counts, newest/oldest sort — holds tens+ of captures | ✅ built | virtualized list if it grows to thousands → **[plumbing]** perf |
| C10 | **Rapid processing** | hover quick-actions on every card (Someday / Reference / Trash / Edit / Clarify) + in-modal keyboard shortcuts (`t` trash · `s` someday · `r` reference · `2` do-now · `esc`) to blitz obvious items to inbox-zero; inline rename to fix a typo without clarifying | ✅ built | — |
| C10b | **Undo safety net (dispose/clarify)** | every quick-dispose, bulk action, and clarify is reversible via a one-level **Undo** toast (`u`) that restores the item(s) to the inbox — fast triage feels safe (GTD: the system must be *trusted* to let go) | ✅ built | — |
| C11 | **Keyboard list navigation** | `j`/`k`/arrows move a cursor row (auto-scrolls into view); `↵` clarify · `e` edit · `x` select · `t`/`s`/`r`/`2` dispose+advance · `esc` clear. Mouse-free processing; a Shortcuts legend is toggleable | ✅ built | — |
| C12 | **Multi-select + bulk actions** | per-card checkboxes (+ `x`) → a bulk bar (Someday / Reference / Trash / Clear) applies to all selected; great for clearing a backlog | ✅ built | — |
| C13 | **Tickler / defer (snooze)** | snooze a capture to Tomorrow / This weekend / Next week / a picked date; deferred items leave the active inbox (and its count) and live under a **Tickler (N)** view until they resurface; un-snooze anytime | ✅ built | — |
| C14 | **Capture-with-note + date-hint seam** | inline editor adds an optional note (shown on the card); a local date-phrase detector surfaces a "tomorrow?" chip → snooze — the seam where the AI capture parser will suggest defer/due dates | ✅ built (note); date parse = local stub | AI NL parse → **[plumbing]** |
| C15 | **Session momentum** | live "N processed" counter and an inbox-zero celebration when you clear the last item | ✅ built | — |
| C17 | **At-a-glance AI hints** | each inbox card shows the assistant's *pre-read* — likely disposition + who to delegate to + matched project + destination (a **ClickUp/Jira** chip vs Local) — so you see the *shape* of your commitments (mine vs delegate vs project) before opening anything. A hint, not a decision; Clarify still confirms. Directly reduces overwhelm on a full inbox | ✅ built (heuristic `proposeClarification`) | agent-side read → **[plumbing]** |
| C16 | **Persistence** | captures/edits survive across sessions and devices | 🔲 | **[plumbing]** — needs the `/tasks` API + DB; client-side localStorage deferred (SSR-hydration risk in this Next setup, and real persistence is cross-device) |

**Mind-dump → inbox pipeline (how it feeds in, and the review gate)**

```
brain-dump text ─▶ [ATOMIZE] ─▶ candidate items ─▶ [REVIEW] ─▶ inbox
                   split into        (editable list,   user edits/
                   discrete items    dedupe flags)     removes, confirms
```

- **Today (no backend):** ATOMIZE = naive **line split** (one non-empty line → one candidate). The **review gate is real** — parsed items appear in an editable list (edit / remove / add-another); nothing lands in the inbox until "Add N to inbox". This is the correctness check the user asked for.
- **With AI [plumbing]:** ATOMIZE becomes an **agent call** — split run-on prose into atomic actions, normalize, and **flag near-duplicates** against existing captures (embeddings). Output populates the *same* review list, so the human still confirms before anything is filed. This respects the GTD boundary (**AI prepares; the user decides**) and keeps capture ≠ clarify. Endpoint: `POST /tasks/capture/atomize` → `{items: [...], duplicates: [...]}`.
| C7 | Multi-source capture | email / chat / Slack / meeting line → inbox item with a **source chip** (the "few buckets → one inbox" rule) | 🔲 | **[plumbing]** email/chat→task ingestion (`source` already in the model) |
| C8 | Voice capture | dictate → item | 🔲 | **[plumbing]** speech-to-text |

**AI in the Capture stage — the boundary, then the opportunities**

> **Boundary:** AI **assists capture and completeness; it must NOT auto-clarify.** Preparing is fine (it lowers friction and helps reach 100% collection); *deciding* stays a deliberate human step at the Clarify stage (with AI proposing there).

| AI capability | Value | Needs |
|---|---|---|
| **AI-guided mind sweep** | assistant walks the Incompletion Trigger List conversationally and files answers as inbox items — the practice people almost never complete alone | **[plumbing]** agent + `/tasks` capture API |
| **Brain-dump atomization** | paste/dictate a paragraph → split into discrete items; flag near-duplicates of existing captures | **[plumbing]** agent (UI already atomizes by line) |
| **Silent clarify-prep** | precompute each item's clarify suggestion while it sits, so processing is one-click — respects capture≠clarify (only *prepares*) | **[plumbing]** agent, background job |
| **Multi-source + ambient capture** | turn flagged emails / Slack mentions / meeting lines into captures, with consent | **[plumbing]** ingestion + Action-Broker gating |
| **Dedup / merge** | flag semantically-duplicate captures | **[plumbing]** embeddings |
| **Staleness nudges** | prompt a sweep when the inbox ages past a threshold | **[plumbing]** scheduler |

### 2.2 The Clarify (Process) stage — deep design

> Added 2026-07-01 after a GTD Clarify-stage study ([Process best practices](https://flow-e.com/gtd/process/), [Asana GTD workflow](https://asana.com/resources/getting-things-done-gtd)). Clarify is the cognitive core — turning raw captures into clear outcomes + next actions. `[plumbing]` marks what needs the agent/gateway.

**GTD principles the Clarify flow must honor**
1. Process **one item at a time, top-down (FIFO)**; never skip, never put an item *back* in the inbox; finish with the inbox **empty**.
2. Run the decision tree per item: **What is it? → Is it actionable?** → **No:** Trash / Incubate (Someday-Maybe · Tickler) / Reference · **Yes:** define the **very next physical action** + the **desired outcome** → **<2 min? do it now** · **someone else's? delegate → Waiting For** · **yours? defer → Calendar** (day/time-specific) or **Next Actions** (by @context). Outcome needs **>1 action → Project** (record the outcome, define its next action).
3. Clarify is **deciding, not doing** (except the 2-minute rule).
4. A **specific, physical next action** is the key output — the #1 GTD failure is a vague or missing next action.

**Feature set (built)**

| # | Feature | What it does | Status | Needs |
|---|---|---|---|---|
| P1 | Guided one-at-a-time clarify | modal walks the inbox FIFO with a **progress bar** (`N of M`) and closes at zero | ✅ built | — |
| P2 | **AI full proposal** | one structured recommendation per item — disposition + specific next action + context/energy/time + **project & delegate detection** + rationale — that you **Accept in one tap** | ✅ built (heuristic `proposeClarification`) | real agent → **[plumbing]** |
| P3 | Adjust / override tree | disposition chips (Next · Project · Delegate · Schedule · Do-now · Someday · Reference · Trash) with **adaptive fields** (project outcome, delegate person, context, energy, schedule date) | ✅ built | — |
| P4 | Project creation | clarifying to **Project** creates the project *and* makes the item its first next action (GTD outcome + next action) | ✅ built | — |
| P5 | Keyboard-blitz | `↵` accept · `t`/`s`/`r`/`2` quick-dispose · `esc` | ✅ built | — |
| P6 | **Destination + delegation frame** | clarifying also decides *where it's stored* — **Local vs a connected PM tool (ClickUp / Jira)** — and the **project** to file it under; **Delegate** auto-targets the team tool (collaborative → SYNCED, §5.1) and picks the assignee. The proposal suggests the destination (delegated/already-synced → team tool; solo → Local) | ✅ built (mock providers) | live create/assign in ClickUp/Jira → **[plumbing]** Action Broker (C-03/C-04) |
| P7 | **PM-tool setup during processing** | for a SYNCED destination, set the tool's real fields inline: **project · stage/status · assignee · due/timeline**. Statuses are the tool's own workflow (ClickUp: Backlog / To-do / In Process / …), and the GTD disposition maps to a sensible default stage — **Someday under a project → Backlog**, **actioned/delegated + timeline → To-do**. Someday items can be parked in the tool's Backlog under a project | ✅ built (mock schema) | fetch live schema (§2.2.1) → **[plumbing]** |
| P8 | **Flexibility to finish later** | all PM fields are optional — set what you can. **Skip** (`]`) leaves an item in the inbox to process later; anything sent to a tool is marked **`pending`** (queued to push, Action-Broker-gated) so you can clarify now and complete/push to ClickUp/Jira later | ✅ built | real push → **[plumbing]** Action Broker |
| P9 | **AI auto-matches the project** | across *many* projects, the assistant infers the **best-fit existing project** by keyword overlap and pre-fills it (destination follows the project's home tool). No hunting a long list — the match is shown in the proposal ("belongs to …") and pinned first in the picker with a ✨. Fine-tune via a **searchable** project picker (type-to-filter, not a wall of pills) that scales to any number of projects | ✅ built (heuristic `suggestProject`) | agent-side matching / embeddings → **[plumbing]** |
| P10 | **Calm, progressive disclosure** | the proposal fills in everything it can, so the default is a **one-tap Accept**. A **confidence** signal (Confident / Best guess) tells you when to trust it. "Where it goes" collapses to a **single summary line** (project · stage · assignee · due) that expands only when you want to change something — processing stays low-effort even for synced items | ✅ built | — |

### 2.2.1 Adapting to the connected PM tool (schema, fetched beforehand)

To set tasks up properly during Clarify, the app must know the connected tool's **schema ahead of time** — synced on connect and refreshed periodically, cached in `task_accounts` / the canonical store, so it's instantly available while processing:

| Schema | Used in Clarify for | Source (real) |
|---|---|---|
| **Projects / lists** | the "file under" picker (scoped to the chosen tool) | provider API `list_projects` → `gtd_projects` |
| **Members** | delegate / assignee picker (capability-aware later — see §6.1) | provider API `list_members` → cached |
| **Statuses / stages** | the "Stage" picker + GTD→stage default map | provider API (per-list custom statuses) → `task_accounts.capabilities`/`field_map` |
| **Custom fields, priorities** (later) | extra optional fields | provider API |

Today `CONNECTED_PROVIDERS` (Local / ClickUp / Jira with their statuses) + `gtd_projects` + `gtd_people` stand in for this fetched schema. **[plumbing]:** a `provider.get_schema()` sync via the interface layer (§5.2) that populates it for real. If the schema (or a matching project/assignee/stage) isn't available or a field can't be set, the item stays fully processable — clarify locally now, complete the PM setup later (P8).

**AI in Clarify — the boundary + opportunities**

> **Boundary:** AI *proposes* the full disposition; the human *confirms/edits* before anything is applied. Deciding stays the person's — AI removes the blank-page cost, not the judgment.

| AI capability | Value | Needs |
|---|---|---|
| **Real proposal** | replace the local heuristic with the `task-manager` agent — better next-action phrasing, project detection, context/energy/time | **[plumbing]** `POST /tasks/items/{id}/clarify` |
| **Batch clarify** | agent pre-clarifies the *whole* inbox → a review list; bulk-accept or adjust rows → apply all. Turns 30 decisions into one scan | **[plumbing]** agent + a batch endpoint |
| **Specific next actions** | rewrite a vague capture ("Slack from Priya") into a physical action ("Reply to Priya proposing 3 times for the vendor call") | **[plumbing]** agent |
| **Project breakdown** | natural-planning: propose the outcome + first action (and later, the whole action list) | **[plumbing]** agent |
| **Conversational clarify** | for ambiguous items the assistant asks one question ("Q3 launch or lab fit-out?") before proposing | **[plumbing]** agent |
| **Learned patterns** | improve proposals from your accept/edit corrections over time | **[plumbing]** agent + memory |

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

> **✅ Shipped as `infra/postgres/48_task_manager_gtd.sql`** (applied + idempotency-verified on Postgres 16). Deltas vs the listing below, per the migration header: `gtd_items`/`gtd_projects` gained **`user_id`** (LOCAL rows have no account to scope through; every route is user-scoped), `gtd_items` gained **`defer_until`** (tickler, §2.1 C13) and **`sync_state`** (`local|pending|synced`, §2.2 P8), and `task_accounts` gained **`schema_cache`** (the fetched-beforehand provider schema, §2.2.1) + `sync_status`/`sync_error`. `schema.generated.sql` must be refreshed on a machine with pgvector (deploy box) — the dev container can't replay `01_schema.sql`.
>
> **Original implementation note (per `infra/postgres/README.md`).** This ships as **one** numbered migration — **`48_task_manager_gtd.sql`** — and **must be idempotent**: every statement uses `CREATE TABLE/INDEX IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` because `apply_migrations.sh` re-runs all `02+` migrations on every deploy. After writing it, run `scripts/dump_schema.sh` and commit the refreshed `schema.generated.sql`. The DDL below is **grouped by concern for readability, not apply order** — the real migration must create tables in **FK-dependency order**: `gtd_contexts` → `gtd_horizons` → `gtd_projects` (FK→horizons) → `gtd_items` (FK→projects, horizons) → `gtd_waiting` (FK→items) → `task_accounts` (independent) → `gtd_reviews` (independent). (`IF NOT EXISTS` is shown only on the first table below to keep the listing readable; apply it to every object.)

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

### 6.1 People & capabilities intelligence — the org-knowledge layer (✅ v1 shipped)

> Added 2026-07-01 as a forward design note; **v1 shipped 2026-07-02** with the *actual* company data. `agent-project-manager`'s `agent-data/` (hr_structure.json + resume_profiles.json — 26 people, 11 departments, roles, org-chart + resume-extracted skills, capacity/load hours, ClickUp user ids) is snapshotted into **`infra/seed/hr/`** (phones stripped) and imported into **`gtd_people`** (migration `49_gtd_people.sql`) by **`scripts/import_hr_people.py`** (idempotent upsert by name; re-run to refresh — the source repo / HR system stays the source of truth). Served via **`GET /tasks/people`** (auth-gated, `q` searches name/role/department/skill); the clarify proposal is now **capability-aware** (skills word-boundary match + free-hours tiebreak → `suggested_assignee` with the person's real ClickUp id, so delegation pushes assign the actual user); the agent gained **`gtd_people(query)`**; the UI's delegation/assignee pickers hydrate from the org people. Remaining (below) = embeddings matching, live load sync from the PM tool, overload warnings, and richer org-structure reasoning.

**The idea.** Today the agent only recognizes a teammate when their *name appears in the capture text* (a plain string match). The larger opportunity — inspired by our internal **`agent-project-manager`** (which already holds the company's **HR list, everyone's résumé, roles, and capabilities**) — is to give the Task Manager agent a first-class model of **who's who and who can do what**, so Clarify and delegation run with real organizational context. This is the Task-Manager equivalent of how the email assistant knows a mailbox: here the agent "knows the org."

**What the agent should know (the knowledge base).** A company knowledge layer, ideally **ported/synced from `agent-project-manager`** and cached alongside `gtd_people` / the provider's `list_members()`:
- **Org structure** — departments, teams, reporting lines (who reports to whom, who owns what area / GTD Horizon H2).
- **Per-person profile** — role/title, seniority, **skills & capabilities distilled from résumés**, domains they own (e.g. *embedded firmware*, *lab ops*, *supply chain*), languages/tools.
- **Live state** — current **workload / capacity** (open-task count and load from the connected PM tool), availability / time-off.
- Matchable representation — a short capability summary + embeddings so a capture can be matched to the best-fit person semantically, not by keyword.

**Data-model sketch (future — reconcile with `agent-project-manager`'s actual schema).** Extend the bare `person` table (currently just name/aliases/ids/email/role) with a capabilities layer, e.g. `person_capabilities(person_id, department, reports_to, seniority, skills TEXT[], domains TEXT[], resume_summary TEXT, capacity JSONB, embedding VECTOR)`. HR/capability data is **sensitive** → access-controlled and executive-scoped; sync source-of-truth stays in the HR system / `agent-project-manager`, not re-authored here.

**How it makes inbox processing better (three ways):**
1. **Capability-aware delegation.** For "*bed-leveling firmware regression*", propose the **best-fit owner by matching the task to skills + current load** (e.g. Arjun — embedded firmware, lightly loaded), even when no name is in the text — and **warn on overload** ("this is Priya's 6th open task this week").
2. **PM-context grounding.** Combined with the live schema fetched beforehand (§2.2.1 — projects, members, statuses, workload), the agent's *who · which project · which stage* proposal reflects what ClickUp/Jira actually contains and who is actually free.
3. **Inbox-level insights.** Whole-inbox reasoning, not just per-item: cluster captures by project ("5 belong to the EU launch — batch them"), recommend a processing order (aging/high-leverage first), surface stale Waiting-For items, and flag capacity risks before you assign.

**Boundary & posture (unchanged).** The AI **proposes**; the human **decides**. Any assignment write to a PM tool stays **Action-Broker-gated (C-04)**. This layer is purely additive to the Clarify/Delegate flows already specced (§2.2, §6).

**Status:** ✅ v1 shipped (table + import + endpoint + capability-aware clarify + agent tool + UI hydration, on real company data). 🔲 Later: embeddings-based matching, live workload sync from the PM tool, overload warnings at assign time, reporting-line reasoning.

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

### 7.1 Mobile

The desktop 4-panel layout collapses to a **single-pane** flow on ≤767px (`useViewMode().isMobile`):

- **Context-aware bottom nav** — the AppShell mobile bottom bar gains a tasks tab set (**Inbox · Lists · Capture · Assistant**) that reflects the current GTD process: the page emits a `cc-tasks-section` event on view change, the bar highlights **Inbox** vs **Lists** accordingly, and **Capture** is emphasized (capture-on-the-go is the core mobile GTD action). Tabs dispatch `cc-mobile-nav` events the page consumes (mirrors the email/chat pattern).
- **Lists & Assistant** open as **bottom-sheet drawers** (`useMobileDrawer`); picking a list closes the sheet (`ListsSidebar onNavigate`).
- **Inbox** renders full-width; other lists render full-width and **tap-through to a full-screen detail** with a Back affordance (no side panels).
- **No capture hero on mobile** — the desktop inbox's capture input/mind-sweep header is `hidden sm:block`; on mobile the dedicated **Capture** button (bottom nav / `C`) owns capture, so the small screen goes to the *task list*, not a redundant capture box. A slim **"Inbox · Getting Things Done" heading** (`sm:hidden`) keeps the page oriented, and capture-undo moves out of the hero to an always-visible strip.
- **Keyboard-safe bottom sheets** — Clarify + Quick-capture sheets track the **visual viewport** (`useVisualViewport`): when the on-screen keyboard opens it shrinks the visual viewport, and the overlay is sized to that height so its `items-end` content (the capture/next-action input) stays **above the keyboard** instead of being hidden behind it.
- **No iOS focus-zoom** — all inputs reachable on touch (capture, mind-sweep, clarify next-action/outcome/date/project-search, inbox search) are `text-base sm:text-sm` (**≥16px on mobile**), so Safari doesn't auto-zoom the page when a field is focused.
- **Clarify + Quick-capture modals are bottom sheets** (`items-end`, rounded-top, `pb-safe`, `z-[80]` above the nav); keyboard-only affordances (shortcut legends, "press C", hover quick-actions) are hidden on touch — tapping a card opens the Clarify sheet, which carries every disposition.

---

## 8. API endpoints (gateway `routes/tasks/` package)

> Follows the email precedent — `routes/email/` is a package (`core.py`, `automation/`, `digest.py`, `transport/`), not a single file. `routes/tasks/` should likewise be a package (e.g. `core.py` for items/lists, `accounts.py`, `review.py`, `ai.py`).

| Method | Path | Description | Status |
|---|---|---|---|
| `GET/POST/DELETE/PATCH` | `/tasks/accounts[/{id}]` | CRUD PM-tool workspace connections (multi-account/multi-workspace; credentials encrypted) | ✅ shipped |
| `POST` | `/tasks/providers/{provider}/workspaces` | Connect step 1: verify a token → the workspaces it reaches (ClickUp needs token **and** workspace) | ✅ shipped |
| `POST` | `/tasks/accounts/{id}/schema/refresh` | Fetch-beforehand schema (§2.2.1): projects/members/statuses → `schema_cache` + mirror provider lists into `gtd_projects` | ✅ shipped |
| `GET` | `/tasks/providers` | Registered connector types | ✅ shipped |
| `GET` | `/tasks/items` | List/search items (`view`, `q`, `context`, `project_id`) | ✅ shipped |
| `POST` | `/tasks/items` · `/items/batch` | Capture one / a mind-sweep batch | ✅ shipped |
| `GET/PATCH/DELETE` | `/tasks/items/{id}` | Detail / small edits (rename, note, tickler, quick-dispose) / undo-capture delete | ✅ shipped |
| `POST` | `/tasks/items/{id}/organize` | Apply one clarify decision atomically (disposition + destination + project/stage/assignee/due + waiting-for; **delegate is a kind here**, not a separate route) | ✅ shipped |
| `POST` | `/tasks/items/{id}/clarify` | Clarify proposal (server-side heuristic today; the agent replaces the body, same contract) | ✅ shipped |
| `POST` | `/tasks/items/{id}/push` | Explicit user-approved push of a staged (`pending`) item to its workspace (C-04) | ✅ shipped |
| `POST` | `/tasks/items/bulk` | Bulk dispose (multi-select) | ✅ shipped |
| `GET` | `/tasks/contexts` · `/tasks/projects` | List surfaces (contexts seed GTD defaults per user) | ✅ shipped |
| `GET` | `/tasks/insights` | Whole-inbox signals: bucket counts, oldest capture, stale waiting-fors, projects w/o next action | ✅ shipped |
| `POST` | `/tasks/projects/plan` | Natural-planning for a project | 🔲 |
| `POST` | `/tasks/review` | Run weekly review → summary | 🔲 |
| `POST` | `/tasks/sync` | Pull existing provider tasks into `gtd_items` | 🔲 next |
| `POST` | `/tasks/ai/chat` · `/ai/quick-action` | Assistant chat / quick actions | 🔲 (agent chat runs via the generic `/agent` route today) |
| `GET` | `/tasks/oauth/{provider}/authorize` · `/callback` | OAuth connect (token-based connect shipped; OAuth later) | 🔲 |

---

## 9. Implementation phases

### 9.1 UI-first build progress (frontend slices, on `main`)

> **Decision (2026-06-30):** build the `/tasks` Control Plane app **UI-first against mock data**, feature by feature, before any backend — mirroring how the email app was built (`lib/mockData` + Zustand store + components, wired to the gateway later). All frontend code lives in **`workbench/control_plane/src/app/tasks/`** (`lib/{types,mockData,taskStore,utils}.ts`, `components/`, `page.tsx`). No backend, schema, or gateway work has started yet.

| Slice | Feature(s) | Status | Key files |
|---|---|---|---|
| 0 — Shell | 4-panel layout | ✅ done | `page.tsx`, `ListsSidebar`, `AssistantRail` (framed) |
| 1 — Browse | F1 capture · F3 lists/contexts | ✅ done | `CaptureBar`, `ItemList`/`ItemRow`, `ProjectsList`, `ItemDetail`, `SourceBadge` |
| 2 — Clarify | F2 decision tree | ✅ done | `ClarifyPanel` + `taskStore.clarify` + mocked `suggestClarification` |
| 2.5 — Inbox depth (Capture stage) | C1–C6 (§2.1) | ✅ done | dedicated capture-first `InboxView` + `ClarifyModal` (de-email-ified); ubiquitous hotkey capture (`QuickCapture`, `C`/`⌘K`), brain-dump/mind-sweep + trigger list, oldest-item aging signal, undo. AI sweep / multi-source / voice = **[plumbing]** later |
| 3 — Engage "Now" | F4 | 🔲 **NEXT** | filter Next Actions by context + time + energy; unlocks the `Engage · Now` nav (currently "soon") |
| 4 — Weekly Review | F5 | 🔲 | get-clear / get-current / get-creative wizard; surface no-next-action projects + stale waiting-fors |
| 5 — Waiting-For / Delegate | F6 | 🔲 | dedicated monitoring view (delegation already partly in Clarify) |
| 6 — Plan / Horizons | F8 · F7 | 🔲 | natural-planning project flow + Horizons (currently "soon") |
| 7 — Assistant wired | F9 | 🔲 | replace the mocked suggestion + rail with the live `task-manager` agent (stream + quick actions) |

| B1 — Backend: capture/clarify/organize | §9.2 Ph. 1–2 core | ✅ done | migration `48_*` · `routes/tasks/` package (20 endpoints, §8) · `providers.py` interface layer + **ClickUp connector** (multi-workspace, encrypted per-account tokens) · `skill-task-gtd` + rewritten `agent-task-manager` · `/api/tasks` proxy + live store hydration with **mock fallback** · `WorkspacesModal` connect flow · e2e-verified (capture→persist→clarify→organize vs real Postgres) |

**Commits on `main`:** shell+browse `9dfa571` · clarify `c26890f` · backend wiring (this change).
**Resume here →** Slice 3 (Engage "Now") on the frontend · `/tasks/sync` (pull existing provider tasks into the inbox views) on the backend.

### 9.2 Backend phases (after the UI slices)

**Build order at a glance** — strictly dependency-ordered, so each step is independently shippable:
1. **Migration `48_task_manager_gtd.sql`** (the canonical store) → 2. **interface layer + ClickUp API connector** (read-only sync into `gtd_items`) → 3. **gateway `/tasks/` read endpoints** → 4. **`/tasks` UI shell** (ported from `/email`, read-only lens) → 5. **`skill-task-gtd` + extend `agent-task-manager`**. Everything in Phase 1 is **read-only**; no writes to source systems, so nothing is blocked on the Action Broker. Capture/LOCAL-CRUD/clarify (Phase 2) and delegation-write (Phase 4) come after.

### 9.3 Dev runbook — continuing on a local machine (handoff)

> Written 2026-07-02 for the cloud→PC handoff. Everything below is on `main`.

**One-time setup**
```bash
uv sync                                             # workspace venv (.venv/)
uv pip install -e apps/skill-task-gtd               # dev-import the agent skill
scripts/apply_migrations.sh                         # applies 48 + 49 (idempotent)
scripts/dump_schema.sh                              # refresh schema.generated.sql (needs pgvector box) — PENDING, do here
.venv/bin/python scripts/import_hr_people.py        # seed gtd_people from infra/seed/hr/
```

**Run the stack**
```bash
# Gateway (FastAPI) — needs: DATABASE_URL, ACB_MASTER_KEY, LITELLM_MASTER_KEY
.venv/bin/uvicorn gateway.main:app --port 8000
# Control Plane (Next.js) — needs: GATEWAY_BASE_URL=http://127.0.0.1:8000 (+ LITELLM_MASTER_KEY for the proxy)
cd workbench/control_plane && npm install && npm run dev
```
The `/tasks` UI hydrates from the gateway when reachable and silently falls back
to bundled mock data when not — so the frontend is always runnable standalone.
Connect ClickUp: Tasks → sidebar → *Connect workspace…* (API token → pick
workspace; one account row per workspace, several companies fine).

**Verify**
```bash
.venv/bin/python -m pytest tests/unit/test_tasks_gtd.py tests/unit/test_hitl_stall_suppression.py -q
.venv/bin/python -m ruff check apps/gateway/gateway/routes/tasks apps/skill-task-gtd apps/agent-task-manager
cd workbench/control_plane && npx eslint src/app/tasks && npm run build
```

**Where everything lives**
| Layer | Path |
|---|---|
| Spec (this doc) | `ai-company-brain/specs/task_manager_app.md` |
| DB migrations | `infra/postgres/48_task_manager_gtd.sql` · `49_gtd_people.sql` |
| HR seed + import | `infra/seed/hr/` · `scripts/import_hr_people.py` |
| Gateway API (21 endpoints, §8) | `apps/gateway/gateway/routes/tasks/` (`core` · `accounts` · `items` · `ai` · `people` · `providers`) |
| Agent | `apps/agent-task-manager/` + `apps/skill-task-gtd/` (10 tools) |
| Frontend | `workbench/control_plane/src/app/tasks/` (+ proxy `src/app/api/tasks/[...path]/`) |
| Tests | `tests/unit/test_tasks_gtd.py` (18) · `test_hitl_stall_suppression.py` |

**State at handoff (✅ done)** — UI slices 0–2.5 (shell/browse/clarify/inbox
depth, mobile-optimized); capture/clarify/organize backend live end-to-end
(browser-verified against real Postgres); ClickUp connector (multi-workspace,
encrypted per-account tokens, fetch-beforehand schema §2.2.1); staged→push
write model (C-04); org-knowledge people layer (§6.1 v1, real company data,
capability-aware delegation); GTD agent tool surface.

**Next in line (🔲)** — in rough priority order:
1. ✅ *(2026-07-03)* `POST /tasks/sync` — pull of existing provider tasks is
   live: `BaseTaskProvider.list_tasks` (+ ClickUp impl, paginated/incremental
   via `last_delta_token`), GTD lens on pulled rows (closed→DONE ·
   backlog→SOMEDAY · mine→NEXT · others'→WAITING+`gtd_waiting` · unassigned→
   team-pool NEXT), overlay-preserving upsert, background pull on app
   hydrate + per-workspace Sync button + agent `gtd_sync` tool. Webhook/push
   scheduler still later (Phase 4).
2. Slice 3 — Engage "Now" view (F4, 4-criteria selection).
3. Weekly Review wizard (F5) + Waiting-For monitoring surfaces (F6).
4. ✅ *(2026-07-03)* Tasks assistant rail (F9): AssistantRail is a live
   AgentChat wrapper pinned to `task-manager` (email-app pattern) — shared
   sessions, Mem0 memories, live GTD persona (`taskAssistantPersona.ts`:
   workspaces + current view + open item + inbox pressure), quick actions →
   composer. Same slice also wired the **server AI clarify proposal** into
   ClarifyPanel (`apiClarifyPropose`: instant local heuristic, server
   upgrade with org-knowledge capability match applied only while the form
   is untouched). Browser-E2E-verified: capture → persist → clarify (server
   proposal, "Rahul fits…") → accept → NEXT view → reload-persist → mind
   sweep → rail quick actions.
5. Live workload sync for `gtd_people` + overload warnings (§6.1 later-list).
6. OAuth connect flow; more connectors (Asana/Jira/Linear); generic MCP connector.

**Known gaps / footnotes** — `schema.generated.sql` not yet regenerated (needs
pgvector; run `scripts/dump_schema.sh` on the PC). HITL question-card fix
(2026-07-02): Copilot-SDK stall watchdog + Tier-2 per-tool timeout were killing
runs parked on `ask_user`/`ask_questions` after 300s — now HITL-aware; knobs:
`HITL_IDLE_TIMEOUT_SECONDS` (3600), `COPILOT_STREAM_STALL_TIMEOUT` (300),
`COPILOT_TOOL_TIMEOUT_SECONDS` (300).

**Mind-dump atomization + capture dedup (2026-07-03)** — `POST
/tasks/ai/atomize` turns freeform text (pasted paragraph, mind sweep, single
capture) into atomic captures, each checked against the user's open items:
`new` · `similar` (UI/agent asks "same or different?") · `duplicate`
(confident same — skipped by default, undoable). LLM tier1 does the split +
judgment with a deterministic sentence/connector splitter + token-similarity
fallback, and a guardrail: an LLM duplicate claim without lexical support
degrades to `similar` (a poisoned title can't silently delete a capture).
Wired into: the sweep review phase (candidates + verdict badges, duplicates
default-excluded), single capture (background check → warning banner:
auto-skip w/ "Add anyway" for duplicates, "Same — remove / Different — keep"
for similars), and the agent's `gtd_capture`/`gtd_capture_many` (paragraph in,
skipped-duplicates report out). Golden-locked in
`evals/trajectories/test_gtd_quality_trajectory.py`; browser-E2E-verified.

**Email → task capture (2026-07-03)** — the email inbox is now a GTD
capture channel (the biggest ubiquitous-capture gap from the GTD audit).
`POST /tasks/capture/from-email {account_id, email_id}`: owner-checked
through the mailbox, AI-drafts the capture (LLM tier1 names the ASK —
"Approve Sanjay's revised quote" — not just the subject; deterministic
"Email from <sender>: <subject>" fallback), files it as an INBOX item with
`gtd_items.origin` (migration 50) linking back to the source email.
Idempotent per email (re-capture returns the existing open item). UI:
"Add to Tasks" in the email right-click context menu (single + bulk), the
desktop unified toolbar, and the mobile detail toolbar; a toast confirms
("Captured to Tasks …" / "Already in Tasks"). The clarify panel and item
detail show the origin ("Captured from email — <sender> · <subject>" +
open link) so processing has the context. Same GTD-audit pass also fixed:
calendar decisions now REQUIRE a date (a hard-date item with no date was
invisible on the Calendar view). Browser-E2E-verified 7/7.

**Chat-stack state (same session, 2026-07-02)** — a full audit of the chat
implementation (SSE · HITL · resume · multi-agent handoffs, both runtimes)
lives in
[`chat_implementation_review_2026-07.md`](chat_implementation_review_2026-07.md);
its status block records the three hardening batches already landed
(`3b9d3c8` · `d2de4d2` · `20a7112` — P0-1/2/4/5/6/7/8, P1-1/3/4/8; regression
suite `tests/unit/test_chat_hardening.py`, 19 tests) and what remains (P0-3
server-side persistence, P1-2 multi-worker control state, P1-5/6/7/9, P2 list,
§5 refactors, §6 doc drift). **Treat that doc as the work queue for chat.**
New env knobs from the batches: `SUB_AGENT_MAX_DEPTH` (2, delegation
depth/cycle guard) and `SUB_AGENT_TIMEOUT_SECONDS` (900, per-delegation
wall-clock budget). Also this session: `web_search` is now SerpAPI-first
(set `SERPAPI_API_KEY`; free ddgs engine rotation is the fallback) — see
`packages/acb_skills/acb_skills/web_tools.py`.

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
