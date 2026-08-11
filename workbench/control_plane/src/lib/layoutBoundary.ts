/**
 * The error boundary's arithmetic, kept out of the component (WS-27am item 3).
 *
 * `components/LayoutBoundary.tsx` is the React half; everything that can be
 * decided without a DOM lives here, because vitest in this tree is node-env and
 * `include` is `src/**\/*.test.ts` — a `.tsx` test is not even collected. So the
 * only part of a boundary that CAN be fenced is the part that is pure, and this
 * module exists to make that part as large as honestly possible.
 *
 * ## The one rule this file encodes
 *
 * **Retry re-mounts by bumping a key. It never clears a flag and re-renders the
 * same subtree.** The two look identical in a diff and behave identically until
 * something below the boundary survives the re-render — a memo, a ref, a
 * component React chose to reconcile rather than replace — at which point the
 * flag-clearing version renders the broken thing again and re-crashes before the
 * user's finger leaves the button. `attempt` is that key: strictly monotone,
 * never re-used, and the value React reconciles the guarded subtree by.
 *
 * `caught()` therefore returns **only** `error` — deliberately not a whole
 * state. It is `getDerivedStateFromError`, whose return value React *merges*, so
 * an `attempt` in it would reset the key on every crash and quietly turn a
 * key-bump back into a flag-clear. `layoutBoundary.test.ts` asserts the key is
 * absent for exactly that reason.
 */

/** What the boundary knows: whether it is broken, and which mount it is on. */
export interface BoundaryState {
  /** The error blanking this subtree, or `null` while it is healthy. */
  error: Error | null;
  /**
   * The guarded subtree's `key`. Starts at 0 and only ever goes up — every
   * retry is a mount React has never seen before.
   */
  attempt: number;
}

/** A fresh boundary. A function, not a shared const: state is per instance. */
export function clean(): BoundaryState {
  return { error: null, attempt: 0 };
}

/**
 * The patch `getDerivedStateFromError` returns.
 *
 * Only `error` — see the header. A thrown non-`Error` (a string, a rejected
 * value, `undefined` from a badly-written throw) is normalised here so the
 * fallback always has something real to render and `componentDidCatch` always
 * has a stack to log.
 */
export function caught(error: unknown): Pick<BoundaryState, "error"> {
  return { error: error instanceof Error ? error : new Error(String(error)) };
}

/**
 * Retry: clear the error AND take a key nobody has rendered under.
 *
 * Called on a healthy boundary it still advances the key, because the only
 * caller is the fallback's button and "re-mount whatever is under me" is a
 * coherent thing to ask for either way. What it must never do is return
 * `attempt` unchanged.
 */
export function retry(state: BoundaryState): BoundaryState {
  return { error: null, attempt: state.attempt + 1 };
}

/**
 * One line for the fallback to show under the heading.
 *
 * The message, not the stack: the stack goes to the console via
 * `componentDidCatch`. An error with an empty message still gets a sentence,
 * because a fallback whose explanation is blank reads as a second failure.
 */
export function describeError(error: Error | null): string {
  const message = error?.message.trim() ?? "";
  return message.length > 0 ? message : "No further detail was reported.";
}
