/**
 * Projects · the tree and the Center slice.
 *
 * Spec: `project-docs/specs/project_management_app.md` §5 · ticket WS-27d
 * done-when 4 — including the one claim that must not be misread as a security
 * boundary.
 */
import { describe, expect, it } from "vitest";

import {
  type ProjectNode,
  canMoveUnder,
  filterByCenter,
  flatten,
  pathTo,
  subtreeIds,
} from "./tree";

const FOREST: ProjectNode[] = [
  {
    id: "sales",
    name: "Sales",
    children: [{ id: "q3", name: "Q3 campaign", children: [{ id: "lp", name: "Landing page" }] }],
  },
  { id: "finance", name: "Finance", children: [{ id: "payroll", name: "Payroll" }] },
  { id: "loose", name: "Unmapped space" },
];

const GRANTS = [
  { project_id: "sales", subject: "group:sales" },
  { project_id: "finance", subject: "group:finance" },
];

describe("subtreeIds / flatten / pathTo", () => {
  it("collects a subtree including its own root", () => {
    expect(subtreeIds(FOREST[0])).toEqual(["sales", "q3", "lp"]);
  });

  it("flattens with depth so a sidebar can indent", () => {
    const rows = flatten(FOREST);
    expect(rows.map((r) => [r.node.id, r.depth])).toEqual([
      ["sales", 0], ["q3", 1], ["lp", 2],
      ["finance", 0], ["payroll", 1],
      ["loose", 0],
    ]);
  });

  it("builds a breadcrumb to a nested project", () => {
    expect(pathTo(FOREST, "lp").map((n) => n.id)).toEqual(["sales", "q3", "lp"]);
  });

  it("returns nothing for a project that is not in the forest", () => {
    expect(pathTo(FOREST, "nope")).toEqual([]);
  });
});

describe("filterByCenter", () => {
  it("narrows the forest to the roots granted to that group", () => {
    const shown = filterByCenter(FOREST, GRANTS, "sales");
    expect(shown.map((n) => n.id)).toEqual(["sales"]);
  });

  it("matches the slug case-insensitively", () => {
    expect(filterByCenter(FOREST, GRANTS, "SALES").map((n) => n.id)).toEqual(["sales"]);
  });

  it("shows the whole forest when no Center is named", () => {
    expect(filterByCenter(FOREST, GRANTS, null)).toHaveLength(FOREST.length);
    expect(filterByCenter(FOREST, GRANTS, "")).toHaveLength(FOREST.length);
  });

  it("treats an unknown Center as 'no filter', never as 'you have nothing'", () => {
    // A typo'd slug must not look like an empty portfolio.
    expect(filterByCenter(FOREST, GRANTS, "sails")).toHaveLength(FOREST.length);
  });

  it("is presentation only — it can never widen what the server returned", () => {
    // ⚠️ The claim that matters: this filters a list the server already
    // scoped. Given a forest of one project, no `?center=` value can produce
    // a second one, so a hand-edited URL reveals nothing.
    const scoped: ProjectNode[] = [{ id: "finance", name: "Finance" }];
    for (const slug of ["sales", "people", "company", "finance", "anything"]) {
      const shown = filterByCenter(scoped, GRANTS, slug);
      expect(shown.every((n) => scoped.some((s) => s.id === n.id))).toBe(true);
      expect(shown.length).toBeLessThanOrEqual(scoped.length);
    }
  });

  it("keeps a root whose GRANT sits on a descendant", () => {
    // A Center granted a subproject must still see the branch that reaches it,
    // or the project would be unreachable from the tree it lives in.
    const shown = filterByCenter(FOREST, [{ project_id: "lp", subject: "group:sales" }], "sales");
    expect(shown.map((n) => n.id)).toEqual(["sales"]);
  });
});

describe("canMoveUnder", () => {
  it("allows a move to the root", () => {
    expect(canMoveUnder(FOREST, "q3", null)).toBe(true);
  });

  it("allows a move under an unrelated project", () => {
    expect(canMoveUnder(FOREST, "q3", "finance")).toBe(true);
  });

  it("refuses a project becoming its own parent", () => {
    expect(canMoveUnder(FOREST, "sales", "sales")).toBe(false);
  });

  it("refuses a move into the project's own subtree", () => {
    // The server refuses this too; checking here stops the UI optimistically
    // rendering a tree that cannot exist and then snapping back on the 422.
    expect(canMoveUnder(FOREST, "sales", "lp")).toBe(false);
  });
});
