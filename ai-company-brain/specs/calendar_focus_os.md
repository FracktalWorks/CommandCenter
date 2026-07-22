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
- **Focus Shield** (tips 5/15/26/84 — control your devices, kill alerts): while
  a focus session runs, Command Center's own notifications (email pings, chat,
  approvals) are *held* and released at the next break — batched, not lost.
  The shield state is visible ("6 held · released at your break"), which is the
  honest version of Do-Not-Disturb: nothing is missed, everything is deferred.
  Full-screen by design; single-theme ultra-dim "quiet" mode.
- **Capture without leaving** (tips 20/22/87 — swirling-thoughts problem): the
  existing QuickCapture hotkey (`C`) opens a minimal capture drawer *inside*
  Focus Mode — the stray thought goes to the GTD inbox and the timer never
  stops. Closing the open loop is one keystroke; triaging waits for later.
- **Ambient sound** (tip 21): optional white-noise/rain loop and tick sounds,
  off by default, remembered per user.
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

### 4.7 Outcome ribbon + the Top-5 constraint
- Blocks show a truncated outcome tag; the day header shows the distinct
  outcomes today advances. Week view rolls up "outcome coverage" — a project
  starved for ≥7 days gets flagged in the weekly review.
- **Top-5 outcomes** (tip 97, Buffett's rule): the Horizons view (currently a
  "soon" placeholder in the sidebar) becomes the place you pick the ≤5 active
  outcomes that matter. The planner *favors* their tasks, the leverage meter
  counts work on them as leveraged-by-association, and the weekly review asks
  the uncomfortable question: "4h went to outcomes not in your five — demote
  the work or promote the outcome?" Everything else is an avoid-list, which is
  also the calendar's institutional way of **saying no** (tip 3): the planner
  declines to schedule over capacity and tells you *what it declined and why*.

### 4.8 AI task breakdown on drop
- Dropping a task with estimate >90m (or none + big title) prompts: "Split into
  sessions?" → AI proposes subtasks/sessions with estimates; accepts as
  multiple blocks (needs multi-block, §5).

### 4.9 Today timeline (mobile Do view)
- On phones, day view defaults to a vertical *agenda journey* (done ✓ above the
  now-marker, upcoming below, breaks as small beads) instead of the hour grid.
  Grid stays one toggle away. Execution-first ergonomics for the surface where
  drag-and-drop is weakest.

### 4.10 Email windows — the inbox gets an appointment
Tips 10/11/83/91/98 all say the same thing: email (and social/chat) is checked
compulsively unless it has *scheduled* time. Command Center owns the email app,
so this can be real, not aspirational:
- A recurring **Email window** batch block (default 2×/day, e.g. 11:30 + 16:00)
  is the sanctioned time to process mail. Outside it, the Focus Shield holds
  email notifications (§4.1).
- Inside the window, the block deep-links into the email app's triage; the
  existing email→task capture (`TaskCaptureModal`, `origin.emailId`) already
  turns "this needs real work" into a GTD item — which the tip-98 rule then
  routes to *tomorrow's* plan seed by default, not into today's focus.
- The end-of-day review counts email time honestly ("52m in email · plan was
  40m"), the same planned-vs-actual treatment as any block.

### 4.11 Waiting-on chase — the delegation loop on the calendar
The app already has WAITING items, `waitingOn` people, `delegatedAt` stamps and
a delegate suggestion in the priority matrix (tips 33/88/93). What's missing is
*when chasing happens*. A small recurring **Chase block** (10–15m, 2–3×/week)
auto-fills with WAITING items sorted by age and deadline; each row is
one-tap "nudge" (drafts the follow-up via the email app) / "got it" (marks
received) / "escalate". Delegation without follow-up is abdication; this makes
follow-up a scheduled habit instead of a guilty memory.

### 4.12 Foundations this unlocks (already spec'd as P5)
`gtd_time_blocks` (multi-block tasks, recurring blocks, break/ritual/external
kinds), ideal-week templates, external calendar sync. The features above are
the *reason* to now build that table. External sync (P4) is also what makes
timeboxing **transparent** (tip 1's shared-calendar clause) — colleagues see
the block, not the task detail — and what lets the packer respect commutes,
meetings and travel buffers (tips 16/48).

---

## 4b. Cross-check against the "100 tips" list

The user-supplied tips list, mapped. Tips that changed this spec are bold;
the rest either confirm existing design or are consciously out of scope.

| Tips | Theme | Where it lands |
|---|---|---|
| 1, 68, 19 | Timebox into a (shared) calendar; scheduled > listed; plan the week around non-negotiables | The core thesis (§2); weekly planning joins the ritual family; shared visibility via P4 sync (§4.12) |
| 2, 32, 86 | Prioritize ruthlessly; effective > efficient; hard stuff first | Existing 8-cell matrix + leverage lens (§4.3); "hard stuff first" = One Thing in the first peak window; effectiveness is *the* leverage-meter argument |
| **3** | Say no | Capacity refusal made legible: the planner reports what it declined and why (§4.7) |
| **5, 15, 26, 84** | Control devices, kill alerts, avoid visual distraction | **Focus Shield** — notifications held during focus, batch-released at breaks (§4.1) |
| 4, 6, 36, 96 | Move, short breaks, long lunch, scheduled decompression | Typed break blocks (walk/stretch/breathe), lunch protection, max-focus-run rule (§4.6) |
| 9 | 2-minute rule (batch the small stuff, don't mix with deep work) | Gap Filler + the 2-minute pile, never interleaved into focus blocks (§4.5) |
| **10, 11, 83, 91, 98** | Scheduled email/social time; inbox ≠ to-do list; emails → tomorrow's plan | **Email windows** (§4.10) — real because the email app is in-house |
| 13, 25, 52 | Know thyself; biological prime time | Energy windows exist; learned time-of-day heuristics close the loop (§5 telemetry) |
| 14, 61 | Breathe, meditate, be present | Startup ritual's breathe step; "breathe" break type; recurring meditation block (§4.2, §4.6) |
| 16, 28, 30, 48, 63 | Meeting hygiene | Mostly out of scope until P4 sync; then meeting-aware buffers + default-shorter-slot suggestions |
| **20, 22, 87** | Single-task; write it down; close open loops | Focus Mode is single-tasking as architecture; **capture-drawer inside Focus Mode** (§4.1); shutdown's "close the day" |
| **21** | Sound & music | Ambient sound option in Focus Mode (§4.1) |
| 23, 56 | Break tasks down; just start | AI breakdown-on-drop (§4.8); Gap Filler's "start the pile" = zero-ceremony starts |
| 24, 31, 97 | 80/20; focus on outcomes; **Buffett's five goals** | Leverage lens + outcome ribbon + **Top-5 outcomes in Horizons** (§4.3, §4.7) |
| 29 | Batch similar tasks | Batch blocks (§4.4) |
| **33, 88, 93** | Delegate; waiting-on list; set deadlines | **Waiting-on chase block** (§4.11) on top of existing WAITING/delegation machinery |
| 37, 41, 74 | Time yourself; flow; rituals | Focus/flow timers + actuals (exist); Startup/Shutdown rituals (§4.2) |
| 44, 94 | Public commitment; accountability | Lightweight: shared-calendar visibility (P4); a future "today's plan" share is noted, not designed |
| 45, 73, 79 | Celebrate, reward, gamify | Done tally, One-Thing verdict, ritual streaks — deliberately gentle, no dark-pattern gamification |
| 51, 65, 70 | Reclaim lost pockets of time | Gap Filler is exactly this (§4.5) |
| 53 | Protected time for yourself | "Protected" is a block property, not lunch-only — recharge blocks the planner won't touch |
| 62, 76 | Systemise; personal agile | The AI planner + rollover *is* the system; weekly ritual ≈ a personal sprint boundary |
| 8, 12, 27, 42, 43, 50, 64, 80, 92, 95, 99, 100 | Diet, sleep, hydration, desk, clothing, etc. | Out of scope — a work calendar shouldn't nag about chewing gum; the break menu's walk/hydrate types are as far as we go |
| 17, 34 | Site blockers, ignore the news | Out of scope (OS/browser territory); the Focus Shield covers our own surfaces only |

## 4c. Ecosystem fit — every feature has an existing home

No feature above is an island; each plugs into a surface that already exists:

| New feature | Existing surface it builds on |
|---|---|
| Focus Mode | `TaskFocusModal` (detail card), Now/Next bar's `actualStart/End` focus timer, `openFocus` store action |
| Focus Shield | Command Center notification/approvals surface (holds + batch-release); email app's unread state |
| Capture-in-focus | `QuickCapture` + the global `C` hotkey in `page.tsx` — reused, not rebuilt |
| Gap Filler | `EngageView`'s energy/time/context matching + `isTwoMinute` flag + Engage's `TIME_OPTS` |
| Leverage lens / meter | `leveraged`/`important` flags + `priority.ts` matrix — display-only change on the grid |
| One Thing | planner's existing rank + `firstFreeSlot`; a per-day setting; protected = `flexible:false` semantics |
| Batch blocks | `GtdContext` (@calls…) + planner's batching instruction; needs `gtd_time_blocks` + members |
| Breaks / rituals | packer's `buffer_mins` seam + settings popover; needs block kinds |
| Startup ritual | `PlanDayPanel` (plan mode) + carry-forward = rollover banner logic, re-sequenced as steps |
| Shutdown | `EndOfDayReview` + `apiEstimateStats` — extended with leverage ratio + tomorrow seed |
| Email windows | email app triage + `TaskCaptureModal` (`origin.emailId` linkage already lands in the GTD inbox) |
| Waiting-on chase | WAITING disposition, `waitingOn`/`delegatedAt`, `DelegateDialog`, email app for nudge drafts |
| Top-5 outcomes | `GtdProject.outcome/purpose/areaId` + the Horizons sidebar placeholder (`soon: true`) |
| Outcome ribbon | `projectId` → project outcome — display-only |
| AI breakdown | subtasks (`parentItemId`/`subtaskCount`) + clarify AI (`clarify.ts`) |
| Mobile timeline | mobile single-pane flow + `ScheduleSheet`; grid stays as the toggle |

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
  `oneThingId (per-day)`, ritual toggles, break-type prefs, email-window
  schedule, focus-shield on/off, ambient-sound choice, top-5 outcome ids.
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
- **F1:** Focus Mode (Pomodoro/flow, subtask checklist, +15 reflow, capture-in-
  focus via the existing QuickCapture, ambient sound) — timer state is
  client-side; actuals API already exists. Focus Shield ships here if the
  notification surface exposes a hold/release hook; otherwise F2.
- **F2:** `gtd_time_blocks` + breaks in the packer + batch blocks + recurring
  ritual blocks + Email windows + Waiting-on chase block.
- **F3:** ideal-week templates, Top-5 outcomes (Horizons build-out), mobile
  timeline view, AI breakdown-on-drop, weekly review surface, external sync
  (P4 creds permitting — unlocks shared-calendar transparency + meeting-aware
  buffers).

## 8. Mockups

`ai-company-brain/specs/mockups/calendar_focus_os.html` — self-contained HTML
(open in any browser) showing: Plan mode grid with leverage lens / batch /
break / ritual blocks + meters; Focus Mode; Gap Filler; Startup ritual;
Shutdown review; mobile Today timeline. Visual language matches the control
plane's dark theme (cyan primary, gold = leverage).
