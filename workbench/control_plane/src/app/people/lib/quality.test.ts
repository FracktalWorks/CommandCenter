/** WS-28m — the wording of the coverage/quality panels (§5.10). */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { describeMissing, describeScan, overflow } from "./quality";

const coverage = (over: Record<string, unknown> = {}) => ({
  single_holder: [],
  title_terms: [],
  unused_skills: [],
  tasks_scanned: 4200,
  tasks_partial: false,
  scope_partial: false,
  scan_ran: true,
  scan_error: false,
  ...over,
});

describe("describeScan — four states, four sentences, none drawn as another", () => {
  it("names the scan size", () => {
    expect(describeScan(coverage())).toContain("4,200 task titles");
  });

  it("an empty scan refuses the claim rather than implying a clean bill", () => {
    expect(describeScan(coverage({ tasks_scanned: 0 }))).toContain(
      "No visible tasks"
    );
  });

  it("a FAILED scan says failed, never 'no visible tasks'", () => {
    const line = describeScan(
      coverage({ scan_error: true, scan_ran: false, tasks_scanned: 0 })
    );
    expect(line).toContain("failed");
    expect(line).not.toContain("No visible tasks");
  });

  it("a skipped scan says what it needs", () => {
    expect(
      describeScan(coverage({ scan_ran: false, tasks_scanned: 0 }))
    ).toContain("did not run");
  });

  it("a capped scan says newest-only", () => {
    expect(describeScan(coverage({ tasks_partial: true }))).toContain(
      "newest only"
    );
  });

  it("a scoped scan names the viewer's slice (D-PC-20)", () => {
    expect(describeScan(coverage({ scope_partial: true }))).toContain(
      "projects you can see"
    );
  });
});

describe("overflow — caps are shown, never silent", () => {
  it("says shown-of-total when capped", () => {
    expect(overflow(50, 87)).toBe("Showing 50 of 87");
  });

  it("is silent when complete", () => {
    expect(overflow(12, 12)).toBeNull();
  });
});

describe("describeMissing", () => {
  it("names the fields in human words", () => {
    expect(
      describeMissing({ id: "1", name: "P", missing: ["timezone", "working_hours"] })
    ).toBe("timezone, working hours");
  });
});

describe("the panel never re-orders (D-PC-14)", () => {
  it("no .sort( in the page — the server's alphabetical order IS the order", () => {
    const page = readFileSync(
      join(__dirname, "..", "quality", "page.tsx"),
      "utf-8"
    );
    expect(page).not.toContain(".sort(");
  });
});
