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
