import { describe, expect, it } from "vitest";
import {
  compactMoney,
  dwellLabel,
  initials,
  money,
  shortEmail,
  stageAgeDays,
  stageAgeLabel,
} from "./format";

describe("money", () => {
  it("groups rupees the Indian way", () => {
    // ₹1,20,000 — not ₹120,000. The team reads lakhs, and a western grouping
    // is the kind of wrong that nobody files a bug about, they just stop
    // trusting the number.
    expect(money(120000)).toContain("1,20,000");
    expect(money(12400000)).toContain("1,24,00,000");
  });

  it("renders nothing as an em dash rather than as zero", () => {
    // A deal with no amount is unpriced; ₹0 is a priced deal worth nothing.
    expect(money(null)).toBe("—");
    expect(money(undefined)).toBe("—");
    expect(money(Number.NaN)).toBe("—");
    expect(money(0)).toContain("0");
  });

  it("honours a currency other than INR", () => {
    // §1's non-goal is multi-currency support, not multi-currency DATA: the
    // column exists and defaults to INR, so the formatter must not hardcode.
    expect(money(1000, "USD")).toContain("$");
  });
});

describe("compactMoney", () => {
  it("uses lakh and crore, because a lane header is 220px wide", () => {
    expect(compactMoney(1240000)).toBe("₹12.4L");
    expect(compactMoney(32000000)).toBe("₹3.2Cr");
    expect(compactMoney(45000)).toBe("₹45K");
    expect(compactMoney(600)).toBe("₹600");
  });

  it("drops a trailing .0 so ₹12L does not read as ₹12.0L", () => {
    expect(compactMoney(1200000)).toBe("₹12L");
  });

  it("keeps the sign on a negative", () => {
    expect(compactMoney(-1200000)).toBe("-₹12L");
  });
});

describe("stage age", () => {
  const now = new Date("2026-08-05T12:00:00Z");

  it("counts whole days in the current stage", () => {
    expect(stageAgeDays("2026-08-02T12:00:00Z", now)).toBe(3);
    expect(stageAgeDays("2026-08-05T09:00:00Z", now)).toBe(0);
  });

  it("says nothing rather than zero when there is no timestamp", () => {
    // Zero days is a measurement; "we were never told" is not one — the same
    // rule the gateway's _dwell_seconds follows.
    expect(stageAgeDays(null, now)).toBeNull();
    expect(stageAgeDays("not a date", now)).toBeNull();
    expect(stageAgeLabel(null, now)).toBe("—");
  });

  it("clamps a clock-skewed future timestamp to today", () => {
    expect(stageAgeDays("2026-08-09T12:00:00Z", now)).toBe(0);
  });

  it("scales its label so a stale deal is legible at a glance", () => {
    expect(stageAgeLabel("2026-08-05T09:00:00Z", now)).toBe("today");
    expect(stageAgeLabel("2026-08-02T12:00:00Z", now)).toBe("3d");
    expect(stageAgeLabel("2026-07-01T12:00:00Z", now)).toBe("5w");
    expect(stageAgeLabel("2026-01-01T12:00:00Z", now)).toBe("7mo");
  });
});

describe("dwellLabel", () => {
  it("reads as the sentence a timeline needs", () => {
    expect(dwellLabel(950_400)).toBe("11 days");
    expect(dwellLabel(86_400)).toBe("1 day");
    expect(dwellLabel(7200)).toBe("2 hr");
    expect(dwellLabel(120)).toBe("2 min");
  });

  it("never rounds a real dwell down to zero minutes", () => {
    expect(dwellLabel(5)).toBe("1 min");
  });

  it("is absent when the gateway could not measure it", () => {
    expect(dwellLabel(null)).toBeNull();
    expect(dwellLabel(undefined)).toBeNull();
  });
});

describe("small display helpers", () => {
  it("shortens an address to the part a card has room for", () => {
    expect(shortEmail("anitha@bosch.in")).toBe("anitha");
    expect(shortEmail(null)).toBe("—");
  });

  it("always produces an avatar chip", () => {
    expect(initials("Anitha", "Kumar")).toBe("AK");
    expect(initials("Anitha", null)).toBe("A");
    expect(initials(null, undefined)).toBe("?");
    expect(initials("a", "b", "c")).toBe("AB");
  });
});
