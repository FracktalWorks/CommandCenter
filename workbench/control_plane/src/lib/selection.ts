/**
 * The selection grammar — shared by /projects and /tasks (WS-27ad).
 *
 * Round 1 of the continuity backport promoted the chips, the keyboard cursor,
 * the group-context quick-add and the post-drop flash. It left the biggest
 * divergence alone and wrote it down: Projects selected with a shift-range
 * anchor, /tasks with a bare toggle set. Two apps, two answers to "what does
 * Shift do", used by the same person in the same hour.
 *
 * This module is the one answer. It sits beside `lib/cursor.ts` deliberately —
 * the cursor's shift-sweep and the mouse's shift-click are the SAME gesture
 * expressed twice, and `stepCursor` reads `range` from here rather than
 * carrying the copy it used to (the copy was already drifting from
 * `app/projects/lib/selection.range`, which is exactly how two selection
 * models get born).
 *
 * Everything is a pure transition over `(state, visible, id, shift)`, so the
 * awkward cases are assertions rather than manual clicking: an anchor a filter
 * has since removed, a shift-click with no anchor at all, a selection that
 * outlived the rows it was made on.
 *
 * The grammar, stated once:
 *   • a plain click TOGGLES the row and becomes the new anchor;
 *   • a shift-click ADDS the inclusive range anchor→target, anchor unmoved;
 *   • un-selecting is a plain click. Shift never removes.
 * Additive, because that is what shift-click already did in Projects — and a
 * keyboard that removed while a mouse added would make Shift mean two things.
 */

/** A selection and the row a shift-click measures its range from. */
export interface SelectionState {
  selected: ReadonlySet<string>;
  /** The last row picked WITHOUT shift, or null before the first pick. */
  anchor: string | null;
}

export const NO_SELECTION: SelectionState = {
  selected: new Set<string>(),
  anchor: null,
};

/** Toggle one id. */
export function toggle(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * The ids between the anchor and the target, in the order the surface is
 * currently drawing them.
 *
 * Order comes from the caller's *visible* list rather than from the selection,
 * because "between these two" means between them **on screen** — after a
 * filter and a grouping have decided what is on screen at all.
 *
 * Either end missing means the anchor scrolled out of the filtered set;
 * selecting just the target is the honest fallback, and it is what leaves the
 * next shift-click sensible.
 */
export function range(
  visible: readonly string[],
  anchor: string,
  target: string
): string[] {
  const from = visible.indexOf(anchor);
  const to = visible.indexOf(target);
  if (from === -1 || to === -1) return [target];
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return visible.slice(lo, hi + 1);
}

/**
 * One click. The whole grammar in one transition, so a surface adopting
 * selection cannot accidentally adopt three quarters of it.
 *
 * `shift` without an anchor falls back to a plain toggle rather than doing
 * nothing: the first click of a session is genuinely ambiguous, and a
 * shift-click that silently does nothing reads as a broken checkbox.
 */
export function clickSelect(
  state: SelectionState,
  visible: readonly string[],
  id: string,
  shift: boolean
): SelectionState {
  if (shift && state.anchor) {
    const next = new Set(state.selected);
    for (const each of range(visible, state.anchor, id)) next.add(each);
    // The anchor STAYS: a sweep is usually several shift-clicks widening the
    // same range, and moving it would make the second click measure from the
    // first click's target.
    return { selected: next, anchor: state.anchor };
  }
  return { selected: toggle(state.selected, id), anchor: id };
}

/**
 * Drop ids that are no longer on the page.
 *
 * A selection that outlives its filter is how a bulk edit hits rows nobody can
 * see any more: somebody selects forty, narrows the filter to three, then
 * presses "Archive" believing they are acting on the three in front of them.
 */
export function prune(
  selected: ReadonlySet<string>,
  visible: readonly string[]
): Set<string> {
  const onScreen = new Set(visible);
  return new Set([...selected].filter((id) => onScreen.has(id)));
}

/** Whether every visible row is selected — drives the "select all" checkbox. */
export function allSelected(
  selected: ReadonlySet<string>,
  visible: readonly string[]
): boolean {
  return visible.length > 0 && visible.every((id) => selected.has(id));
}
