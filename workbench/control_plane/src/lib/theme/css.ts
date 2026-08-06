/**
 * Theme → CSS.
 *
 * Turns theme manifests into the custom-property scopes the app renders
 * against. The output is emitted once, server-side, into a `<style>` tag in
 * the document head (see `components/ThemeStyles.tsx`), so switching themes at
 * runtime is a single attribute write with no stylesheet fetch and no flash.
 *
 * Selector strategy
 * -----------------
 *   html[data-theme="x"]        → dark tokens  (specificity 0,1,1)
 *   html[data-theme="x"].light  → light tokens (specificity 0,2,1)
 *
 * The `html` element qualifier is deliberate. `globals.css` keeps the original
 * `:root` / `.light` blocks as a no-JavaScript fallback, and those score
 * (0,1,0) — lower than everything generated here. Generated themes therefore
 * always win no matter which stylesheet the browser happens to apply first,
 * which a bare `[data-theme=…]` selector could not guarantee.
 */

import type { ColorTokens, Theme } from "./types";
import { THEMES } from "./themes";

/** `id` of the injected `<style>` element. */
export const THEME_STYLE_ID = "cc-theme-tokens";

/**
 * Theme ids become part of a CSS selector, so they are restricted to
 * characters that need no escaping. Enforced at generation time — a malformed
 * id fails the build rather than emitting a broken or injectable selector.
 */
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

/** `cardForeground` → `card-foreground`. */
function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * Sidebar tokens a theme did not spell out fall back to the equivalent core
 * token, so a theme only declares the surfaces it wants to look different.
 */
function withSidebarDefaults(c: ColorTokens): Required<ColorTokens> {
  return {
    ...c,
    sidebarBackground: c.sidebarBackground ?? c.background,
    sidebarForeground: c.sidebarForeground ?? c.foreground,
    sidebarPrimary: c.sidebarPrimary ?? c.primary,
    sidebarPrimaryForeground: c.sidebarPrimaryForeground ?? c.primaryForeground,
    sidebarAccent: c.sidebarAccent ?? c.secondary,
    sidebarAccentForeground: c.sidebarAccentForeground ?? c.secondaryForeground,
    sidebarBorder: c.sidebarBorder ?? c.border,
    sidebarRing: c.sidebarRing ?? c.ring,
  };
}

function declarations(entries: [string, string][], indent = "  "): string {
  return entries.map(([k, v]) => `${indent}--${k}: ${v};`).join("\n");
}

/** Colour declarations for one mode. */
function colorDeclarations(colors: ColorTokens): [string, string][] {
  const full = withSidebarDefaults(colors);
  return Object.entries(full).map(([key, value]) => [kebab(key), value as string]);
}

/**
 * The non-colour half of a theme: shape, typography and effects. These do not
 * vary by mode, so they are emitted once on the theme's dark (base) scope and
 * inherited by the light scope.
 */
function structuralDeclarations(theme: Theme): [string, string][] {
  const { shape, effects, typography } = theme;
  return [
    ["radius", shape.radius],
    ["border-width", shape.borderWidth],
    ["font-app", typography.app],
    ["font-app-mono", typography.mono],
    ["font-display", typography.display ?? typography.app],
    ["heading-tracking", typography.headingLetterSpacing],
    ["heading-weight", typography.headingWeight],
    ["label-weight", typography.labelWeight],
    ["glass-blur", effects.glassBlur],
    ["glass-opacity", effects.glassOpacity],
    ["glass-opacity-strong", effects.glassOpacityStrong],
    ["glow-strength", effects.glowStrength],
    ["elevation", effects.shadow],
    ["motion-duration", effects.motionDuration],
    ["motion-easing", effects.motionEasing],
  ];
}

/** CSS for a single theme — both modes. */
export function buildThemeCss(theme: Theme): string {
  if (!SAFE_ID.test(theme.id)) {
    throw new Error(
      `Invalid theme id ${JSON.stringify(theme.id)}: ids must match ${SAFE_ID} ` +
        `so they can be embedded in a CSS selector without escaping.`,
    );
  }

  const base = `html[data-theme="${theme.id}"]`;
  const dark = declarations([
    ...structuralDeclarations(theme),
    ...colorDeclarations(theme.colors.dark),
  ]);
  const light = declarations(colorDeclarations(theme.colors.light));

  return [
    `/* ${theme.name} — ${theme.description} */`,
    `${base} {`,
    dark,
    `}`,
    `${base}.light {`,
    light,
    `}`,
  ].join("\n");
}

/** CSS for every built-in theme, concatenated in registration order. */
export function buildAllThemesCss(themes: Theme[] = THEMES): string {
  return themes.map(buildThemeCss).join("\n\n");
}

/**
 * Accepted forms for a user-supplied accent colour.
 *
 * The accent is the one theme value that comes from user input, and it ends up
 * in a CSS custom property. Restricting it to plain colour literals keeps
 * anything that could terminate a declaration or open a `url()` out of the
 * stylesheet, whichever path applies it.
 */
const SAFE_COLOR =
  /^(#[0-9a-f]{3,8}|(rgb|hsl|oklch|lab|lch)a?\([0-9a-z%.,/\s+-]*\)|[a-z]{3,20})$/i;

/** True when `value` is a colour literal safe to use as an accent override. */
export function isSafeColor(value: string): boolean {
  const v = value.trim();
  return v.length > 0 && v.length <= 64 && SAFE_COLOR.test(v);
}
