/**
 * Billing view-model — the arithmetic and the wording, framework-free.
 *
 * Spec: `project-docs/specs/subscription_console.md` SC-1b / SC-4c / SC-5 ·
 * decisions D37 (the credit product) and D38 (billing documents).
 *
 * Why this is a separate module from the page: every number here is either
 * money or a promise about money, and both deserve tests that do not need a
 * browser. The page renders; this decides.
 *
 * ⚠️ **Nothing here recomputes a balance.** The balance is `SUM(credit_ledger)`
 * and it is computed once, server-side, by the Control Plane (WS-31 §3.4). A
 * second implementation in the client is exactly how two surfaces come to
 * disagree — and the one that disagrees in the customer's favour is the one
 * that costs money. This module formats and forecasts; it never re-derives.
 */

export interface CreditSummary {
  /** Authoritative, from the Control Plane. Never recomputed here. */
  balanceCredits: number;
  /** Consumed in the current cycle, from `usage_rollup`. */
  burnThisCycle: number;
  /** Days of history the burn figure covers — named in the UI (SC-4c). */
  windowDays: number;
  /** BYOK orgs are metered but not charged for tokens (§3.4). */
  isByok: boolean;
}

/** A credit is the ₹10 purchase and display unit (D19.2). */
export const RUPEES_PER_CREDIT = 10;

export function creditsToRupees(credits: number): number {
  return credits * RUPEES_PER_CREDIT;
}

/**
 * Money, as a customer expects to read it. Indian digit grouping, because the
 * audience is Indian businesses and `1,00,000` is what their accountant writes.
 */
export function formatRupees(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatCredits(credits: number): string {
  // Fractional draws are real (a cheap classification call burns ~0.2), so
  // small balances must not round to a misleading whole number.
  const digits = Math.abs(credits) < 100 && !Number.isInteger(credits) ? 1 : 0;
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: digits,
  }).format(credits);
}

export type RunwayState =
  | { kind: "unknown"; reason: string }
  | { kind: "days"; days: number }
  | { kind: "empty" };

/**
 * "About N days left at your current rate" — the number that actually prompts a
 * top-up (SC-4c). A balance alone does not.
 *
 * Returns `unknown` rather than a number when there is no usage to extrapolate
 * from. That case is common (a new organization) and the honest answer is "we
 * cannot tell yet" — **not** `Infinity`, and not a reassuring large number that
 * turns out to be an artefact of dividing by nearly zero.
 */
export function runway(summary: CreditSummary): RunwayState {
  if (summary.balanceCredits <= 0) return { kind: "empty" };
  if (summary.burnThisCycle <= 0 || summary.windowDays <= 0) {
    return { kind: "unknown", reason: "no usage yet" };
  }
  const perDay = summary.burnThisCycle / summary.windowDays;
  if (perDay <= 0) return { kind: "unknown", reason: "no usage yet" };

  const days = Math.floor(summary.balanceCredits / perDay);
  // Beyond a quarter the figure stops being decision-useful and starts being
  // a false promise — burn rates move. Cap rather than print "412 days".
  return days > 90 ? { kind: "unknown", reason: "more than 90 days" }
                   : { kind: "days", days };
}

export type BalanceTone = "ok" | "warning" | "danger";

/**
 * The 80% threshold from §3.3, as a tone rather than a colour.
 *
 * ⚠️ Percent-of-what matters. There is no "allowance" to be 80% *of* — credits
 * roll over indefinitely (D32.6), so a percentage of a purchase is meaningless
 * a month later. The signal customers can act on is **runway**, so the tone is
 * driven by days remaining, with an absolute floor for the empty case.
 */
export function balanceTone(summary: CreditSummary): BalanceTone {
  if (summary.balanceCredits <= 0) return "danger";
  const r = runway(summary);
  if (r.kind === "days" && r.days <= 3) return "danger";
  if (r.kind === "days" && r.days <= 10) return "warning";
  return "ok";
}

export interface InvoiceRow {
  id: string;
  /** `subscription` and `credits` are separate documents on purpose (D38.2). */
  kind: "subscription" | "credits";
  serial: string;
  issuedOn: string;
  periodLabel: string | null;
  amountInr: number;
  status: "paid" | "due" | "failed" | "credit_note";
  downloadUrl: string | null;
}

/**
 * One chronological list, newest first — the admin should not have to know that
 * a seat subscription and a credit pack are different tax events to find their
 * bill. The separation is real underneath (D38.2); it is not the customer's
 * problem.
 */
export function sortInvoices(rows: InvoiceRow[]): InvoiceRow[] {
  return [...rows].sort((a, b) => b.issuedOn.localeCompare(a.issuedOn));
}

export function invoiceKindLabel(kind: InvoiceRow["kind"]): string {
  return kind === "subscription" ? "Subscription" : "AI credits";
}
