/**
 * Projects · the keyboard cursor (WS-27y).
 *
 * The transitions that decide whether arrow keys feel solid: entry from
 * nowhere, both boundaries, a shift-sweep in each direction, a sweep started
 * with the very first shifted keystroke, and a cursor left standing on rows
 * that a reload just shortened.
 */

import { describe, expect, it } from "vitest";

import { NO_CURSOR, clampCursor, stepCursor } from "./cursor";

const rows = ["a", "b", "c", "d"];
const at = (cursor: number, selection: string[] = [], anchor: number | null = null) => ({
  cursor,
  anchor,
  selection: new Set(selection),
});

describe("plain arrows", () => {
  it("walks down and up", () => {
    expect(stepCursor(rows, at(1), "ArrowDown", false)?.cursor).toBe(2);
    expect(stepCursor(rows, at(1), "ArrowUp", false)?.cursor).toBe(0);
  });

  it("enters at the top going down and at the bottom going up", () => {
    expect(stepCursor(rows, at(-1), "ArrowDown", false)?.cursor).toBe(0);
    expect(stepCursor(rows, at(-1), "ArrowUp", false)?.cursor).toBe(3);
  });

  it("stops at both boundaries instead of wrapping", () => {
    expect(stepCursor(rows, at(3), "ArrowDown", false)?.cursor).toBe(3);
    expect(stepCursor(rows, at(0), "ArrowUp", false)?.cursor).toBe(0);
  });

  it("leaves the selection untouched — and returns the SAME set", () => {
    const state = at(0, ["a"]);
    const next = stepCursor(rows, state, "ArrowDown", false);
    // Identity, not just equality: callers use it to skip a state write.
    expect(next?.selection).toBe(state.selection);
  });

  it("ends any running sweep", () => {
    expect(stepCursor(rows, at(2, [], 0), "ArrowDown", false)?.anchor).toBeNull();
  });
});

describe("shift-arrows extend the selection", () => {
  it("adds the swept range from the cursor", () => {
    const next = stepCursor(rows, at(1), "ArrowDown", true);
    expect(next?.cursor).toBe(2);
    expect(next?.anchor).toBe(1);
    expect([...(next?.selection ?? [])].sort()).toEqual(["b", "c"]);
  });

  it("sweeps upward too", () => {
    const next = stepCursor(rows, at(2), "ArrowUp", true);
    expect([...(next?.selection ?? [])].sort()).toEqual(["b", "c"]);
  });

  it("keeps the anchor across a continued sweep", () => {
    const first = stepCursor(rows, at(1), "ArrowDown", true)!;
    const second = stepCursor(rows, first, "ArrowDown", true)!;
    expect(second.anchor).toBe(1);
    expect([...second.selection].sort()).toEqual(["b", "c", "d"]);
  });

  it("adds to an existing selection rather than replacing it", () => {
    // The additive grammar shift-click already has (WS-27n): shift extends,
    // a plain click un-selects. The keyboard must not invent a second one.
    const next = stepCursor(rows, at(2, ["a"]), "ArrowDown", true);
    expect([...(next?.selection ?? [])].sort()).toEqual(["a", "c", "d"]);
  });

  it("selects the entry row when the sweep starts from nowhere", () => {
    const next = stepCursor(rows, at(-1), "ArrowDown", true);
    expect(next?.cursor).toBe(0);
    expect([...(next?.selection ?? [])]).toEqual(["a"]);
  });
});

describe("Enter", () => {
  it("opens the cursor row", () => {
    expect(stepCursor(rows, at(2), "Enter", false)?.open).toBe("c");
  });

  it("opens nothing when no row is active", () => {
    expect(stepCursor(rows, at(-1), "Enter", false)).toBeNull();
  });
});

describe("keys the cursor does not own", () => {
  it("returns null so the caller never preventDefaults them", () => {
    expect(stepCursor(rows, at(0), "ArrowLeft", false)).toBeNull();
    expect(stepCursor(rows, at(0), "a", false)).toBeNull();
  });

  it("handles nothing on an empty surface", () => {
    expect(stepCursor([], at(0), "ArrowDown", false)).toBeNull();
  });
});

describe("clampCursor — the rows changed underneath", () => {
  it("clamps a cursor past the end onto the last row", () => {
    expect(clampCursor(2, 5)).toBe(1);
  });

  it("keeps a still-valid cursor where it was", () => {
    expect(clampCursor(4, 2)).toBe(2);
  });

  it("clears the cursor when nothing is left, and keeps none none", () => {
    expect(clampCursor(0, 2)).toBe(-1);
    expect(clampCursor(4, NO_CURSOR.cursor)).toBe(-1);
  });

  it("steps sensibly right after a clamp", () => {
    // The reload race: cursor on row 5 of 6, filter drops it to 3 rows,
    // then the user presses ArrowDown. Clamp then step must stay in bounds.
    const clamped = clampCursor(3, 5);
    expect(stepCursor(["a", "b", "c"], at(clamped), "ArrowDown", false)?.cursor).toBe(2);
  });
});
