import { describe, expect, it } from "vitest";

import { ancestry, type TreeNode } from "./ancestry";

/** The real shape: M&M has programmes, Zealics does not. */
const FOREST: TreeNode[] = [
  {
    id: "root", name: "Product Engineering", kind: "department",
    children: [
      {
        id: "mm", name: "Mahindra & Mahindra", kind: "client",
        children: [
          { id: "z121", name: "Z121", kind: "program" },
          { id: "u171", name: "U171", kind: "program" },
        ],
      },
      { id: "zealics", name: "Zealics", kind: "client" },
    ],
  },
];

describe("ancestry", () => {
  it("resolves a programme to both its programme and its client", () => {
    expect(ancestry(FOREST).z121).toEqual({ client: "Mahindra & Mahindra", program: "Z121" });
  });

  it("resolves a client with NO programme — the Zealics case", () => {
    // Depth would be the obvious rule and it is wrong: Zealics' projects hang
    // one level higher than M&M's, so a depth rule would call Zealics a
    // programme. Resolution is by KIND.
    expect(ancestry(FOREST).zealics).toEqual({ client: "Zealics", program: null });
  });

  it("gives the department neither", () => {
    expect(ancestry(FOREST).root).toEqual({ client: null, program: null });
  });

  it("covers every node in the forest", () => {
    expect(Object.keys(ancestry(FOREST)).sort()).toEqual(
      ["mm", "root", "u171", "z121", "zealics"],
    );
  });

  it("does not leak one client's programme onto a sibling", () => {
    const map = ancestry(FOREST);
    expect(map.zealics.program).toBeNull();
    expect(map.u171.program).toBe("U171");
  });

  it("survives an untyped tree rather than guessing", () => {
    // Every pre-171 row has kind = NULL. Better to show nothing than to invent
    // a client from position.
    const untyped: TreeNode[] = [{ id: "a", name: "A", children: [{ id: "b", name: "B" }] }];
    expect(ancestry(untyped)).toEqual({
      a: { client: null, program: null }, b: { client: null, program: null },
    });
  });

  it("is empty for an empty forest", () => {
    expect(ancestry([])).toEqual({});
  });
});
