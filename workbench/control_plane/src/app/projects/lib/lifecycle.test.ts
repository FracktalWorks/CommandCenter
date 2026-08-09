/**
 * Projects · lifecycle helpers (WS-27z).
 *
 * `isAutomated` is what makes an automated timeline entry LOOK automated —
 * a sweep that archives a task must not read as a person having done it. The
 * flag rides in `meta.automation`, written by the gateway's activity spine
 * for every engine write and never for a human one, so the cases here are
 * exactly the shapes the timeline endpoint can hand back.
 */

import { describe, expect, it } from "vitest";

import { isAutomated, parseMonths } from "./lifecycle";

describe("isAutomated", () => {
  it("reads the automation flag out of meta", () => {
    expect(isAutomated({ meta: { automation: true } })).toBe(true);
  });

  it("is false for a human write — absent flag, absent meta, null meta", () => {
    expect(isAutomated({ meta: { changes: [] } })).toBe(false);
    expect(isAutomated({})).toBe(false);
    expect(isAutomated({ meta: null })).toBe(false);
  });
});

describe("parseMonths", () => {
  it("empty means the policy is off (null), not zero", () => {
    expect(parseMonths("")).toEqual({ ok: true, value: null });
    expect(parseMonths("   ")).toEqual({ ok: true, value: null });
  });

  it("a whole positive number passes", () => {
    expect(parseMonths("3")).toEqual({ ok: true, value: 3 });
    expect(parseMonths(" 12 ")).toEqual({ ok: true, value: 12 });
  });

  it("zero, negatives, fractions and words are refused — the gateway's rule", () => {
    expect(parseMonths("0").ok).toBe(false);
    expect(parseMonths("-1").ok).toBe(false);
    expect(parseMonths("1.5").ok).toBe(false);
    expect(parseMonths("soon").ok).toBe(false);
    // Scientific notation is a number to `Number()` and not to a person.
    expect(parseMonths("1e2").ok).toBe(false);
  });
});
