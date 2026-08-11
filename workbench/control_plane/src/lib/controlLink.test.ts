/**
 * WS-27al(1) — the fences for `ControlLink`.
 *
 * Two halves, and they fail for different reasons:
 *
 * 1. **The decision** — `shouldIntercept`, asserted case by case. The one that
 *    earns its keep is middle-click: our upstream reference
 *    (`packages/ui/src/control-link/control-link.tsx`, §9.6) exempts
 *    `metaKey`/`ctrlKey` only and silently swallows `button === 1`, so this is
 *    the case a reimplementation is most likely to lose.
 * 2. **The wiring** — that the two table surfaces really render it. Following
 *    `sharedTaskUi.test.ts`'s "wired, not merely imported" idiom: a source scan,
 *    because `vitest.config.ts` is `environment: "node"` and `.tsx` tests are
 *    not collected, so there is no way to render anything here. What this can
 *    prove is that the wiring exists; what it cannot prove is that a cmd-click
 *    opens a second tab. **That half is review-only in this tree** — there is
 *    no DOM, no browser and no e2e runner — and it is stated rather than faked.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { shouldIntercept } from "./controlLink";

describe("shouldIntercept", () => {
  it("takes a plain left-click", () => {
    expect(shouldIntercept({ button: 0 })).toBe(true);
    // An event that names no button at all is a primary click (React's
    // `onClick` only fires for one) — the default must not be "leave it alone",
    // or the panel would stop opening entirely.
    expect(shouldIntercept({})).toBe(true);
  });

  it.each([
    ["metaKey", { metaKey: true }],
    ["ctrlKey", { ctrlKey: true }],
    ["shiftKey", { shiftKey: true }],
    ["altKey", { altKey: true }],
  ])("leaves a %s click to the browser", (_name, mods) => {
    expect(shouldIntercept({ button: 0, ...mods })).toBe(false);
  });

  it("leaves a MIDDLE click to the browser", () => {
    // Asserted by name, not folded into the table above: middle-click is
    // "open in a background tab" on every platform, and it is exactly the case
    // the upstream implementation this was read from does not exempt.
    expect(shouldIntercept({ button: 1 })).toBe(false);
  });

  it("leaves a right-click alone", () => {
    expect(shouldIntercept({ button: 2 })).toBe(false);
  });

  it("does not re-handle a click something else already claimed", () => {
    // A checkbox or a disclosure chevron nested in the same cell calls
    // `preventDefault`; running the row action too would be two actions from
    // one press.
    expect(shouldIntercept({ button: 0, defaultPrevented: true })).toBe(false);
  });

  it("still refuses a modified click that also carries a non-primary button", () => {
    expect(shouldIntercept({ button: 1, metaKey: true })).toBe(false);
  });
});

/**
 * Rooted at `src/` via `import.meta.url`, never the process cwd — the same
 * reason `sharedTaskUi.test.ts` gives: a checkout with agent worktrees under
 * `.claude/worktrees/` would otherwise scan itself.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Source with comments stripped, so the prose about a change cannot pass for it. */
const code = (rel: string) =>
  readFileSync(join(SRC, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<![:"'/])\/\/[^\n]*/g, "");

describe("ControlLink is wired, not merely imported", () => {
  const SURFACES = [
    "app/projects/components/TaskList.tsx",
    "app/projects/components/TableView.tsx",
  ];

  it.each(SURFACES)("%s imports it", (file) => {
    expect(
      /import\s*\{[^}]*\bControlLink\b[^}]*\}\s*from\s*["']@\/components\/ControlLink["']/.test(
        code(file),
      ),
      `${file} no longer imports ControlLink — either the task title stopped ` +
        "being a real link (the regression this exists for) or the seam moved.",
    ).toBe(true);
  });

  it.each(SURFACES)("%s actually renders it", (file) => {
    // The import half alone passes for a file that imports and never uses —
    // which is the shape a half-finished revert leaves behind.
    expect(/<ControlLink\b/.test(code(file)), `${file} imports ControlLink but renders none.`).toBe(
      true,
    );
  });

  it.each(SURFACES)("%s gives it a real href and a plain-click action", (file) => {
    // A `ControlLink` without `href` is a div with extra steps; one without
    // `onActivate` navigates away from the docked panel on every click.
    const text = code(file);
    expect(/<ControlLink\b[\s\S]{0,400}?\bhref=/.test(text)).toBe(true);
    expect(/<ControlLink\b[\s\S]{0,400}?\bonActivate=/.test(text)).toBe(true);
  });

  it("the component itself defers to the tested decision", () => {
    // Otherwise the modifier rules above fence a function nothing calls.
    expect(/shouldIntercept\(/.test(code("components/ControlLink.tsx"))).toBe(true);
  });
});
