/**
 * Appearance store.
 *
 * Holds the two-level preference model the theming engine is built around:
 *
 *   organisation default  — set by an admin, applies to everyone
 *   member override       — optional, wins for that person only
 *
 * A `null` member value means "inherit", which is why overrides are stored as
 * nullable rather than pre-resolved: clearing an override has to fall back to
 * whatever the org default currently is, including later changes to it.
 *
 * Deliberately a store rather than a context: `<Icon>` reads the active icon
 * pack and is rendered in well over a hundred places, several of them outside
 * any provider we control. A store keeps that read provider-free.
 */

import { create } from "zustand";
import type { Density, ThemeMode } from "./types";
import { DEFAULT_THEME_ID, findTheme, resolveTheme } from "./themes";
import {
  ACCENT_PROPERTIES,
  DENSITY_PROPERTY,
  THEME_ATTRIBUTE,
  densityScale,
  themeStorage,
} from "./storage";
import { isSafeColor } from "./css";

type AppearanceState = {
  /** Member's theme override; `null` inherits the org default. */
  userThemeId: string | null;
  /** Member's density override; `null` inherits the org default. */
  userDensity: Density | null;
  /** Member's accent override; `null` keeps the theme's own primary. */
  accent: string | null;

  /** Organisation defaults, refreshed from the backend on mount. */
  orgThemeId: string;
  orgDensity: Density;
  /** When false, members must use the org default. */
  allowUserOverride: boolean;

  /** True once local preferences have been read out of storage. */
  hydrated: boolean;

  setUserTheme: (id: string | null) => void;
  setUserDensity: (density: Density | null) => void;
  setAccent: (color: string | null) => void;
  setOrgDefaults: (org: {
    themeId: string;
    density: Density;
    allowUserOverride: boolean;
  }) => void;
  hydrate: () => void;
};

/** The theme actually in force, honouring the org's override policy. */
export function effectiveThemeId(s: AppearanceState): string {
  if (!s.allowUserOverride) return s.orgThemeId;
  return s.userThemeId ?? s.orgThemeId;
}

/** The density actually in force, honouring the org's override policy. */
export function effectiveDensity(s: AppearanceState): Density {
  if (!s.allowUserOverride) return s.orgDensity;
  return s.userDensity ?? s.orgDensity;
}

/**
 * Push the resolved state onto the document. Every mutation funnels through
 * here so the DOM can never disagree with the store.
 *
 * Values reach CSS through `setProperty`, never through generated stylesheet
 * text, so a malformed stored value is rejected by the CSSOM instead of
 * altering the stylesheet.
 */
function applyToDocument(state: AppearanceState): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  root.setAttribute(THEME_ATTRIBUTE, resolveTheme(effectiveThemeId(state)).id);
  root.style.setProperty(DENSITY_PROPERTY, String(densityScale(effectiveDensity(state))));

  const accent = state.accent && isSafeColor(state.accent) ? state.accent : null;
  for (const prop of ACCENT_PROPERTIES) {
    if (accent) root.style.setProperty(prop, accent);
    else root.style.removeProperty(prop);
  }
}

export const useAppearanceStore = create<AppearanceState>((set, get) => ({
  userThemeId: null,
  userDensity: null,
  accent: null,
  orgThemeId: DEFAULT_THEME_ID,
  orgDensity: "default",
  allowUserOverride: true,
  hydrated: false,

  setUserTheme: (id) => {
    // An unknown id would leave the document wearing an attribute no
    // stylesheet matches, so treat it as "inherit" instead.
    const next = id && findTheme(id) ? id : null;
    themeStorage.setTheme(next);
    set({ userThemeId: next });
    applyToDocument(get());
  },

  setUserDensity: (density) => {
    themeStorage.setDensity(density);
    set({ userDensity: density });
    applyToDocument(get());
  },

  setAccent: (color) => {
    const next = color && isSafeColor(color) ? color : null;
    themeStorage.setAccent(next);
    set({ accent: next });
    applyToDocument(get());
  },

  setOrgDefaults: ({ themeId, density, allowUserOverride }) => {
    const resolved = resolveTheme(themeId).id;
    themeStorage.setOrgTheme(resolved);
    themeStorage.setOrgDensity(density);
    set({ orgThemeId: resolved, orgDensity: density, allowUserOverride });
    applyToDocument(get());
  },

  hydrate: () => {
    if (get().hydrated) return;
    const storedOrgTheme = themeStorage.getOrgTheme();
    const storedOrgDensity = themeStorage.getOrgDensity();
    set({
      userThemeId: themeStorage.getTheme(),
      userDensity: themeStorage.getDensity(),
      accent: themeStorage.getAccent(),
      orgThemeId: storedOrgTheme ? resolveTheme(storedOrgTheme).id : DEFAULT_THEME_ID,
      orgDensity: storedOrgDensity ?? "default",
      hydrated: true,
    });
    applyToDocument(get());
  },
}));

/** The resolved `Theme` object currently in force. */
export function useActiveTheme() {
  return useAppearanceStore((s) => resolveTheme(effectiveThemeId(s)));
}

/** The icon pack the active theme asks for. */
export function useIconPack() {
  return useAppearanceStore((s) => resolveTheme(effectiveThemeId(s)).iconPack);
}

export type { AppearanceState, ThemeMode };
