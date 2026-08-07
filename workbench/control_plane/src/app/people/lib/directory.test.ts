import { describe, expect, it } from "vitest";

import type { PersonRow } from "./api";
import {
  NO_DEPARTMENT,
  SKILLS_SHOWN,
  groupByDepartment,
  initials,
  loadBar,
  skillOrigin,
  skillsState,
  statusTone,
} from "./directory";

function person(over: Partial<PersonRow> & { id: string }): PersonRow {
  return { name: `p${over.id}`, status: "active", ...over };
}

describe("initials", () => {
  it("takes the first and last token", () => {
    // Not every token: a three-letter monogram in a 24px circle is a smudge.
    expect(initials("Vijay Raghav Varada")).toBe("VV");
  });

  it("handles a single name", () => {
    expect(initials("Priya")).toBe("P");
  });

  it("survives an empty name rather than throwing", () => {
    expect(initials("   ")).toBe("?");
  });
});

describe("skillsState", () => {
  it("says RESTRICTED when the HR half was projected away", () => {
    // The distinction §3.1 insists on — a blank strip cannot say which of the
    // two facts it means, so the state must.
    expect(skillsState([], false)).toEqual({ kind: "restricted" });
    expect(skillsState(["Firmware"], false)).toEqual({ kind: "restricted" });
  });

  it("says EMPTY only when the caller could have seen skills", () => {
    expect(skillsState([], true)).toEqual({ kind: "empty" });
    expect(skillsState(undefined, true)).toEqual({ kind: "empty" });
  });

  it("shows the first few and counts the rest", () => {
    const state = skillsState(["a", "b", "c", "d", "e"], true);
    expect(state).toEqual({ kind: "some", shown: ["a", "b", "c"], more: 2 });
    expect((state as { shown: string[] }).shown).toHaveLength(SKILLS_SHOWN);
  });

  it("does not report more when everything fits", () => {
    expect(skillsState(["a", "b"], true)).toEqual({
      kind: "some", shown: ["a", "b"], more: 0,
    });
  });

  it("ignores blank entries rather than rendering empty chips", () => {
    expect(skillsState(["a", "  ", ""], true)).toEqual({
      kind: "some", shown: ["a"], more: 0,
    });
  });
});

describe("skillOrigin", () => {
  it("reads a stated skill as stated", () => {
    expect(skillOrigin("Firmware", { Firmware: "stated" })).toBe("stated");
  });

  it("defaults UNKNOWN provenance to resume, not stated", () => {
    // Over-claiming on somebody's behalf is the worse error: a skill nobody
    // stated and a parser inferred must not look like a claim they made.
    expect(skillOrigin("Firmware", {})).toBe("resume");
    expect(skillOrigin("Firmware", undefined)).toBe("resume");
  });
});

describe("loadBar", () => {
  it("is unknown when there is no capacity and no work", () => {
    expect(loadBar({ capacity_hours_per_week: null, load: null }).unknown).toBe(true);
  });

  it("computes a percentage from estimated hours against capacity", () => {
    const bar = loadBar({
      capacity_hours_per_week: 40,
      load: { open_tasks: 4, estimated_hours: 20, unestimated: 0 },
    });
    expect(bar.percent).toBe(50);
    expect(bar.unknown).toBe(false);
    expect(bar.label).toContain("20h of 40h");
  });

  it("clamps an over-committed person at 100 rather than overflowing the bar", () => {
    const bar = loadBar({
      capacity_hours_per_week: 10,
      load: { open_tasks: 9, estimated_hours: 80, unestimated: 0 },
    });
    expect(bar.percent).toBe(100);
  });

  it("refuses to draw a confident zero when NOTHING is estimated", () => {
    // The load-bearing case: thirty un-estimated tasks contribute zero hours,
    // and a 0% bar would read as "completely free".
    const bar = loadBar({
      capacity_hours_per_week: 40,
      load: { open_tasks: 30, estimated_hours: 0, unestimated: 30 },
    });
    expect(bar.unknown).toBe(true);
    expect(bar.percent).toBe(0);
    expect(bar.label).toContain("none estimated");
  });

  it("names the un-estimated remainder alongside a real number", () => {
    const bar = loadBar({
      capacity_hours_per_week: 40,
      load: { open_tasks: 5, estimated_hours: 10, unestimated: 2 },
    });
    expect(bar.unknown).toBe(false);
    expect(bar.label).toContain("2 with no estimate");
  });

  it("is unknown when capacity is unset even though work exists", () => {
    const bar = loadBar({
      capacity_hours_per_week: null,
      load: { open_tasks: 3, estimated_hours: 6, unestimated: 0 },
    });
    expect(bar.unknown).toBe(true);
    expect(bar.label).toContain("3 open");
  });
});

describe("groupByDepartment", () => {
  it("sorts named departments and trails the unassigned", () => {
    const groups = groupByDepartment([
      person({ id: "1", department: "Sales" }),
      person({ id: "2" }),
      person({ id: "3", department: "Engineering" }),
    ]);
    expect(groups.map((g) => g.department)).toEqual([
      "Engineering", "Sales", NO_DEPARTMENT,
    ]);
  });

  it("never drops a person with no department", () => {
    // A directory that quietly omits somebody is worse than an untidy last
    // section.
    const groups = groupByDepartment([person({ id: "1", department: "  " })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].department).toBe(NO_DEPARTMENT);
    expect(groups[0].people).toHaveLength(1);
  });

  it("omits the unassigned group entirely when everyone has a department", () => {
    const groups = groupByDepartment([person({ id: "1", department: "Sales" })]);
    expect(groups.map((g) => g.department)).toEqual(["Sales"]);
  });

  it("keeps every person exactly once", () => {
    const rows = [
      person({ id: "1", department: "Sales" }),
      person({ id: "2", department: "Sales" }),
      person({ id: "3", department: "Ops" }),
    ];
    const total = groupByDepartment(rows).reduce((n, g) => n + g.people.length, 0);
    expect(total).toBe(rows.length);
  });
});

describe("statusTone", () => {
  it("separates the three vocabularies migration 148 allows", () => {
    expect(statusTone("active")).toBe("active");
    expect(statusTone("contractor")).toBe("warn");
    expect(statusTone("invited")).toBe("warn");
    expect(statusTone("alumni")).toBe("muted");
  });

  it("falls back to muted for anything unexpected", () => {
    // Migration 148's CHECK is NOT VALID, so a legacy row can still carry an
    // unknown status; it must render, not crash.
    expect(statusTone("weird")).toBe("muted");
  });
});
