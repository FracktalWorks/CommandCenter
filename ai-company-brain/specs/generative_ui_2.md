# Generative UI 2.0 — Immersive HITL UI for Agents

**Status:** Phase 1 shipped 2026-07-23 · **Owner:** Vijay
**Scope:** how agents generate rich, interactive, on-brand UI — inline in chat AND
as immersive side-panel views — with first-class human-in-the-loop interaction.

**Companions:** `chat_ux.md` §12 (AG-UI protocol headroom) ·
`chat_agent_framework_review_2026-07.md` §8 (co-authoring) ·
`workbench/control_plane/DESIGN_SYSTEM.md` (tokens/components).

---

## 1. Review — how it worked before this spec

Three-tier pipeline, all delivered over the AG-UI `CUSTOM`/`generative_ui` event
(`acb_skills/write_artifact.py::emit_generative_ui` → executor queue → SSE →
`useAgentChat` → `MessageBubble` → `GenerativeUINode`):

| Tier | What | Strength | Weakness |
|---|---|---|---|
| 1 | Whitelisted component tree (card/table/badge/…/button/icon) | safe, declarative | verbose `{type,props,children}`; display-only — **no input primitives** |
| 2 | Named React templates (6: weather/stats/bars/spark/comparison/progress) | data-only, on-brand, animated | thin coverage; **no interactive template** |
| 3 | Sandboxed HTML iframe (`SandboxedHtml`, opaque origin, CSP-locked, `ccAction`/`ccSubmit` bridge, `--cc-*` tokens, report kit CSS) | unlimited | hand-written per run — token-heavy, inconsistent |

**The four structural gaps** (verified in code):
1. **No blocking submit.** genUI buttons/`ccSubmit` route through `submitText` →
   a NEW chat message (queued/steered if a run is active). Only
   ElicitationCard/ConfirmationCard could resume a parked run via
   `request_id` → `/agent/respond-input`. A rich form could never pause the turn.
2. **No panel surface.** The side panel (`sidePanelStore`) was file-tab-only; the
   only route to immersive UI was writing an `.html` file to the workspace (a
   filesystem round-trip that abandons Tier 1/2 React entirely).
3. **No form/choice machinery.** Structured input = hand-rolled Tier-3 HTML.
4. **Efficiency.** The agent restates design in every custom-HTML emission;
   templates (data-only) are the cheap path but covered too few scenarios.

## 2. Architecture (the Claude-artifacts model, adapted)

**One payload, two surfaces, two interaction modes** — orthogonal axes on the
same `emit_generative_ui` spec:

```
emit_generative_ui({
  surface: "inline" | "panel",   // WHERE: transcript card vs immersive side panel
  hitl:    true | absent,        // HOW: block-and-return vs fire-a-new-message
  title:   "...",                // panel tab label / chip label
  ...one of: template | tree | html
})
```

- **`surface:"panel"`** → the spec opens as a side-panel tab (`openGenUI` in
  `sidePanelStore`, `kind:"genui"`), rendered natively by `GenerativeUINode` —
  no file round-trip, Tier-2 templates keep their React implementations. The
  transcript shows a compact re-open chip (persisted via `custom_events`, so it
  survives reload). Auto-opens on arrival, artifacts-style.
- **`hitl:true`** → the tool call parks on the SAME Future registry as
  `ask_questions` (`_pending_user_input` + `wait_user_future` heartbeat); the
  spec carries a `request_id`; any interaction resolves it through
  `/agent/respond-input` and the run resumes with the values as the tool
  result. Non-blocking interactions keep the legacy send-a-message path.
  Frontend routing: `MessageBubble`/`SidePanelEditor` → `request_id` present →
  `postRespondInput` (fallback: `submitText` so an answer is never lost).
- **Panel interactions** travel over the global `agentEvents` bus
  (`genui_panel_action`) because the side panel has no direct line to
  AgentChat's send/HITL plumbing.

**Design language:** everything renders from the app's semantic tokens
(`var(--primary)`, `--accent`, `--success`, `--warning`, `--destructive`,
`--card`, `--border`, radius, `--cc-ease` motion) with hex fallbacks; icons are
Lucide-only via `resolveIcon` (bundled, no network — Font Awesome rejected to
keep one icon system, per DESIGN_SYSTEM.md).

## 3. Template library (Phase 1 catalog — 11 templates)

Display: `weatherCard`, `statDashboard`, `barChart`, `sparkTrend`,
`comparison`, `progressTracker` *(pre-existing)* + `recipeCard` (meta chips,
ingredient checklist, numbered steps, tip callout), `flightStatus` (route with
animated plane on a progress line, gates/terminals, status badge),
`trainStatus` (stops timeline, platforms, delay badge).

Input (HITL-first): **`formCard`** — schema-driven fields
(text/number/select/slider/toggle/date/textarea, required-gating, unit
labels) that submit `label — {json}` back; **`optionPicker`** — rich choice
cards (icon/badge/recommended★, single=tap-to-submit, multi=confirm).

Data shapes live in `genUITemplates.tsx::TEMPLATE_CATALOG` (source of truth,
mirrored into the `emit_generative_ui` docstring — keep in lockstep).

## 4. Scenario → element mapping (brainstorm; build on demand)

| Scenario | Today | Future template candidates |
|---|---|---|
| Recipe / how-to | `recipeCard` | `stepByStepGuide` (interactive check-off) |
| Weather | `weatherCard` | `weatherWeek` (panel surface) |
| Flight / train info | `flightStatus` / `trainStatus` | `journeyItinerary` (multi-leg, panel), `seatMap` |
| Enter information | `formCard` + hitl | `wizardForm` (multi-step, panel), `fileDropField` |
| Decisions / approvals | `optionPicker`, `confirmation` | `tradeoffMatrix` (weighted scoring) |
| Metrics / status | `statDashboard`, `sparkTrend`, `barChart` | `gauge`, `donut`, `liveTicker` (needs event re-emit) |
| Schedules | — (Tier 3) | `calendarSlotPicker` (hitl), `ganttTimeline` |
| Shopping / orders | — | `productCards`, `orderStatus` (reuse journey pattern) |
| Documents | report kit (`.html` artifact) | genUI panel + `markdown` node already covers light cases |
| Data tables | Tier-1 `table` | `dataGrid` (sort/filter, row actions → ccAction) |

Rule of thumb for adding: a scenario earns a TEMPLATE when agents hit it
repeatedly in Tier 3 (grep run traces for `type":"html` payloads) — promote the
pattern, delete the bespoke HTML.

## 5. Why this is the efficient method

- **Tokens:** a template emission is ~10-20 lines of data vs hundreds of lines
  of HTML/CSS; the design cost is paid once in the repo, not per run.
- **Consistency:** Tier-2 React + tokens render identically every run, both
  themes, reduced-motion respected — no drift between agents.
- **Latency:** no filesystem round-trip for immersive UI; the panel opens from
  the same SSE event the chip renders from.
- **HITL correctness:** blocking submits resume the SAME turn (no queued
  follow-up message, no prompt re-assembly, no "the user will reply later"
  dance) — and they inherit every HITL hardening already shipped (heartbeats,
  cross-worker acks, watchdog suppression).

## 6. Phases

- **Phase 1 — SHIPPED 2026-07-23:** `surface`/`hitl`/`title` on
  `emit_generative_ui` (+ park/resume + cleanup on failure); `openGenUI` +
  `kind:"genui"` side-panel tabs; transcript chip; `genui_panel_action` bus
  route; 5 new templates; ctx-threaded `renderTemplate`; addendum/tool-doc
  updates; backend tests (`tests/unit/test_genui_hitl.py`).
- **Phase 2:** Tier-1 input primitives (`input`/`select`/`slider` nodes) so
  trees can embed fields; `calendarSlotPicker` + `wizardForm`; panel genUI
  re-open from the Files/Artifacts viewer; template gallery page in the
  workbench for eyeballing the library.
- **Phase 3:** live-updating templates (agent re-emits with same `title` →
  in-place update — the store already replaces same-id tabs); typed
  TEMPLATE_CATALOG (zod) generated into the backend docstring to kill the
  hand-mirrored contract; A2UI/MCP-UI payload interop assessment (chat_ux §12).
- **Cleanup backlog:** migrate genUI primitive hardcoded hexes
  (`ICON_TONE`, badge/callout classes, `TONE_COLOR`) to semantic tokens;
  DESIGN_SYSTEM rule says never raw hex.
