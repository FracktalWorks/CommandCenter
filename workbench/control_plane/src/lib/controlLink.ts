/**
 * When a real link may be intercepted, and when the browser must be left alone.
 *
 * Spec: `project-docs/specs/project_management_app.md` §9.4.2 · ticket WS-27al(1).
 *
 * A task row on `/projects` opens a docked panel rather than navigating, so it
 * has always been a bare `onClick`. That is the one interaction the whole
 * machine agrees on and this app got wrong: cmd/ctrl-click, shift-click and
 * middle-click open a new tab or window everywhere else, and here they did
 * nothing at all — `/projects` carries **zero** `<a href>`. `ControlLink` fixes
 * that by being a genuine anchor and *taking the plain click back*; this module
 * is the single rule for which clicks it may take.
 *
 * Pure and framework-free on purpose. `vitest.config.ts` runs `environment:
 * "node"` over `src/**\/*.test.ts` — no DOM, and `.tsx` tests are not even
 * collected — so a decision left inside the component would have no fence at
 * all. Here it is a plain function over a plain shape.
 */

/**
 * The part of a mouse event this decision reads.
 *
 * Structural rather than `React.MouseEvent`, so the test can hand it an object
 * literal. A React synthetic event satisfies it as-is.
 */
export interface ClickModifiers {
  /** 0 = primary/left, 1 = middle/auxiliary, 2 = secondary/right. */
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  /** Somebody upstream already handled this click. */
  defaultPrevented?: boolean;
}

/**
 * True when the app may swallow this click and open its own panel instead.
 *
 * False for every click the operating system has an opinion about:
 *
 * - **`button !== 0`** — middle-click is "open in a background tab" on every
 *   platform. ⚠️ Our upstream reference exempts `metaKey`/`ctrlKey` **only**
 *   and misses exactly this case (§9.6's `control-link.tsx` row), which is why
 *   `controlLink.test.ts` asserts `button === 1` by name. React only routes the
 *   primary button to `onClick` today, so this arm is belt-and-braces — but it
 *   is the arm that a future `onAuxClick` caller depends on, and it costs one
 *   comparison.
 * - **meta / ctrl** — new tab (macOS / Windows-Linux respectively).
 * - **shift** — new window.
 * - **alt** — download the target on most browsers.
 * - **`defaultPrevented`** — a nested control (a checkbox, a disclosure
 *   chevron) already claimed the click; re-handling it here would run two
 *   actions from one press.
 */
export function shouldIntercept(event: ClickModifiers): boolean {
  if (event.defaultPrevented) return false;
  if ((event.button ?? 0) !== 0) return false;
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}
