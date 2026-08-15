/** WS-28l — the landing arranges, never recomputes (§5.9). */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { describeQuality, headcountMatrix } from "./overview";

const rows = [
  { department: "R&D", status: "active", count: 3 },
  { department: "R&D", status: "alumni", count: 1 },
  { department: "Sales", status: "active", count: 2 },
  { department: "Sales", status: "on sabbatical", count: 1 },
];

describe("headcountMatrix", () => {
  it("keeps vocabulary statuses in order and appends legacy ones", () => {
    const m = headcountMatrix(rows);
    expect(m.statuses).toEqual(["active", "alumni", "on sabbatical"]);
  });

  it("cells, department totals and status totals agree with the rows", () => {
    const m = headcountMatrix(rows);
    expect(m.cell("R&D", "active")).toBe(3);
    expect(m.cell("R&D", "on sabbatical")).toBe(0);
    expect(m.departmentTotal("Sales")).toBe(3);
    expect(m.statusTotal("active")).toBe(5);
  });
});

describe("describeQuality", () => {
  it("names each non-zero count in human words", () => {
    const line = describeQuality({
      email_conflict: 1,
      no_email: 2,
      bad_status: 0,
      unused_skills: 9,
    });
    expect(line).toBe("1 quarantined address · 2 people without email");
  });

  it("a clean record is null, not five zeros", () => {
    expect(describeQuality({ no_email: 0 })).toBeNull();
  });
});

describe("the landing is a projection (D-PC-14, §5.9)", () => {
  const page = readFileSync(
    join(__dirname, "..", "overview", "page.tsx"),
    "utf-8"
  );

  it("no .sort( in the page — server order is the order", () => {
    expect(page).not.toContain(".sort(");
  });

  it("roots are NUMBERED from the §5.10 count, never from the capped list", () => {
    // Adversarial-review finding: `roots` is capped at 50; numbering from
    // `.length` makes the same screen show two different totals past 50.
    expect(page).toContain("quality_counts.no_manager} unmanaged roots");
    expect(page).not.toContain("roots.length} unmanaged roots");
  });
});
