/**
 * Where a dragged card lands — shared by /projects and /tasks (WS-27ad).
 *
 * The two boards disagreed about what a drop MEANS. /tasks drew a thin target
 * between every pair of cards and dropped the card exactly there; /projects
 * accepted the drop anywhere on the column and appended to the bottom
 * (`planDrop(cell, id, cell.length)`), even though `planDrop` had taken an
 * index all along. Dragging a card two rows up and watching it fall to the
 * bottom of the column is the gesture failing, not a preference.
 *
 * So the drop-gap wins, and this is the arithmetic behind it. It is here rather
 * than in either app because the off-by-one below is the part that is easy to
 * get wrong and impossible to see in review — /tasks had it right inside
 * `taskStore.reorderItem`, /projects would have grown its own copy, and the two
 * would have drifted the moment one of them was fixed.
 *
 * Each app keeps its own RANK maths: /tasks writes a fractional `sortKey`
 * (`lib/ordering.rankForDrop`), /projects writes per-view float positions
 * (`lib/board.planDrop`). Only "which slot did they mean" is one answer.
 */

/**
 * The drop target's identity, as `"<group>:<index>"`.
 *
 * A string rather than an object because it is held in `useState` and compared
 * on every dragover of every gap; two objects that describe the same slot are
 * not `===`, which is how a highlight ends up flickering or sticking.
 */
export function gapKey(group: string, index: number): string {
  return `${group}:${index}`;
}

/**
 * A gap index, translated into an index in the destination list WITHOUT the
 * card being moved.
 *
 * The gap the user aimed at is measured against the list they can see, which
 * still contains the dragged card. Remove it and every slot after it shifts
 * down by one — so dropping a card into the gap below its own current position
 * lands it one slot past where the line was drawn, every time, and only when
 * dragging downward within a group. That asymmetry is why the bug survives
 * casual testing.
 *
 * `movingId` not being in `ordered` is the normal cross-group case: nothing
 * shifts, and the gap index is already right.
 */
export function dropIndexFor(
  ordered: readonly { id: string }[],
  movingId: string,
  gapIndex: number
): number {
  const from = ordered.findIndex((row) => row.id === movingId);
  const index = from !== -1 && from < gapIndex ? gapIndex - 1 : gapIndex;
  // Clamped against the neighbour set, which is what both apps' rank maths
  // interpolate over. An unclamped index reads `undefined` off the end and
  // silently becomes "append" — the very behaviour this replaces.
  const others = from === -1 ? ordered.length : ordered.length - 1;
  return Math.max(0, Math.min(index, others));
}
