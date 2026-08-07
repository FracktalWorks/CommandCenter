import { expect, test, type Page } from "@playwright/test";

import { resolveTheme as resolveThemeForTest } from "../src/lib/theme/themes";

/**
 * The theming engine, end to end.
 *
 * Unit tests cover the manifests and the generated CSS as text. What they
 * cannot check is the part that actually decides whether a theme applies: CSS
 * specificity and cascade order in a real browser. `globals.css` keeps a
 * fallback copy of the default theme at `:root` (0,1,0) and the generated
 * scopes sit at `html[data-theme=…]` (0,1,1) — if that relationship ever
 * inverts, every theme silently stops working while every unit test still
 * passes. These tests read computed style, so they see what the user sees.
 *
 * They also pin the two axes as independent: switching colour mode must not
 * disturb the active theme's shape, type or effects.
 */

const readVar = (page: Page, prop: string) =>
  page.evaluate(
    (p) => getComputedStyle(document.documentElement).getPropertyValue(p).trim(),
    prop,
  );

/** Load the app with a theme already stored, as a returning member would. */
async function loadWithTheme(page: Page, themeId: string, mode: "dark" | "light" = "dark") {
  await page.goto("/");
  await page.evaluate(
    ([t, m]) => {
      localStorage.setItem("cc-theme", t);
      localStorage.setItem("theme", m);
    },
    [themeId, mode],
  );
  await page.goto("/");
}

/** Split the page's glyphs by which library drew them. Lucide self-labels. */
const countGlyphs = (page: Page) =>
  page.evaluate(() => {
    const svgs = [...document.querySelectorAll("svg")];
    return {
      lucide: svgs.filter((s) => s.getAttribute("class")?.includes("lucide")).length,
      themed: svgs.filter((s) => !s.getAttribute("class")?.includes("lucide")).length,
    };
  });

test.describe("theme tokens", () => {
  test("the server renders a theme scope before any script runs", async ({ page }) => {
    await page.goto("/");
    // Without this the first paint would be unstyled for anyone with
    // JavaScript disabled or still loading.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "rapidtool");
    expect(await readVar(page, "--primary")).toBe("hsl(198 89% 50%)");
    expect(await readVar(page, "--radius")).toBe("0.75rem");
  });

  test("a stored theme is applied before first paint", async ({ page }) => {
    await loadWithTheme(page, "material");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "material");
    expect(await readVar(page, "--radius")).toBe("1rem");
  });

  test("an unknown stored theme falls back instead of leaving the app unstyled", async ({
    page,
  }) => {
    await loadWithTheme(page, "theme-that-was-deleted");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "rapidtool");
    expect(await readVar(page, "--primary")).toBe("hsl(198 89% 50%)");
  });

  test("switching theme re-resolves colour, shape and effect tokens together", async ({
    page,
  }) => {
    await loadWithTheme(page, "fluent");
    expect(await readVar(page, "--primary")).toBe("hsl(197 100% 65%)");
    expect(await readVar(page, "--radius")).toBe("0.25rem");
    expect(await readVar(page, "--glass-blur")).toBe("30px");
    // Fluent has no glow; a zero here is what switches `.tech-glow` off.
    expect(await readVar(page, "--glow-strength")).toBe("0");

    await loadWithTheme(page, "material");
    expect(await readVar(page, "--primary")).toBe("hsl(258 100% 87%)");
    expect(await readVar(page, "--radius")).toBe("1rem");
    // Material is flat: depth comes from --elevation, not blur.
    expect(await readVar(page, "--glass-blur")).toBe("0px");
  });

  test("the theme's font stack reaches the body", async ({ page }) => {
    await loadWithTheme(page, "material");
    const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(font).toMatch(/Roboto/i);

    await loadWithTheme(page, "fluent");
    const fluentFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(fluentFont).toContain("Segoe UI");
  });

  test("the whole Tailwind radius scale follows --radius", async ({ page }) => {
    await loadWithTheme(page, "fluent");
    const radii = await page.evaluate(() => {
      const el = document.createElement("div");
      document.body.appendChild(el);
      const at = (cls: string) => {
        el.className = cls;
        return getComputedStyle(el).borderRadius;
      };
      const out = { sm: at("rounded-sm"), lg: at("rounded-lg"), xl: at("rounded-xl") };
      el.remove();
      return out;
    });
    expect(radii.lg).toBe("4px");
    expect(radii.xl).toBe("4px");
    // `rounded-sm` is --radius minus 4px; at Fluent's 0.25rem that is zero,
    // not a negative value the browser would discard.
    expect(radii.sm).toBe("0px");
  });
});

test.describe("colour mode is independent of theme", () => {
  test("light mode swaps colours but keeps the theme's structure", async ({ page }) => {
    await loadWithTheme(page, "fluent", "light");
    // 41%, not Fluent's nominal 42%: white-on-42% measures 4.44:1, just under
    // WCAG AA. See src/lib/theme/contrast.test.ts.
    expect(await readVar(page, "--primary")).toBe("hsl(206 100% 41%)");
    expect(await readVar(page, "--background")).toBe("hsl(0 0% 95%)");
    // Structural tokens live only on the base scope; light inherits them.
    expect(await readVar(page, "--radius")).toBe("0.25rem");

    await loadWithTheme(page, "fluent", "dark");
    expect(await readVar(page, "--primary")).toBe("hsl(197 100% 65%)");
  });
});

test.describe("icon packs", () => {
  test("a lucide theme draws every glyph with lucide", async ({ page }) => {
    await loadWithTheme(page, "rapidtool");
    const glyphs = await countGlyphs(page);
    expect(glyphs.lucide).toBeGreaterThan(20);
    expect(glyphs.themed).toBe(0);
  });

  test("the Fluent theme swaps the chrome onto Fluent System Icons", async ({ page }) => {
    await loadWithTheme(page, "fluent");
    // The pack is a lazily-fetched chunk, so the swap lands a tick after paint.
    await expect
      .poll(async () => (await countGlyphs(page)).themed, { timeout: 15_000 })
      .toBeGreaterThan(20);

    expect((await countGlyphs(page)).lucide).toBe(0);

    const glyph = await page.evaluate(() => {
      const svg = [...document.querySelectorAll("svg")].find(
        (s) => !s.getAttribute("class")?.includes("lucide"),
      );
      return { viewBox: svg?.getAttribute("viewBox"), hasPath: !!svg?.querySelector("path") };
    });
    // Real geometry on Fluent's 20px UI grid — not an empty placeholder svg.
    expect(glyph.hasPath).toBe(true);
    expect(glyph.viewBox).toBe("0 0 20 20");
  });

  test("the Material theme swaps the chrome onto Material Symbols", async ({ page }) => {
    await loadWithTheme(page, "material");
    await expect
      .poll(async () => (await countGlyphs(page)).themed, { timeout: 15_000 })
      .toBeGreaterThan(20);

    const viewBox = await page.evaluate(
      () =>
        [...document.querySelectorAll("svg")]
          .find((s) => !s.getAttribute("class")?.includes("lucide"))
          ?.getAttribute("viewBox"),
    );
    expect(viewBox).toBe("0 0 24 24");
  });

  test("returning to a lucide theme restores lucide glyphs", async ({ page }) => {
    await loadWithTheme(page, "graphite");
    const glyphs = await countGlyphs(page);
    expect(glyphs.lucide).toBeGreaterThan(20);
    expect(glyphs.themed).toBe(0);
  });
});

test.describe("user preferences", () => {
  test("density scales the root font size", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("cc-density", "compact"));
    await page.goto("/");
    // 16px browser default × the compact scale of 0.92.
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
      "14.72px",
    );
  });

  test("an accent override replaces the theme's primary", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("cc-accent", "rgb(255, 0, 0)"));
    await page.goto("/");
    expect(await readVar(page, "--primary")).toBe("rgb(255, 0, 0)");
  });

  test("an accent override brings ink that is legible ON it", async ({ page }) => {
    // Reported 2026-08-07: on Graphite dark the sidebar logo mark rendered a
    // near-black glyph on the red accent badge. The accent replaced `--primary`
    // but not `--primary-foreground`, so the ink stayed the one Graphite chose
    // for its OWN primary — which is near-white, hence near-black ink. Every
    // primary-filled surface had it, not just the logo.
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem("cc-theme", "graphite");
      localStorage.setItem("theme", "dark");
      localStorage.setItem("cc-accent", "hsl(347 77% 50%)");
      localStorage.setItem("cc-accent-ink", "#ffffff");
    });
    await page.goto("/");
    expect(await readVar(page, "--primary")).toBe("hsl(347 77% 50%)");
    expect(await readVar(page, "--primary-foreground")).toBe("#ffffff");
    // The glyph on the primary-filled logo badge, in a real browser.
    const glyph = await page
      .locator("svg.lucide-command")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(glyph).toBe("rgb(255, 255, 255)");
  });

  test("clearing the accent restores the theme's own pairing", async ({ page }) => {
    // The ink must not outlive the accent that justified it.
    await loadWithTheme(page, "graphite", "dark");
    expect(await readVar(page, "--primary-foreground")).toBe(
      resolveThemeForTest("graphite").colors.dark.primaryForeground,
    );
  });

  test("a malformed stored accent is ignored rather than applied", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() =>
      localStorage.setItem("cc-accent", "red; background: url(https://evil.test/x)"),
    );
    await page.goto("/");
    // The boot script writes through setProperty, so the CSSOM rejects the
    // value outright; nothing is injected into the stylesheet.
    expect(await readVar(page, "--primary")).toBe("hsl(198 89% 50%)");
  });
});

test.describe("control personality", () => {
  /**
   * The point of the shared primitives: a theme changes how a control BEHAVES,
   * not just what colour it is. These read computed style off a real button,
   * because none of it is visible to a type-checker and only some of it is
   * expressible as a class.
   */
  const measureButton = (page: Page) =>
    page.evaluate(() => {
      const el = document.createElement("button");
      el.className =
        "cc-control cc-button cc-button-filled bg-primary text-primary-foreground px-3 py-1.5 text-xs";
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      const out = {
        radius: cs.borderTopLeftRadius,
        filledBorder: cs.borderTopWidth,
        weight: cs.fontWeight,
        transform: cs.textTransform,
        hasStateLayer: getComputedStyle(el, "::after").content !== "none",
      };
      el.remove();
      return out;
    });

  test("Material renders pill buttons with a state layer", async ({ page }) => {
    await loadWithTheme(page, "material");
    const b = await measureButton(page);
    expect(b.radius).toBe("9999px");
    expect(b.hasStateLayer).toBe(true);
    // 8% overlay of the foreground colour, M3's hover treatment.
    expect(await readVar(page, "--control-state-layer")).toBe("0.08");
    expect(await readVar(page, "--control-focus-ring")).toBe("3px");
  });

  test("Fluent strokes its solid buttons and weights labels heavier", async ({ page }) => {
    await loadWithTheme(page, "fluent");
    const b = await measureButton(page);
    expect(b.radius).toBe("4px");
    // The 1px stroke is what stops a Fluent button reading as a flat block.
    expect(b.filledBorder).toBe("1px");
    expect(b.weight).toBe("600");
  });

  test("Graphite upper-cases control labels", async ({ page }) => {
    await loadWithTheme(page, "graphite");
    const b = await measureButton(page);
    expect(b.transform).toBe("uppercase");
    expect(b.radius).toBe("2px");
  });

  test("the default theme's buttons are unchanged by the primitives", async ({ page }) => {
    // Adoption must not shift the shipped look: same radius, same weight, no
    // border on a filled button, no state layer.
    await loadWithTheme(page, "rapidtool");
    const b = await measureButton(page);
    expect(b.radius).toBe("12px");
    expect(b.filledBorder).toBe("0px");
    expect(b.weight).toBe("500");
    expect(b.transform).toBe("none");
  });
});
