/**
 * Where appearance preferences live in the browser.
 *
 * Two readers share these keys: the React store, and the pre-paint boot script
 * (`boot.ts`) which runs before hydration and cannot import anything. The key
 * names are therefore defined once here and interpolated into the script
 * source, so the two can never drift apart.
 */

import type { Density, ThemeMode } from "./types";
import { DENSITY_SCALE } from "./types";

export const STORAGE_KEYS = {
  /** The member's own theme choice. Absent means "follow the org default". */
  theme: "cc-theme",
  /** The member's own density choice. Absent means "follow the org default". */
  density: "cc-density",
  /** Optional primary-colour override. */
  accent: "cc-accent",
  /**
   * Last-known organisation defaults, cached so a member who has never opened
   * Settings still gets the company look on first paint instead of a flash of
   * the built-in default.
   */
  orgTheme: "cc-theme-org",
  orgDensity: "cc-density-org",
} as const;

/** The DOM attribute carrying the active theme's id. */
export const THEME_ATTRIBUTE = "data-theme";

/** Custom property the density setting drives. */
export const DENSITY_PROPERTY = "--ui-scale";

/** Custom properties an accent override replaces. */
export const ACCENT_PROPERTIES = ["--primary", "--ring", "--sidebar-primary"] as const;

/** localStorage key next-themes uses for the colour mode. */
export const MODE_STORAGE_KEY = "theme";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private mode / blocked storage: fall back to defaults rather than crash.
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Preferences simply do not persist when storage is unavailable.
  }
}

export const themeStorage = {
  getTheme: () => read(STORAGE_KEYS.theme),
  setTheme: (id: string | null) => write(STORAGE_KEYS.theme, id),
  getDensity: () => read(STORAGE_KEYS.density) as Density | null,
  setDensity: (d: Density | null) => write(STORAGE_KEYS.density, d),
  getAccent: () => read(STORAGE_KEYS.accent),
  setAccent: (c: string | null) => write(STORAGE_KEYS.accent, c),
  getOrgTheme: () => read(STORAGE_KEYS.orgTheme),
  setOrgTheme: (id: string) => write(STORAGE_KEYS.orgTheme, id),
  getOrgDensity: () => read(STORAGE_KEYS.orgDensity) as Density | null,
  setOrgDensity: (d: Density) => write(STORAGE_KEYS.orgDensity, d),
  getMode: () => read(MODE_STORAGE_KEY) as ThemeMode | null,
};

/** Root font-size multiplier for a density setting. */
export function densityScale(density: Density | null | undefined): number {
  return density ? DENSITY_SCALE[density] : DENSITY_SCALE.default;
}
