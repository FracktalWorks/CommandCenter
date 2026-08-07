/**
 * CSS generation.
 *
 * These assertions encode the two properties the whole engine rests on:
 * the generated scopes must outrank the fallback layer in `globals.css`, and
 * a theme's light mode must outrank its own dark mode. Get either wrong and
 * themes appear to "not apply" in ways that are painful to debug from the
 * browser, so they are pinned here instead.
 */

import { describe, expect, it } from "vitest";

import { buildAllThemesCss, buildThemeCss, isSafeColor } from "./css";
import { THEMES, resolveTheme } from "./themes";
import type { Theme } from "./types";

const rapidtool = resolveTheme("rapidtool");

describe("buildThemeCss", () => {
  it("scopes tokens under html[data-theme] so they outrank the :root fallback", () => {
    const css = buildThemeCss(rapidtool);
    // `html[data-theme=…]` is (0,1,1); `:root` and `.light` in globals.css are
    // (0,1,0). The `html` qualifier is what makes generated themes win
    // regardless of stylesheet order.
    expect(css).toContain('html[data-theme="rapidtool"] {');
    expect(css).toContain('html[data-theme="rapidtool"].light {');
  });

  it("emits dark tokens on the base scope and light tokens on the .light scope", () => {
    const css = buildThemeCss(rapidtool);
    const darkStart = css.indexOf('html[data-theme="rapidtool"] {');
    const lightStart = css.indexOf('html[data-theme="rapidtool"].light {');
    const darkBlock = css.slice(darkStart, lightStart);
    const lightBlock = css.slice(lightStart);

    expect(darkBlock).toContain(`--background: ${rapidtool.colors.dark.background};`);
    expect(lightBlock).toContain(`--background: ${rapidtool.colors.light.background};`);
  });

  it("puts structural tokens only on the base scope, so light inherits them", () => {
    const css = buildThemeCss(rapidtool);
    const lightStart = css.indexOf('html[data-theme="rapidtool"].light {');
    const lightBlock = css.slice(lightStart);

    // Shape, typography and effects do not vary by mode. Emitting them twice
    // would double the payload and invite the two copies to disagree.
    expect(lightBlock).not.toContain("--radius:");
    expect(lightBlock).not.toContain("--font-app:");
    expect(lightBlock).not.toContain("--glass-blur:");
    expect(css).toContain(`--radius: ${rapidtool.shape.radius};`);
  });

  it("fills unset sidebar tokens from the matching core token", () => {
    const theme: Theme = {
      ...rapidtool,
      id: "fixture",
      colors: {
        dark: { ...rapidtool.colors.dark, sidebarBackground: undefined, sidebarAccent: undefined },
        light: rapidtool.colors.light,
      },
    };
    const css = buildThemeCss(theme);
    const darkBlock = css.slice(0, css.indexOf(".light {"));

    expect(darkBlock).toContain(`--sidebar-background: ${rapidtool.colors.dark.background};`);
    expect(darkBlock).toContain(`--sidebar-accent: ${rapidtool.colors.dark.secondary};`);
  });

  it("rejects theme ids that would need escaping in a selector", () => {
    for (const id of ['a"b', "a b", "a.b", "A", "-lead", "a{b"]) {
      expect(() => buildThemeCss({ ...rapidtool, id })).toThrow(/Invalid theme id/);
    }
  });
});

describe("buildAllThemesCss", () => {
  const css = buildAllThemesCss();

  it("emits a scope pair for every registered theme", () => {
    for (const theme of THEMES) {
      expect(css).toContain(`html[data-theme="${theme.id}"] {`);
      expect(css).toContain(`html[data-theme="${theme.id}"].light {`);
    }
  });

  it("orders each theme's light scope after its dark scope", () => {
    // Equal-specificity ties are broken by source order, so a light block that
    // preceded its dark block would never take effect.
    for (const theme of THEMES) {
      expect(css.indexOf(`html[data-theme="${theme.id}"] {`)).toBeLessThan(
        css.indexOf(`html[data-theme="${theme.id}"].light {`),
      );
    }
  });

  it("stays small enough to inline in every document", () => {
    // Inlining is what makes switching instant; if this ever grows past a few
    // tens of KB the design should move to a fetched stylesheet instead.
    expect(css.length).toBeLessThan(64_000);
  });
});

describe("isSafeColor", () => {
  it("accepts ordinary colour literals", () => {
    for (const value of [
      "#fff",
      "#0078d4",
      "#0078d4ff",
      "rebeccapurple",
      "hsl(206 100% 42%)",
      "rgb(0, 120, 212)",
      "rgba(0,120,212,0.5)",
      "oklch(0.7 0.15 250)",
    ]) {
      expect(isSafeColor(value), value).toBe(true);
    }
  });

  it("rejects anything that could escape the declaration", () => {
    for (const value of [
      "red; background: url(https://evil.test/x)",
      "url(https://evil.test/x)",
      "}",
      "var(--primary)",
      "expression(alert(1))",
      "",
      "   ",
      "#".repeat(80),
    ]) {
      expect(isSafeColor(value), value).toBe(false);
    }
  });
});
