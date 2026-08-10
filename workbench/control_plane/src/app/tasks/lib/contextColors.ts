// Per-@context colour accents — a thin adapter over the SHARED categorical
// vocabulary (`src/lib/categorical.ts`).
//
// A GTD @context (@computer, @calls, @errands, …) reads faster when each carries
// its own stable hue instead of every context sharing the one primary tint. The
// hue is derived from the context NAME so it's deterministic across every
// surface (card chip, list column, toolbar facet) and survives new contexts
// being added — no colour is stored anywhere.
//
// The hues come from the themed ramp (`--cat-1` … `--cat-8`), not from
// Tailwind's palette. This file used to write `bg-sky-500/10 text-sky-600
// dark:text-sky-400` and seven more like it — eight colours the theming engine
// cannot reach, so switching the org to Material moved every other surface and
// left these clashing. Each theme now supplies its own eight, and the `dark:`
// variants are gone, because a token already knows which mode it is in.
//
// What stays local is the one rule that is /tasks' and not everyone's: KEYWORD,
// the hand-assigned slot for the common GTD contexts. Everything else — the
// class strings, the hash, the slot count — is shared, for the same reason
// `stageColors.ts` kept only `lastIsDone` and delegated the rest.

import {
  CATEGORICAL_SLOTS,
  accentForSlot,
  hashSlot,
  type CategoricalAccent,
} from "@/lib/categorical";

/** @deprecated-in-name-only: the shared shape, re-exported for call sites. */
export type ContextAccent = CategoricalAccent;

// Fixed slot for the common contexts, so they read intuitively rather than
// arbitrarily. Keyed on the bare word (no leading @).
//
// This map and the shared hash are the whole stability contract: a given
// @context name resolves to the same slot for every user, in every session,
// forever. An index may not be reassigned and a key may not be removed — both
// repaint a colour people have already learned. Adding a NEW key is safe.
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

// Every hand-assigned slot has to exist on the ramp. A typo'd index here would
// otherwise be silently wrapped by `accentForSlot` into somebody else's colour.
for (const [word, slot] of Object.entries(KEYWORD)) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= CATEGORICAL_SLOTS) {
    throw new Error(`KEYWORD["${word}"] = ${slot} is not a ramp slot (0…${CATEGORICAL_SLOTS - 1}).`);
  }
}

/** The ramp slot a @context maps to — 0-based, stable for a given name. */
export function contextSlot(name: string): number {
  // Trim BEFORE stripping the sigil, not after. `" @office "` used to keep its
  // `@` (because `^@` did not match a leading space), miss KEYWORD entirely and
  // hash to a different slot than `"@office"` — the same context rendering two
  // colours depending on which surface had padded the string.
  const key = name.trim().replace(/^@/, "").trim().toLowerCase();
  return key in KEYWORD ? KEYWORD[key] : hashSlot(key);
}

/** The colour accent for a @context, deterministic from its name. */
export function contextAccent(name: string): ContextAccent {
  return accentForSlot(contextSlot(name));
}
