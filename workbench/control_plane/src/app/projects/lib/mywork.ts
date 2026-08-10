/**
 * Projects · the personal lens — grouping and ordering for "My work".
 *
 * Spec: `project-docs/specs/project_management_app.md` §3.11-§3.12, §6.1 ·
 * **D-PM-6 (revised)** · ticket WS-27e.
 *
 * Pure functions only. The server already decided *which* rows are mine and
 * what my effective disposition is (`GET /projects/my/inbox` derives it when I
 * have not triaged); this module decides only how they are laid out. Keeping
 * the derivation server-side and the layout here is what stops the browser
 * growing a second, drifting answer to "what is my next action".
 */

import type { TaskRow } from "./api";

/**
 * A task as the personal lens sees it: the shared row plus **my** overlay.
 *
 * There is one task row and one status — `disposition` and the rest are mine
 * alone, which is why two people can hold different ones for the same task.
 */
export interface MyTaskRow extends TaskRow {
  /** Stated by me, or derived by the server when I have not triaged it. */
  disposition: string;
  /** False when the disposition above was derived rather than chosen. */
  is_triaged: boolean;
  next_action?: string | null;
  context?: string | null;
  energy?: string | null;
  is_two_minute?: boolean;
}

/**
 * The lanes My Work shows, in order.
 *
 * Deliberately four of the eight dispositions. `DONE`/`TRASH` are excluded by
 * the endpoint unless asked for, and `PROJECT`/`REFERENCE` are filing states
 * rather than work states — surfacing them as lanes would make the daily view
 * a filing cabinet. They are still reachable, via {@link OTHER_LANE}.
 */
export const DISPOSITION_LANES = ["INBOX", "NEXT", "WAITING", "SOMEDAY"] as const;

export type DispositionLane = (typeof DISPOSITION_LANES)[number];

/** Where a disposition that is not a lane lands, so nothing is ever dropped. */
export const OTHER_LANE = "OTHER";

export const LANE_LABELS: Record<string, string> = {
  INBOX: "Inbox",
  NEXT: "Next actions",
  WAITING: "Waiting on",
  SOMEDAY: "Someday",
  OTHER: "Filed",
};

/**
 * True when a task's due date has passed.
 *
 * `now` is a parameter rather than a `Date.now()` call so the boundary is
 * testable — a function that reads the clock itself can only be tested by
 * mocking time, and "is this overdue" is exactly the kind of off-by-a-day
 * question that deserves a plain assertion.
 */
export function isOverdue(task: Pick<MyTaskRow, "due_at">, now: Date): boolean {
  if (!task.due_at) return false;
  const due = new Date(task.due_at);
  return !Number.isNaN(due.getTime()) && due.getTime() < now.getTime();
}

/**
 * Order within a lane: dated work first, soonest first; undated after it.
 *
 * Undated tasks sort **below** dated ones rather than above. A task nobody gave
 * a date is not more urgent than one due tomorrow, and putting the undated pile
 * on top is how a personal list stops being read.
 */
export function sortMyTasks(rows: readonly MyTaskRow[]): MyTaskRow[] {
  return [...rows].sort((a, b) => {
    const aDue = a.due_at ? new Date(a.due_at).getTime() : null;
    const bDue = b.due_at ? new Date(b.due_at).getTime() : null;
    const aHas = aDue !== null && !Number.isNaN(aDue);
    const bHas = bDue !== null && !Number.isNaN(bDue);
    if (aHas && bHas && aDue !== bDue) return (aDue as number) - (bDue as number);
    if (aHas !== bHas) return aHas ? -1 : 1;
    return String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
  });
}

/**
 * Split my work into its lanes, each already ordered.
 *
 * Every lane is present even when empty — an empty Next list is a real and
 * important state ("you have triaged nothing into today"), and a lane that
 * disappears when empty cannot say that.
 */
export function groupByDisposition(
  rows: readonly MyTaskRow[]
): Array<{ lane: string; label: string; tasks: MyTaskRow[] }> {
  const buckets = new Map<string, MyTaskRow[]>();
  for (const lane of DISPOSITION_LANES) buckets.set(lane, []);
  buckets.set(OTHER_LANE, []);

  for (const row of rows) {
    const key = (DISPOSITION_LANES as readonly string[]).includes(row.disposition)
      ? row.disposition
      : OTHER_LANE;
    buckets.get(key)?.push(row);
  }

  const lanes = [...DISPOSITION_LANES, OTHER_LANE].map((lane) => ({
    lane,
    label: LANE_LABELS[lane] ?? lane,
    tasks: sortMyTasks(buckets.get(lane) ?? []),
  }));
  // "Filed" is the only lane hidden when empty: unlike the four work lanes, an
  // empty one says nothing a member needs to know.
  return lanes.filter((l) => l.lane !== OTHER_LANE || l.tasks.length > 0);
}

/**
 * How many of my tasks I have never actually looked at.
 *
 * The Weekly Review's whole question, and the reason the server derives
 * dispositions instead of storing them on first read: a stored default would
 * make every untriaged task indistinguishable from a triaged one and this
 * count would be permanently zero.
 */
export function untriagedCount(rows: readonly MyTaskRow[]): number {
  return rows.filter((r) => !r.is_triaged).length;
}

/**
 * Tasks I marked as taking under two minutes.
 *
 * GTD's two-minute rule is the one piece of the method that pays off inside a
 * single sitting, so it gets its own surface rather than being a badge someone
 * has to notice.
 */
export function twoMinuteTasks(rows: readonly MyTaskRow[]): MyTaskRow[] {
  return sortMyTasks(rows.filter((r) => r.is_two_minute === true));
}

/**
 * What to show as the actionable line for a task.
 *
 * The next action when I wrote one, the title otherwise. "Email Priya the
 * revised quote" is a next action; "Q3 pricing" is a project title, and a list
 * of project titles is a list nobody can start work from.
 */
export function actionLine(task: MyTaskRow): string {
  const next = (task.next_action ?? "").trim();
  return next || task.title;
}
