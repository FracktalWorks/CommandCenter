/**
 * ThemeStyles — ships every theme's tokens to the browser.
 *
 * The full set is inlined once, in the document head, rather than fetched per
 * theme. Themes are a few hundred custom properties each, so all of them
 * together cost less than a single extra round trip, and inlining is what
 * makes switching instant: changing `data-theme` re-resolves already-parsed
 * CSS with no network request and no flash of the previous look.
 *
 * A server component with no state — the CSS is derived from static manifests,
 * so it is computed once at module load and reused for every request.
 */

import { buildAllThemesCss, THEME_STYLE_ID } from "@/lib/theme/css";

const THEME_CSS = buildAllThemesCss();

export default function ThemeStyles() {
  return (
    <style
      // React 19 hoists a style with a `precedence` into <head> and dedupes it
      // by href, so this renders once even though the layout may re-render.
      href={THEME_STYLE_ID}
      precedence="theme"
      dangerouslySetInnerHTML={{ __html: THEME_CSS }}
    />
  );
}
