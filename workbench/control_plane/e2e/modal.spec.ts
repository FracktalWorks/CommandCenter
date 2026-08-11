import { expect, test, type Page } from "@playwright/test";

/**
 * `Modal` — the dialog primitive, in a real browser (WS-27ak item 1, D-PM-21).
 *
 * ## Why this file is Playwright and not vitest
 *
 * Every property below is a property of *layout, focus order and event
 * sequencing*. `vitest.config.ts` here is `environment: "node"` and collects
 * only `src/**‍/*.test.ts`, so a React component is not rendered by any test in
 * this repo at all; and jsdom — the cheaper-looking alternative D-PM-21
 * rejected — has **no layout engine**, so scroll-lock compensation, real Tab
 * order and a press that starts inside and ends outside are all unobservable
 * under it. Those are exactly the behaviours most likely to be silently wrong,
 * which is the whole argument.
 *
 * ## The harness, and why it needs nothing
 *
 * `/projects` renders with **no auth and no API mocking** — the gateway is not
 * running here, so the board renders its empty/error state and every keyboard
 * path still works. `?` opens the shortcuts sheet and `⌘K` the search palette,
 * so two of the six converted dialogs are reachable from a cold page with zero
 * fixtures.
 *
 * ## What was true before this primitive (measured at `00c47c6b`, same harness)
 *
 *   dialogs: 1 · activeElement after open: **BODY** (focus never moved in) ·
 *   focus inside after 6 Tabs: **false ×6** (no trap — Tab walked the page
 *   behind) · `[inert]` elements: 0 · activeElement after close: **A**, an
 *   arbitrary anchor rather than the opener.
 *
 * Each test below asserts the *after* of one of those.
 *
 * ## Two things this file deliberately does NOT assert, with the reason
 *
 * 1. **A real `inert` attribute.** The ticket says the background must be
 *    "`inert`, not merely covered". `@base-ui/react@1.7.0` does not set one:
 *    `floating-ui-react/components/FloatingFocusManager.mjs:339` calls
 *    `markOthers(…, { ariaHidden: modal })` and **nothing in the package ever
 *    passes `inert: true`** (`markOthers.mjs:147-155` defaults it to `false`).
 *    What it does set is `aria-hidden="true"` plus a `data-base-ui-inert`
 *    marker on the outside elements, and it contains focus with guard nodes.
 *    So a screen reader cannot walk into the background — the half the ticket
 *    argues for — but **find-in-page still can**. That gap is real, it is the
 *    substrate's, and it is recorded in `project-docs/specs/project_management_app.md`
 *    §9.4.2 rather than papered over here. This file asserts what is true.
 * 2. **Scrollbar-width compensation as a non-zero number.** Measured on this
 *    runner: `window.innerWidth - documentElement.clientWidth === 0` with the
 *    page scrolled — headless Chromium draws **overlay** scrollbars, so there
 *    is no gutter to compensate for and the width assertion below cannot fail
 *    from a missing compensation *here*. It is still the assertion that catches
 *    it on a platform with inset scrollbars, and the measurement itself is one
 *    jsdom cannot produce at all.
 */

const DIALOG = '[role="dialog"]';

/** Mark an element as the opener and put focus on it, so "focus returned to
 *  the opener" is checkable by identity rather than by tag name — the pre-fix
 *  measurement returned `A`, which is a tag name that proves nothing. */
async function focusOpener(page: Page) {
  await page.evaluate(() => {
    const el = document.querySelector("button") as HTMLElement | null;
    if (!el) throw new Error("no focusable control on /projects — harness broke");
    el.setAttribute("data-e2e-opener", "1");
    el.focus();
  });
}

async function openShortcuts(page: Page) {
  await focusOpener(page);
  await page.keyboard.press("?");
  await expect(page.locator(DIALOG)).toHaveCount(1);
  await page.waitForTimeout(150);
}

/** Whether focus is inside the popup right now, plus what has it. */
const focusState = (page: Page) =>
  page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const active = document.activeElement;
    return {
      inside: Boolean(dialog && active && dialog.contains(active)),
      tag: active?.tagName ?? "NONE",
      isOpener: active?.getAttribute("data-e2e-opener") === "1",
    };
  });

test.beforeEach(async ({ page }) => {
  await page.goto("/projects");
  await expect(page.locator("button").first()).toBeVisible();
});

test.describe("Modal", () => {
  test("focus moves in on open and returns to the opener on close", async ({ page }) => {
    await openShortcuts(page);
    const open = await focusState(page);
    expect(open.inside, `focus stayed on <${open.tag}> outside the dialog`).toBe(true);
    expect(open.tag).not.toBe("BODY");

    await page.keyboard.press("Escape");
    await expect(page.locator(DIALOG)).toHaveCount(0);
    await page.waitForTimeout(150);
    const closed = await focusState(page);
    // Never `<body>`: focus on the document is focus nowhere, and the next Tab
    // starts the reader at the top of the page they were already inside.
    expect(closed.tag).not.toBe("BODY");
    expect(closed.isOpener, `focus landed on <${closed.tag}>, not the opener`).toBe(true);
  });

  test("Tab wraps at both ends instead of walking into the page behind", async ({ page }) => {
    await openShortcuts(page);
    // Ten is past the end of this dialog's tabbable content — an untrapped
    // dialog is out into the board by the third or fourth.
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(60);
      const at = await focusState(page);
      expect(at.inside, `Tab #${i + 1} left the dialog, onto <${at.tag}>`).toBe(true);
    }
    // And backwards off the front, which is the end everybody forgets.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Shift+Tab");
      await page.waitForTimeout(60);
      const at = await focusState(page);
      expect(at.inside, `Shift+Tab #${i + 1} left the dialog, onto <${at.tag}>`).toBe(true);
    }
  });

  test("the document behind is hidden from assistive tech while open", async ({ page }) => {
    const marked = () =>
      page.evaluate(
        () =>
          [...document.body.children].filter(
            (el) => el.getAttribute("aria-hidden") === "true",
          ).length,
      );
    expect(await marked()).toBe(0);
    await openShortcuts(page);
    // See this file's header, note 1: `aria-hidden`, not a real `inert`.
    expect(await marked(), "nothing outside the dialog was marked").toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(DIALOG)).toHaveCount(0);
    await page.waitForTimeout(150);
    expect(await marked(), "the marking outlived the dialog").toBe(0);
  });

  test("one Escape closes exactly one surface, and the page's own keys stay suppressed", async ({
    page,
  }) => {
    await openShortcuts(page);

    // ⚠️ THE regression this slice exists to prevent. `page.tsx:1039` is a
    // WINDOW keydown listener that returns early on `live.current.overlayOpen`
    // (`:1003`), which is derived from the page's own state. A wrapper that
    // took ownership of open state would break that suppression silently, and
    // `g t` would navigate to /tasks out from under a half-filled form.
    await page.keyboard.press("g");
    await page.keyboard.press("t");
    await page.waitForTimeout(400);
    expect(page.url(), "a `g` sequence navigated while a dialog was up").toContain(
      "/projects",
    );
    await expect(page.locator(DIALOG)).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(page.locator(DIALOG)).toHaveCount(0);
    // One press, one surface: the page is still where it was, so nothing else
    // consumed the same key.
    expect(page.url()).toContain("/projects");

    // And with nothing up, the sequence works again — which is what proves the
    // suppression above was the dialog's doing and not a broken keymap.
    await page.waitForTimeout(200);
    await page.keyboard.press("g");
    await page.keyboard.press("t");
    await page.waitForURL(/\/tasks/, { timeout: 5000 });
  });

  test("outside dismissal needs a press that both starts and ends outside", async ({
    page,
  }) => {
    await openShortcuts(page);
    const popup = page.locator(DIALOG);
    const box = await popup.boundingBox();
    if (!box) throw new Error("dialog has no box");
    const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    // (1) The ticket's own wording: a text selection dragged OUT of the dialog.
    await page.mouse.move(middle.x, middle.y);
    await page.mouse.down();
    await page.mouse.move(4, 4, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    await expect(popup, "a selection dragged out of the dialog closed it").toHaveCount(1);
    // ⚠️ Honest note: this direction does NOT discriminate `intentional` from
    // `sloppy` — measured. Base UI marks the press as having begun inside its
    // own React tree (`useDismiss.mjs:109`) and ignores the resulting click
    // under either setting. Case (2) is the one that tells them apart.

    // (2) The other direction, and the discriminating one: press starts on the
    // backdrop and is released INSIDE the dialog. Under `'sloppy'` the
    // dismissal fires on `pointerdown`, so the dialog is gone before the mouse
    // is even lifted; under `'intentional'` it waits for the release and sees
    // it land inside. Measured both ways on this runner: 1 dialog with the
    // wrapper as written, 0 with `Dialog.Backdrop` removed.
    await page.mouse.move(6, 6);
    await page.mouse.down();
    await page.mouse.move(middle.x, middle.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    await expect(
      popup,
      "a press released inside the dialog closed it — outside press has " +
        "degraded to `sloppy`, i.e. the wrapper stopped rendering a backdrop",
    ).toHaveCount(1);

    // (3) A genuine outside press — down and up both outside — still closes it.
    await page.mouse.click(6, 6);
    await expect(popup).toHaveCount(0);
  });

  test("page scroll is locked while open and free again after, with no shift", async ({
    page,
  }) => {
    // `/projects` fills the viewport and never scrolls the document, so the
    // scroll container is made real here rather than asserted against a page
    // that cannot scroll either way. No `!important`: the primitive's lock is
    // an INLINE style and an `!important` rule here would silently beat it,
    // which is a green test measuring the harness.
    await page.addStyleTag({ content: "html.h-full, body.h-full { height: auto; }" });
    await page.evaluate(() => {
      const tall = document.createElement("div");
      tall.id = "e2e-tall";
      tall.style.height = "4000px";
      document.body.appendChild(tall);
    });
    const metrics = () =>
      page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        bodyWidth: Math.round(document.body.getBoundingClientRect().width),
        scrollY: window.scrollY,
      }));
    await page.waitForTimeout(200);
    const before = await metrics();
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight),
      "the page was not made scrollable — this test would be vacuous",
    ).toBeGreaterThan(2000);

    await openShortcuts(page);
    const open = await metrics();
    // The layout-engine assertion D-PM-21 is about: locking `overflow` without
    // compensating for the scrollbar gutter moves every pixel on the page
    // sideways as the dialog appears. (Overlay scrollbars on this runner mean
    // the gutter is 0 — see this file's header, note 2.)
    expect(open.clientWidth, "the viewport narrowed when the dialog opened").toBe(
      before.clientWidth,
    );
    expect(open.bodyWidth, "the page shifted when the dialog opened").toBe(
      before.bodyWidth,
    );

    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(250);
    expect(
      (await metrics()).scrollY,
      "the page scrolled underneath an open dialog",
    ).toBe(open.scrollY);

    await page.keyboard.press("Escape");
    await expect(page.locator(DIALOG)).toHaveCount(0);
    await page.waitForTimeout(200);
    const after = await metrics();
    expect(after.clientWidth, "the viewport did not come back").toBe(before.clientWidth);
    expect(after.bodyWidth, "the page shifted when the dialog closed").toBe(
      before.bodyWidth,
    );
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(250);
    expect(
      (await metrics()).scrollY,
      "scrolling was never given back",
    ).toBeGreaterThan(0);
  });

  test("the dialog names itself for assistive tech", async ({ page }) => {
    await openShortcuts(page);
    const popup = page.locator(DIALOG);
    await expect(popup).toHaveAttribute("aria-modal", "true");
    // `aria-labelledby` comes from `Dialog.Title`, which the wrapper renders
    // from its `title` prop — so a dialog with a visible heading is named by
    // that heading rather than by a string kept in sync beside it.
    const labelledBy = await popup.getAttribute("aria-labelledby");
    expect(labelledBy, "the dialog has no accessible name").toBeTruthy();
    expect(
      await page.evaluate(
        (id) => document.getElementById(id!)?.textContent?.trim(),
        labelledBy,
      ),
    ).toBe("Keyboard shortcuts");
  });

  test("a second call site behaves the same — ⌘K, no visible title", async ({ page }) => {
    // The palette passes `label` instead of `title`, so its name is an
    // `aria-label` and the wrapper draws no header. Same trap, same lock.
    await focusOpener(page);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.locator(DIALOG)).toHaveCount(1);
    await page.waitForTimeout(200);
    await expect(page.locator(DIALOG)).toHaveAttribute("aria-label", "Search tasks");
    const at = await focusState(page);
    expect(at.inside, `focus stayed on <${at.tag}>`).toBe(true);
    // `initialFocus` aims at the search box, not merely at "first tabbable".
    expect(at.tag).toBe("INPUT");
    await page.keyboard.press("Escape");
    await expect(page.locator(DIALOG)).toHaveCount(0);
    const closed = await focusState(page);
    expect(closed.isOpener, `focus landed on <${closed.tag}>, not the opener`).toBe(true);
  });
});
