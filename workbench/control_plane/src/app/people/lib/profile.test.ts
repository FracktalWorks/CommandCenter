/**
 * WS-28g — the profile's pure half.
 *
 * Spec: `project-docs/specs/people_center_app.md` §4.4, §5.3.
 *
 * The claim worth testing here is not "the form renders". It is that **the UI
 * has no opinion about permissions**: editability comes from the server's
 * `editable_fields` and from nowhere else (D-PC-4), and a save carries only
 * fields that both changed and are in that list.
 */

import { describe, expect, it } from "vitest";

import type { PersonDetail } from "./api";
import {
  EMPLOYMENT_TYPES,
  FIELDS,
  SECTIONS,
  changedFields,
  completeness,
  formatChips,
  isFilled,
  parseChips,
  renderSections,
} from "./profile";

function person(overrides: Partial<PersonDetail> = {}): PersonDetail {
  return {
    id: "p1",
    name: "Priya",
    email: "priya@fracktal.in",
    status: "active",
    has_login: true,
    hr_visible: true,
    can_manage: false,
    is_self: true,
    editable_fields: [],
    ...overrides,
  } as PersonDetail;
}

describe("the catalogue is a layout, not a permission map", () => {
  it("gives every field a section that exists", () => {
    const keys = new Set(SECTIONS.map((s) => s.key));
    for (const field of FIELDS) expect(keys.has(field.section)).toBe(true);
  });

  it("names every field exactly once", () => {
    const names = FIELDS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("never decides editability itself", () => {
    // Nothing renders as editable when the server said nothing is.
    const sections = renderSections(person({ editable_fields: [] }));
    const editable = sections.flatMap((s) => s.fields).filter((f) => f.editable);
    expect(editable).toEqual([]);
  });

  it("renders exactly what the server allows and no more", () => {
    const sections = renderSections(
      person({ editable_fields: ["timezone", "bio"] })
    );
    const editable = sections
      .flatMap((s) => s.fields)
      .filter((f) => f.editable)
      .map((f) => f.spec.name);
    expect(editable.sort()).toEqual(["bio", "timezone"]);
  });

  it("still SHOWS a field the caller may not write", () => {
    // A profile you can only half-see is not a profile. Read-only ≠ hidden.
    const sections = renderSections(
      person({ title: "Firmware lead", editable_fields: [] })
    );
    const names = sections.flatMap((s) => s.fields).map((f) => f.spec.name);
    expect(names).toContain("employment_type");
    expect(names).toContain("seniority");
  });

  it("can drop the private panel on somebody else's page", () => {
    const sections = renderSections(person(), { includePrivate: false });
    expect(sections.map((s) => s.section.key)).not.toContain("private");
  });

  it("offers the same vocabulary the gateway validates against", () => {
    const spec = FIELDS.find((f) => f.name === "employment_type");
    expect(spec?.options).toEqual(EMPLOYMENT_TYPES);
  });
});

describe("changedFields", () => {
  const editable = ["timezone", "bio", "languages", "working_hours"];

  it("sends only what changed", () => {
    const body = changedFields(
      { timezone: "Europe/Berlin", bio: "same" },
      { timezone: "Asia/Kolkata", bio: "same" },
      editable
    );
    expect(body).toEqual({ timezone: "Europe/Berlin" });
  });

  it("drops a field the server said is not editable", () => {
    // The server refusing it is the real control (D-PC-5); this only stops the
    // request being pointless.
    const body = changedFields({ title: "CTO" }, { title: "Engineer" }, editable);
    expect(body).toEqual({});
  });

  it("treats null and empty string as the same 'not set'", () => {
    // Otherwise an untouched empty input looks like a change on every save.
    expect(changedFields({ bio: "" }, { bio: null }, editable)).toEqual({});
  });

  it("compares arrays by content, not by identity", () => {
    expect(
      changedFields({ languages: ["en"] }, { languages: ["en"] }, editable)
    ).toEqual({});
    expect(
      changedFields({ languages: ["en", "kn"] }, { languages: ["en"] }, editable)
    ).toEqual({ languages: ["en", "kn"] });
  });

  it("compares objects by content", () => {
    expect(
      changedFields(
        { working_hours: { start: "09:00" } },
        { working_hours: { start: "09:00" } },
        editable
      )
    ).toEqual({});
    expect(
      changedFields(
        { working_hours: { start: "10:00" } },
        { working_hours: { start: "09:00" } },
        editable
      )
    ).toEqual({ working_hours: { start: "10:00" } });
  });

  it("can clear a field", () => {
    expect(changedFields({ bio: "" }, { bio: "something" }, editable)).toEqual({
      bio: "",
    });
  });
});

describe("the completeness meter", () => {
  it("counts only fields whose absence has a stated consequence", () => {
    // "Cost centre is empty" is not worth interrupting somebody about.
    const meter = completeness(person());
    expect(meter.total).toBe(FIELDS.filter((f) => f.why).length);
    expect(meter.missing.every((m) => m.why.length > 0)).toBe(true);
  });

  it("names the consequence, not just the field", () => {
    const meter = completeness(person());
    const tz = meter.missing.find((m) => m.label === "Time zone");
    expect(tz?.why).toMatch(/scheduler|day/i);
  });

  it("counts a filled field as filled", () => {
    const before = completeness(person()).filled;
    const after = completeness(person({ timezone: "Asia/Kolkata" })).filled;
    expect(after).toBe(before + 1);
  });

  it("does not count an empty array as filled", () => {
    expect(completeness(person({ skills: [] })).missing.map((m) => m.label))
      .toContain("Skills");
  });

  it("survives a null person", () => {
    expect(completeness(null).filled).toBe(0);
  });
});

describe("value helpers", () => {
  it("knows what counts as filled", () => {
    expect(isFilled("")).toBe(false);
    expect(isFilled("  ")).toBe(false);
    expect(isFilled([])).toBe(false);
    expect(isFilled({})).toBe(false);
    expect(isFilled(null)).toBe(false);
    expect(isFilled(0)).toBe(true);
    expect(isFilled(["a"])).toBe(true);
  });

  it("round-trips chips", () => {
    expect(parseChips("firmware, modbus ,, ")).toEqual(["firmware", "modbus"]);
    expect(formatChips(["a", "b"])).toBe("a, b");
    expect(formatChips(null)).toBe("");
  });
});
