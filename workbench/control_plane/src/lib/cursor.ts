/**
 * The keyboard cursor — shared by /projects and /tasks (WS-27y, backported).
 *
 * ArrowUp/ArrowDown walk an active row through a list or board in render
 * order; Shift+Arrow extends an EXISTING selection from the cursor; Enter
 * opens the row. All of it is one pure transition —
 * (rows, state, key) → next state — so the awkward cases are assertions
 * rather than manual testing: a cursor on a row a filter just removed, a
 * shift-sweep started from nowhere, an arrow at the boundary.
 *
 * Born in `app/projects/lib/cursor.ts` and promoted here so both apps walk
 * their rows with the same grammar (the same reason `lib/taskCard.ts` holds
 * the chip vocabulary): a member uses both surfaces in the same hour, and the
 * arrow keys must not feel like two different products.
 *
 * Selection semantics are deliberately ADDITIVE, like the shift-click they
 * extend: sweeping over rows adds them, and un-selecting is a click, exactly
 * as it already was. A second removal grammar here would make the keyboard
 * and the mouse disagree about what shift means. A surface with no
 * shift-selection model (the /tasks list today) simply never passes
 * `shift=true`, and the sweep branch stays dormant.
 */

export interface CursorState {
  /** Index into the visible rows. `-1` = no active row. */
  cursor: number;
  /** Where the current shift-sweep started, or null outside a sweep. */
  anchor: number | null;
  selection: ReadonlySet<string>;
}

export const NO_CURSOR: Pick<CursorState, "cursor" | "anchor"> = {
  cursor: -1,
  anchor: null,
};

export interface CursorNext extends CursorState {
  /** The row id Enter asked to open, else null. */
  open: string | null;
}

/**
 * The inclusive id range between two rows of `visible`, in render order.
 *
 * Mirrors `app/projects/lib/selection.range` (WS-27n), which stays where it is
 * because that module is the Projects selection model's home and this shared
 * module must not import app code. Same contract: either end missing from the
 * visible set means the anchor scrolled out from under the sweep, and
 * selecting just the target is the honest fallback.
 */
function sweepRange(
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
 * One keystroke. Returns `null` for keys the cursor does not own, so callers
 * can `preventDefault` exactly when the key was consumed and never eat a
 * keystroke that belonged to something else.
 */
export function stepCursor(
  rows: readonly string[],
  state: CursorState,
  key: string,
  shift: boolean
): CursorNext | null {
  if (rows.length === 0) return null;
  const cursor = clampCursor(rows.length, state.cursor);

  if (key === "Enter") {
    if (cursor < 0) return null;
    return { ...state, cursor, open: rows[cursor] };
  }
  if (key !== "ArrowDown" && key !== "ArrowUp") return null;

  // From nowhere, ArrowDown enters at the top and ArrowUp at the bottom —
  // the row nearest where the keystroke's attention already was.
  const next =
    key === "ArrowDown"
      ? cursor < 0
        ? 0
        : Math.min(cursor + 1, rows.length - 1)
      : cursor < 0
        ? rows.length - 1
        : Math.max(cursor - 1, 0);

  if (!shift) {
    // A plain arrow ends any sweep; the selection itself is untouched, and is
    // returned as the SAME set so callers can cheaply see nothing changed.
    return { cursor: next, anchor: null, selection: state.selection, open: null };
  }

  // Shift: the sweep runs from where it started (or from the row the cursor
  // was on; or, entering from nowhere, from the entry row itself) to the new
  // cursor, and everything in between joins the selection.
  const anchor = state.anchor ?? (cursor >= 0 ? cursor : next);
  const selection = new Set(state.selection);
  for (const id of sweepRange(rows, rows[anchor], rows[next])) selection.add(id);
  return { cursor: next, anchor, selection, open: null };
}

/**
 * Where the cursor lands after the rows changed under it: clamped into the
 * new bounds, or gone when there is nothing left to stand on.
 */
export function clampCursor(rowCount: number, cursor: number): number {
  if (rowCount === 0 || cursor < 0) return -1;
  return Math.min(cursor, rowCount - 1);
}
