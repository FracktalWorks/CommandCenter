/**
 * The shared selection grammar (WS-27ad).
 *
 * The cases a selection UI always gets wrong: a shift-click with no anchor, an
 * anchor a filter has since removed, a sweep that must widen rather than
 * restart, and a selection that outlived its rows.
 */

import { describe, expect, it } from "vitest";

import {
  NO_SELECTION,
  allSelected,
  clickSelect,
  prune,
  range,
  toggle,
} from "./selection";

const visible = ["a", "b", "c", "d"];

describe("toggle", () => {
  it("adds what is missing and removes what is there", () => {
    expect([...toggle(new Set(), "a")]).toEqual(["a"]);
    expect([...toggle(new Set(["a"]), "a")]).toEqual([]);
  });
});

describe("range", () => {
  it("returns the inclusive span in render order, either direction", () => {
    expect(range(visible, "b", "d")).toEqual(["b", "c", "d"]);
    expect(range(visible, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("returns just the target when an end is off-screen", () => {
    // The anchor scrolled out from under the sweep — selecting only what was
    // actually clicked is the honest answer.
    expect(range(visible, "zz", "c")).toEqual(["c"]);
    expect(range(visible, "b", "zz")).toEqual(["zz"]);
  });
});

describe("clickSelect — the one grammar both apps speak", () => {
  it("a plain click toggles and becomes the anchor", () => {
    const first = clickSelect(NO_SELECTION, visible, "b", false);
    expect([...first.selected]).toEqual(["b"]);
    expect(first.anchor).toBe("b");

    const second = clickSelect(first, visible, "b", false);
    expect([...second.selected]).toEqual([]);
    expect(second.anchor).toBe("b");
  });

  it("a shift-click adds the range and leaves the anchor put", () => {
    const first = clickSelect(NO_SELECTION, visible, "b", false);
    const swept = clickSelect(first, visible, "d", true);
    expect([...swept.selected].sort()).toEqual(["b", "c", "d"]);
    expect(swept.anchor).toBe("b");
  });

  it("widens from the SAME anchor on a second shift-click", () => {
    // Moving the anchor to the previous target is the classic bug: the second
    // click would then measure from "d" and lose "b"/"c".
    const first = clickSelect(NO_SELECTION, visible, "d", false);
    const back = clickSelect(first, visible, "b", true);
    const wider = clickSelect(back, visible, "a", true);
    expect([...wider.selected].sort()).toEqual(["a", "b", "c", "d"]);
    expect(wider.anchor).toBe("d");
  });

  it("never removes on shift — un-selecting stays a plain click", () => {
    const seeded = { selected: new Set(["a", "b", "c"]), anchor: "a" };
    const swept = clickSelect(seeded, visible, "c", true);
    expect([...swept.selected].sort()).toEqual(["a", "b", "c"]);
  });

  it("falls back to a toggle when shift has no anchor to measure from", () => {
    const next = clickSelect(NO_SELECTION, visible, "c", true);
    expect([...next.selected]).toEqual(["c"]);
    expect(next.anchor).toBe("c");
  });

  it("selects only the target when the anchor has been filtered away", () => {
    const stale = { selected: new Set<string>(), anchor: "gone" };
    const next = clickSelect(stale, visible, "c", true);
    expect([...next.selected]).toEqual(["c"]);
    // The anchor survives the click that could not use it, so the next
    // shift-click is not silently a toggle too.
    expect(next.anchor).toBe("gone");
  });
});

describe("prune", () => {
  it("drops ids that left the page", () => {
    expect([...prune(new Set(["a", "zz"]), visible)]).toEqual(["a"]);
  });
});

describe("allSelected", () => {
  it("is true only when every visible row is picked", () => {
    expect(allSelected(new Set(visible), visible)).toBe(true);
    expect(allSelected(new Set(["a"]), visible)).toBe(false);
  });

  it("is false on an empty page — nothing is not everything", () => {
    expect(allSelected(new Set(), [])).toBe(false);
  });
});
