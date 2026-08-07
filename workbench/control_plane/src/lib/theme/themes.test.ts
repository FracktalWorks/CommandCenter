/**
 * Theme manifest integrity.
 *
 * The load-bearing test here is the drift guard: `globals.css` keeps a copy of
 * the default theme as the no-JavaScript fallback, and a copy that silently
 * disagrees with the manifest is worse than no copy at all — the app would
 * render one set of colours before hydration and a different set after. This
 * parses the stylesheet and fails if the two ever diverge.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DEFAULT_THEME_ID, THEMES, findTheme, resolveTheme } from "./themes";
import { REQUIRED_COLOR_TOKENS } from "./types";
import type { ColorTokens } from "./types";

const GLOBALS = readFileSync(
  fileURLToPath(new URL("../../app/globals.css", import.meta.url)),
  "utf8",
);

/** Custom-property declarations inside the first block matching `selector`. */
function declarationsIn(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`No \`${selector}\` block in globals.css`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const body = css.slice(open + 1, close);

  const out: Record<string, string> = {};
  for (const match of body.matchAll(/^\s*(--[\w-]+)\s*:\s*([^;]+);/gm)) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

/** `cardForeground` → `--card-foreground`. */
function cssVar(token: string): string {
  return `--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

describe("theme registry", () => {
  it("exposes the default theme", () => {
    expect(findTheme(DEFAULT_THEME_ID)).toBeDefined();
  });

  it("falls back to the default for unknown, empty and nullish ids", () => {
    for (const bad of ["nope", "", null, undefined]) {
      expect(resolveTheme(bad).id).toBe(DEFAULT_THEME_ID);
    }
  });

  it("gives every theme a unique id", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(THEMES.map((t) => [t.id, t] as const))(
    "%s defines every required colour token in both modes",
    (_id, theme) => {
      for (const mode of ["dark", "light"] as const) {
        const colors = theme.colors[mode];
        const missing = REQUIRED_COLOR_TOKENS.filter(
          (token) => !colors[token as keyof ColorTokens],
        );
        expect(missing).toEqual([]);
      }
    },
  );

  it.each(THEMES.map((t) => [t.id, t] as const))(
    "%s uses distinct colours for dark and light",
    (_id, theme) => {
      // A theme whose two modes are identical is almost always a copy-paste
      // slip; every real theme changes at least its background.
      expect(theme.colors.dark.background).not.toBe(theme.colors.light.background);
    },
  );
});

describe("globals.css fallback matches the default manifest", () => {
  const theme = resolveTheme(DEFAULT_THEME_ID);

  it("mirrors every dark colour token in :root", () => {
    const root = declarationsIn(GLOBALS, ":root");
    for (const [token, value] of Object.entries(theme.colors.dark)) {
      expect.soft(root[cssVar(token)], `:root ${cssVar(token)}`).toBe(value);
    }
  });

  it("mirrors every light colour token in .light", () => {
    const light = declarationsIn(GLOBALS, ".light");
    for (const [token, value] of Object.entries(theme.colors.light)) {
      expect.soft(light[cssVar(token)], `.light ${cssVar(token)}`).toBe(value);
    }
  });

  it("mirrors the shape and effect tokens in :root", () => {
    const root = declarationsIn(GLOBALS, ":root");
    expect.soft(root["--radius"]).toBe(theme.shape.radius);
    expect.soft(root["--border-width"]).toBe(theme.shape.borderWidth);
    expect.soft(root["--glass-blur"]).toBe(theme.effects.glassBlur);
    expect.soft(root["--glass-opacity"]).toBe(theme.effects.glassOpacity);
    expect.soft(root["--glass-opacity-strong"]).toBe(theme.effects.glassOpacityStrong);
    expect.soft(root["--glow-strength"]).toBe(theme.effects.glowStrength);
    expect.soft(root["--elevation"]).toBe(theme.effects.shadow);
    expect.soft(root["--motion-duration"]).toBe(theme.effects.motionDuration);
    expect.soft(root["--motion-easing"]).toBe(theme.effects.motionEasing);
    expect.soft(root["--heading-tracking"]).toBe(theme.typography.headingLetterSpacing);
    expect.soft(root["--heading-weight"]).toBe(theme.typography.headingWeight);
    expect.soft(root["--label-weight"]).toBe(theme.typography.labelWeight);
    expect.soft(root["--button-radius"]).toBe(theme.controls.buttonRadius);
    expect.soft(root["--control-filled-border"]).toBe(theme.controls.filledBorderWidth);
    expect.soft(root["--control-state-layer"]).toBe(theme.controls.stateLayerOpacity);
    expect.soft(root["--control-focus-ring"]).toBe(theme.controls.focusRingWidth);
    expect.soft(root["--control-label-tracking"]).toBe(theme.controls.labelTracking);
    expect.soft(root["--control-label-transform"]).toBe(theme.controls.labelTransform);
  });

  it("still declares the Tailwind bridge the tokens feed", () => {
    // Every colour utility resolves through `@theme inline`; losing an entry
    // there silently drops a whole family of classes.
    expect(GLOBALS).toContain("--color-primary: var(--primary)");
    expect(GLOBALS).toContain("--font-sans: var(--font-app)");
    expect(GLOBALS).toContain("--radius-lg: var(--radius)");
  });
});

describe("third-party surface themes", () => {
  // Monaco silently falls back to its default for an unknown id, and Shiki
  // throws at render time — neither surfaces a typo anywhere a type-checker or
  // a page load would catch it. So the names are checked against reality here.
  const MONACO_BUILT_INS = new Set(["vs", "vs-dark", "hc-black", "hc-light"]);

  it.each(THEMES.map((t) => [t.id, t] as const))(
    "%s names Monaco themes that exist",
    (_id, theme) => {
      for (const mode of ["dark", "light"] as const) {
        expect(
          MONACO_BUILT_INS.has(theme.surfaces.monaco[mode]),
          `${theme.id}/${mode} → ${theme.surfaces.monaco[mode]}`,
        ).toBe(true);
      }
    },
  );

  it.each(THEMES.map((t) => [t.id, t] as const))(
    "%s names Shiki themes that Shiki actually bundles",
    (_id, theme) => {
      for (const mode of ["dark", "light"] as const) {
        const name = theme.surfaces.shiki[mode];
        expect(
          existsSync(
            fileURLToPath(new URL(`../../../node_modules/@shikijs/themes/dist/${name}.mjs`, import.meta.url)),
          ),
          `${theme.id}/${mode} → ${name} is not a bundled Shiki theme`,
        ).toBe(true);
      }
    },
  );

  it("gives the dark and light modes different surface themes", () => {
    // A theme reusing one highlighting theme for both modes renders dark code
    // on a light page, or vice versa.
    for (const theme of THEMES) {
      expect(theme.surfaces.shiki.dark).not.toBe(theme.surfaces.shiki.light);
      expect(theme.surfaces.monaco.dark).not.toBe(theme.surfaces.monaco.light);
    }
  });
});
