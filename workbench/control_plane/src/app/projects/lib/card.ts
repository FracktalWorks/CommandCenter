/**
 * Projects · a task row, in the shared card's terms (WS-27s).
 *
 * The seam between `TaskRow` — snake_case, straight off the list endpoint — and
 * `@/lib/taskCard`'s `TaskFacts`, which is deliberately neither app's row type.
 * Keeping the translation here rather than inline in the board means the two
 * surfaces that draw a card (board and list) cannot start disagreeing about
 * which facts a task has, which is exactly how they drifted before.
 *
 * **Only fields the LIST endpoint actually returns.** `attachmentCount` and
 * `estimateMins` are honestly absent: attachments are counted on the single
 * task read (WS-27i) and there is no estimate column at all. Filling either
 * with a plausible zero would make the card assert something it does not know.
 */

import { type MetaChip, type TaskFacts, taskMeta } from "@/lib/taskCard";

import type { TaskRow } from "./api";

export function taskFacts(task: TaskRow): TaskFacts {
  return {
    dueAt: task.due_at,
    completedAt: task.completed_at,
    subtasks: task.subtasks ?? null,
    blockedByCount: task.blocked_by_count ?? 0,
    tagCount: task.tags?.length ?? 0,
  };
}

/** The chips one row has earned. */
export function cardChips(task: TaskRow, nowMs?: number): MetaChip[] {
  return taskMeta(taskFacts(task), nowMs);
}

/**
 * WS-27x — which shown-field key each chip kind renders under.
 *
 * The VISIBILITY layer over `taskMeta`'s fact layer: `taskCard.ts` stays the
 * one place that decides which chips a task has *earned*, and this mapping is
 * the one place that decides which of them the view's `shown_fields` lets
 * through. Keys are `lib/shownFields.ts`'s vocabulary — the same source the
 * table's columns read, so hiding a field silences its chip on every surface
 * at once.
 *
 * Exported so a test can assert every chip `taskMeta` can emit is mapped —
 * an unmapped chip kind would silently bypass the gate.
 */
export const CHIP_FIELD: Record<string, string> = {
  blocked: "blocked",
  due: "due_at",
  subtasks: "subtasks",
  tags: "tags",
  attachments: "attachments",
  estimate: "estimate",
};

/**
 * The chips one row has earned AND the view chose to show.
 *
 * A chip whose field is not shown produces nothing — not a dimmed chip, not a
 * placeholder — because "this view does not surface due dates" and "this task
 * has no due date" must read identically, exactly as `taskMeta`'s
 * a-zero-earns-no-chip rule already treats absence.
 */
export function visibleChips(
  task: TaskRow,
  shownFields: readonly string[],
  nowMs?: number
): MetaChip[] {
  return cardChips(task, nowMs).filter((chip) =>
    shownFields.includes(CHIP_FIELD[chip.key] ?? chip.key)
  );
}

/**
 * WS-27w item 6 — the human task id, formatted in ONE place.
 *
 * `#42` everywhere a number exists; `null` (not `"#undefined"`, not `"—"`)
 * when it does not, so each surface keeps its own honest fallback. The board,
 * the list and the panel all read this — three inline `#${…}` templates is
 * how one of them ends up rendering `#null` after an import.
 */
export function taskRef(task: Pick<TaskRow, "task_number">): string | null {
  return task.task_number == null ? null : `#${task.task_number}`;
}

/**
 * The URL the copy-link affordance puts on the clipboard.
 *
 * `/projects?task=<id>` is the deep-link shape the board already reads
 * (WS-28b) and the notification bell already emits — a third spelling would
 * be a link that opens nothing. `origin` is passed in rather than read from
 * `window` here, so the formatting stays pure and testable.
 */
export function taskDeepLink(task: Pick<TaskRow, "id">, origin = ""): string {
  return `${origin}/projects?task=${encodeURIComponent(task.id)}`;
}
