/**
 * WS-28p — the working week's pure half.
 *
 * Spec: `project-docs/specs/people_center_app.md` §3.4a, §5.11.
 *
 * The claim worth testing is that this module **formats and never computes**:
 * the layering is the server's, and a second implementation of "policy +
 * override" here would be a second answer to how many hours somebody works.
 */

import { describe, expect, it } from "vitest";

import {
  type EffectiveSchedule,
  DAY_NAMES,
  describeImpact,
  describeSchedule,
  formatDays,
  formatHours,
  overriddenFields,
  policyChanged,
} from "./schedule";

function schedule(over: Partial<EffectiveSchedule> = {}): EffectiveSchedule {
  return {
    days: [1, 2, 3, 4, 5],
    hours_per_day: 8,
    start: "09:30",
    end: "18:00",
    timezone: "Asia/Kolkata",
    shift: null,
    fraction: 1,
    source: { days: "org", hours_per_day: "org", start: "org", end: "org" },
    ...over,
  };
}

describe("formatDays", () => {
  it("collapses a run into a range", () => {
    // "Mon, Tue, Wed, Thu, Fri" is the same fact spelled so nobody reads it.
    expect(formatDays([1, 2, 3, 4, 5])).toBe("Mon–Fri");
  });

  it("lists a scattered week", () => {
    expect(formatDays([1, 3, 5])).toBe("Mon, Wed, Fri");
  });

  it("handles a mixed week", () => {
    expect(formatDays([1, 2, 3, 6])).toBe("Mon–Wed, Sat");
  });

  it("keeps a two-day run as a list, not a range", () => {
    // "Mon–Tue" is longer than "Mon, Tue" and no clearer.
    expect(formatDays([1, 2])).toBe("Mon, Tue");
  });

  it("says so when there is no week at all", () => {
    expect(formatDays([])).toBe("no working days");
  });

  it("collapses a full week", () => {
    expect(formatDays([1, 2, 3, 4, 5, 6, 7])).toBe("every day");
  });

  it("sorts and deduplicates what it is given", () => {
    expect(formatDays([5, 1, 1, 3])).toBe("Mon, Wed, Fri");
  });

  it("starts the week on Monday, matching the server's ISO numbering", () => {
    expect(DAY_NAMES[0]).toBe("Mon");
  });
});

describe("describeSchedule", () => {
  it("reads in the order somebody asks it", () => {
    expect(describeSchedule(schedule())).toBe("Mon–Fri · 09:30–18:00 · 8h/day");
  });

  it("mentions part time only when it applies", () => {
    expect(describeSchedule(schedule({ fraction: 0.5 }))).toContain("50% time");
    expect(describeSchedule(schedule())).not.toContain("%");
  });

  it("names the shift when there is one", () => {
    expect(describeSchedule(schedule({ shift: "night" }))).toContain("night shift");
  });

  it("omits the clock for an org that has none", () => {
    const line = describeSchedule(schedule({ start: null, end: null }));
    expect(line).toBe("Mon–Fri · 8h/day");
  });

  it("survives a missing schedule", () => {
    expect(describeSchedule(null)).toBe("—");
  });
});

describe("overriddenFields", () => {
  it("reads the server's source map rather than diffing", () => {
    // The client HAS the override and the policy and could compare them. Doing
    // so would be the second implementation this module exists to avoid.
    const fields = overriddenFields(
      schedule({ source: { days: "org", start: "person", end: "person" } })
    );
    expect(fields).toEqual(["end", "start"]);
  });

  it("is empty when everything comes from the company", () => {
    expect(overriddenFields(schedule())).toEqual([]);
  });

  it("survives a schedule with no source map", () => {
    expect(overriddenFields(null)).toEqual([]);
  });
});

describe("formatHours", () => {
  it("drops a trailing zero", () => {
    expect(formatHours(40)).toBe("40h");
  });

  it("keeps a real fraction", () => {
    expect(formatHours(37.5)).toBe("37.5h");
  });

  it("says nothing rather than 0 when there is no answer", () => {
    expect(formatHours(null)).toBe("—");
    expect(formatHours(undefined)).toBe("—");
  });
});

describe("describeImpact", () => {
  const impact = {
    changed: 0,
    unchanged: 12,
    examples: [],
    hours_before: 40,
    hours_after: 40,
  };

  it("leads with who moves, not with the roster size", () => {
    // "45 people" is true and useless. The question an admin is asking before
    // agreeing is "whose numbers change".
    const line = describeImpact({ ...impact, changed: 3, hours_after: 30 });
    expect(line).toMatch(/^3 people's contracted hours change/);
  });

  it("is singular for one person", () => {
    expect(describeImpact({ ...impact, changed: 1 })).toMatch(/^1 person's/);
  });

  it("says plainly when nothing moves", () => {
    expect(describeImpact(impact)).toBe("Nobody's contracted hours change.");
  });

  it("shows the before and after for the company default", () => {
    expect(describeImpact({ ...impact, changed: 2, hours_after: 30 }))
      .toContain("40h → 30h");
  });

  it("renders nothing when there is no impact yet", () => {
    expect(describeImpact(null)).toBe("");
  });
});

describe("policyChanged", () => {
  const base = { working_days: [1, 2, 3, 4, 5], hours_per_day: 8 };

  it("ignores day order", () => {
    expect(policyChanged({ ...base, working_days: [5, 4, 3, 2, 1] }, base))
      .toBe(false);
  });

  it("sees a real change", () => {
    expect(policyChanged({ ...base, hours_per_day: 6 }, base)).toBe(true);
  });

  it("treats a missing shift list and an empty one as the same", () => {
    expect(policyChanged({ ...base, shifts: [] }, base)).toBe(false);
  });

  it("sees a new shift", () => {
    expect(policyChanged({ ...base, shifts: [{ name: "night" }] }, base))
      .toBe(true);
  });
});
