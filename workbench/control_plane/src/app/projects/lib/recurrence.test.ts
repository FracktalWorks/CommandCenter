/**
 * Projects · the repeat rule in the browser (WS-27o).
 *
 * The gateway owns the date arithmetic. This owns saying what a rule MEANS
 * before somebody commits to it — and the cases worth pinning are the ones
 * where a sentence would read wrong: a plural that should be singular, a count
 * that shows the cap instead of what is left, and an anchor whose two values a
 * reader cannot guess.
 */

import { describe, expect, it } from "vitest";

import {
  ANCHORS,
  FREQS,
  MAX_INTERVAL,
  type Rule,
  describeRule,
  emptyRule,
  ordinal,
  ruleProblem,
  toPayload,
  toggleWeekday,
} from "./recurrence";

const rule = (over: Partial<Rule> = {}): Rule => ({ ...emptyRule(), ...over });

describe("ordinal", () => {
  it("handles the suffixes", () => {
    expect([1, 2, 3, 4, 21, 22, 23, 31].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "21st", "22nd", "23rd", "31st",
    ]);
  });

  it("gets the teens right, which the naive rule does not", () => {
    // 11, 12 and 13 end in 1, 2 and 3 but are "th".
    expect([11, 12, 13].map(ordinal)).toEqual(["11th", "12th", "13th"]);
  });
});

describe("describeRule", () => {
  it("says every day, not every 1 days", () => {
    expect(describeRule(rule({ freq: "daily", interval: 1 }))).toContain("Every day");
  });

  it("pluralises a real interval", () => {
    expect(describeRule(rule({ freq: "daily", interval: 3 }))).toContain("Every 3 days");
  });

  it("names the weekdays in order, whatever order they were picked in", () => {
    const said = describeRule(
      rule({ freq: "weekly", interval: 2, weekdays: [4, 1] })
    );
    expect(said).toContain("Every 2 weeks on Mon, Thu");
  });

  it("reads a monthly rule as a date", () => {
    expect(
      describeRule(rule({ freq: "monthly", day_of_month: 31 }))
    ).toContain("Every month on the 31st");
  });

  it("names the month for a yearly rule", () => {
    expect(
      describeRule(rule({ freq: "yearly", day_of_month: 29, month_of_year: 2 }))
    ).toContain("Every year on February 29th");
  });

  it("spells the anchor out rather than naming it", () => {
    // "due" and "completed" are the two words in this feature a reader cannot
    // guess — and choosing wrong makes a cadence drift later every month.
    expect(describeRule(rule({ anchor: "due", weekdays: [1] }))).toContain(
      "keeping to the schedule"
    );
    expect(describeRule(rule({ anchor: "completed", weekdays: [1] }))).toContain(
      "measured from when it is finished"
    );
  });

  it("counts what is LEFT, not the cap", () => {
    // "6 times" beside a series that has already run five reads as five more
    // to come.
    const said = describeRule(
      rule({ weekdays: [1], max_occurrences: 6, occurrences_made: 5 })
    );
    expect(said).toContain("1 more time");
    expect(said).not.toContain("6 more");
  });

  it("does not go negative when the cap has been passed", () => {
    const said = describeRule(
      rule({ weekdays: [1], max_occurrences: 2, occurrences_made: 5 })
    );
    expect(said).toContain("0 more times");
    expect(said).not.toContain("-3");
  });

  it("ignores an unparseable until date rather than saying Invalid Date", () => {
    const said = describeRule(rule({ weekdays: [1], until_at: "soon" }));
    expect(said).not.toMatch(/invalid/i);
  });

  it("says nothing about limits when there are none", () => {
    const said = describeRule(rule({ weekdays: [1] }));
    expect(said).not.toContain("more time");
    expect(said).not.toContain("until");
  });
});

describe("ruleProblem", () => {
  it("is null for a rule that can be saved", () => {
    expect(ruleProblem(rule({ freq: "weekly", weekdays: [1] }))).toBeNull();
  });

  it("catches a weekly rule with no day chosen", () => {
    expect(ruleProblem(rule({ freq: "weekly", weekdays: [] }))).toMatch(/day of the week/);
  });

  it("catches a monthly rule with no date", () => {
    expect(ruleProblem(rule({ freq: "monthly" }))).toMatch(/day of the month/);
  });

  it("catches an interval of zero, which the server also refuses", () => {
    // The falsy-zero trap on the server was real; this is its front half.
    expect(ruleProblem(rule({ freq: "daily", interval: 0 }))).not.toBeNull();
  });

  it("catches an interval past the cap", () => {
    expect(ruleProblem(rule({ freq: "daily", interval: MAX_INTERVAL + 1 }))).not.toBeNull();
  });

  it("catches a fractional interval", () => {
    expect(ruleProblem(rule({ freq: "daily", interval: 1.5 }))).not.toBeNull();
  });
});

describe("toggleWeekday", () => {
  it("adds and removes", () => {
    expect(toggleWeekday([], 3)).toEqual([3]);
    expect(toggleWeekday([3], 3)).toEqual([]);
  });

  it("keeps the list sorted so the sentence reads in order", () => {
    expect(toggleWeekday([4], 1)).toEqual([1, 4]);
  });

  it("does not mutate the list it was given", () => {
    const current = [1];
    toggleWeekday(current, 4);
    expect(current).toEqual([1]);
  });
});

describe("toPayload", () => {
  it("clears the fields the chosen frequency does not use", () => {
    // A rule edited from monthly to weekly must not keep a stale day_of_month
    // that reappears the moment somebody switches back.
    const payload = toPayload(
      rule({ freq: "weekly", weekdays: [1], day_of_month: 31, month_of_year: 2 })
    );
    expect(payload.day_of_month).toBeNull();
    expect(payload.month_of_year).toBeNull();
    expect(payload.weekdays).toEqual([1]);
  });

  it("clears weekdays when the frequency is not weekly", () => {
    expect(
      toPayload(rule({ freq: "monthly", day_of_month: 1, weekdays: [1, 4] })).weekdays
    ).toEqual([]);
  });

  it("defaults a yearly rule's month rather than sending null", () => {
    // The gateway falls back to the due date's month, which would make the
    // same rule mean different things on different tasks.
    expect(toPayload(rule({ freq: "yearly", day_of_month: 1 })).month_of_year).toBe(1);
  });

  it("sends null rather than an empty string for the end date", () => {
    expect(toPayload(rule({ weekdays: [1], until_at: "" })).until_at).toBeNull();
  });
});

describe("the vocabulary", () => {
  it("matches the gateway's", () => {
    expect(FREQS).toEqual(["daily", "weekly", "monthly", "yearly"]);
    expect(ANCHORS).toEqual(["due", "completed"]);
  });

  it("starts a new rule on something that needs one more choice", () => {
    // Weekly with no day chosen: the form opens asking a question rather than
    // pre-filling an answer nobody made.
    expect(ruleProblem(emptyRule())).not.toBeNull();
  });
});
