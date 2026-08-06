"use client";

/**
 * Theme resolution for third-party surfaces.
 *
 * Monaco and Shiki each ship a closed set of named themes and cannot be driven
 * by our CSS custom properties, so they are the one place a theme has to name
 * an external vocabulary rather than supply token values. Every call site that
 * used to branch on `resolvedTheme === "light"` reads this instead, so a code
 * view follows the active theme rather than only the colour mode.
 */

import { useTheme } from "next-themes";
import { useActiveTheme } from "./store";
import type { ThemeMode } from "./types";

/** Monaco's built-in theme ids — the only values it accepts unregistered. */
export const MONACO_BUILT_INS = ["vs", "vs-dark", "hc-black", "hc-light"] as const;

/** The active colour mode, defaulting to dark as the app does. */
export function useMode(): ThemeMode {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === "light" ? "light" : "dark";
}

/** Monaco editor theme id for the active theme and mode. */
export function useMonacoTheme(): string {
  const theme = useActiveTheme();
  return theme.surfaces.monaco[useMode()];
}

/** Shiki highlighting theme for the active theme and mode. */
export function useShikiTheme(): string {
  const theme = useActiveTheme();
  return theme.surfaces.shiki[useMode()];
}
