/**
 * Projects · the table's cell cursor (WS-27x).
 *
 * The 2-D sibling of `lib/cursor.ts`: arrows move a visible cell ring, Enter
 * starts editing the cell, Esc cancels back to cursor mode. One pure
 * transition — (rowCount, colCount, state, key) → next state — so the awkward
 * cases are assertions: entry from nowhere, all four boundaries, a keystroke
 * while an editor owns the keyboard, a cursor left standing on rows a reload
 * just shortened.
 *
 * Where the two cursors overlap they behave identically, on purpose:
 * entry from nowhere goes to the top on ArrowDown and the bottom on ArrowUp,
 * boundaries clamp rather than wrap, unowned keys return `null` so the caller
 * only ever `preventDefault`s a keystroke that was consumed, and clamping
 * happens at READ time (`clampCell`) rather than by a state-syncing effect.
 * It is deliberately NOT a fork of `stepCursor`: the row cursor carries
 * selection sweeps the cell cursor does not have, and the cell cursor carries
 * an editing mode the row cursor does not — grafting either onto the other
 * would make both grammars mushy.
 */

export interface TableCursor {
  /** Index into the visible rows. `-1` = no active cell. */
  row: number;
  /** Index into the visible columns. Meaningless while `row` is `-1`. */
  col: number;
  /** An editor owns the cell. Arrows belong to it; only Esc comes back. */
  editing: boolean;
}

export const NO_CELL: TableCursor = { row: -1, col: 0, editing: false };

/**
 * Where the cursor stands after the grid changed under it: row clamped into
 * the new bounds (or gone when nothing is left), column clamped likewise —
 * a hidden column must not leave the ring floating past the table's edge.
 * A cursor whose row vanished cannot still be editing anything.
 */
export function clampCell(
  rowCount: number,
  colCount: number,
  cell: TableCursor
): TableCursor {
  const row = rowCount === 0 || cell.row < 0 ? -1 : Math.min(cell.row, rowCount - 1);
  const col = Math.max(0, Math.min(cell.col, Math.max(colCount - 1, 0)));
  const editing = row >= 0 && cell.editing;
  if (row === cell.row && col === cell.col && editing === cell.editing) return cell;
  return { row, col, editing };
}

/**
 * One keystroke. Returns `null` for keys the cursor does not own — including
 * EVERY key except Escape while editing, because those belong to the editor.
 */
export function stepCell(
  rowCount: number,
  colCount: number,
  state: TableCursor,
  key: string
): TableCursor | null {
  if (rowCount === 0 || colCount === 0) return null;
  const at = clampCell(rowCount, colCount, state);

  if (at.editing) {
    // Esc cancels back to cursor mode on the same cell; the editor's draft is
    // the component's to throw away.
    if (key === "Escape") return { ...at, editing: false };
    return null;
  }

  if (key === "Enter") {
    if (at.row < 0) return null;
    return { ...at, editing: true };
  }

  switch (key) {
    case "ArrowDown":
      // From nowhere, down enters at the top and up at the bottom — the row
      // nearest where the keystroke's attention already was (same rule as
      // `stepCursor`).
      return { ...at, row: at.row < 0 ? 0 : Math.min(at.row + 1, rowCount - 1) };
    case "ArrowUp":
      return {
        ...at,
        row: at.row < 0 ? rowCount - 1 : Math.max(at.row - 1, 0),
      };
    case "ArrowLeft":
      if (at.row < 0) return null;
      return { ...at, col: Math.max(at.col - 1, 0) };
    case "ArrowRight":
      if (at.row < 0) return null;
      return { ...at, col: Math.min(at.col + 1, colCount - 1) };
    default:
      return null;
  }
}
