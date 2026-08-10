// ── The reports tab's geometry and its labels ─────────────────────────────
//
// Everything the reports surface does that is not painting pixels lives here,
// so it can be tested against fixtures without a DOM: bar widths, the wording
// that keeps a number from being read as something it is not, and the two
// checks that decide whether a block has anything to say.
//
// ⚠️ **No math is re-derived here.** Every figure — weighted ₹, entered,
// conversion-forward %, medians, win rate — is computed server-side in
// `routes/crm/reports.py` and rendered verbatim. The one formula that exists
// on both sides is the weighted ₹ in `board.ts`, and it is held to the SQL by
// the shared fixture `tests/fixtures/crm_weighted_parity.json`. A second
// calculation added to this file is a second answer to a question that already
// has one.
//
// Spec: project-docs/specs/crm_app.md §5.1 system 2 (WS-26g).

import type {
  FunnelReport,
  FunnelStage,
  OwnerLeaderboard,
  PipelineReport,
  StageTotals,
  WinLossReport,
} from "./types";

/**
 * A bar's width as a percentage of the biggest value in its set.
 *
 * Relative to the MAX rather than to the first stage: a funnel is not
 * guaranteed to be monotonically decreasing (a deal can move backwards, and
 * the visited-set rule counts it in both lanes), so scaling to the top lane
 * would render bars wider than the chart the moment somebody demotes a deal.
 *
 * Returns 0 for an empty set and for a zero value, never NaN — a chart that
 * renders `width: NaN%` collapses to nothing and looks like a load failure.
 */
export function barWidth(value: number, values: number[]): number {
  const max = Math.max(0, ...values);
  if (!max || value <= 0) return 0;
  return Math.round((value / max) * 100);
}

/** The funnel's bars are scaled against the widest `entered`. */
export function funnelWidths(report: FunnelReport | null): number[] {
  if (!report) return [];
  const entered = report.stages.map((s) => s.entered);
  return entered.map((value) => barWidth(value, entered));
}

/** The forecast's bars are scaled against the biggest weighted lane. */
export function pipelineWidths(report: PipelineReport | null): number[] {
  if (!report) return [];
  const weighted = report.stages.map((s) => s.weighted);
  return weighted.map((value) => barWidth(value, weighted));
}

/**
 * "3.0 days (12 departures)" — the median WITH its sample size.
 *
 * The sample size is not decoration. `dwell_seconds` is stamped only when a
 * deal LEAVES a stage, so this median is over departures and can legitimately
 * be one measurement; presenting a median of one without saying so is how it
 * gets quoted in a meeting.
 *
 * `null` renders as "no departures yet" rather than "0 days", because zero is
 * a measurement and "nobody has left this stage" is not one.
 */
export function dwellSummary(stage: Pick<FunnelStage, "median_dwell_days" | "dwell_samples">): string {
  if (stage.median_dwell_days === null) return "no departures yet";
  const unit = stage.median_dwell_days === 1 ? "day" : "days";
  const departures = stage.dwell_samples === 1 ? "departure" : "departures";
  return `${stage.median_dwell_days} ${unit} · ${stage.dwell_samples} ${departures}`;
}

/** "66.7%" — a percentage the server already rounded. Never recomputed. */
export function percentLabel(value: number): string {
  return `${value}%`;
}

/**
 * What to call a deal nobody owns.
 *
 * The server reports NULL and blank as two rows, because the per-owner
 * aggregate can bind `IS NULL` or `lower(owner_email) = :owner` and not an OR
 * — so folding them there would give a row whose count came from one rule and
 * whose ₹ came from another. Folding them into one WORD is safe and is this
 * layer's job.
 */
export function ownerLabel(email: string | null | undefined): string {
  return (email || "").trim() || "Unassigned";
}

/**
 * "in the last 90 days" — the window the server actually used.
 *
 * Read off the payload rather than hard-coded next to it: two places that must
 * agree about a constant is how a report ends up labelled 30 days while
 * showing 90.
 */
export function windowLabel(days: number): string {
  return `in the last ${days} days`;
}

/**
 * The sentence that explains a zero win rate on a board full of closed deals.
 *
 * Returns null when there is nothing to explain. This is the ONE piece of
 * interpretation the surface offers, and it exists because the alternative —
 * a 0% win rate with no explanation next to 551 closed deals — reads as a
 * broken report rather than as missing data.
 */
export function undatedNotice(report: WinLossReport | null): string | null {
  if (!report || report.closed_without_date <= 0) return null;
  const deals = report.closed_without_date;
  const noun = deals === 1 ? "deal is" : "deals are";
  return (
    `${deals} closed ${noun} outside every window: no close date was ever ` +
    `recorded for them. Imported deals carry none until the pipeline repair ` +
    `stamps one.`
  );
}

/**
 * Has this block anything to say?
 *
 * An empty CRM is a legitimate state that must render as "nothing yet" rather
 * than as a grid of zeros — the same courtesy the board's empty lanes get, in
 * the other direction.
 */
export function hasPipeline(report: PipelineReport | null): boolean {
  return !!report && report.stages.length > 0;
}

export function hasFunnel(report: FunnelReport | null): boolean {
  return !!report && report.deals > 0;
}

export function hasWinLoss(report: WinLossReport | null): boolean {
  return (
    !!report &&
    (report.won > 0 || report.lost > 0 || report.closed_without_date > 0)
  );
}

export function hasOwners(report: OwnerLeaderboard | null): boolean {
  return !!report && report.owners.length > 0;
}

/**
 * The forecast's stages, biggest weighted first.
 *
 * A different order from the board on purpose: the board is a pipeline you
 * walk left to right, and a forecast is a list of where the money is. The
 * server sends them in `position` order, and this never mutates that array —
 * the surface renders both orders from the same payload.
 */
export function byWeight(report: PipelineReport | null): StageTotals[] {
  if (!report) return [];
  return [...report.stages].sort((a, b) => b.weighted - a.weighted);
}

/**
 * The share of the total forecast one lane carries, as a percentage.
 *
 * 0 when the board forecasts nothing, rather than NaN — an empty pipeline is
 * every quarter's first day.
 */
export function shareOfForecast(
  stage: Pick<StageTotals, "weighted">,
  report: Pick<PipelineReport, "weighted">
): number {
  if (!report.weighted) return 0;
  return Math.round((stage.weighted / report.weighted) * 1000) / 10;
}
