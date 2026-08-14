/**
 * People Center · the working week's pure half (WS-28p).
 *
 * Spec: `project-docs/specs/people_center_app.md` §3.4a, §5.11.
 *
 * Formatting and diffing only. **The layering is the server's** — the effective
 * schedule and the contracted hours arrive computed, with a `source` map naming
 * which layer decided each field, and nothing here recombines them. A second
 * implementation of "policy + override" in TypeScript would be a second answer
 * to how many hours somebody works, and it would drift silently.
 */

export interface WorkPolicy {
  working_days: number[];
  hours_per_day: number;
  start?: string | null;
  end?: string | null;
  week_start?: number;
  default_timezone?: string;
  shifts?: Array<{ name: string; start?: string; end?: string; days?: number[] }>;
  holidays?: string[];
}

/** The server's answer for one person. `source` says who decided each field. */
export interface EffectiveSchedule {
  days: number[];
  hours_per_day: number;
  start?: string | null;
  end?: string | null;
  timezone?: string | null;
  shift?: string | null;
  fraction: number;
  source: Record<string, "org" | "person">;
}

export interface PolicyImpact {
  changed: number;
  unchanged: number;
  examples: Array<{ id: string; name: string; before: number; after: number }>;
  hours_before: number;
  hours_after: number;
}

/** ISO day numbers, so 1 is Monday everywhere — the server's convention. */
export const DAY_NAMES: readonly string[] = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
];

export function dayName(iso: number): string {
  return DAY_NAMES[iso - 1] ?? String(iso);
}

/**
 * `[1,2,3,4,5]` → `"Mon–Fri"`, `[1,3,5]` → `"Mon, Wed, Fri"`.
 *
 * Ranges are collapsed because "Mon, Tue, Wed, Thu, Fri" is the same fact
 * spelled in a way nobody reads.
 */
export function formatDays(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 0) return "no working days";
  if (sorted.length === 7) return "every day";
  const runs: number[][] = [];
  for (const day of sorted) {
    const last = runs[runs.length - 1];
    if (last && day === last[last.length - 1] + 1) last.push(day);
    else runs.push([day]);
  }
  return runs
    .map((run) =>
      run.length >= 3
        ? `${dayName(run[0])}–${dayName(run[run.length - 1])}`
        : run.map(dayName).join(", ")
    )
    .join(", ");
}

/** A one-line summary of a schedule, in the order somebody asks it. */
export function describeSchedule(schedule: EffectiveSchedule | null): string {
  if (!schedule) return "—";
  const parts = [formatDays(schedule.days)];
  if (schedule.start && schedule.end) {
    parts.push(`${schedule.start}–${schedule.end}`);
  }
  parts.push(`${schedule.hours_per_day}h/day`);
  if (schedule.fraction !== 1) {
    parts.push(`${Math.round(schedule.fraction * 100)}% time`);
  }
  if (schedule.shift) parts.push(`${schedule.shift} shift`);
  return parts.join(" · ");
}

/**
 * Which fields this person overrode, in the order the panels show them.
 *
 * Read straight off the server's `source` map rather than compared here: the
 * client has the override and the policy and could diff them, and doing so
 * would be the second implementation this module exists to avoid.
 */
export function overriddenFields(
  schedule: EffectiveSchedule | null
): string[] {
  if (!schedule?.source) return [];
  return Object.entries(schedule.source)
    .filter(([, layer]) => layer === "person")
    .map(([field]) => field)
    .sort();
}

/** `40` → `"40h"`, `37.5` → `"37.5h"`. No trailing `.0`. */
export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return "—";
  return `${Number.isInteger(hours) ? hours : hours.toFixed(2).replace(/0+$/, "")}h`;
}

/**
 * The sentence an admin reads before agreeing to move everybody's capacity.
 *
 * Deliberately leads with **who moves**, not with the roster size: "45 people"
 * is true and useless, and a settings page that silently re-baselines every
 * load bar is one nobody trusts twice.
 */
export function describeImpact(impact: PolicyImpact | null): string {
  if (!impact) return "";
  if (impact.changed === 0) {
    return "Nobody's contracted hours change.";
  }
  const who =
    impact.changed === 1 ? "1 person's" : `${impact.changed} people's`;
  return (
    `${who} contracted hours change ` +
    `(${formatHours(impact.hours_before)} → ${formatHours(impact.hours_after)} ` +
    `for anyone on the company default). ${impact.unchanged} unchanged.`
  );
}

/** Is this policy different from what is stored? Drives the save button. */
export function policyChanged(draft: WorkPolicy, saved: WorkPolicy): boolean {
  return JSON.stringify(normalise(draft)) !== JSON.stringify(normalise(saved));
}

function normalise(policy: WorkPolicy): WorkPolicy {
  return {
    ...policy,
    working_days: [...new Set(policy.working_days ?? [])].sort((a, b) => a - b),
    shifts: policy.shifts ?? [],
    holidays: [...(policy.holidays ?? [])].sort(),
  };
}
