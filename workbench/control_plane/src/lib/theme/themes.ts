/**
 * Built-in themes.
 *
 * Adding a theme means adding an entry here — no component, CSS or Tailwind
 * change is required. `buildThemeCss()` turns each manifest into the
 * `html[data-theme="…"]` custom-property scope the app renders against.
 *
 * Font stacks reference `var(--font-*)` handles registered by `next/font` in
 * `src/app/layout.tsx`; a theme that wants a font nobody has loaded yet must
 * add it there too. Stacks may name platform fonts first (Segoe UI, Cascadia
 * Code) so a theme looks native where the OS can supply the real thing, and
 * falls back to a self-hosted face everywhere else.
 */

import type { Theme } from "./types";

// Shared font handles, so a typo lands in one place rather than four.
const GEIST = "var(--font-geist-sans)";
const GEIST_MONO = "var(--font-geist-mono)";
const INTER = "var(--font-inter)";
const ROBOTO = "var(--font-roboto)";
const ROBOTO_MONO = "var(--font-roboto-mono)";

const SYSTEM_FALLBACK = "system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
const MONO_FALLBACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/**
 * RapidTool — the Control Plane's original look, preserved token-for-token.
 *
 * These values are the contract with `globals.css`: the `:root` / `.light`
 * blocks there are the no-JavaScript fallback and must stay in sync. A unit
 * test (`themes.test.ts`) parses that stylesheet and fails if the two drift.
 */
const rapidtool: Theme = {
  id: "rapidtool",
  name: "RapidTool",
  description: "The CommandCenter original — deep blue-gray surfaces, professional blue, soft glass.",
  iconPack: "lucide",
  typography: {
    app: `${GEIST}, ${SYSTEM_FALLBACK}`,
    mono: `${GEIST_MONO}, ${MONO_FALLBACK}`,
    headingLetterSpacing: "0em",
    headingWeight: "700",
    labelWeight: "500",
  },
  shape: { radius: "0.75rem", borderWidth: "1px" },
  effects: {
    glassBlur: "16px",
    glassOpacity: "0.65",
    glassOpacityStrong: "0.92",
    glowStrength: "1",
    shadow: "0 4px 16px hsl(0 0% 0% / 0.25)",
    motionDuration: "0.2s",
    motionEasing: "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
  },
  colors: {
    dark: {
      background: "hsl(220 13% 8%)",
      foreground: "hsl(210 40% 98%)",
      card: "hsl(220 13% 10%)",
      cardForeground: "hsl(210 40% 98%)",
      popover: "hsl(220 13% 12%)",
      popoverForeground: "hsl(210 40% 98%)",
      primary: "hsl(198 89% 50%)",
      primaryForeground: "hsl(220 13% 8%)",
      secondary: "hsl(220 13% 14%)",
      secondaryForeground: "hsl(210 40% 98%)",
      muted: "hsl(220 13% 15%)",
      mutedForeground: "hsl(215 20% 65%)",
      accent: "hsl(27 96% 61%)",
      accentForeground: "hsl(220 13% 8%)",
      destructive: "hsl(0 63% 60%)",
      destructiveForeground: "hsl(210 40% 98%)",
      border: "hsl(220 13% 16%)",
      input: "hsl(220 13% 16%)",
      ring: "hsl(198 89% 50%)",
      success: "hsl(142 76% 47%)",
      successForeground: "hsl(220 13% 8%)",
      warning: "hsl(47 96% 53%)",
      warningForeground: "hsl(220 13% 8%)",
      sidebarBackground: "hsl(220 13% 9%)",
      sidebarForeground: "hsl(210 40% 98%)",
      sidebarPrimary: "hsl(198 89% 50%)",
      sidebarPrimaryForeground: "hsl(220 13% 8%)",
      sidebarAccent: "hsl(220 13% 13%)",
      sidebarAccentForeground: "hsl(210 40% 98%)",
      sidebarBorder: "hsl(220 13% 16%)",
      sidebarRing: "hsl(198 89% 50%)",
    },
    light: {
      background: "hsl(0 0% 100%)",
      foreground: "hsl(222.2 84% 4.9%)",
      card: "hsl(0 0% 100%)",
      cardForeground: "hsl(222.2 84% 4.9%)",
      popover: "hsl(0 0% 100%)",
      popoverForeground: "hsl(222.2 84% 4.9%)",
      primary: "hsl(198 89% 35%)",
      primaryForeground: "hsl(0 0% 100%)",
      secondary: "hsl(210 40% 96%)",
      secondaryForeground: "hsl(222.2 84% 4.9%)",
      muted: "hsl(210 40% 96%)",
      mutedForeground: "hsl(215.4 16.3% 46.9%)",
      accent: "hsl(27 96% 61%)",
      accentForeground: "hsl(210 40% 98%)",
      destructive: "hsl(0 84.2% 60.2%)",
      destructiveForeground: "hsl(210 40% 98%)",
      border: "hsl(214.3 31.8% 91.4%)",
      input: "hsl(214.3 31.8% 91.4%)",
      ring: "hsl(198 89% 50%)",
      success: "hsl(142 76% 47%)",
      successForeground: "hsl(210 40% 98%)",
      warning: "hsl(47 96% 53%)",
      warningForeground: "hsl(210 40% 98%)",
      sidebarBackground: "hsl(0 0% 98%)",
      sidebarForeground: "hsl(222.2 84% 4.9%)",
      sidebarPrimary: "hsl(198 89% 45%)",
      sidebarPrimaryForeground: "hsl(210 40% 98%)",
      sidebarAccent: "hsl(210 40% 95%)",
      sidebarAccentForeground: "hsl(222.2 84% 4.9%)",
      sidebarBorder: "hsl(214.3 31.8% 91.4%)",
      sidebarRing: "hsl(198 89% 50%)",
    },
  },
};

/**
 * Fluent — Microsoft's design language (Fluent 2, the Windows 11 / Lumia
 * lineage). Near-square corners, Segoe UI where the OS has it, acrylic
 * instead of glow, and the Fluent System Icons pack.
 */
const fluent: Theme = {
  id: "fluent",
  name: "Fluent",
  description: "Microsoft's Fluent 2 — squared corners, Segoe UI, acrylic surfaces, Fluent icons.",
  inspiration: "Microsoft Fluent 2 design system",
  iconPack: "fluent",
  typography: {
    app: `"Segoe UI Variable Text", "Segoe UI", ${INTER}, ${SYSTEM_FALLBACK}`,
    mono: `"Cascadia Code", "Cascadia Mono", Consolas, ${GEIST_MONO}, ${MONO_FALLBACK}`,
    display: `"Segoe UI Variable Display", "Segoe UI", ${INTER}, ${SYSTEM_FALLBACK}`,
    headingLetterSpacing: "-0.005em",
    headingWeight: "600",
    labelWeight: "600",
  },
  shape: { radius: "0.25rem", borderWidth: "1px" },
  effects: {
    // Acrylic: a heavier blur over a more opaque surface than our default glass.
    glassBlur: "30px",
    glassOpacity: "0.82",
    glassOpacityStrong: "0.95",
    glowStrength: "0",
    shadow: "0 2px 4px hsl(0 0% 0% / 0.14), 0 0 2px hsl(0 0% 0% / 0.12)",
    motionDuration: "0.15s",
    motionEasing: "cubic-bezier(0.33, 0, 0.67, 1)",
  },
  colors: {
    dark: {
      background: "hsl(0 0% 13%)",
      foreground: "hsl(0 0% 98%)",
      card: "hsl(0 0% 17%)",
      cardForeground: "hsl(0 0% 98%)",
      popover: "hsl(0 0% 19%)",
      popoverForeground: "hsl(0 0% 98%)",
      // Windows dark-mode accent (#4CC2FF) — the light-mode #0078D4 fails
      // contrast on a near-black surface.
      primary: "hsl(197 100% 65%)",
      primaryForeground: "hsl(0 0% 10%)",
      secondary: "hsl(0 0% 22%)",
      secondaryForeground: "hsl(0 0% 98%)",
      muted: "hsl(0 0% 20%)",
      mutedForeground: "hsl(0 0% 72%)",
      accent: "hsl(263 37% 62%)",
      accentForeground: "hsl(0 0% 10%)",
      destructive: "hsl(353 100% 80%)",
      destructiveForeground: "hsl(0 0% 10%)",
      border: "hsl(0 0% 24%)",
      input: "hsl(0 0% 24%)",
      ring: "hsl(197 100% 65%)",
      success: "hsl(113 51% 59%)",
      successForeground: "hsl(0 0% 10%)",
      warning: "hsl(53 100% 49%)",
      warningForeground: "hsl(0 0% 10%)",
      sidebarBackground: "hsl(0 0% 15%)",
      sidebarAccent: "hsl(0 0% 21%)",
      sidebarBorder: "hsl(0 0% 22%)",
    },
    light: {
      background: "hsl(0 0% 95%)",
      foreground: "hsl(0 0% 11%)",
      card: "hsl(0 0% 100%)",
      cardForeground: "hsl(0 0% 11%)",
      popover: "hsl(0 0% 100%)",
      popoverForeground: "hsl(0 0% 11%)",
      // 41% rather than Fluent's nominal 42%: white on 42% measures
      // 4.44:1, a hair under AA. See contrast.test.ts.
      primary: "hsl(206 100% 41%)",
      primaryForeground: "hsl(0 0% 100%)",
      secondary: "hsl(0 0% 92%)",
      secondaryForeground: "hsl(0 0% 11%)",
      muted: "hsl(0 0% 94%)",
      mutedForeground: "hsl(0 0% 38%)",
      accent: "hsl(263 37% 56%)",
      accentForeground: "hsl(0 0% 100%)",
      destructive: "hsl(6 75% 44%)",
      destructiveForeground: "hsl(0 0% 100%)",
      border: "hsl(0 0% 88%)",
      input: "hsl(0 0% 88%)",
      ring: "hsl(206 100% 41%)",
      success: "hsl(120 78% 27%)",
      successForeground: "hsl(0 0% 100%)",
      warning: "hsl(36 100% 31%)",
      warningForeground: "hsl(0 0% 100%)",
      sidebarBackground: "hsl(0 0% 98%)",
      sidebarAccent: "hsl(0 0% 92%)",
      sidebarBorder: "hsl(0 0% 88%)",
    },
  },
};

/**
 * Material — Google's Material 3. Generously rounded, Roboto, flat surfaces
 * with elevation expressed through shadow rather than blur or glow. Colours
 * follow the M3 baseline scheme (source colour #6750A4).
 */
const material: Theme = {
  id: "material",
  name: "Material",
  description: "Google's Material 3 — rounded shapes, Roboto, flat surfaces with elevation shadows.",
  inspiration: "Google Material Design 3 baseline scheme",
  iconPack: "material",
  typography: {
    app: `${ROBOTO}, Roboto, ${SYSTEM_FALLBACK}`,
    mono: `${ROBOTO_MONO}, "Roboto Mono", ${MONO_FALLBACK}`,
    headingLetterSpacing: "0em",
    headingWeight: "500",
    labelWeight: "500",
  },
  shape: { radius: "1rem", borderWidth: "1px" },
  effects: {
    // Material is flat: no blur, no glow, depth comes entirely from elevation.
    glassBlur: "0px",
    glassOpacity: "1",
    glassOpacityStrong: "1",
    glowStrength: "0",
    shadow: "0 1px 2px hsl(0 0% 0% / 0.3), 0 2px 6px 2px hsl(0 0% 0% / 0.15)",
    motionDuration: "0.2s",
    motionEasing: "cubic-bezier(0.2, 0, 0, 1)",
  },
  colors: {
    dark: {
      background: "hsl(270 12% 9%)",
      foreground: "hsl(274 21% 90%)",
      card: "hsl(266 11% 14%)",
      cardForeground: "hsl(274 21% 90%)",
      popover: "hsl(264 11% 18%)",
      popoverForeground: "hsl(274 21% 90%)",
      primary: "hsl(258 100% 87%)",
      primaryForeground: "hsl(261 58% 28%)",
      secondary: "hsl(263 8% 22%)",
      secondaryForeground: "hsl(274 21% 90%)",
      muted: "hsl(270 8% 12%)",
      mutedForeground: "hsl(266 16% 80%)",
      accent: "hsl(340 60% 83%)",
      accentForeground: "hsl(338 33% 22%)",
      destructive: "hsl(2 65% 83%)",
      destructiveForeground: "hsl(4 70% 22%)",
      border: "hsl(266 8% 29%)",
      input: "hsl(266 8% 29%)",
      ring: "hsl(258 100% 87%)",
      success: "hsl(140 45% 75%)",
      successForeground: "hsl(142 60% 14%)",
      warning: "hsl(35 90% 78%)",
      warningForeground: "hsl(30 70% 16%)",
      sidebarBackground: "hsl(270 8% 12%)",
      sidebarAccent: "hsl(263 8% 22%)",
      sidebarBorder: "hsl(266 8% 24%)",
    },
    light: {
      background: "hsl(293 100% 98%)",
      foreground: "hsl(270 8% 12%)",
      card: "hsl(0 0% 100%)",
      cardForeground: "hsl(270 8% 12%)",
      popover: "hsl(275 33% 95%)",
      popoverForeground: "hsl(270 8% 12%)",
      primary: "hsl(258 35% 48%)",
      primaryForeground: "hsl(0 0% 100%)",
      secondary: "hsl(270 27% 92%)",
      secondaryForeground: "hsl(270 8% 12%)",
      muted: "hsl(274 21% 94%)",
      mutedForeground: "hsl(266 8% 29%)",
      accent: "hsl(339 21% 41%)",
      accentForeground: "hsl(0 0% 100%)",
      destructive: "hsl(3 71% 41%)",
      destructiveForeground: "hsl(0 0% 100%)",
      border: "hsl(266 16% 80%)",
      input: "hsl(266 16% 80%)",
      ring: "hsl(258 35% 48%)",
      success: "hsl(139 68% 25%)",
      successForeground: "hsl(0 0% 100%)",
      warning: "hsl(43 100% 24%)",
      warningForeground: "hsl(0 0% 100%)",
      sidebarBackground: "hsl(280 43% 96%)",
      sidebarAccent: "hsl(270 27% 92%)",
      sidebarBorder: "hsl(266 16% 84%)",
    },
  },
};

/**
 * Graphite — a quiet, near-monochrome workspace. Sharp corners, monospace
 * headings, effects dialled off. Useful as a low-distraction mode and as
 * proof that the font and effect axes are real and not colour-only.
 */
const graphite: Theme = {
  id: "graphite",
  name: "Graphite",
  description: "Low-distraction monochrome — sharp corners, monospace headings, no glass or glow.",
  iconPack: "lucide",
  typography: {
    app: `${GEIST}, ${SYSTEM_FALLBACK}`,
    mono: `${GEIST_MONO}, ${MONO_FALLBACK}`,
    display: `${GEIST_MONO}, ${MONO_FALLBACK}`,
    headingLetterSpacing: "-0.02em",
    headingWeight: "600",
    labelWeight: "500",
  },
  shape: { radius: "0.125rem", borderWidth: "1px" },
  effects: {
    glassBlur: "8px",
    glassOpacity: "0.94",
    glassOpacityStrong: "0.98",
    glowStrength: "0",
    shadow: "0 1px 2px hsl(0 0% 0% / 0.2)",
    motionDuration: "0.12s",
    motionEasing: "ease-out",
  },
  colors: {
    dark: {
      background: "hsl(0 0% 7%)",
      foreground: "hsl(0 0% 93%)",
      card: "hsl(0 0% 10%)",
      cardForeground: "hsl(0 0% 93%)",
      popover: "hsl(0 0% 12%)",
      popoverForeground: "hsl(0 0% 93%)",
      primary: "hsl(0 0% 88%)",
      primaryForeground: "hsl(0 0% 8%)",
      secondary: "hsl(0 0% 15%)",
      secondaryForeground: "hsl(0 0% 93%)",
      muted: "hsl(0 0% 14%)",
      mutedForeground: "hsl(0 0% 60%)",
      accent: "hsl(35 90% 60%)",
      accentForeground: "hsl(0 0% 8%)",
      destructive: "hsl(0 70% 65%)",
      destructiveForeground: "hsl(0 0% 8%)",
      border: "hsl(0 0% 18%)",
      input: "hsl(0 0% 18%)",
      ring: "hsl(0 0% 70%)",
      success: "hsl(140 55% 55%)",
      successForeground: "hsl(0 0% 8%)",
      warning: "hsl(45 90% 58%)",
      warningForeground: "hsl(0 0% 8%)",
      sidebarBackground: "hsl(0 0% 9%)",
      sidebarAccent: "hsl(0 0% 14%)",
      sidebarBorder: "hsl(0 0% 17%)",
    },
    light: {
      background: "hsl(0 0% 99%)",
      foreground: "hsl(0 0% 10%)",
      card: "hsl(0 0% 100%)",
      cardForeground: "hsl(0 0% 10%)",
      popover: "hsl(0 0% 100%)",
      popoverForeground: "hsl(0 0% 10%)",
      primary: "hsl(0 0% 16%)",
      primaryForeground: "hsl(0 0% 100%)",
      secondary: "hsl(0 0% 95%)",
      secondaryForeground: "hsl(0 0% 10%)",
      muted: "hsl(0 0% 96%)",
      mutedForeground: "hsl(0 0% 42%)",
      accent: "hsl(30 90% 37%)",
      accentForeground: "hsl(0 0% 100%)",
      destructive: "hsl(0 70% 42%)",
      destructiveForeground: "hsl(0 0% 100%)",
      border: "hsl(0 0% 89%)",
      input: "hsl(0 0% 89%)",
      ring: "hsl(0 0% 40%)",
      success: "hsl(140 65% 26%)",
      successForeground: "hsl(0 0% 100%)",
      warning: "hsl(35 95% 32%)",
      warningForeground: "hsl(0 0% 100%)",
      sidebarBackground: "hsl(0 0% 97%)",
      sidebarAccent: "hsl(0 0% 94%)",
      sidebarBorder: "hsl(0 0% 89%)",
    },
  },
};

/** Every built-in theme, in the order Settings presents them. */
export const THEMES: Theme[] = [rapidtool, fluent, material, graphite];

/** The theme used when nothing has been chosen and no org default is set. */
export const DEFAULT_THEME_ID = rapidtool.id;

const THEMES_BY_ID = new Map(THEMES.map((t) => [t.id, t]));

/** Look up a theme by id, or `undefined` when the id is unknown. */
export function findTheme(id: string | null | undefined): Theme | undefined {
  return id ? THEMES_BY_ID.get(id) : undefined;
}

/**
 * Resolve an id to a real theme, falling back to the default. Used on every
 * boundary where an id arrives from outside the app (stored preference, API
 * response, URL) and may name a theme that has since been removed.
 */
export function resolveTheme(id: string | null | undefined): Theme {
  return findTheme(id) ?? THEMES_BY_ID.get(DEFAULT_THEME_ID)!;
}
