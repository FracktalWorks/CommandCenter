/**
 * WS-28d — the capability search's presentation half.
 *
 * The ranking is the server's; what these cases pin is that the ARGUMENT for
 * it renders checkably — each signal as its fact plus its points — and that
 * nothing here re-ranks.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type CapabilityResult,
  describeResultLoad,
  describeSignal,
  rankedRows,
} from "./search";

describe("describeSignal", () => {
  it("renders a skill hit as the fact plus its points", () => {
    expect(
      describeSignal({ kind: "skill", skill: "firmware", level: "expert",
                       last_used_year: 2026, points: 2 })
    ).toBe("firmware · expert · used 2026 (+2)");
  });

  it("marks a CV-sourced skill", () => {
    expect(
      describeSignal({ kind: "skill", skill: "altium", evidence: "resume",
                       points: 1 })
    ).toContain("from CV");
  });

  it("quotes the résumé line — evidence, checkable", () => {
    const line = describeSignal({ kind: "resume",
                                  quote: "Shipped extruder firmware", points: 1 });
    expect(line).toContain("“Shipped extruder firmware”");
    expect(line).toContain("(+1)");
  });

  it("shows the cosine rather than hiding the arithmetic", () => {
    expect(
      describeSignal({ kind: "semantic", cosine: 0.82, points: 2.46 })
    ).toBe("related work, similarity 0.82 (+2.46)");
  });

  it("survives a signal kind it has never seen", () => {
    expect(describeSignal({ kind: "future", points: 1 })).toBe("future (+1)");
  });
});

describe("describeResultLoad", () => {
  const base: CapabilityResult = {
    person_id: "p1", name: "Priya", score: 2, signals: [], warnings: [],
    load: { open_tasks: 3, estimated_hours: 10, unestimated: 1 },
    contracted_hours: 40,
  };

  it("reads committed against contracted, with the caveat", () => {
    expect(describeResultLoad(base)).toBe(
      "3 open · 10h of 40h committed · 1 with no estimate"
    );
  });

  it("is empty without load data rather than inventing zeros", () => {
    expect(describeResultLoad({ ...base, load: null })).toBe("");
  });
});

describe("rankedRows", () => {
  it("returns the server's order untouched", () => {
    const rows = [
      { person_id: "b", name: "B", score: 1, signals: [], warnings: [] },
      { person_id: "a", name: "A", score: 9, signals: [], warnings: [] },
    ];
    expect(
      rankedRows({ q: "x", rows, total: 2, semantic_available: false })
    ).toBe(rows);
  });

  it("and nothing in this module sorts — the server's order IS the ranking", () => {
    // A client-side sort() would be a second ranker, the drift §5.5's eval
    // lock exists to prevent. Asserted on the source so it cannot creep in
    // with a helpful refactor.
    const source = readFileSync(join(__dirname, "search.ts"), "utf-8");
    expect(source).not.toMatch(/\.sort\(/);
  });
});
