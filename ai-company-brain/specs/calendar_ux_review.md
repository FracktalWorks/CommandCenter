# Calendar-for-task-management — UX & backend review

A designer's-eye audit of the calendar built in PR #71 (2026-07-18). What's
strong, what's missing, and the psychology of *why* people abandon calendars for
task management — with prioritized, specific fixes.

## 1. Executive summary

The calendar is strong at **planning** — the AI "Plan my day", energy-aware
timeboxing, drag-drop, roll-over and deadline radar are a genuinely good
planning engine, and the LLM-judgment / deterministic-geometry split is the
right architecture.

The gaps cluster in three areas, and they're the areas that actually decide
whether a task-calendar gets *used*:

1. **The execution loop is thin.** The app is great at deciding *what to do
   when*, but weak at *doing it and feeling progress*. You can't complete a
   block from the calendar, completed blocks vanish (no sense of
   accomplishment), and there's no "what should I be doing right now" focus.
2. **Mobile is a second-class citizen.** Scheduling (the drag rail, due-soon,
   capacity) is desktop-only; native HTML5 drag doesn't work on touch at all.
3. **The plan and reality drift apart with no reconciliation.** No reminders, no
   real-time reflection of changes, no planned-vs-actual, no learning from bad
   estimates. Drift erodes trust, and a distrusted calendar gets abandoned.

The single highest-leverage theme: **make the calendar kind and alive during the
day, not just smart the night before.**

## 2. Psychological roadblocks — the real reasons task-calendars fail

The failure modes aren't mechanical, they're psychological. Status against this
implementation:

| Roadblock | What it is | Status here | Fix |
|---|---|---|---|
| **Planning fallacy** | We chronically under-estimate durations | ❌ estimates are taken at face value, blocks are fixed to them | Track actuals; learn a per-user fudge factor; suggest padded estimates |
| **Overpacking / optimism** | Filling every slot, no slack | ⚠️ capacity meter + buffers exist, but nothing stops you dragging past capacity | Enforce/visualize capacity on the grid; default a buffer; show white space as OK |
| **Guilt & shame spiral** | A wall of unfinished red is demoralizing → abandonment | ⚠️ roll-over helps, but overdue shows as red/alarm | Frame as "carry forward", not "failed"; soften overdue visuals; a *gentle* morning digest |
| **All-or-nothing** | One missed block ⇒ "the plan is ruined" ⇒ quit | ⚠️ roll-over + free-slots-from-now help | A prominent "Replan the rest of my day" that reorganizes, not just fills |
| **Rigidity vs reality** | Plans assume zero interruptions | ✅ easy drag/resize/reschedule | Distinguish **fixed** (meetings) vs **flexible** (auto-moving) blocks |
| **Decision fatigue** | Deciding what/when is tiring | ✅ one-click AI plan + chat | Ideal-week templates + defaults to remove even more choices |
| **Context switching** | Scattered task types fragment focus | ⚠️ planner is told to batch contexts | Surface context batching visually; "theme days" |
| **Losing the big picture** | Day view hides the week's shape/deadlines | ✅ week/month + deadline radar | Per-day load bars in week view; a week "capacity at a glance" |
| **Tyranny of the urgent** | Reactive work crowds out important work | ✅ leverage-first planning + priority matrix | Protected/‑labelled deep-work blocks the planner won't fill over |
| **Time blindness** (esp. ADHD) | Not sensing time pass; ignoring blocks | ⚠️ now-line only | Highlight the **current block**; countdown; reminders; Pomodoro tie-in |
| **Scheduling friction** | If it's hard to block time, you won't | ✅ drag + one-click timebox (desktop) | Natural-language quick-add; tap-to-schedule on mobile |
| **Commitment aversion** | Reluctance to "appointment" a task | ⚠️ everything is a hard-looking block | Soft/flexible blocks that visibly auto-move reduce the fear |
| **No progress feedback** | Completed work vanishes → no dopamine | ❌ **DONE blocks disappear from the grid** | Show completed blocks (struck/greyed); a daily "done" tally + streak |
| **Plan≠reality drift** | The calendar stops matching life → distrust | ❌ no actuals, no reconciliation | Track actual start/stop; a 2-minute end-of-day review |

## 3. UX gaps & improvements (prioritized)

### P0 — the execution loop (highest impact, small effort)
- **Complete a block from the calendar.** Blocks have open / unschedule /
  resize but no done. Add a checkbox on the block → `quickDispose(id,"DONE")`.
  (Today you must open the task, and then it vanishes — double punishment.)
- **Keep completed blocks visible.** `blocksForDay` renders from the store's
  active `items`, which exclude DONE, so a finished block disappears — the exact
  moment you want a hit of accomplishment. Fetch DONE-with-a-block for the
  viewed range (the `GET /tasks/calendar` endpoint already *could* include them)
  and render them struck-through/green. Add a small "3 done · 2.5h" tally.
- **"Now" focus.** Highlight the block that contains the current time (border +
  subtle pulse), and show a compact "Now / Next" card: what you should be doing
  and what's coming. This is the single best antidote to time-blindness.

### P1 — mobile & reminders
- **Mobile scheduling.** The rail (drag source, due-soon, capacity, Plan) is
  `hidden md:flex`, and native drag doesn't fire on touch — so on a phone you
  can view but barely schedule. Add: tap an empty slot → "schedule a task here"
  sheet; a bottom-sheet unscheduled list; make "Plan my day" the primary mobile
  CTA.
- **Reminders / notifications** when a block starts (and a nudge if the previous
  one isn't marked done). Hook the app's notification surface (the approvals/
  notifications work) or web push. Without reminders, blocks are ignored.

### P2 — adapting to reality
- **"Replan the rest of the day."** The plan modal only fills *free* slots; it
  can't reorganize existing future incomplete blocks. Add a mode that unschedules
  today's not-yet-done future blocks and re-timeboxes them from now — the true
  "I fell behind, fix my day" button.
- **Fixed vs flexible blocks.** A meeting must not auto-move; a task block should.
  A `flexible` flag lets roll-over/replan/auto-scheduler move only what's movable,
  and reduces commitment-aversion ("it'll re-flow if I slip").
- **Deadline *risk* (not just radar).** Today's radar shows unscheduled due-soon
  tasks. Add the harder signal: "these N tasks can't fit before their deadline
  given your remaining capacity" — computed from estimate sum vs capacity×days.

### P3 — feedback, learning, big-picture
- **Planned-vs-actual + a 2-minute end-of-day review** (what got done, what
  rolled, how estimates compared) → the loop that builds trust and better
  estimates.
- **Learned estimates.** Use logged actuals to nudge future estimates and the
  planner's durations (fixes the planning fallacy over time).
- **Week load-at-a-glance.** Mini capacity bars in each week-view day header so
  overcommitted days are obvious before you commit.
- **Ideal-week templates / recurring blocks** (needs the P5 `gtd_time_blocks`
  table): "Mon AM = deep work" the planner fills against.

### P4 — polish, a11y, semantics
- **Accessibility:** drag-drop is mouse-only — add keyboard scheduling (select
  task → arrow to a slot → enter) and ARIA on blocks; the conflict signal is
  color-only (red) — pair it with an icon/label (it has a title tooltip, but that
  isn't enough).
- **Color semantics:** energy uses high=`destructive` (red). Red reads as
  "urgent/bad", not "high energy" — consider a dedicated energy ramp so meaning
  isn't overloaded with the deadline/conflict reds.
- **Empty state:** a brand-new calendar with nothing scheduled is just an empty
  grid — add a "Plan your day" hero / first-run nudge.
- **Quick-add natural language** on the grid ("gym 6pm", "deep work 2h tmrw AM").
- **Keyboard shortcuts** (T = today, D/W/M = views, P = plan) for power users.

## 4. Backend gaps

- **No real-time push.** Server-side roll-over (and any change from another
  device / the agent) isn't reflected in an open client until re-hydrate. At
  minimum re-hydrate on window focus; ideally SSE/websocket for the grid.
- **No "actuals".** We store the *planned* block but never when it was actually
  started/finished — blocking planned-vs-actual, learned estimates, and honest
  review. Add `actual_start/actual_end` (or events) — pairs naturally with a
  Pomodoro/focus timer.
- **Replan doesn't touch committed blocks.** `/calendar/plan` only fills free
  space; there's no server operation to *reorganize* an existing day.
- **External events are invisible.** Until P4 sync lands, the planner/roll-over
  can happily book over a real Google/Outlook meeting. Even before full sync,
  reading busy times would prevent embarrassing double-bookings.
- **Auto roll-over is silent.** It applies without telling the user; a **morning
  digest** ("I moved 3 unfinished tasks into today") would be more trustworthy
  than tasks silently reappearing — and less spooky.
- **Capacity is advisory, not modelled per-day.** It's a single number; a busy
  Tuesday and a light Friday get the same budget. Per-day / ideal-week capacity
  would let the planner load-balance across the week.
- **One block per task.** No `gtd_time_blocks` table yet, so you can't split a
  4-hour task into two focus sessions, or represent recurring/external blocks on
  the same grid (the grid is already written against a block abstraction, so the
  swap is non-breaking — see spec §3).

## 5. Recommended next six (impact × effort)

1. **Complete-from-calendar + keep DONE blocks visible + a daily done tally.**
   (small; fixes the missing dopamine loop — the biggest retention lever.)
2. **"Now / Next" focus + current-block highlight.** (small; kills time-blindness.)
3. **Mobile scheduling** (tap-to-schedule sheet + mobile Plan CTA). (medium; half
   your usage is probably phone.)
4. **Block reminders/notifications.** (medium; blocks you don't get pinged about
   are blocks you ignore.)
5. **"Replan the rest of my day" + fixed/flexible blocks.** (medium; the honest
   answer to falling behind.)
6. **Actuals + a 2-minute end-of-day review → learned estimates.** (larger;
   builds the trust + accuracy flywheel.)

If only one thing ships next: **#1**. A calendar that celebrates done work and
never shames you for undone work is a calendar people keep using. Everything else
is optimization on top of that.
