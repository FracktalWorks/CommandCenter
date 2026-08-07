/**
 * Pre-paint boot script.
 *
 * Runs before React hydrates and before the first paint, so the document is
 * already wearing the right theme when pixels first hit the screen. Without
 * it every load would flash the default theme for a frame before the store
 * caught up — the same problem next-themes solves for light/dark, applied to
 * the style, density and accent axes it does not know about.
 *
 * Constraints: this string is executed as an inline `<script>`, so it cannot
 * import anything and must not throw. Storage keys are interpolated from
 * `storage.ts` so the script and the React store always read the same places.
 * It contains no server- or user-supplied data — the values it acts on come
 * from localStorage and are written through the CSSOM, never concatenated into
 * CSS text.
 */

import { DEFAULT_THEME_ID, THEMES } from "./themes";
import { DENSITY_SCALE } from "./types";
import {
  ACCENT_INK_PROPERTIES,
  ACCENT_PROPERTIES,
  DENSITY_PROPERTY,
  STORAGE_KEYS,
  THEME_ATTRIBUTE,
} from "./storage";

/**
 * The script source. Generated rather than hand-written so the known-theme
 * list, density scale and storage keys stay in lockstep with the manifests.
 */
export function themeBootScript(): string {
  const ids = JSON.stringify(THEMES.map((t) => t.id));
  const scales = JSON.stringify(DENSITY_SCALE);
  const accentProps = JSON.stringify(ACCENT_PROPERTIES);
  const accentInkProps = JSON.stringify(ACCENT_INK_PROPERTIES);

  return `(function(){try{
var d=document.documentElement,ls=window.localStorage;
var known=${ids},scale=${scales};
var t=ls.getItem(${JSON.stringify(STORAGE_KEYS.theme)})||ls.getItem(${JSON.stringify(STORAGE_KEYS.orgTheme)});
if(known.indexOf(t)===-1)t=${JSON.stringify(DEFAULT_THEME_ID)};
d.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)},t);
var den=ls.getItem(${JSON.stringify(STORAGE_KEYS.density)})||ls.getItem(${JSON.stringify(STORAGE_KEYS.orgDensity)});
if(scale[den])d.style.setProperty(${JSON.stringify(DENSITY_PROPERTY)},String(scale[den]));
var a=ls.getItem(${JSON.stringify(STORAGE_KEYS.accent)});
if(a){var p=${accentProps};for(var i=0;i<p.length;i++)d.style.setProperty(p[i],a);
var ink=ls.getItem(${JSON.stringify(STORAGE_KEYS.accentInk)});if(ink){var q=${accentInkProps};for(var j=0;j<q.length;j++)d.style.setProperty(q[j],ink);}}
}catch(e){}})();`;
}
