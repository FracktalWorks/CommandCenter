/** WS-28c — the org chart's guards: a loop is a labelled root, never a hang. */

import { describe, expect, it } from "vitest";

import {
  type ChartNode,
  buildTree,
  departmentMismatch,
  focusIds,
  slugify,
  wouldCycle,
} from "./chart";

const node = (
  id: string,
  manager_id: string | null = null,
  over: Partial<ChartNode> = {}
): ChartNode => ({
  id,
  name: `Person ${id.toUpperCase()}`,
  manager_id,
  groups: [],
  ...over,
});

describe("buildTree", () => {
  it("builds the forest, unmanaged people as roots (§5.4)", () => {
    const t = buildTree([node("a"), node("b", "a"), node("c", "a"), node("x")]);
    expect(t.roots.map((r) => r.node.id)).toEqual(["a", "x"]);
    expect(t.roots[0].children.map((c) => c.node.id)).toEqual(["b", "c"]);
    expect(t.cycleIds).toEqual([]);
  });

  it("a manager off the list means root, not a crash", () => {
    const t = buildTree([node("b", "gone-alumni")]);
    expect(t.roots.map((r) => r.node.id)).toEqual(["b"]);
  });

  it("a two-node loop terminates, severs one deterministic root and flags it", () => {
    const t = buildTree([node("b", "c"), node("c", "b"), node("d", "b")]);
    expect(t.cycleIds.sort()).toEqual(["b", "c"]);
    const severed = t.roots.find((r) => r.cycle);
    expect(severed?.node.id).toBe("b"); // smallest id — same data, same tree
    // The rest of the loop, and the feeder, render beneath it.
    expect(severed?.children.map((c) => c.node.id).sort()).toEqual(["c", "d"]);
  });

  it("a self-loop is a flagged root, not smoothed into a plain one", () => {
    const t = buildTree([node("a", "a")]);
    expect(t.cycleIds).toEqual(["a"]);
    expect(t.roots[0].cycle).toBe(true);
  });
});

describe("wouldCycle — refused before the request", () => {
  const nodes = [node("a"), node("b", "a"), node("c", "b")];

  it("moving your manager under you is a cycle", () => {
    expect(wouldCycle(nodes, "a", "c")).toBe(true);
    expect(wouldCycle(nodes, "b", "c")).toBe(true);
  });

  it("yourself under yourself is a cycle", () => {
    expect(wouldCycle(nodes, "a", "a")).toBe(true);
  });

  it("a legal move is not", () => {
    expect(wouldCycle(nodes, "c", "a")).toBe(false);
  });

  it("terminates even when the existing data already loops", () => {
    const looped = [node("b", "c"), node("c", "b")];
    expect(wouldCycle(looped, "x", "b")).toBe(false);
  });
});

describe("the Center overlay names the mismatch (§5.4)", () => {
  const slugs = new Set(["sales", "r-d"]);

  it("department names a group the person is not in → said, not smoothed", () => {
    const out = departmentMismatch(
      node("a", null, { department: "Sales" }),
      slugs
    );
    expect(out).toContain("not in the sales group");
  });

  it("membership agreeing with the department is silent", () => {
    expect(
      departmentMismatch(
        node("a", null, { department: "Sales", groups: ["sales"] }),
        slugs
      )
    ).toBeNull();
  });

  it("free text naming no group is just text", () => {
    expect(
      departmentMismatch(node("a", null, { department: "Skunkworks" }), slugs)
    ).toBeNull();
  });

  it("slugify matches the group-slug shape", () => {
    expect(slugify("R&D")).toBe("r-d");
  });
});

describe("focusIds — search keeps the path visible", () => {
  it("matches plus every ancestor", () => {
    const nodes = [
      node("a"),
      node("b", "a"),
      node("c", "b", { name: "Firmware Priya" }),
    ];
    expect([...focusIds(nodes, "firmware")].sort()).toEqual(["a", "b", "c"]);
  });

  it("empty query focuses nothing", () => {
    expect(focusIds([node("a")], "  ").size).toBe(0);
  });
});
