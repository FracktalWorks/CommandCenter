/**
 * Skeleton arithmetic — the parts of a loading placeholder that are decisions
 * rather than markup.
 *
 * Spec: `project_management_app.md` §9.4.2 item (5), whose acceptance criteria
 * are the four rules below. They live in a `.ts` module rather than inside the
 * component because that is what makes them testable — a placeholder's whole
 * job happens in the 300ms nobody is looking at, and a rule you cannot assert
 * is a rule that quietly stops holding.
 *
 * The component is `src/components/ui/Skeleton.tsx`.
 */

/**
 * A stable pseudo-random number in [0, 1) from an integer seed.
 *
 * ⚠️ **Never `Math.random()`.** §9.4.4 refuses it in a skeleton render BY NAME,
 * and the reason is visible rather than theoretical: React re-renders during
 * loading (a parent state change, a resize, StrictMode's double-invoke), and a
 * random width re-rolls on every one of them. The placeholder then *shimmers
 * shape* — rows visibly changing length under the reader — which is worse than
 * a plain grey block and is the thing people mean when they say skeletons feel
 * cheap.
 *
 * A hash of the row index is stable for that row forever, so the skeleton is
 * still irregular but never moves.
 */
export function seededUnit(seed: number): number {
  // xorshift-ish integer scramble, then normalise. Chosen over `Math.sin(seed)`
  // (the usual one-liner) because that is periodic and adjacent rows come out
  // suspiciously similar, which defeats the irregularity it is there for.
  let x = (seed + 1) * 2654435761;
  x = Math.imul(x ^ (x >>> 15), 2246822507);
  x = Math.imul(x ^ (x >>> 13), 3266489909);
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

/**
 * The width of placeholder row `index`, as a percentage string.
 *
 * Bounded to [min, max] rather than [0, 100]: a 4%-wide bar does not read as a
 * line of text, and a 100%-wide one makes the block look like a solid
 * rectangle. The default band is what a paragraph of real text looks like.
 */
export function rowWidth(index: number, min = 55, max = 95): string {
  if (max < min) [min, max] = [max, min];
  const span = max - min;
  return `${Math.round(min + seededUnit(index) * span)}%`;
}

/**
 * Widths for `count` rows, with the last one short.
 *
 * The short last line is not decoration — it is the single strongest cue that a
 * block is *text*, and without it a stack of equal bars reads as a table and
 * the shape changes when the real content lands.
 */
export function rowWidths(count: number, min = 55, max = 95): string[] {
  if (count <= 0) return [];
  const rows = Array.from({ length: count }, (_, i) => rowWidth(i, min, max));
  if (count > 1) rows[count - 1] = rowWidth(count - 1, 30, 55);
  return rows;
}

/**
 * How long a skeleton must stay once it has appeared, in ms.
 *
 * §9.4.2's fifth criterion. A response that arrives in 80ms would otherwise
 * produce an 80ms flash of grey — perceived as a glitch, not as loading, and
 * the defect that makes teams rip skeletons out again.
 */
export const MIN_VISIBLE_MS = 300;

/**
 * A skeleton should not appear at all for a response this fast.
 *
 * The other half of the same problem: showing a placeholder for a 40ms fetch is
 * worse than showing nothing, because the reader's eye is drawn to a change
 * that carries no information.
 */
export const SHOW_DELAY_MS = 120;

/** What the caller should render right now. */
export type SkeletonPhase = "hidden" | "visible";

/**
 * The min-display state machine, as a pure function of the clock.
 *
 * `startedAt` is when loading began; `settledAt` is when the data arrived, or
 * `null` while still in flight. `now` is passed in rather than read so this is
 * testable and so a list of rows all agree on one instant.
 *
 * Three outcomes, and the middle one is the point:
 *
 *   • still loading, and fast so far      → hidden  (no flash for a quick call)
 *   • still loading, past the delay       → visible
 *   • settled, but shown for < 300ms      → visible (hold it, do not flash)
 *   • settled, and either never shown or  → hidden
 *     shown long enough
 */
export function skeletonPhase(
  startedAt: number,
  settledAt: number | null,
  now: number,
  { showDelay = SHOW_DELAY_MS, minVisible = MIN_VISIBLE_MS } = {},
): SkeletonPhase {
  const shownAt = startedAt + showDelay;
  const everShown = (settledAt ?? now) >= shownAt;

  if (settledAt === null) return now >= shownAt ? "visible" : "hidden";
  // It settled before the delay elapsed — it was never shown, so there is
  // nothing to hold and nothing to flash.
  if (!everShown) return "hidden";
  return now < shownAt + minVisible ? "visible" : "hidden";
}

/**
 * When the caller should next re-render, or `null` when nothing is pending.
 *
 * Returned so a hook can set exactly one timer instead of polling. A skeleton
 * that re-renders on an interval to check whether it may leave is a skeleton
 * that costs more than the content.
 */
export function nextTransitionAt(
  startedAt: number,
  settledAt: number | null,
  now: number,
  { showDelay = SHOW_DELAY_MS, minVisible = MIN_VISIBLE_MS } = {},
): number | null {
  const shownAt = startedAt + showDelay;
  if (settledAt === null) return now < shownAt ? shownAt : null;
  if (settledAt < shownAt) return null;
  const hideAt = shownAt + minVisible;
  return now < hideAt ? hideAt : null;
}
