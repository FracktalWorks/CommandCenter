/**
 * WS-27x — the table's cell cursor.
 *
 * The transitions that make a 2-D cursor feel solid, plus the ones its 1-D
 * sibling (`cursor.test.ts`) already pinned — entry from nowhere, boundaries
 * that clamp instead of wrap, unowned keys returning null — asserted again
 * here because the two cursors must FEEL like the same grammar.
 */

import { describe, expect, it } from "vitest";

import { NO_CELL, type TableCursor, clampCell, stepCell } from "./tableCursor";

const at = (row: number, col = 0, editing = false): TableCursor => ({
  row,
  col,
  editing,
});

// A 4-row, 3-column grid throughout.
const step = (state: TableCursor, key: string) => stepCell(4, 3, state, key);

describe("plain arrows", () => {
  it("walks all four directions", () => {
    expect(step(at(1, 1), "ArrowDown")).toEqual(at(2, 1));
    expect(step(at(1, 1), "ArrowUp")).toEqual(at(0, 1));
    expect(step(at(1, 1), "ArrowRight")).toEqual(at(1, 2));
    expect(step(at(1, 1), "ArrowLeft")).toEqual(at(1, 0));
  });

  it("enters at the top going down and at the bottom going up — like the row cursor", () => {
    expect(step(NO_CELL, "ArrowDown")).toEqual(at(0, 0));
    expect(step(NO_CELL, "ArrowUp")).toEqual(at(3, 0));
  });

  it("does not enter sideways — a column with no row is not a cell", () => {
    expect(step(NO_CELL, "ArrowLeft")).toBeNull();
    expect(step(NO_CELL, "ArrowRight")).toBeNull();
  });

  it("clamps at all four boundaries instead of wrapping", () => {
    expect(step(at(3, 0), "ArrowDown")).toEqual(at(3, 0));
    expect(step(at(0, 0), "ArrowUp")).toEqual(at(0, 0));
    expect(step(at(0, 2), "ArrowRight")).toEqual(at(0, 2));
    expect(step(at(0, 0), "ArrowLeft")).toEqual(at(0, 0));
  });
});

describe("Enter and Escape — the editing mode", () => {
  it("Enter starts editing the cell under the ring", () => {
    expect(step(at(1, 2), "Enter")).toEqual(at(1, 2, true));
  });

  it("Enter from nowhere edits nothing", () => {
    expect(step(NO_CELL, "Enter")).toBeNull();
  });

  it("Escape cancels back to cursor mode on the same cell", () => {
    expect(step(at(1, 2, true), "Escape")).toEqual(at(1, 2));
  });

  it("Escape outside editing is not the cursor's key", () => {
    // It belongs to whoever owns dismissal above (the panel, the palette).
    expect(step(at(1, 2), "Escape")).toBeNull();
  });

  it("while editing, every other key belongs to the editor", () => {
    for (const key of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter", "a"]) {
      expect(step(at(1, 1, true), key)).toBeNull();
    }
  });
});

describe("keys the cursor does not own", () => {
  it("returns null so the caller never preventDefaults them", () => {
    expect(step(at(1, 1), "a")).toBeNull();
    expect(step(at(1, 1), "Tab")).toBeNull();
  });

  it("handles nothing on an empty grid, in either dimension", () => {
    expect(stepCell(0, 3, at(0), "ArrowDown")).toBeNull();
    expect(stepCell(4, 0, at(0), "ArrowDown")).toBeNull();
  });
});

describe("clampCell — the grid changed underneath", () => {
  it("clamps a row past the end onto the last row", () => {
    expect(clampCell(2, 3, at(5, 1)).row).toBe(1);
  });

  it("clamps a column past the edge — a field was just hidden", () => {
    expect(clampCell(4, 2, at(1, 5)).col).toBe(1);
  });

  it("clears the cursor when no rows are left, and keeps none none", () => {
    expect(clampCell(0, 3, at(2, 1)).row).toBe(-1);
    expect(clampCell(4, 3, NO_CELL)).toEqual(NO_CELL);
  });

  it("cannot stay editing a cell whose row vanished", () => {
    expect(clampCell(0, 3, at(2, 1, true)).editing).toBe(false);
  });

  it("returns the SAME state when nothing moved — callers skip a write", () => {
    const state = at(1, 1);
    expect(clampCell(4, 3, state)).toBe(state);
  });

  it("steps sensibly right after a clamp", () => {
    // The reload race, same as the row cursor: cursor on row 5 of 6, the
    // rows shrink to 3, then ArrowDown. Clamp then step must stay in bounds.
    const clamped = clampCell(3, 3, at(5, 2));
    expect(stepCell(3, 3, clamped, "ArrowDown")?.row).toBe(2);
  });
});
