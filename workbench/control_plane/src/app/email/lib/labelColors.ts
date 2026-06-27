/**
 * Label colour palette — the frontend mirror of the backend's
 * `providers/label_colors.py`. The canonical colour id is an Outlook-style
 * preset token ('preset0'..'preset24'); the backend maps it to each provider's
 * native colour (Gmail bg/text pair, Outlook preset) so a choice round-trips to
 * the real mailbox. Here we only need the display hex + a contrasting text
 * colour for rendering chips and swatches.
 *
 * `hex` values must stay in sync with PRESET_COLORS in the Python module.
 */

export interface PaletteColor {
  /** Canonical preset token, e.g. "preset4". */
  id: string;
  /** Human label for the swatch tooltip. */
  name: string;
  /** Display colour (chip background / swatch fill). */
  hex: string;
}

export const LABEL_PALETTE: PaletteColor[] = [
  { id: "preset0", name: "Red", hex: "#E74C3C" },
  { id: "preset1", name: "Orange", hex: "#E67E22" },
  { id: "preset2", name: "Brown", hex: "#A0522D" },
  { id: "preset3", name: "Yellow", hex: "#F1C40F" },
  { id: "preset4", name: "Green", hex: "#2ECC71" },
  { id: "preset5", name: "Teal", hex: "#1ABC9C" },
  { id: "preset6", name: "Olive", hex: "#9DAE2A" },
  { id: "preset7", name: "Blue", hex: "#3498DB" },
  { id: "preset8", name: "Purple", hex: "#9B59B6" },
  { id: "preset9", name: "Cranberry", hex: "#E91E8C" },
  { id: "preset10", name: "Steel", hex: "#5D8AA8" },
  { id: "preset11", name: "Dark steel", hex: "#34699A" },
  { id: "preset12", name: "Gray", hex: "#95A5A6" },
  { id: "preset13", name: "Dark gray", hex: "#707B7C" },
  { id: "preset14", name: "Black", hex: "#2C3E50" },
  { id: "preset15", name: "Dark red", hex: "#B03A2E" },
  { id: "preset16", name: "Dark orange", hex: "#BA4A00" },
  { id: "preset17", name: "Dark brown", hex: "#6E2C00" },
  { id: "preset18", name: "Dark yellow", hex: "#B7950B" },
  { id: "preset19", name: "Dark green", hex: "#1E8449" },
  { id: "preset20", name: "Dark teal", hex: "#117A65" },
  { id: "preset21", name: "Dark olive", hex: "#6B7A1E" },
  { id: "preset22", name: "Dark blue", hex: "#1F618D" },
  { id: "preset23", name: "Dark purple", hex: "#6C3483" },
  { id: "preset24", name: "Dark cranberry", hex: "#99235C" },
];

const BY_ID = new Map(LABEL_PALETTE.map((c) => [c.id, c]));

/** Display hex for a preset token (falls back to the first palette colour). */
export function presetHex(token: string | null | undefined): string {
  return (token && BY_ID.get(token)?.hex) || LABEL_PALETTE[0].hex;
}

/** Black or white text for readable contrast on a hex background. */
export function textOn(hex: string): string {
  const v = hex.replace("#", "");
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  // Perceived luminance (sRGB) — light backgrounds get dark text.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#1a1a1a" : "#ffffff";
}

/**
 * Deterministic preset for a label with no explicit colour. Matches the
 * backend `preset_for_name` so an uncoloured label renders consistently across
 * surfaces (and the same as it would after the provider colours it on apply).
 */
export function deterministicPreset(name: string): string {
  let sum = 0;
  for (let i = 0; i < name.length; i++) sum += name.charCodeAt(i);
  return LABEL_PALETTE[sum % LABEL_PALETTE.length].id;
}

/**
 * Resolve the effective preset token for a label name, preferring an explicit
 * colour from the account's label-colour map, else a deterministic fallback.
 */
export function presetForLabel(
  name: string,
  colors: Record<string, string | null | undefined>,
): string {
  return colors[name] || deterministicPreset(name);
}

/** Chip background + text colours for a label name. */
export function chipColors(
  name: string,
  colors: Record<string, string | null | undefined>,
): { bg: string; text: string } {
  const bg = presetHex(presetForLabel(name, colors));
  return { bg, text: textOn(bg) };
}
