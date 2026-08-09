/**
 * Projects · lifecycle policy helpers (WS-27z).
 *
 * Two small pure functions, kept out of the components so they are testable
 * without a DOM:
 *
 * - `isAutomated` — the one predicate the timeline renders automated entries
 *   distinctly by. It reads `meta.automation`, the flag every write made by
 *   the `/workflows` engine (the lifecycle sweep, `pm_task` nodes) carries;
 *   human writes never do.
 * - `parseMonths` — the settings dialog's input contract, mirroring the
 *   gateway's validation (a whole number of months > 0, or empty = the
 *   policy is off) so a bad value is refused before the request instead of
 *   round-tripping for a 422.
 */

/** Whether one timeline row was written by an automation. */
export function isAutomated(activity: {
  meta?: Record<string, unknown> | null;
}): boolean {
  return Boolean(activity.meta?.automation);
}

export type MonthsParse =
  | { ok: true; value: number | null }
  | { ok: false; reason: string };

/** A months input box → the PATCH value (`null` = off), or a refusal. */
export function parseMonths(input: string): MonthsParse {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: true, value: null };
  // `Number` alone accepts "1e2" and ""; the regex pins plain digits so the
  // browser refuses exactly what the gateway would.
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, reason: "Months must be a whole number." };
  }
  const value = Number(trimmed);
  if (value <= 0) {
    return {
      ok: false,
      reason: "Months must be greater than zero — leave it empty to turn the policy off.",
    };
  }
  return { ok: true, value };
}
