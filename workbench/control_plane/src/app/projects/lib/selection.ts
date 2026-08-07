/**
 * Projects · multi-select and the bulk request (WS-27n).
 *
 * §11.3 names this ticket as the one that gates the ClickUp cutover: an import
 * that cannot be re-triaged in bulk is one somebody abandons halfway, leaving
 * two live systems.
 *
 * Selection is a set of ids held by the board, and everything here is a pure
 * function over it. The awkward cases are the ones a selection UI always gets
 * wrong — shift-clicking a range, a selected card that a filter has since
 * removed from the page, and a bulk request that would say "change nothing".
 */

import type { TaskRow } from "./api";
import { type Filters } from "./grouping";

export interface BulkRequest {
  task_ids: string[];
  patch?: Record<string, unknown>;
  assignees_add?: string[];
  assignees_remove?: string[];
  tags_add?: string[];
  tags_remove?: string[];
}

/** Mirrors the gateway's `MAX_BULK`. */
export const MAX_BULK = 500;

/** Toggle one id. */
export function toggle(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * The ids a shift-click selects: everything between the anchor and the target,
 * in the order the board is currently drawing them.
 *
 * Order comes from the caller's *visible* list rather than from the selection,
 * because "between these two" means between them **on screen** — after a
 * filter and a grouping have decided what is on screen at all.
 */
export function range(
  visible: readonly string[],
  anchor: string,
  target: string
): string[] {
  const from = visible.indexOf(anchor);
  const to = visible.indexOf(target);
  // Either end missing means the anchor scrolled out of the filtered set;
  // selecting just the target is the honest fallback, and it is what leaves
  // the next shift-click sensible.
  if (from === -1 || to === -1) return [target];
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return visible.slice(lo, hi + 1);
}

/**
 * Drop ids that are no longer on the page.
 *
 * A selection that outlives its filter is how a bulk edit hits tasks nobody
 * can see any more: somebody selects forty, narrows the filter to three, then
 * presses "Done" believing they are acting on the three in front of them.
 */
export function prune(
  selected: ReadonlySet<string>,
  visible: readonly string[]
): Set<string> {
  const onScreen = new Set(visible);
  return new Set([...selected].filter((id) => onScreen.has(id)));
}

/** Whether every visible task is selected — drives the "select all" checkbox. */
export function allSelected(
  selected: ReadonlySet<string>,
  visible: readonly string[]
): boolean {
  return visible.length > 0 && visible.every((id) => selected.has(id));
}

/** Every visible id, in the board's own order. */
export function visibleIds(groups: { tasks: TaskRow[] }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const task of group.tasks) {
      // A task with two assignees is drawn in two columns (WS-27k), so the
      // same id genuinely appears twice. Selecting it twice would make the
      // count say two for one task.
      if (!seen.has(task.id)) {
        seen.add(task.id);
        out.push(task.id);
      }
    }
  }
  return out;
}

export interface BulkDraft {
  status: string;
  importance: string;
  assigneeAdd: string;
  assigneeRemove: string;
  tagAdd: string;
  tagRemove: string;
}

export const EMPTY_DRAFT: BulkDraft = {
  status: "",
  importance: "",
  assigneeAdd: "",
  assigneeRemove: "",
  tagAdd: "",
  tagRemove: "",
};

const list = (raw: string): string[] =>
  raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * The draft → the request body, or `null` when it asks for nothing.
 *
 * `null` rather than an empty request: the gateway answers 422 for a no-op, and
 * a button that fires a request only to be told "nothing to change" should have
 * been disabled instead.
 *
 * **Status goes by NAME.** A selection can span projects and a status id
 * belongs to exactly one root, so the id would put most of the selection in a
 * lane that is not theirs — the gateway refuses `status_id` for that reason.
 */
export function buildRequest(
  ids: readonly string[],
  draft: BulkDraft
): BulkRequest | null {
  if (ids.length === 0) return null;

  const patch: Record<string, unknown> = {};
  if (draft.status) patch.status = draft.status;
  // `""` is "leave it alone"; `"0"` is Low. The explicit emptiness check is
  // what separates them — and it is `Number("")` that makes it matter, since
  // dropping the guard entirely would turn an untouched box into a silent
  // "set every selected task to Low".
  //
  // (A truthiness check would behave the same here, because the draft holds a
  // STRING and `"0"` is truthy in JS. Said plainly because the falsy-zero trap
  // is real one line later, where the value has become a number.)
  if (draft.importance !== "") patch.importance = Number(draft.importance);

  const request: BulkRequest = { task_ids: [...ids] };
  if (Object.keys(patch).length) request.patch = patch;

  const addPeople = list(draft.assigneeAdd);
  const dropPeople = list(draft.assigneeRemove);
  const addTags = list(draft.tagAdd);
  const dropTags = list(draft.tagRemove);
  if (addPeople.length) request.assignees_add = addPeople;
  if (dropPeople.length) request.assignees_remove = dropPeople;
  if (addTags.length) request.tags_add = addTags;
  if (dropTags.length) request.tags_remove = dropTags;

  const asks =
    Boolean(request.patch) ||
    addPeople.length + dropPeople.length + addTags.length + dropTags.length > 0;
  return asks ? request : null;
}

export interface BulkOutcome {
  requested: number;
  applied: number;
  skipped: { task_id: string; reason: string }[];
  failed: { task_id: string; reason: string }[];
}

/**
 * What to tell somebody after a bulk edit.
 *
 * Every category is named, including the boring ones. A sweep that reports only
 * its successes is how "it said 47 changed" and "but I selected 50" become a
 * support conversation instead of a sentence somebody already read.
 */
export function describeOutcome(outcome: BulkOutcome): string {
  const parts = [`${outcome.applied} of ${outcome.requested} updated`];

  const unchanged = outcome.skipped.filter((s) => s.reason === "unchanged").length;
  if (unchanged) parts.push(`${unchanged} already like that`);

  const missing = outcome.skipped.filter((s) => s.reason === "not_found").length;
  // Deliberately vague about WHY: the API answers 404 for "not yours" as well
  // as "no such thing" (R5), and the UI must not invent a distinction the
  // server refuses to make.
  if (missing) parts.push(`${missing} not available`);

  if (outcome.failed.length) parts.push(`${outcome.failed.length} failed`);
  return `${parts.join(", ")}.`;
}

/** Filters that would make the current selection meaningless if re-applied. */
export const selectionSurvives = (before: Filters, after: Filters): boolean =>
  JSON.stringify(before) === JSON.stringify(after);
