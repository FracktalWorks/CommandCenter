/**
 * The billing view-model: money, runway, and the wording around them.
 *
 * Spec: `subscription_console.md` SC-1b / SC-4c · D37 · D38.
 *
 * These are the numbers a customer reads before deciding to spend money, so the
 * cases worth pinning are the ones where a plausible implementation lies:
 * an empty organization extrapolating to `Infinity`, a fractional balance
 * rounding to zero, and a runway so long it is a promise rather than a figure.
 */
import { describe, expect, it } from "vitest";

import {
  type CreditSummary,
  balanceTone,
  creditsToRupees,
  formatCredits,
  formatRupees,
  invoiceKindLabel,
  runway,
  sortInvoices,
  type InvoiceRow,
} from "./billing";

const summary = (over: Partial<CreditSummary> = {}): CreditSummary => ({
  balanceCredits: 1000,
  burnThisCycle: 300,
  windowDays: 30,
  isByok: false,
  ...over,
});

describe("money", () => {
  it("prices a credit at ₹10 (D19.2)", () => {
    expect(creditsToRupees(250)).toBe(2500);
  });

  it("groups digits the way an Indian accountant writes them", () => {
    // 1,00,000 — not 100,000. The audience is Indian businesses.
    expect(formatRupees(100000)).toContain("1,00,000");
  });

  it("keeps a fraction visible on a small balance", () => {
    // Draws are fractional — a cheap classification call burns ~0.2 credits —
    // so rounding 0.4 to "0" would read as empty when it is not.
    expect(formatCredits(0.4)).toBe("0.4");
  });

  it("drops noise fractions on a large balance", () => {
    expect(formatCredits(12345.67)).toBe("12,346");
  });
});

describe("runway — the number that prompts a top-up", () => {
  it("extrapolates from the burn window", () => {
    // 300 credits over 30 days = 10/day; 1000 left ⇒ 100 days... capped below.
    expect(runway(summary({ balanceCredits: 500 }))).toEqual({
      kind: "days", days: 50,
    });
  });

  it("says 'unknown', never Infinity, when there is no usage", () => {
    // The common case for a new organization. Dividing by ~zero produces a
    // reassuring enormous number that is purely an artefact.
    const r = runway(summary({ burnThisCycle: 0 }));
    expect(r.kind).toBe("unknown");
  });

  it("reports empty rather than zero days at a zero balance", () => {
    expect(runway(summary({ balanceCredits: 0 })).kind).toBe("empty");
  });

  it("refuses to promise beyond 90 days", () => {
    // Burn rates move. "412 days" is a false promise, not a forecast.
    const r = runway(summary({ balanceCredits: 100000 }));
    expect(r).toEqual({ kind: "unknown", reason: "more than 90 days" });
  });

  it("never returns a negative runway on an overdrawn balance", () => {
    // §3.3's grace overdraft makes a negative balance reachable.
    expect(runway(summary({ balanceCredits: -50 })).kind).toBe("empty");
  });
});

describe("tone — driven by runway, not by a percentage", () => {
  it("is danger when empty", () => {
    expect(balanceTone(summary({ balanceCredits: 0 }))).toBe("danger");
  });

  it("is danger within three days", () => {
    // 300/30 = 10 a day, 25 left ⇒ 2 days.
    expect(balanceTone(summary({ balanceCredits: 25 }))).toBe("danger");
  });

  it("is warning within ten days", () => {
    expect(balanceTone(summary({ balanceCredits: 80 }))).toBe("warning");
  });

  it("is ok with room to spare", () => {
    expect(balanceTone(summary({ balanceCredits: 5000 }))).toBe("ok");
  });

  it("is ok for a new org that has spent nothing", () => {
    // Unknown runway must not read as danger, or every new customer is
    // greeted by an alarm.
    expect(balanceTone(summary({ burnThisCycle: 0 }))).toBe("ok");
  });
});

describe("the invoice list", () => {
  const row = (over: Partial<InvoiceRow>): InvoiceRow => ({
    id: "1", kind: "credits", serial: "CC/26-27/0001",
    issuedOn: "2026-08-01", periodLabel: null, amountInr: 5900,
    status: "paid", downloadUrl: "/x.pdf", ...over,
  });

  it("interleaves both document types newest first", () => {
    // The admin should not need to know that a subscription and a credit pack
    // are different tax events in order to find their bill (D38.2).
    const sorted = sortInvoices([
      row({ id: "a", issuedOn: "2026-06-01", kind: "subscription" }),
      row({ id: "b", issuedOn: "2026-08-01", kind: "credits" }),
      row({ id: "c", issuedOn: "2026-07-01", kind: "subscription" }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("names the two kinds in customer language", () => {
    expect(invoiceKindLabel("credits")).toBe("AI credits");
    expect(invoiceKindLabel("subscription")).toBe("Subscription");
  });

  it("does not mutate its input", () => {
    const rows = [row({ id: "a" }), row({ id: "b", issuedOn: "2026-09-01" })];
    sortInvoices(rows);
    expect(rows[0].id).toBe("a");
  });
});
