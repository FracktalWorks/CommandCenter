// Per-@context colour accents. A GTD @context (@computer, @calls, @errands, …)
// reads faster when each carries its own stable hue instead of every context
// sharing the one primary tint. The hue is derived from the context NAME so it's
// deterministic across every surface (card chip, list column, anywhere a context
// pill renders) and survives new contexts being added — no colour is stored.
//
// Common contexts get a fixed, intuitive hue via KEYWORD; anything else hashes
// to a stable palette slot. Uses explicit tailwind colour classes (matching the
// priority pills' `bg-<c>-500/10 text-<c>-600 dark:text-<c>-400` language) so
// each context is distinguishable in both light and dark themes.

export interface ContextAccent {
  /** filled tint chip (border + bg + text) for a @context pill */
  chip: string;
  /** the solid dot, for a leading marker / legend */
  dot: string;
}

// Eight well-separated hues. Order matters only in that KEYWORD indexes into it.
const PALETTE: ContextAccent[] = [
  { chip: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400", dot: "bg-sky-500" },
  { chip: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400", dot: "bg-violet-500" },
  { chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-500" },
  { chip: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400", dot: "bg-amber-500" },
  { chip: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400", dot: "bg-rose-500" },
  { chip: "border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400", dot: "bg-teal-500" },
  { chip: "border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400", dot: "bg-indigo-500" },
  { chip: "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400", dot: "bg-fuchsia-500" },
];

// Fixed hue for the common contexts so they never change slot when the palette
// grows — indexes into PALETTE above. Keyed on the bare word (no leading @).
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

/** The colour accent for a @context, deterministic from its name. */
export function contextAccent(name: string): ContextAccent {
  const key = name.replace(/^@/, "").trim().toLowerCase();
  const idx = key in KEYWORD ? KEYWORD[key] : hash(key) % PALETTE.length;
  return PALETTE[idx];
}
