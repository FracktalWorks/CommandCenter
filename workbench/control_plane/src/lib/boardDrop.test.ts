/**
 * The drop-gap arithmetic (WS-27ad).
 *
 * One property carries the whole file: dropping a card into the gap the user
 * aimed at must land it THERE, including the downward intra-group drag where
 * removing the card first shifts every later slot down by one.
 */

import { describe, expect, it } from "vitest";

import { dropIndexFor, gapKey } from "./boardDrop";

const rows = ["a", "b", "c", "d"].map((id) => ({ id }));

describe("gapKey", () => {
  it("is a stable string so a highlight compares by value", () => {
    expect(gapKey("todo", 2)).toBe("todo:2");
    expect(gapKey("todo", 2)).toBe(gapKey("todo", 2));
  });
});

describe("dropIndexFor", () => {
  it("shifts a DOWNWARD intra-group drop back by one", () => {
    // "a" is at 0; the gap under "c" is index 3 on screen. Without "a" the
    // neighbour list is [b, c, d] and the slot after "c" is 2.
    expect(dropIndexFor(rows, "a", 3)).toBe(2);
  });

  it("leaves an UPWARD intra-group drop alone", () => {
    // "d" is at 3; the gap above "b" is index 1, and removing "d" changes
    // nothing before it.
    expect(dropIndexFor(rows, "d", 1)).toBe(1);
  });

  it("leaves a cross-group drop alone — nothing was removed", () => {
    expect(dropIndexFor(rows, "elsewhere", 2)).toBe(2);
  });

  it("keeps a drop at the very top at the top", () => {
    expect(dropIndexFor(rows, "c", 0)).toBe(0);
  });

  it("appends when the gap is the trailing one", () => {
    // The trailing gap of a 4-row group is index 4; without the moved card the
    // neighbour list is 3 long, so 3 IS the append slot.
    expect(dropIndexFor(rows, "a", 4)).toBe(3);
    expect(dropIndexFor(rows, "elsewhere", 4)).toBe(4);
  });

  it("clamps rather than reading off the end", () => {
    // An unclamped index reads `undefined` as its right-hand neighbour, which
    // both apps' rank maths quietly treat as "append" — exactly the
    // append-on-drop behaviour this replaces.
    expect(dropIndexFor(rows, "a", 99)).toBe(3);
    expect(dropIndexFor(rows, "a", -5)).toBe(0);
  });

  it("handles an empty destination group", () => {
    expect(dropIndexFor([], "a", 0)).toBe(0);
  });
});
