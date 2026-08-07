/**
 * WCAG contrast maths for theme validation.
 *
 * A theme is a few dozen colours chosen by eye, and the failure mode is
 * specific: a pair that looks fine to the author is unreadable for someone
 * else, on a worse screen, in sunlight. Checking it is arithmetic, so there is
 * no reason for a theme to ship unchecked — see `contrast.test.ts`, which runs
 * every shipped theme through this.
 *
 * Supports the colour forms the manifests actually use. Anything else returns
 * `null` rather than a wrong number, so an unparseable colour shows up as
 * "not checked" instead of silently passing.
 */

export type Rgb = { r: number; g: number; b: number };

/** WCAG 2.1 AA thresholds. */
export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;

function hslToRgb(h: number, s: number, l: number): Rgb {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return lig - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return { r: f(0), g: f(8), b: f(4) };
}

/**
 * Parse a CSS colour into normalised 0–1 RGB, or `null` when the form is not
 * one this checker understands.
 */
export function parseColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase();

  const hsl = v.match(
    /^hsla?\(\s*([\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%/,
  );
  if (hsl) return hslToRgb(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));

  const rgb = v.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/);
  if (rgb) {
    return { r: Number(rgb[1]) / 255, g: Number(rgb[2]) / 255, b: Number(rgb[3]) / 255 };
  }

  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255,
    };
  }

  return null;
}

/** Relative luminance, per WCAG 2.1. */
export function luminance({ r, g, b }: Rgb): number {
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two colours, 1–21. Order does not matter. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Ratio between two CSS colour strings, or `null` if either cannot be parsed.
 */
export function contrast(fg: string, bg: string): number | null {
  const a = parseColor(fg);
  const b = parseColor(bg);
  if (!a || !b) return null;
  return contrastRatio(a, b);
}
