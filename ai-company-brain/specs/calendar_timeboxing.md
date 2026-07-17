# Calendar & Timeboxing — feature spec + roadmap

Status: **scaffolding + plan** (2026-07-17). Branch `feat/calendar-app`. This
document is the plan; the branch ships the scaffold (data model + day/week/month
grid + seams). Nothing here auto-deploys until reviewed.

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

## 10. Phased roadmap

- **P0 — scaffold (this branch):** scheduling columns + migration; `GtdItem`
  fields + API mapping + `scheduleItem` store action; `CalendarView`
  day/week/month grid rendering scheduled + deadline items; unscheduled rail +
  click-to-schedule; `GET /tasks/calendar` range endpoint; sync + chat + planner
  **seams** (stubs) wired but returning "coming soon".
- **P1 — timeboxing usable:** drag-and-drop scheduling + resize; capacity meter;
  energy windows setting; the deadlines all-day lane.
- **P2 — smart planning:** `gtd_plan_day` tool + "Plan my day" + look-ahead;
  chat-with-calendar persona context + schedule tools.
- **P3 — auto-reschedule:** nightly roll-over job + deadline escalation + roll
  history UI.
- **P4 — external sync:** `calendar_accounts` + Google/Graph read; then two-way
  write; conflict avoidance against external events.
- **P5 — time-blocks table + auto-scheduling engine + Pomodoro + templates.**

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
