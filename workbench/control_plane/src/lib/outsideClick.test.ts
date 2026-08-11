/**
 * WS-27al(2) — the outside-click walker.
 *
 * The whole point of the injected accessor is that this file can exist: the
 * runner is `environment: "node"`, so a walker written against `parentElement`
 * and `closest()` would have no fence at all. The nodes below are plain
 * objects; `domClickWalk` is the one adapter that maps them onto real elements
 * and is the (small, unreachable-from-here) part held by review.
 */

import { describe, expect, it } from "vitest";

import { PREVENT_OUTSIDE_CLICK, type ClickWalk, shouldDismiss } from "./outsideClick";

interface Node {
  name: string;
  parent: Node | null;
  surface?: boolean;
  guarded?: boolean;
}

const walk: ClickWalk<Node> = {
  parent: (n) => n.parent,
  isSurface: (n) => n.surface === true,
  isGuarded: (n) => n.guarded === true,
};

/** `root → … → leaf`, returning the leaf. */
function chain(...nodes: Array<Partial<Node> & { name: string }>): Node {
  let parent: Node | null = null;
  for (const spec of nodes) parent = { parent, ...spec };
  return parent as Node;
}

describe("shouldDismiss", () => {
  it("dismisses a click with nothing of ours above it", () => {
    const leaf = chain({ name: "body" }, { name: "somewhere-else" }, { name: "clicked" });
    expect(shouldDismiss(leaf, walk)).toBe(true);
  });

  it("does not dismiss a click inside the surface", () => {
    const leaf = chain(
      { name: "body" },
      { name: "panel", surface: true },
      { name: "row" },
      { name: "clicked" },
    );
    expect(shouldDismiss(leaf, walk)).toBe(false);
  });

  it("bails when it meets the prevent attribute, however far up", () => {
    // The case the feature exists for: a picker portalled to <body>, so the
    // surface is nowhere on this chain and containment alone says "outside".
    const leaf = chain(
      { name: "body" },
      { name: "portal", guarded: true },
      { name: "calendar" },
      { name: "clicked-day" },
    );
    expect(shouldDismiss(leaf, walk)).toBe(false);
  });

  it("dismisses the SAME chain once the attribute is gone", () => {
    // The paired half. Without it, a walker that returned `false` for
    // everything would pass the test above.
    const leaf = chain(
      { name: "body" },
      { name: "portal" },
      { name: "calendar" },
      { name: "clicked-day" },
    );
    expect(shouldDismiss(leaf, walk)).toBe(true);
  });

  it("checks the clicked node itself, not only its ancestors", () => {
    expect(shouldDismiss(chain({ name: "guarded-leaf", guarded: true }), walk)).toBe(false);
    expect(shouldDismiss(chain({ name: "surface-leaf", surface: true }), walk)).toBe(false);
  });

  it("dismisses nothing on an event with no target", () => {
    // A missing target is not evidence the click was outside; closing on it
    // would dismiss the panel for events the app never really saw.
    expect(shouldDismiss(null, walk)).toBe(false);
    expect(shouldDismiss(undefined, walk)).toBe(false);
  });

  it("terminates on a cyclic accessor instead of hanging the tab", () => {
    const loop: Node = { name: "loop", parent: null };
    loop.parent = loop;
    expect(shouldDismiss(loop, walk, 10)).toBe(true);
  });

  it("names the attribute the DOM adapter looks for", () => {
    // Consumed by whatever portals itself out of a popover; a rename here is a
    // silent un-guarding of every one of them.
    expect(PREVENT_OUTSIDE_CLICK).toBe("data-prevent-outside-click");
  });
});
