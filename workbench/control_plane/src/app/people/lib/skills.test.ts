/**
 * WS-28h — the structured-skills pure half.
 *
 * Formatting and editor scaffolding. The validation is deliberately NOT here —
 * it lives on the server and its refusals render verbatim, so what these
 * cases pin is that nothing is invented (no "undefined" years, no restyled
 * evidence words) and that the wire shape drops only what a person abandoned.
 */

import { describe, expect, it } from "vitest";

import {
  credentialYears,
  credentialsToWire,
  describeCredential,
  describeSkill,
  seedRows,
  toWire,
} from "./skills";

describe("describeSkill", () => {
  it("reads as the assessment, compactly", () => {
    expect(
      describeSkill({ skill: "python", level: "expert", years: 8,
                      last_used_year: 2026 })
    ).toBe("expert · 8y · used 2026");
  });

  it("is empty when the row carries only its name", () => {
    // A chip with a blank subtitle is noise, and "null · undefinedy" is worse.
    expect(describeSkill({ skill: "python" })).toBe("");
  });

  it("keeps a fractional year honest", () => {
    expect(describeSkill({ skill: "go", years: 1.5 })).toBe("1.5y");
  });
});

describe("describeCredential", () => {
  it("renders the full form", () => {
    expect(
      describeCredential({ kind: "education", title: "BTech Mechatronics",
                           issuer: "IIT Bombay", year_from: 2012,
                           year_to: 2016 })
    ).toBe("BTech Mechatronics — IIT Bombay · 2012–2016");
  });

  it("never renders a missing part as undefined", () => {
    expect(describeCredential({ kind: "certification", title: "PMP" }))
      .toBe("PMP");
  });

  it("collapses a single-year range", () => {
    expect(credentialYears({ kind: "certification", title: "x",
                             year_from: 2024, year_to: 2024 })).toBe("2024");
  });

  it("marks an open-ended engagement", () => {
    expect(credentialYears({ kind: "prior_role", title: "x",
                             year_from: 2021 })).toBe("2021–");
  });
});

describe("seedRows", () => {
  it("prefers the structured rows when they exist", () => {
    const rows = seedRows(
      [{ skill: "python", level: "expert" }], ["python", "rust"]);
    expect(rows).toEqual([{ skill: "python", level: "expert" }]);
  });

  it("seeds from the flat list for a row nobody has enriched", () => {
    // "Add your levels" should start from what exists, not from an empty
    // table that invites retyping everything.
    expect(seedRows([], ["python", "rust"]).map((r) => r.skill))
      .toEqual(["python", "rust"]);
  });

  it("copies rather than aliasing, so edits do not mutate the payload", () => {
    const detail = [{ skill: "python", level: "expert" }];
    const rows = seedRows(detail, []);
    rows[0].level = "learning";
    expect(detail[0].level).toBe("expert");
  });
});

describe("toWire", () => {
  it("drops the row somebody added and abandoned", () => {
    expect(toWire([{ skill: "  " }, { skill: "python" }]))
      .toHaveLength(1);
  });

  it("leaves duplicates for the SERVER to refuse by name", () => {
    // Pre-filtering here would silently pick one of two rows the person
    // typed differently — a silent drop, which is the D-PC-5 shape.
    expect(toWire([{ skill: "Python" }, { skill: "python" }]))
      .toHaveLength(2);
  });

  it("normalises empties to null, not empty string", () => {
    const [row] = toWire([{ skill: "python", level: "" }]);
    expect(row.level).toBeNull();
  });
});

describe("credentialsToWire", () => {
  it("drops the abandoned, keeps the typed", () => {
    const rows = credentialsToWire([
      { kind: "education", title: "" },
      { kind: "education", title: "BTech", issuer: "  " },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].issuer).toBeNull();
  });
});
