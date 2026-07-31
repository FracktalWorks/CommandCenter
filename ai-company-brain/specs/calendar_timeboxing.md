# Calendar & Timeboxing — feature spec + roadmap

Status: **P0–P3 SHIPPED to main** (PR #71 merged, commit `7a5c72b2`).
The day/week/month grid, drag-drop + resize timeboxing, energy/capacity prefs,
the AI "Plan my day" planner, chat-with-calendar tools, auto-reschedule
roll-over, deadline radar, and overlap detection are all live.
Only P4 (external Google/Outlook sync — needs OAuth creds) and parts of P5
remain deferred (see cross-map, §12).

**Update 2026-08-01 (doc-truth pass):** the old "draft PR / nothing auto-deploys
until reviewed + merged" caveat is obsolete — PR #71 merged
(`7a5c72b2 feat(calendar): timeboxing app … (#71)`) and `CalendarView.tsx` +
the calendar routes are in main. P3's "still to do" (nightly job + roll history)
has ALSO shipped since: migration `infra/postgres/78_gtd_calendar_rollover.sql`
(`gtd_rollover_log`, `auto_rollover` toggle, per-user `timezone`) and
`start_auto_rollover()` launched at gateway startup (`gateway/main.py`).
Roll-over SEMANTICS then changed in #235 (2026-07-26): unfinished blocks are
RELEASED back to the unscheduled list (`rolled_to = NULL` in the log) for
deliberate re-planning — NOT packed onto today — so §6's "rolls them to the
next open slot" no longer describes shipped behaviour. Successor roadmap:
`calendar_focus_os.md`.

## 1. Why

The GTD app captures, clarifies, prioritises and files next actions — but it has
no way to **place work in time**. Today the "Calendar" view is a flat list of
`is_hard_date` items sorted by `due_at`. There is no start time, no duration
block, no day/week/month grid, no "plan my day". The goal is a calendar that
lets the user **timebox** next actions against the hours they actually have,
**account for energy**, **sync** with Google/Outlook, and **plan the day by
chatting** with an assistant that already knows their Next Actions.

Design north star: Sunsama / Motion / Akiflow — a *task-first* calendar where the
calendar is the planning surface for the task list, not a separate silo.

## 2. Core concepts

- **Due date (`due_at` + `is_hard_date`)** — a *deadline*. Already exists. "This
  must be done BY X." Not a schedule.
- **Time block (`scheduled_start` + `scheduled_end`)** — *when you will actually
  do it*. NEW. A task can have a deadline of Friday but be timeboxed Wednesday
  10:00–10:45. This is the heart of timeboxing.
- **Estimate (`time_estimate_mins`)** — how long it should take. Already exists.
  Seeds the default block length (`end = start + estimate`).
- **Energy (`energy` low/med/high)** — already exists. Drives *where in the day*
  a task should land (high-energy work in your peak window).
- **Capacity** — how many focus-hours a day realistically holds. NEW (setting).

A task is thus in one of: **unscheduled** (in Next Actions, no block),
**scheduled** (has a block), **overdue-unscheduled** (deadline passing, no block →
nagged), **done**, **rolled-over** (auto-rescheduled, see §6).

## 3. Data model (scaffolded)

MVP scaffold adds two columns to `gtd_items` (migration `76_gtd_scheduling.sql`):

```
scheduled_start TIMESTAMPTZ   -- start of the time block (null = unscheduled)
scheduled_end   TIMESTAMPTZ   -- end of the block; default start + estimate
```

- Client `GtdItem`: `scheduledStart?`, `scheduledEnd?`.
- A task is "on the calendar grid" when `scheduled_start` is set (distinct from
  the deadline-driven `is_hard_date` list, which stays as an all-day lane).

**Phase 2 evolution (planned, not built):** promote to a `gtd_time_blocks` table
(`id, item_id, start, end, kind, source, external_event_id`) so one task can have
*multiple* blocks (split focus sessions, recurring), and so external calendar
events (meetings that are NOT tasks) can live on the same grid via
`kind='external'`. The grid component is written against a `TimeBlock[]`
abstraction so this swap is non-breaking.

> **Update 2026-08-01 (doc-truth pass):** `gtd_time_blocks` is still unbuilt —
> no migration creates it. Its column set is specified in three places with
> different shapes (here, `calendar_focus_os.md` §5, and the comment at
> `infra/postgres/76_gtd_scheduling.sql:14`); **`calendar_focus_os.md` §5 is
> canonical** — this section and the migration comment defer to it.

## 4. Views (scaffolded: day / week / month grid)

Replace the flat list at `page.tsx` "calendar" branch with a dedicated
`CalendarView` (day/week/month toggle, persisted like the list/board toggle).

- **Day** — vertical hour grid (configurable day window, e.g. 07:00–22:00),
  blocks positioned by start/end, current-time line, an **unscheduled rail** of
  schedulable next actions on the side. Click/drag a task onto an hour to
  timebox it.
- **Week** — 7 day-columns × hour rows; same block rendering; drag across days.
- **Month** — calendar month grid; tasks appear as chips on their
  `scheduled_start` day (or `due_at` day for deadline-only items); click a day →
  jumps to that day view.
- **Deadlines lane** — `is_hard_date` items without a block show as all-day
  markers so a deadline is never invisible just because it isn't timeboxed yet.

Scheduling a task writes `scheduled_start/end` (store `scheduleItem(id, start,
end)` → PATCH). Rendering reads a date-range query `GET /tasks/calendar?from&to`.

## 5. Timeboxing + energy-aware planning

- **Estimate → block**: dropping a task defaults its block to
  `time_estimate_mins` (fallback 30m). Resize adjusts the estimate.
- **Capacity meter**: each day shows scheduled focus-hours vs the capacity
  setting; overcommit is flagged ("you've booked 9h of focus work today").
- **Energy lanes**: the user marks peak/trough windows (setting). The planner
  prefers high-energy tasks in peak windows, low-energy/administrative work in
  troughs. Energy of a task (already captured) is matched to the slot.
- **Conflict avoidance**: blocks can't overlap existing blocks or synced
  external events (meetings).

## 6. Smart daily planning + auto-reschedule

- **"Plan my day"** — given today's date, the planner pulls the user's Next
  Actions (mine, NEXT, not done), ranks by the existing priority matrix + due
  proximity + leverage, respects capacity and energy windows, works *around*
  already-scheduled blocks and synced meetings, and proposes a timeboxed day.
  The user accepts/edits.
- **Look-ahead**: the planner also reads upcoming deadlines and scheduled items
  for the next N days, so it can pull work *forward* ("Thursday is slammed —
  do the deck prep today"). This is the "get ahead of what needs to be done"
  behaviour.
- **Auto-reschedule (roll-over)**: a nightly job (reuse the existing
  scheduler pattern) finds blocks whose end has passed and whose task is **not
  done**, and rolls them to the next open slot on the next day that has
  capacity (respecting deadlines — a rolled task that would miss its `due_at` is
  escalated/flagged instead of silently moved). Every roll is recorded so the
  user sees "moved from Tue → Wed."

## 7. Chat with your calendar

Reuse the existing task assistant (`AgentChat` → `/api/agent/chat`, agent
`task-manager`). Two additions:
- **Persona context**: extend `buildTaskAssistantPersona` with today's blocks,
  free windows, capacity, energy windows, and upcoming deadlines.
- **Tools** (in `skill-task-gtd`): `gtd_schedule(item, start, end)`,
  `gtd_reschedule`, `gtd_plan_day(date, energy_note)`, `gtd_unschedule`.

Then the user can say *"I'm low energy today, move the deep work to tomorrow and
give me admin tasks"* and the LLM re-timeboxes: it reads Next Actions + today's
grid + upcoming load, and reorganises the day around the stated energy, pulling
manageable work forward. This directly satisfies the "chat with my calendar,
account for energy, auto-organise the main tasks to focus on" request.

## 8. External sync — Google Calendar + Outlook (planned; seams scaffolded)

Reuse the email OAuth stack (`email/transport/oauth.py` already does Google +
Microsoft Graph; encrypted tokens via `key_store`).
- New `calendar_accounts` table (mirror `task_accounts`/`email_accounts`
  encrypted-token pattern). Scopes: Google `calendar.events`, Graph
  `Calendars.ReadWrite`.
- **Read**: pull external events into the grid as `kind='external'` blocks
  (read-only, for conflict-avoidance and context) — "don't book over my 2pm."
- **Write**: push timeboxed task-blocks out as real calendar events (two-way),
  so the phone calendar shows the plan; edits flow back.
- Scaffold ships `POST /tasks/calendar/sync` + `calendar.py` route returning
  `501 not_implemented` with the design noted, and a settings seam for
  connecting a calendar — no live OAuth wiring yet (needs client creds).

## 9. Powerful features to consider (brainstorm)

- **Auto-scheduling engine (Motion-style)**: continuously (re)optimise the whole
  week when tasks/estimates/deadlines change — not just a one-shot "plan my day."
- **Focus/Pomodoro integration**: start a block → start a focus timer; running
  over shifts subsequent blocks (ties into the deferred Pomodoro item).
- **Meeting-aware buffers**: auto-insert prep/travel/decompress buffers around
  meetings.
- **Ideal week / templates**: recurring "themes" (Mon = deep work AM, Fri =
  admin) the planner fills against.
- **Time-of-day heuristics from history**: learn when the user actually completes
  high-energy work and bias future planning toward it.
- **Deadline risk radar**: surface tasks that *cannot* fit before their deadline
  given remaining capacity ("you can't finish these 3 by Friday").
- **"What can I do in 15 min?"** — free-slot filler from short next actions.
- **Weekly review**: planned-vs-actual, roll-over count, focus-hours trend.
- **Calendar-as-input**: a captured meeting → suggested prep task blocks.
- **Shared/【delegated】visibility**: see when a delegate is free (later, org-aware).

## 9b. How timeboxing fails — and how this design overcomes it

| Failure mode | Overcome by |
|---|---|
| **Overcommitment** — planning more than fits | Capacity setting + "Xh/Yh over capacity" meter; the AI planner refuses to select more than fits and leaves the rest for another day |
| **No buffers** — one overrun cascades | Buffer-minutes setting the packer leaves between blocks |
| **Ignoring energy** — deep work in a trough | Energy windows (tinted on the grid); the planner places high-energy work in peak windows |
| **Interruptions / falling behind** — the plan goes stale | One-click roll-over of overdue-incomplete blocks into today's open slots; the planner's free slots start at *now* |
| **Deadline slip** — a due task never gets timeboxed | Deadline radar: due-soon badge + rail section + one-click "Today" |
| **Bad estimates** — tasks run long | Drag-resize a block in seconds; the planner uses estimates and shows total load |
| **Double-booking** — overlaps hide each other | Side-by-side lane layout + a red "double-booked" flag |
| **Fragmentation** — scattered context switches | The planner is told to batch similar contexts |
| **Tedium** — manual timeboxing is work | One-click "Plan my day"; or just tell the assistant "I'm low energy, move deep work to tomorrow" |
| **Rigid plans** — replanning is manual | Re-plan with an energy note; roll-over; chat to reorganize |
| **Timezone/boundary bugs** | The client sends resolved ISO geometry to the planner (no server tz guessing); the assistant gets the current local time + offset |

## 10. Phased roadmap

- **P0 — scaffold ✅ DONE:** scheduling columns (mig 76) + `GtdItem` fields + API
  mapping; `CalendarView` day/week/month grid; unscheduled rail + click-to-
  schedule; `GET /tasks/calendar` range endpoint; external-sync seams.
- **P1 — timeboxing usable ✅ DONE:** drag-and-drop scheduling + block resize
  (native DnD + pointer events, 15-min snap, drop highlight); capacity meter +
  working-window/buffer/energy-window prefs (mig 77) that the grid + planner
  honor; energy-window tint bands; overlap detection with side-by-side lanes +
  "double-booked" flag; deadline all-day markers on the grid.
- **P2 — smart planning ✅ DONE:** `POST /calendar/plan` LLM planner (judgment =
  LLM, geometry = deterministic packer; priority/energy/capacity/deadline aware;
  fallback ranking) + the "Plan my day" review modal with an energy-note re-plan;
  chat-with-calendar = persona calendar context + `gtd_schedule`/`gtd_unschedule`
  /`gtd_list_schedule` agent tools.
- **P3 — auto-reschedule ✅ DONE (manual trigger):** `POST /calendar/rollover`
  packs overdue-incomplete blocks into today (deadline-aware) + the roll-over
  banner; deadline radar (due-soon badge + rail section + one-click timebox).
  *Still to do: a nightly automatic roll-over job (scheduler) + roll history.*
  *(Update 2026-08-01: the nightly job + `gtd_rollover_log` history SHIPPED —
  mig 78 + `start_auto_rollover()`; and #235 changed the semantics to
  release-to-list, see the header note. P3 is CLOSED.)*
- **P4 — external sync (DEFERRED — needs OAuth creds):** `calendar_accounts` +
  Google/Graph read (conflict-avoidance) then two-way write. Seamed at
  `GET /calendar/accounts` + `POST /calendar/sync` (501).
- **P5 — DEFERRED:** `gtd_time_blocks` table (multiple blocks/task, external
  events on the grid) + continuous auto-scheduling engine + Pomodoro + ideal-week
  templates + learned-estimate heuristics.
  *(Update 2026-08-01: the Pomodoro item SHIPPED via `calendar_focus_os.md` F1's
  Focus Mode — pomodoro/flow timer with cycle dots, 2026-07-22,
  `app/tasks/components/FocusMode.tsx`. Remaining Pomodoro-adjacent scope lives
  under focus_os F2: break blocks in the packer + cycle telemetry feeding
  learned estimates. The rest of P5 also tracks under focus_os F2/F3 — see §12.)*

## 11. Files this touches (map)

- Migration: `infra/postgres/76_gtd_scheduling.sql` (+ `schema.generated.sql`).
- Backend: `routes/tasks/core.py` (model + row map), `routes/tasks/items.py`
  (patch fields + `GET /tasks/calendar`), new `routes/tasks/calendar.py` (sync
  stubs), later `skill-task-gtd/core.py` (schedule tools) +
  `agent-task-manager/agents.py` (register tools).
- Frontend: `lib/types.ts` (`ViewKey` already has `calendar`; add scheduled
  fields), `lib/api.ts` (`mapItem` + `apiSchedule`/`apiCalendarRange`),
  `lib/taskStore.ts` (`scheduleItem`, calendar range loader), new
  `components/CalendarView.tsx` (+ day/week/month subviews), `page.tsx` (route
  calendar → `CalendarView`), `lib/taskAssistantPersona.ts` (calendar context,
  P2).

## 12. Cross-map to `calendar_focus_os.md` F0–F3 (added 2026-08-01, doc-truth pass)

| This doc | focus_os | State |
|---|---|---|
| P0–P2 (grid, timeboxing, planner, chat) | shipped foundation under F0/F1 | SHIPPED (PR #71; F0/F1 2026-07-22) |
| P3 remainder (nightly roll-over + history) | — (closed here) | SHIPPED (mig 78 + #235 release-to-list) |
| P4 external sync | F3 item | OPEN — `/tasks/calendar/sync` still 501 |
| P5 `gtd_time_blocks` / batch / recurring blocks | F2 | OPEN (table unbuilt; focus_os §5 canonical) |
| P5 Pomodoro | F1 Focus Mode | SHIPPED 2026-07-22 (`FocusMode.tsx`) |
| P5 ideal-week templates / auto-scheduling / learned estimates | F3 | OPEN (partial: recurring windows, mig 98) |

## 13. Acceptance & verification (added 2026-08-01, doc-truth pass)

- **P3 nightly roll-over — SHIPPED; acceptance restated to match #235:** after a
  user's local midnight, yesterday's unfinished flexible timeboxes are RELEASED
  to the unscheduled rail on first load without user action
  (`scheduled_start/end → NULL`, at most once per local day, `auto_rollover`
  opt-out honoured), and each release is recorded as a `gtd_rollover_log` row
  with `rolled_to = NULL`; re-planning them is deliberate (drag, or Rebuild my
  day, which sweeps them in per #232).
- **P4 external sync — OPEN; done when:** a `calendar_accounts` row can be
  created through a real OAuth connect flow (Google/Graph, reusing the
  `email/transport/oauth.py` pattern); external events render on the grid as
  `kind='external'` and the planner/packer refuses to book over them;
  `POST /tasks/calendar/sync` returns data instead of 501; two-way write pushes
  a timeboxed block out as a real calendar event.
- **Verify:** `cd workbench/control_plane && npx tsc --noEmit && npm test`
  (vitest); `pytest tests/unit -k calendar` — runs
  `tests/unit/test_calendar_planner.py` (packer geometry: free intervals,
  buffers, energy windows, lunch carve-out, day templates) and
  `tests/unit/test_email_calendar_context.py`; GTD API surface:
  `pytest tests/unit/test_tasks_gtd.py`.
