// Per-@context colour accents. A GTD @context (@computer, @calls, @errands, …)
// reads faster when each carries its own stable hue instead of every context
// sharing the one primary tint. The hue is derived from the context NAME so it's
// deterministic across every surface (card chip, list column, anywhere a context
// pill renders) and survives new contexts being added — no colour is stored.
//
// Common contexts get a fixed, intuitive slot via KEYWORD; anything else hashes
// to a stable slot.
//
// The hues come from the THEMED categorical ramp (`--cat-1` … `--cat-8`,
// src/lib/theme/themes.ts), not from Tailwind's palette. This file used to
// write `bg-sky-500/10 text-sky-600 dark:text-sky-400` and friends, which is
// eight colours the theming engine cannot reach: switch the org to Material and
// every other surface followed while these eight stayed put and clashed. Each
// theme now supplies its own eight, so a context chip belongs to whichever
// theme is active — and the `dark:` variants are gone, because a token already
// knows which mode it is in.

import { CATEGORICAL_TOKENS } from "@/lib/theme/types";

export interface ContextAccent {
  /** filled tint chip (border + bg + text) for a @context pill */
  chip: string;
  /** the solid dot, for a leading marker / legend */
  dot: string;
}

// One entry per ramp slot, in slot order. Written out literally rather than
// generated from CATEGORICAL_TOKENS because Tailwind v4 finds classes by
// scanning source text: a template-built `bg-cat-${n}` is a class that exists
// in this file and in no stylesheet.
const PALETTE: ContextAccent[] = [
  { chip: "border-cat-1/30 bg-cat-1/10 text-cat-1", dot: "bg-cat-1" },
  { chip: "border-cat-2/30 bg-cat-2/10 text-cat-2", dot: "bg-cat-2" },
  { chip: "border-cat-3/30 bg-cat-3/10 text-cat-3", dot: "bg-cat-3" },
  { chip: "border-cat-4/30 bg-cat-4/10 text-cat-4", dot: "bg-cat-4" },
  { chip: "border-cat-5/30 bg-cat-5/10 text-cat-5", dot: "bg-cat-5" },
  { chip: "border-cat-6/30 bg-cat-6/10 text-cat-6", dot: "bg-cat-6" },
  { chip: "border-cat-7/30 bg-cat-7/10 text-cat-7", dot: "bg-cat-7" },
  { chip: "border-cat-8/30 bg-cat-8/10 text-cat-8", dot: "bg-cat-8" },
];

// The literal list above and the ramp have to stay the same length: `hash %
// PALETTE.length` is what makes an assignment stable, so a ninth slot added to
// the ramp and not to this list would leave it unreachable, while a slot
// removed from the ramp and not from here would emit a class with no token.
if (PALETTE.length !== CATEGORICAL_TOKENS.length) {
  throw new Error(
    `contextColors PALETTE has ${PALETTE.length} entries but the categorical ` +
      `ramp has ${CATEGORICAL_TOKENS.length}. Keep them in step.`,
  );
}

// Fixed slot for the common contexts so they never move when the palette
// changes — indexes into PALETTE above. Keyed on the bare word (no leading @).
//
// This map and the hash below are the whole stability contract: a given
// @context name resolves to the same slot for every user, in every session,
// forever. Nothing here may be reordered, and an index may not be reassigned —
// both repaint contexts people have already learned. Adding a NEW key is safe.
const KEYWORD: Record<string, number> = {
  computer: 0, mac: 0, laptop: 0, online: 0, desk: 0,
  agenda: 1, meeting: 1, meetings: 1, "1:1": 1,
  home: 2, house: 2,
  errand: 3, errands: 3, car: 3, out: 3,
  call: 4, calls: 4, phone: 4,
  office: 6,
  email: 5, waiting: 5,
  read: 7, reading: 7, review: 7,
};

/** djb2-ish string hash → stable non-negative int. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/** The ramp slot a @context maps to — 0-based, stable for a given name. */
export function contextSlot(name: string): number {
  // Trim BEFORE stripping the sigil, not after. `" @office "` used to keep its
  // `@` (because `^@` did not match a leading space), miss KEYWORD entirely and
  // hash to a different slot than `"@office"` — the same context rendering two
  // colours depending on which surface had padded the string.
  const key = name.trim().replace(/^@/, "").trim().toLowerCase();
  return key in KEYWORD ? KEYWORD[key] : hash(key) % PALETTE.length;
}

/** The colour accent for a @context, deterministic from its name. */
export function contextAccent(name: string): ContextAccent {
  return PALETTE[contextSlot(name)];
}
