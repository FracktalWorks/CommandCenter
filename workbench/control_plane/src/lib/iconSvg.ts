/**
 * iconSvg — render a Lucide icon (by name) to a static SVG STRING.
 *
 * The Tier-3 sandbox (SandboxedHtml) runs in an isolated origin and cannot
 * import from our bundle, so it can't use React <Icon> components. Instead the
 * parent resolves the icons an agent asked for into inline SVG markup here and
 * injects those strings into the frame. SVG uses stroke="currentColor", so an
 * injected icon inherits the surrounding CSS color with no extra wiring.
 *
 * Icons are data (SVG), not code — injecting them keeps the sandbox's no-network
 * guarantee intact (no CDN, no <img> host to allow-list).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { resolveIcon } from "@/lib/icons";

/** Render one Lucide icon to an SVG string. Returns "" for a bad name (caller
 *  decides the fallback). Size in px; stroke inherits `currentColor`. */
export function iconToSvg(name: string, size = 18): string {
  try {
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
): Record<string, string> {
  if (!Array.isArray(names)) return {};
  const out: Record<string, string> = {};
  for (const raw of names.slice(0, cap)) {
    const name = typeof raw === "string" ? raw : String(raw ?? "");
    if (!name || out[name]) continue;
    const svg = iconToSvg(name, size);
    if (svg) out[name] = svg;
  }
  return out;
}
