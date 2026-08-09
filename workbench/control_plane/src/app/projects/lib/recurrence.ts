/**
 * Projects · the repeat rule in the browser (WS-27o).
 *
 * The gateway owns the date arithmetic — `routes/projects/recurrence.py`, where
 * January 31st and February 29th are decided — and this file owns saying what a
 * rule MEANS before somebody commits to it.
 *
 * **A rule is easier to get wrong than to read back.** "Every 2, weekly, [1,4],
 * anchor due" is a shape; "Every 2 weeks on Mon, Thu — keeping to the schedule"
 * is a sentence somebody can check. Building that sentence is most of what is
 * here, and it is a pure function so the awkward pluralisations have tests.
 */

export type Freq = "daily" | "weekly" | "monthly" | "yearly";
export type Anchor = "due" | "completed";

/** Mirrors the gateway's `FREQS`. */
export const FREQS: Freq[] = ["daily", "weekly", "monthly", "yearly"];

/** Mirrors the gateway's `ANCHORS`. */
export const ANCHORS: Anchor[] = ["due", "completed"];

export const MAX_INTERVAL = 365;

export interface Rule {
  id?: string;
  freq: Freq;
  interval: number;
  anchor: Anchor;
  weekdays: number[];
  day_of_month?: number | null;
  month_of_year?: number | null;
  until_at?: string | null;
  max_occurrences?: number | null;
  occurrences_made?: number;
}

/** ISO weekdays: 1 is Monday, matching the gateway and `Date.getDay()+shift`. */
export const WEEKDAY_LABELS: Array<[number, string]> = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
];

const UNIT: Record<Freq, [string, string]> = {
  daily: ["day", "days"],
  weekly: ["week", "weeks"],
  monthly: ["month", "months"],
  yearly: ["year", "years"],
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** `1` → "1st". Used only for a day of the month, so 1–31. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export const emptyRule = (): Rule => ({
  freq: "weekly",
  interval: 1,
  anchor: "due",
  weekdays: [],
});

/**
 * A rule as a sentence.
 *
 * The anchor is spelled out rather than named, because "due" and "completed"
 * are the two words in this feature that a reader cannot guess the meaning of —
 * and choosing the wrong one makes a monthly cadence drift a little later every
 * month until nobody trusts the date.
 */
export function describeRule(rule: Rule): string {
  const [one, many] = UNIT[rule.freq];
  const every =
    rule.interval === 1 ? `Every ${one}` : `Every ${rule.interval} ${many}`;

  let when = every;
  if (rule.freq === "weekly" && rule.weekdays.length) {
    const days = [...rule.weekdays]
      .sort((a, b) => a - b)
      .map((d) => WEEKDAY_LABELS.find(([n]) => n === d)?.[1])
      .filter(Boolean);
    when = `${every} on ${days.join(", ")}`;
  } else if (rule.freq === "monthly" && rule.day_of_month) {
    when = `${every} on the ${ordinal(rule.day_of_month)}`;
  } else if (rule.freq === "yearly" && rule.day_of_month) {
    const month = MONTHS[(rule.month_of_year ?? 1) - 1] ?? "";
    when = `${every} on ${month} ${ordinal(rule.day_of_month)}`.trim();
  }

  const anchor =
    rule.anchor === "due"
      ? "keeping to the schedule"
      : "measured from when it is finished";

  const limits: string[] = [];
  if (rule.max_occurrences) {
    const left = rule.max_occurrences - (rule.occurrences_made ?? 0);
    // The count LEFT, not the cap: "6 times" beside a series that has run five
    // of them reads as five more to come.
    limits.push(`${Math.max(0, left)} more time${left === 1 ? "" : "s"}`);
  }
  if (rule.until_at) {
    const until = new Date(rule.until_at);
    if (!Number.isNaN(until.getTime())) {
      limits.push(`until ${until.toLocaleDateString()}`);
    }
  }

  return `${when}, ${anchor}${limits.length ? `, ${limits.join(", ")}` : ""}.`;
}

/**
 * Why this rule cannot be saved, or `null`.
 *
 * Mirrors the gateway's `validate_rule`. The point is not to replace it — the
 * server is still the authority — but to say so *before* the round trip, since
 * a Save button that can only fail is worse than one that explains itself.
 */
export function ruleProblem(rule: Rule): string | null {
  if (!FREQS.includes(rule.freq)) return "Pick how often it repeats.";
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > MAX_INTERVAL) {
    return `Repeat every 1 to ${MAX_INTERVAL}.`;
  }
  if (rule.freq === "weekly" && rule.weekdays.length === 0) {
    return "Pick at least one day of the week.";
  }
  if ((rule.freq === "monthly" || rule.freq === "yearly") && !rule.day_of_month) {
    return "Pick a day of the month.";
  }
  return null;
}

/** Toggle one weekday, keeping the list sorted so the sentence reads in order. */
export function toggleWeekday(weekdays: number[], day: number): number[] {
  const has = weekdays.includes(day);
  const next = has ? weekdays.filter((d) => d !== day) : [...weekdays, day];
  return next.sort((a, b) => a - b);
}

/**
 * The rule → the request body.
 *
 * Fields the chosen frequency does not use are sent as `null` rather than left
 * off: a rule edited from monthly to weekly must not keep a stale
 * `day_of_month` that would come back the moment somebody switched it again.
 */
export function toPayload(rule: Rule): Record<string, unknown> {
  const choice = rule.freq;
  return {
    freq: choice,
    interval: rule.interval,
    anchor: rule.anchor,
    weekdays: choice === "weekly" ? rule.weekdays : [],
    day_of_month:
      choice === "monthly" || choice === "yearly" ? rule.day_of_month ?? null : null,
    month_of_year: choice === "yearly" ? rule.month_of_year ?? 1 : null,
    until_at: rule.until_at || null,
    max_occurrences: rule.max_occurrences || null,
  };
}
