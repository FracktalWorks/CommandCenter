/**
 * iconSvg — render a themed icon (by Lucide name) to a static SVG STRING.
 *
 * The sandbox runs in an isolated origin and cannot import from our bundle, so
 * it can't use React <Icon> components. Instead the parent resolves the icons an
 * agent asked for into inline SVG markup here and injects those strings into the
 * frame. SVG uses stroke="currentColor", so an injected icon inherits the
 * surrounding CSS color with no extra wiring.
 *
 * Icons are data (SVG), not code — injecting them keeps the sandbox's no-network
 * guarantee intact (no CDN, no <img> host to allow-list).
 *
 * ## Which pack draws them
 *
 * An icon set is part of a theme, not a constant: Fluent ships Fluent's glyphs,
 * Material ships Material Symbols, and `<Icon>` has followed that since the
 * engine landed. This file did not — so a sandboxed app kept drawing Lucide
 * while every icon around it changed, and looked subtly foreign inside its own
 * shell.
 *
 * `pack` is optional and defaults to Lucide, because two callers legitimately
 * cannot know better: server components, and any render that happens before the
 * pack's offline collection has finished loading. Those are the same two
 * fallbacks `<Icon>` uses, so a glyph always renders.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon as IconifyIcon } from "@iconify/react";

import { resolveIcon } from "@/lib/icons";
import { iconPackState } from "@/lib/theme/icon-packs";
import { iconifyName } from "@/lib/theme/icon-registry";
import type { IconPackId } from "@/lib/theme/types";

/** Render one Lucide icon to an SVG string. Returns "" for a bad name (caller
 *  decides the fallback). Size in px; stroke inherits `currentColor`. */
export function iconToSvg(name: string, size = 18, pack: IconPackId = "lucide"): string {
  try {
    const themed =
      pack !== "lucide" && iconPackState(pack) === "ready" ? iconifyName(name, pack) : null;
    if (themed) {
      return renderToStaticMarkup(
        createElement(IconifyIcon, { icon: themed, width: size, height: size }),
      );
    }
    const Icon = resolveIcon(name);
    return renderToStaticMarkup(
      createElement(Icon, { size, strokeWidth: 1.75 }),
    );
  } catch {
    return "";
  }
}

/** Build a { name → svgString } map for a list of requested icon names.
 *  De-dupes and caps the count so a runaway list can't bloat a frame. */
export function buildIconMap(
  names: unknown,
  size = 18,
  cap = 40,
  pack: IconPackId = "lucide",
): Record<string, string> {
  if (!Array.isArray(names)) return {};
  const out: Record<string, string> = {};
  for (const raw of names.slice(0, cap)) {
    const name = typeof raw === "string" ? raw : String(raw ?? "");
    if (!name || out[name]) continue;
    const svg = iconToSvg(name, size, pack);
    if (svg) out[name] = svg;
  }
  return out;
}

/** Re-exported so callers that resolve icons import from one place. The scanner
 *  itself lives in iconRefs.ts, free of any React dependency. */
export { iconsUsedIn } from "@/lib/iconRefs";
