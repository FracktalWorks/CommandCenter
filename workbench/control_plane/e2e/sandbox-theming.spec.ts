/**
 * The theming engine at the sandbox boundary, in a real browser.
 *
 * Custom Apps, generative-UI cards and React artifacts run in an
 * opaque-origin iframe that inherits *nothing* from us — not our stylesheet,
 * not `data-theme`, not one custom property. Whatever design system they get,
 * we hand across explicitly as the `--cc-*` contract.
 *
 * Unit tests check what `appTokens()` returns. They cannot check the thing that
 * actually decides whether an app looks themed: whether those declarations
 * survive the frame's CSP, resolve against real CSS, and can be *changed* on a
 * document that is already running. This drives the real `buildSrcDoc` and the
 * real `BRIDGE` — importing them rather than mirroring them, because a copy of
 * the frame would happily pass while the frame itself was broken.
 *
 * The regression it exists for is specific and was live until this landed: the
 * `--cc-*` values were hand-written RapidTool literals switching only on
 * light/dark, so every app ever built stayed RapidTool-blue while the shell
 * around it turned Fluent or Material. Nothing errored. It just quietly did not
 * theme.
 */
import { expect, test, type FrameLocator, type Page } from "@playwright/test";

import { BRIDGE, buildSrcDoc } from "../src/lib/theme/sandbox-frame";
import { resolveTheme } from "../src/lib/theme/themes";
import { appTokenMap } from "../src/lib/theme/app-tokens";
import type { ThemeMode } from "../src/lib/theme/types";

/** An app styled the way the agent instructions tell agents to style one. */
const APP = `
<div class="cc-card" id="panel" style="padding:12px">
  <h1 id="title">Orders</h1>
  <p id="hint" style="color:var(--cc-muted)">3 pending</p>
  <span id="chip" style="background:var(--cc-warning);color:var(--cc-warning-fg)">late</span>
  <button class="cc-btn cc-primary" id="go">Go</button>
  <code id="mono" style="font-family:var(--cc-mono)">42</code>
  <span data-cc-icon="Plus" id="ico"></span>
</div>`;

/** Host page with the real frame inside it, reachable as `#f`. */
async function mount(page: Page, themeId: string, mode: ThemeMode = "dark") {
  const srcDoc = buildSrcDoc(APP, resolveTheme(themeId), mode, {
    Plus: '<svg data-pack="lucide"></svg>',
  });
  await page.setContent(
    `<!doctype html><html><body><iframe id="f" sandbox="allow-scripts" ` +
      `style="width:600px;height:400px;border:0" srcdoc="${srcDoc.replace(/"/g, "&quot;")}"></iframe>` +
      `</body></html>`,
  );
  return page.frameLocator("#f");
}

/**
 * Computed value of a `--cc-*` variable, read from INSIDE the frame.
 *
 * It has to be read from inside: the frame is `allow-scripts` without
 * `allow-same-origin`, so its origin is opaque and `contentDocument` is null to
 * us. That is the security property the whole sandbox rests on, and it is worth
 * bumping into here — it is exactly why the tokens have to be handed across
 * rather than inherited.
 */
const readVar = (frame: FrameLocator, name: string) =>
  frame
    .locator("#panel")
    .evaluate(
      (_el, n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
      name,
    );

test.describe("tokens cross the boundary", () => {
  test("an app styled with tokens renders against the active theme", async ({ page }) => {
    const frame = await mount(page, "rapidtool");
    const t = resolveTheme("rapidtool").colors.dark;

    // The declarations survived the CSP and resolved — the baseline claim
    // everything else here depends on.
    await expect(frame.locator("#title")).toHaveText("Orders");
    expect(await readVar(frame, "--cc-primary")).toBe(t.primary);
    expect(await readVar(frame, "--cc-card")).toBe(t.card);
  });

  test("switching theme changes what the app looks like", async ({ page }) => {
    // THE regression. Before this, both of these were the same RapidTool blue.
    const rapid = await readVar(await mount(page, "rapidtool"), "--cc-primary");
    const material = await readVar(await mount(page, "material"), "--cc-primary");
    expect(material).not.toBe(rapid);
  });

  test("control personality crosses, not just colour", async ({ page }) => {
    // An app built a year ago should pick up Material's pill buttons from a
    // theme switch. Colour alone would make it "RapidTool with Material's
    // palette", which is not the same product.
    const material = await mount(page, "material");
    expect(await readVar(material, "--cc-button-radius")).toBe("9999px");
    expect(await readVar(material, "--cc-control-state-layer")).toBe("0.08");
    const graphite = await mount(page, "graphite");
    expect(await readVar(graphite, "--cc-control-label-transform")).toBe("uppercase");
  });

  test("ink on a coloured fill is legible on every theme", async ({ page }) => {
    // Was hardcoded `hsl(20 14% 12%)`, i.e. near-black, which is only legible
    // over a YELLOW warning. A theme with a dark warning rendered black on dark.
    for (const id of ["rapidtool", "fluent", "material", "graphite"]) {
      const frame = await mount(page, id);
      const fill = await readVar(frame, "--cc-warning");
      const ink = await readVar(frame, "--cc-warning-fg");
      expect(ink, id).toBeTruthy();
      expect(ink, id).not.toBe(fill);
    }
  });

  test("the font stack resolves rather than collapsing to nothing", async ({ page }) => {
    // Theme manifests write `var(--font-geist-sans), …` — a next/font handle
    // registered on OUR <html> and undefined in here. An unresolvable var()
    // invalidates the whole font-family, so exporting it verbatim gave apps no
    // themed font at all, silently.
    const frame = await mount(page, "fluent");
    const font = await frame.locator("#mono").evaluate((el) => getComputedStyle(el).fontFamily);
    expect(font).not.toBe("");
    expect(font).not.toContain("var(");
    expect(font.toLowerCase()).toContain("cascadia");
  });

  test("light mode swaps colour without disturbing the theme's shape", async ({ page }) => {
    const dark = await mount(page, "material", "dark");
    const darkBg = await readVar(dark, "--cc-bg");
    const radius = await readVar(dark, "--cc-button-radius");
    const light = await mount(page, "material", "light");
    expect(await readVar(light, "--cc-bg")).not.toBe(darkBg);
    expect(await readVar(light, "--cc-button-radius")).toBe(radius);
  });
});

test.describe("live theme changes", () => {
  test("a running app restyles without being remounted", async ({ page }) => {
    // Why this must be a patch and not a srcDoc rebuild: a rebuild remounts the
    // document, and a published app would throw away whatever the person had
    // typed into it every time somebody changed theme.
    const frame = await mount(page, "rapidtool");
    const before = await readVar(frame, "--cc-primary");

    // Stand in for user state the app is holding.
    await frame.locator("#title").evaluate((el) => {
      el.setAttribute("data-user-state", "typed-but-unsaved");
    });

    const material = resolveTheme("material");
    await page.evaluate(
      ([vars, icons]) => {
        const win = (document.getElementById("f") as HTMLIFrameElement).contentWindow!;
        win.postMessage({ __cc: true, kind: "theme", mode: "dark", vars, icons }, "*");
      },
      [appTokenMap(material, "dark"), { Plus: '<svg data-pack="material"></svg>' }] as const,
    );

    await expect
      .poll(() => readVar(frame, "--cc-primary"))
      .toBe(material.colors.dark.primary);
    expect(await readVar(frame, "--cc-primary")).not.toBe(before);

    // The document was never rebuilt, so the state is still there.
    await expect(frame.locator("#title")).toHaveAttribute(
      "data-user-state",
      "typed-but-unsaved",
    );
  });

  test("icon placeholders re-resolve to the new pack", async ({ page }) => {
    const frame = await mount(page, "rapidtool");
    await expect(frame.locator("#ico svg")).toHaveAttribute("data-pack", "lucide");

    await page.evaluate(() => {
      const win = (document.getElementById("f") as HTMLIFrameElement).contentWindow!;
      win.postMessage(
        {
          __cc: true,
          kind: "theme",
          mode: "dark",
          vars: {},
          icons: { Plus: '<svg data-pack="material"></svg>' },
        },
        "*",
      );
    });

    await expect(frame.locator("#ico svg")).toHaveAttribute("data-pack", "material");
  });

  test("the patch cannot write outside the --cc-* namespace", async ({ page }) => {
    // A sibling frame that got a handle to this window should at worst be able
    // to recolour it — not reach other properties, and not break out of the
    // declaration (setProperty is a value API, so a ';' is rejected, not parsed).
    const frame = await mount(page, "rapidtool");
    await page.evaluate(() => {
      const win = (document.getElementById("f") as HTMLIFrameElement).contentWindow!;
      win.postMessage(
        {
          __cc: true,
          kind: "theme",
          vars: { "--evil": "red", "--cc-primary": "rgb(1, 2, 3); --evil2: red" },
        },
        "*",
      );
    });

    await expect.poll(() => readVar(frame, "--evil")).toBe("");
    expect(await readVar(frame, "--evil2")).toBe("");
  });

  test("a message that is not ours is ignored", async ({ page }) => {
    const frame = await mount(page, "rapidtool");
    const before = await readVar(frame, "--cc-primary");
    await page.evaluate(() => {
      const win = (document.getElementById("f") as HTMLIFrameElement).contentWindow!;
      win.postMessage({ kind: "theme", vars: { "--cc-primary": "red" } }, "*");
      win.postMessage("theme", "*");
    });
    expect(await readVar(frame, "--cc-primary")).toBe(before);
  });
});

test("the bridge ships the theme listener", () => {
  // Cheap guard on the thing every test above depends on: if the listener is
  // ever dropped from BRIDGE, the frame stops responding to theme changes and
  // the only symptom is an app that needs a reload to restyle.
  expect(BRIDGE).toContain('d.kind !== "theme"');
});
