// The prioritization engine — the single source of truth for how a task's
// three inputs (important × urgent × leveraged) become a priority CELL, an
// action MODE, and a rank. Pure + unit-testable; imported everywhere the UI
// slices by priority so the matrix is computed identically on every surface.
//
// Design (agreed with the user):
//   • urgent is DERIVED from dueAt (overdue or due within a window), never
//     stored — so it can't go stale. Overridable only by editing the due date.
//   • important = downside (something stalls/breaks if skipped) — manual.
//   • leveraged = upside (asymmetric 100x outcome) — manual, the scarce flag.
//   • The 8 cells are a projection of the three booleans (the user's Notion
//     formula, verbatim). Never persisted.
//   • The cells collapse into ACTION MODES: do / delegate / schedule / drop.
//     Delegate/Schedule are SUGGESTIONS layered on My Next Actions, never a
//     forced move — dismissible via keptMine.

import { GtdItem } from "./types";

/** Default urgency window (hours). A due task is urgent when overdue or due
 *  within this many hours. Overridable per-user (gtd_settings). */
export const DEFAULT_URGENT_WINDOW_HOURS = 48;

/** Header label for the "no @context" bucket when grouping by context. */
export const NO_CONTEXT_GROUP = "No context";

const HOUR_MS = 60 * 60 * 1000;

/** Is this task urgent right now? Overdue OR due within `windowHours`. A task
 *  with no due date is never urgent. `now` is injectable for tests/determinism. */
export function isUrgent(
  item: Pick<GtdItem, "dueAt">,
  windowHours = DEFAULT_URGENT_WINDOW_HOURS,
  now: number = Date.now(),
): boolean {
  if (!item.dueAt) return false;
  const due = new Date(item.dueAt).getTime();
  if (Number.isNaN(due)) return false;
  return due <= now + windowHours * HOUR_MS; // overdue (due<=now) is included
}

/** True when the task became urgent only because a deadline is now close (vs
 *  already overdue) — used to *surface* a task that silently crossed into
 *  urgent so the auto-derivation doesn't work against the user. */
export function isNewlyUrgent(
  item: Pick<GtdItem, "dueAt">,
  windowHours = DEFAULT_URGENT_WINDOW_HOURS,
  now: number = Date.now(),
): boolean {
  if (!item.dueAt) return false;
  const due = new Date(item.dueAt).getTime();
  if (Number.isNaN(due)) return false;
  return due > now && due <= now + windowHours * HOUR_MS; // close, not overdue
}

// ── The 8 cells (the user's Notion formula, verbatim) ───────────────────────

export type PriorityCell =
  | "founder-fire" // 1. ❗⏰⚖️  Important + Urgent + Leveraged
  | "deep-work" // 2. ❗⚖️   Important + Leveraged, not Urgent
  | "quick-leverage" // 3. ⏰⚖️   Urgent + Leveraged, not Important
  | "delegate-important" // 4. ❗⏰   Important + Urgent, not Leveraged
  | "schedule-important" // 5. ❗    Important, not Urgent, not Leveraged
  | "delegate-urgent" // 6. ⏰    Urgent, not Important, not Leveraged
  | "leverage-bet" // 7. ⚖️    Leveraged only
  | "eliminate"; // 8.        none of the three

export interface CellMeta {
  cell: PriorityCell;
  /** 1..8 — the user's own numbering / rank order (1 = act first). */
  order: number;
  emoji: string;
  label: string;
  /** which action mode this cell collapses into. */
  mode: ActionMode;
}

/** do = my deep/leverage work · delegate = hand off · schedule = calendar it ·
 *  drop = eliminate. Delegate/schedule are SUGGESTED, never auto-applied. */
export type ActionMode = "do" | "delegate" | "schedule" | "drop";

export const CELL_META: Record<PriorityCell, CellMeta> = {
  "founder-fire": { cell: "founder-fire", order: 1, emoji: "🔥", label: "Founder Fire", mode: "do" },
  "deep-work": { cell: "deep-work", order: 2, emoji: "📈", label: "High-Leverage Deep Work", mode: "do" },
  "quick-leverage": { cell: "quick-leverage", order: 3, emoji: "📤", label: "Quick Leverage Win", mode: "do" },
  "delegate-important": { cell: "delegate-important", order: 4, emoji: "🚨", label: "Delegate / Schedule ASAP", mode: "delegate" },
  "schedule-important": { cell: "schedule-important", order: 5, emoji: "🔁", label: "Delegate / Schedule", mode: "schedule" },
  "delegate-urgent": { cell: "delegate-urgent", order: 6, emoji: "🚨", label: "Delegate ASAP", mode: "delegate" },
  "leverage-bet": { cell: "leverage-bet", order: 7, emoji: "🧪", label: "Leverage Bet / Optional", mode: "do" },
  eliminate: { cell: "eliminate", order: 8, emoji: "🗑", label: "Eliminate / Ignore", mode: "drop" },
};

/** The 8 cells in the user's rank order (1 → 8). */
export const CELLS_IN_ORDER: PriorityCell[] = (
  Object.values(CELL_META) as CellMeta[]
)
  .slice()
  .sort((a, b) => a.order - b.order)
  .map((m) => m.cell);

/** The three resolved booleans for a task (urgent derived). */
export interface PriorityInputs {
  important: boolean;
  urgent: boolean;
  leveraged: boolean;
}

/** Resolve a task's three matrix inputs (urgent derived from dueAt). */
export function priorityInputs(
  item: Pick<GtdItem, "dueAt" | "important" | "leveraged">,
  windowHours = DEFAULT_URGENT_WINDOW_HOURS,
  now: number = Date.now(),
): PriorityInputs {
  return {
    important: Boolean(item.important),
    leveraged: Boolean(item.leveraged),
    urgent: isUrgent(item, windowHours, now),
  };
}

/** The user's Notion formula, verbatim, as a pure function of the 3 booleans. */
export function cellForInputs({ important, urgent, leveraged }: PriorityInputs): PriorityCell {
  if (leveraged) {
    if (important && urgent) return "founder-fire"; // 1
    if (important && !urgent) return "deep-work"; // 2
    if (!important && urgent) return "quick-leverage"; // 3
    return "leverage-bet"; // 7
  }
  if (important && urgent) return "delegate-important"; // 4
  if (important && !urgent) return "schedule-important"; // 5
  if (!important && urgent) return "delegate-urgent"; // 6
  return "eliminate"; // 8
}

/** The priority cell for a task (inputs resolved + formula applied). */
export function priorityCell(
  item: Pick<GtdItem, "dueAt" | "important" | "leveraged">,
  windowHours = DEFAULT_URGENT_WINDOW_HOURS,
  now: number = Date.now(),
): PriorityCell {
  return cellForInputs(priorityInputs(item, windowHours, now));
}

/** The action mode for a task (do / delegate / schedule / drop). */
export function actionMode(
  item: Pick<GtdItem, "dueAt" | "important" | "leveraged">,
  windowHours = DEFAULT_URGENT_WINDOW_HOURS,
  now: number = Date.now(),
): ActionMode {
  return CELL_META[priorityCell(item, windowHours, now)].mode;
}

/** The matrix rank (1 = highest). Lower sorts first. */
export function priorityRank(
  item: Pick<GtdItem, "dueAt" | "important" | "leveraged">,
  windowHours = DEFAULT_URGENT_WINDOW_HOURS,
  now: number = Date.now(),
): number {
  return CELL_META[priorityCell(item, windowHours, now)].order;
}

/** A task has NO explicit judgment yet (neither flag set) — the matrix is only
 *  *guessing* (via urgency) about it. Drives the "needs triage" affordance so
 *  the user can tell judged tasks from defaulted ones. */
export function isUntagged(
  item: Pick<GtdItem, "important" | "leveraged">,
): boolean {
  return !item.important && !item.leveraged;
}

// ── Action-mode suggestion (the delegate/schedule hint on Next Actions) ──────

export interface ModeSuggestion {
  mode: ActionMode;
  cell: PriorityCell;
}

/** Should this NEXT task carry a delegate/schedule/drop *suggestion*?
 *
 * Only for tasks that are still mine to act on (NEXT + mine), not already
 * delegated (WAITING) or calendared, and not dismissed (keptMine). Returns null
 * for "do" work and anything that shouldn't be nudged. This is the source of
 * the "⚡ To Delegate" / "📅 To Schedule" buckets inside My Next Actions. */
export function modeSuggestion(
  item: Pick<
    GtdItem,
    "dueAt" | "important" | "leveraged" | "disposition" | "isMine" | "keptMine"
  >,
  windowHours = DEFAULT_URGENT_WINDOW_HOURS,
  now: number = Date.now(),
): ModeSuggestion | null {
  if (item.keptMine) return null; // user said "this one's mine"
  if (item.disposition !== "NEXT" || !item.isMine) return null;
  const cell = priorityCell(item, windowHours, now);
  const mode = CELL_META[cell].mode;
  if (mode === "do") return null; // nothing to suggest — it's yours to do
  return { mode, cell };
}
