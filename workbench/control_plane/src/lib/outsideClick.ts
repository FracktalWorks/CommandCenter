/**
 * Whether a click landed far enough away to dismiss a popover.
 *
 * Spec: `project-docs/specs/project_management_app.md` §9.4.2 · ticket WS-27al(2).
 *
 * The ordinary case is `surface.contains(event.target)`, and every popover in
 * this app writes it by hand. It breaks the moment a control inside the popover
 * renders somewhere else in the DOM — a date picker or a menu portalled to
 * `<body>` is, by containment, *outside* the popover that raised it, so picking
 * a date closes the thing you were picking it for.
 *
 * The fix is a marker rather than ref plumbing between components that do not
 * know each other: a portalled element carries
 * {@link PREVENT_OUTSIDE_CLICK}, and the walker climbing from the event target
 * bails when it meets one.
 *
 * ⚠️ **Honest scope.** `/projects` has no portalled picker today — the one real
 * consumer is `NotificationBell`, whose panel is a normal child, so the
 * attribute currently guards nothing. This exists ahead of the need because
 * Wave 2's Modal / Tooltip / Combobox create that case immediately and it is
 * cheaper to have one answer waiting than three hand-rolled ones arriving.
 *
 * ## Why it walks an injected accessor and not an `Element`
 *
 * `vitest.config.ts` is `environment: "node"`: there is no `Element`, no
 * `parentElement`, no `closest`. A walker written against the DOM directly
 * could not be tested here at all, and an untested walker is a rule with no
 * fence (R7). So the climb is generic over a node type `N` and the DOM is one
 * adapter — {@link domClickWalk} — which is small enough to read.
 */

/** The attribute a portalled child carries to stay "inside" its opener. */
export const PREVENT_OUTSIDE_CLICK = "data-prevent-outside-click";

/** Everything {@link shouldDismiss} needs to know about a node. */
export interface ClickWalk<N> {
  /** The next node up, or `null` at the root. */
  parent: (node: N) => N | null;
  /** True when this node *is* the popover being dismissed. */
  isSurface: (node: N) => boolean;
  /** True when this node carries {@link PREVENT_OUTSIDE_CLICK}. */
  isGuarded: (node: N) => boolean;
}

/**
 * Climb from the clicked node; dismiss only if nothing on the way up objects.
 *
 * Meeting the surface means the click was inside it. Meeting a guarded node
 * means it belongs to the surface even though the DOM says otherwise. Running
 * out of ancestors means it really was outside.
 *
 * `limit` is a cycle guard, not a depth policy: a real DOM cannot loop, but an
 * injected accessor can, and a popover that hangs the tab is a worse bug than
 * one that fails to close.
 */
export function shouldDismiss<N>(
  target: N | null | undefined,
  walk: ClickWalk<N>,
  limit = 1000,
): boolean {
  let node: N | null = target ?? null;
  for (let steps = 0; node !== null && steps < limit; steps++) {
    if (walk.isSurface(node) || walk.isGuarded(node)) return false;
    node = walk.parent(node);
  }
  // A click with no target at all (`null`) is not evidence of anything, and
  // dismissing on it would close the panel on events the app never saw.
  return target != null;
}

/**
 * The DOM adapter: climb `parentElement`, compare against the surface node.
 *
 * Identity against `surface` rather than `surface.contains(node)` — walking
 * every ancestor makes the two equivalent, and identity has no second way to be
 * wrong. A `null` surface (the ref has not attached yet) simply never matches,
 * so the click is treated as outside.
 */
export function domClickWalk(surface: Element | null): ClickWalk<Element> {
  return {
    parent: (node) => node.parentElement,
    isSurface: (node) => surface !== null && node === surface,
    isGuarded: (node) => node.hasAttribute(PREVENT_OUTSIDE_CLICK),
  };
}
