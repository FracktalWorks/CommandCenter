# Calendar → Focus OS — evaluation & redesign brainstorm

Status: **PROPOSAL / brainstorm** (2026-07-22). Nothing here is built; this doc
evaluates the calendar shipped via `calendar_timeboxing.md` + `calendar_ux_review.md`
and proposes the configuration that would make it the *primary* daily tool —
the place you focus, complete work and plan the day — effectively replacing the
task list as the surface you live in. Mockups: `mockups/calendar_focus_os.html`.

---

## 1. Where the calendar stands today (honest evaluation)

### What is already genuinely strong

| Capability | State |
|---|---|
| Timeboxing mechanics | ✅ day/week/month grid, drag-drop + resize, 15-min snap, overlap lanes, deadline all-day markers |
| AI planning | ✅ "Plan my day" + "Replan rest of day" (LLM judgment / deterministic packer), energy-note re-plan, rationale per block |
| Energy awareness | ✅ energy windows tinted on the grid; planner places high-energy work in peak windows |
| Capacity honesty | ✅ daily capacity target + booked meter + over-capacity flag; buffer minutes |
| Falling behind | ✅ one-click roll-over of overdue blocks; fixed vs flexible blocks; replan-from-now |
| Execution basics | ✅ Now/Next live bar with countdown; complete-from-block; focus timer (actualStart/End) |
| Feedback loop | ✅ end-of-day review, planned-vs-actual per block, learned estimate-accuracy stats |
| Mobile | ✅ tap-to-schedule sheet + FAB (view + basic scheduling works on touch) |

This is already at or past Sunsama/Akiflow parity **on planning**. The review
doc's "next six" have all shipped.

### Where it still falls short of "the tool I live in"

1. **Execution is a bar, not a place.** The Now/Next strip is great, but when
   it's time to *do* the work you're still staring at a grid of everything else
   — visual noise is the enemy of focus. There is no full-screen "Do" surface,
   no Pomodoro cycle, no breaks, no session ritual. The focus timer exists as a
   data-capture mechanism, not an experience.
2. **The day has no shape.** No morning startup or evening shutdown ritual as a
   first-class flow; planning is a modal you *may* open. Habits form around
   rituals, not features.
3. **All blocks look the same.** A leveraged, outcome-moving deep-work block
   renders identically to "expense report". The 80/20 signal the task manager
   already captures (`leveraged`, `important`, priority matrix) is invisible on
   the calendar — the one surface where it should scream.
4. **Small tasks and gaps don't meet.** `isTwoMinute` exists at clarify time,
   and Engage can filter "≤15 min", but the calendar never says *"you have 20
   free minutes right now — knock out these three."* Free time evaporates.
5. **No batching surface.** Contexts exist (`@calls`, `@computer`) and the
   planner is *told* to batch, but there's no visible batch block ("Calls ×4,
   45m") and no one-click "batch these".
6. **Breaks/recovery don't exist.** The packer knows `buffer_mins` but a buffer
   is dead space, not a break. Nothing suggests a walk after 90 focus minutes;
   nothing protects lunch; meditation is nowhere.
7. **Outcome blindness.** Projects carry `outcome` + `purpose`, yet a block
   never says *which outcome it advances*. A day can feel busy and be pointless.
8. **One block per task** (known P5): no split sessions, no recurring ritual
   blocks, no ideal-week templates — all needed by the ideas above.

---

## 2. The thesis: one calendar, three modes — **Plan · Do · Review**

The standout move is not "more calendar features". It's re-centering the app on
the *daily loop* every productivity method ultimately serves:

```
   PLAN (morning, 5 min)  →  DO (all day, one block at a time)  →  REVIEW (evening, 2 min)
        ↑                                                              │
        └────────────── learned estimates, carry-forward, tomorrow-seed ┘
```

- **Plan** = today's grid + unscheduled rail + AI planner (exists, gets the
  leverage/batch/break upgrades below).
- **Do** = a new full-screen focus surface: the current block, a Pomodoro/flow
  timer, the outcome it advances, and *nothing else*. The calendar shrinks to a
  thin "up next" ribbon. This is where the user spends 90% of their time — and
  it's the surface no competitor makes primary.
- **Review** = the existing end-of-day review, extended into a shutdown ritual
  that also *seeds tomorrow's plan* (closing the loop is what makes the morning
  plan take 5 minutes instead of 20).

Task lists don't disappear — they become the *backlog behind the calendar*.
Every list view keeps working, but the default landing surface is the calendar
in whichever mode fits the time of day (before day-start → Plan; during →
Do/Now; after day-end → Review).

---

## 3. Method-by-method mapping

How each philosophy the user named lands in this design — what exists (✅),
what's proposed (→):

| Method | Today | Proposed |
|---|---|---|
| **GTD** | ✅ capture→clarify→next actions feed the rail; engage criteria (energy/time/context) drive planner | → Weekly Review gets a calendar home (recurring ritual block + review flow); tickler (`deferUntil`) items surface on their day |
| **Timeboxing** | ✅ core mechanic | → split sessions (multi-block), recurring blocks, ideal-week templates |
| **Prioritizing** | ✅ 8-cell matrix ranks the planner's picks | → priority is *visible* on blocks (leverage lens, §4.3); planner guarantees the top leveraged task gets the first peak window |
| **Pomodoro** | ❌ | → Focus Mode cycles: work N min → break M min, configurable per block or "flow mode" (no interrupts, just elapsed); cycle count feeds actuals |
| **Breaks** | ⚠️ buffer minutes only | → first-class break blocks the packer inserts (after ≥90m focus, lunch protection); break menu: walk / stretch / breathe / hydrate |
| **2-minute rule** | ⚠️ flag exists at clarify | → Gap Filler: any free gap ≥10 min offers the shortest matching tasks; "clear 5 two-minute tasks" appears as one micro-batch chip |
| **Meditation** | ❌ | → startup ritual opens with an optional 1–5 min breathing timer; "breathe" is a break type; a recurring meditation block is one tap from settings |
| **Planning** | ✅ AI plan/replan modal | → becomes the *morning ritual* (auto-prompted at day start): review carry-forwards → pick the One Thing → accept plan. 5 minutes, guided |
| **Task breakdown** | ⚠️ subtasks exist in detail view | → drop a >90m task on the grid → AI offers to split into sessions/subtasks with estimates; oversized blocks get a "break this down" nudge |
| **80/20 rule** | ⚠️ `leveraged` captured, invisible here | → Leverage lens: gold accent on leveraged blocks; a daily **leverage meter** (% of focus-time on leveraged/important work); review reports it |
| **Batching** | ⚠️ planner prompt only | → Batch blocks: one grid block containing n same-context micro-tasks with an internal checklist; one-click "batch these 4 @calls" from the rail |
| **Outcome-focus** | ⚠️ project outcomes exist, not shown | → every block shows its project outcome ("→ Ship v2 onboarding"); day header: "Today advances 3 outcomes"; Do mode displays the outcome above the task |

---

## 4. Standout features (the brainstorm, ranked)

### 4.1 Focus Mode — the "Do" surface ⭐ the differentiator
Tap ▶ on any block (or the Now bar) → full-screen focus:
- Big timer ring: **Pomodoro** (25/5, 50/10, custom) or **Flow** (count-up,
  no interruptions). Cycle dots show progress through the block.
- The task title, its clarified next action, and the **project outcome** it
  advances. Checklist of subtasks ticks off in place.
- One line of context: what's next after this, and when the next break is.
- Controls: pause · done early (feeds learned estimates) · +15 min (auto-shifts
  the rest of the flexible day — no guilt, the plan reflows) · switch task
  (logged, so the review can show context-switch count).
- Ambient touches: optional tick sounds, an ultra-dim "quiet" theme.
- Ending a block → micro-transition: "Break for 5?" with break menu, then
  auto-advance to the next block.
Why it stands out: Motion/Reclaim auto-schedule but dump you back into a grid;
Sunsama has a timer but not a *place*. A first-class execution room, fed by an
AI planner, is the unclaimed spot.

### 4.2 Daily rituals — Startup & Shutdown
- **Startup (morning, auto-offered once per day):** 3 guided steps —
  (1) optional 1-min breathe, (2) review carry-forwards + calendar risk
  ("Thursday is slammed"), (3) confirm the **One Thing** + accept the AI plan.
- **Shutdown:** existing review + (4) "seed tomorrow": pick up to 3 candidates
  for tomorrow's plan; planner pre-loads them next morning. Ends with an
  explicit "day closed" state — permission to stop (the Zeigarnik release).
- Both are recurring ritual blocks on the grid (visible, skippable, streaked).

### 4.3 Leverage lens + the One Thing (80/20 made visible)
- Leveraged blocks get a gold left-edge + subtle glow; important-not-leveraged
  neutral; busywork intentionally muted.
- **One Thing:** the startup ritual asks "if only one thing gets done today…" —
  that block gets a ★ and the planner schedules it in the first peak energy
  window, protected (planner never books over it, replan moves it last).
- **Leverage meter** next to the capacity meter: "2.5h / 6h booked on leveraged
  work". The end-of-day review reports the ratio and its weekly trend.

### 4.4 Batch blocks
- Rail groups schedulable micro-tasks by context; "Batch 4 @calls (45m)" is one
  drag. On the grid it's a single block with an internal checklist; in Focus
  Mode it plays as a rapid-fire queue (done → next, satisfying).
- Planner batches automatically and *labels* the block as a batch.

### 4.5 Gap Filler — "you have 22 minutes"
- Tap any free gap (or the Now bar when nothing is scheduled): "22 min until
  your 3:00 — here's what fits": 2-minute tasks first, then short next actions
  filtered by current energy (reuses Engage's exact matching logic).
- One tap schedules it *now* and drops straight into Focus Mode.

### 4.6 Breaks & recovery as first-class citizens
- Packer rule: no more than N focus-minutes without a break (default 90 → 10);
  lunch window protected by default.
- Break blocks have types (walk · stretch · breathe · coffee) with tiny guided
  timers; skipping is one tap (tracked, gently reported in review).
- Buffers remain for meeting decompression; breaks are for recovery.

### 4.7 Outcome ribbon
- Blocks show a truncated outcome tag; the day header shows the distinct
  outcomes today advances. Week view rolls up "outcome coverage" — a project
  starved for ≥7 days gets flagged in the weekly review.

### 4.8 AI task breakdown on drop
- Dropping a task with estimate >90m (or none + big title) prompts: "Split into
  sessions?" → AI proposes subtasks/sessions with estimates; accepts as
  multiple blocks (needs multi-block, §5).

### 4.9 Today timeline (mobile Do view)
- On phones, day view defaults to a vertical *agenda journey* (done ✓ above the
  now-marker, upcoming below, breaks as small beads) instead of the hour grid.
  Grid stays one toggle away. Execution-first ergonomics for the surface where
  drag-and-drop is weakest.

### 4.10 Foundations this unlocks (already spec'd as P5)
`gtd_time_blocks` (multi-block tasks, recurring blocks, break/ritual/external
kinds), ideal-week templates, external calendar sync. The features above are
the *reason* to now build that table.

---

## 5. Data model deltas

- **`gtd_time_blocks`** (promote from spec §3 phase-2): `id, item_id NULLABLE,
  start, end, kind('task'|'batch'|'break'|'ritual'|'external'), flexible,
  actual_start, actual_end, source, external_event_id, recurrence_rule`.
  `item_id` nullable because breaks/rituals aren't tasks. Batch blocks join to
  members via `gtd_block_members(block_id, item_id, done_at)`.
- **`gtd_items`**: no change needed beyond what exists (leveraged, isTwoMinute,
  energy, estimates, actuals all present) — the redesign is mostly *surfacing*
  captured data.
- **Settings**: `pomodoroWorkMins/BreakMins`, `maxFocusRunMins`, `lunchWindow`,
  `oneThingId (per-day)`, ritual toggles, break-type prefs.
- **New telemetry**: focus sessions (cycles, switches, completed-early/late) →
  powers review stats + learned time-of-day heuristics.

## 6. Why this stands out vs Motion / Sunsama / Akiflow / Reclaim

- **Motion/Reclaim**: world-class auto-scheduling, zero execution experience,
  zero philosophy. We match the planner and add the room you work in.
- **Sunsama**: owns the ritual niche (calm planning) but is manual and
  meeting-centric; our rituals are AI-accelerated (5 min, not 20) and the
  80/20 + outcome layer is absent there.
- **Akiflow**: fast command-bar timeboxing, but tasks are still the center; the
  calendar is a target, not a home.
- **Unique combination here**: AI planner ＋ execution room ＋ leverage/outcome
  visibility ＋ the whole thing already living inside the same brain that reads
  your email, tasks and org — capture-to-calendar with zero re-entry.

## 7. Suggested phasing (for the "what do we build" discussion)

- **F0 (no schema change, ~1 sprint):** Leverage lens + One Thing ＋ leverage
  meter; Gap Filler; outcome tag on blocks; Startup/Shutdown flows reusing the
  existing plan + review modals.
- **F1:** Focus Mode (Pomodoro/flow, subtask checklist, +15 reflow) — timer
  state is client-side; actuals API already exists.
- **F2:** `gtd_time_blocks` + breaks in the packer + batch blocks + recurring
  ritual blocks.
- **F3:** ideal-week templates, mobile timeline view, AI breakdown-on-drop,
  weekly review surface, external sync (P4 creds permitting).

## 8. Mockups

`ai-company-brain/specs/mockups/calendar_focus_os.html` — self-contained HTML
(open in any browser) showing: Plan mode grid with leverage lens / batch /
break / ritual blocks + meters; Focus Mode; Gap Filler; Startup ritual;
Shutdown review; mobile Today timeline. Visual language matches the control
plane's dark theme (cyan primary, gold = leverage).
