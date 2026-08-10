/**
 * The status colour vocabulary — one palette for /projects and /tasks (WS-27ad).
 *
 * Before this module there were three vocabularies and a fact nobody drew:
 *
 *  1. `app/tasks/lib/stageColors.ts` — a real accent system (dot / soft / text /
 *     bar) resolved from the stage NAME, because /tasks' stages are user-typed
 *     and nothing machine-readable exists to key off. Its board columns, list
 *     group headers and status pill all read the same because of it.
 *  2. `app/projects/lib/tags.ts` — a six-name chip palette used for tags only.
 *  3. `pm_task_statuses.color` — stored since migration 146, exposed on the API
 *     as `StatusRow.color`, and **rendered nowhere**: every Projects board
 *     column drew the same `bg-muted`, so a Done lane and a Backlog lane looked
 *     identical while the /tasks board next door was colour-coded.
 *
 * So this is a merge, not a redesign. Both existing palettes were already
 * token-only (`DESIGN_SYSTEM.md` forbids a literal), and the class strings below
 * are theirs — which is what lets /tasks keep rendering byte-identically while
 * gaining a shared home.
 *
 * ## Precedence
 *
 * An accent is resolved by asking, in order, for the most authoritative fact
 * available. Each step exists because one of the two apps has that fact and the
 * other does not:
 *
 *   1. **stored colour** — `status.color`, `tag.color`. Somebody chose it; a
 *      derived hue must never overrule a human.
 *   2. **category** — Projects' six machine-readable values
 *      (`routes/projects/core.py` `STATUS_CATEGORIES`). Projects *knows* what a
 *      lane means; guessing from its name would be worse information.
 *   3. **name keyword** — /tasks' stages are user-named and have no category, so
 *      "Done"/"Waiting"/"In progress" are read out of the words. The regexes are
 *      ported unchanged from `stageColors.ts`.
 *   4. **positional** — nothing is known, so give neighbouring lanes different
 *      hues. `lastIsDone` additionally paints the final lane green, which is
 *      /tasks' rule (dropping on the last stage completes the task) and NOT
 *      Projects' (where a category already says so).
 *
 * Unknown input never throws and never returns undefined: an unrecognised colour
 * name or category falls through to the next step, and the end of the chain is
 * always a hue. A board that renders no columns because somebody typed a colour
 * we do not know is a worse failure than a grey column.
 */

/**
 * The accent shape /tasks proved, plus the chip pair tags need.
 *
 * Five slots rather than one string because a hue is used five ways and the
 * variations are not derivable from each other: `soft` is a fill behind text,
 * `text` must stay readable ON that fill, `dot` is a solid marker, `bar` is a
 * left border, and `chip` is a self-contained pill whose gray and violet
 * deliberately differ from `soft`+`text` (see CHIP below).
 */
export interface StatusAccent {
  /** The solid marker: a column's cap, the dot beside a label. */
  dot: string;
  /** A faint tinted background for a header strip or pill. */
  soft: string;
  /** A readable text tone on the `soft` background. */
  text: string;
  /** The left border accent of a list group header. */
  bar: string;
  /** A complete pill: background AND text, for a tag or status chip. */
  chip: string;
}

/**
 * The palette, by name.
 *
 * **`gray`, not `grey`.** Both spellings existed — `stageColors` wrote `grey`
 * internally, the database writes `gray` (`146_projects.sql`, `DEFAULT 'gray'`)
 * and so does `TAG_COLORS`. The stored spelling wins, because that is the one a
 * row can contain; `grey` is accepted as an alias so no call site has to care.
 */
export const ACCENT_HUES = [
  "gray",
  "red",
  "amber",
  "green",
  "blue",
  "violet",
] as const;

export type AccentHue = (typeof ACCENT_HUES)[number];

const ACCENTS: Record<AccentHue, StatusAccent> = {
  gray: {
    dot: "bg-muted-foreground/60",
    soft: "bg-muted/40",
    text: "text-muted-foreground",
    bar: "border-l-muted-foreground/40",
    // Deliberately not `soft`+`text`: a tag chip sits on a card and needs a
    // solid-enough fill to read as a chip, which `bg-muted/40` does not give.
    chip: "bg-secondary text-muted-foreground",
  },
  red: {
    dot: "bg-destructive",
    soft: "bg-destructive/10",
    text: "text-destructive",
    bar: "border-l-destructive",
    chip: "bg-destructive/10 text-destructive",
  },
  amber: {
    dot: "bg-warning",
    soft: "bg-warning/10",
    text: "text-warning",
    bar: "border-l-warning",
    chip: "bg-warning/10 text-warning",
  },
  green: {
    dot: "bg-success",
    soft: "bg-success/10",
    text: "text-success",
    bar: "border-l-success",
    chip: "bg-success/10 text-success",
  },
  blue: {
    dot: "bg-primary",
    soft: "bg-primary/10",
    text: "text-primary",
    bar: "border-l-primary",
    chip: "bg-primary/10 text-primary",
  },
  violet: {
    // No dedicated violet token — primary at lower emphasis, so a fifth lane
    // still differs from plain blue without inventing a raw colour.
    dot: "bg-primary/60",
    soft: "bg-primary/5",
    text: "text-primary/80",
    bar: "border-l-primary/50",
    // The tag palette's violet, kept as it was: `accent` is the one token pair
    // that gives a distinct chip without competing with `primary`.
    chip: "bg-accent text-accent-foreground",
  },
};

/** Spellings a stored value may legitimately use. */
const COLOR_ALIASES: Record<string, AccentHue> = {
  grey: "gray",
  gray: "gray",
  red: "red",
  amber: "amber",
  orange: "amber",
  yellow: "amber",
  green: "green",
  blue: "blue",
  violet: "violet",
  purple: "violet",
};

/**
 * `pm_task_statuses.category` → hue.
 *
 * **Agrees with `keywordHue` below, lane for lane — that agreement IS the
 * feature.** A category and a name are two ways of learning the same thing, so
 * if they disagreed, the same lane would render one colour in /projects (which
 * has categories) and another in /tasks (which has only names), which is the
 * exact divergence this module exists to end. `test_category_and_keyword_agree`
 * is the fence.
 *
 * It was briefly the other way round: this map was written to match the seeded
 * colours in `routes/projects/tree.py` (`To do` blue, `In progress` amber), and
 * the result was that two of the four default lanes still read differently in
 * the two apps. The seed moved to match this instead — the semantics belong to
 * the token vocabulary, not to whatever four rows a migration happened to
 * insert. `bg-primary` is this UI's "active" tone everywhere else, so
 * `in_progress` is blue; nothing has started in `backlog` or `todo`, so both
 * stay muted.
 *
 * `cancelled` is terminal-and-not-successful, which is what the destructive
 * tone means everywhere else here. `triage` (WS-27u) is the
 * parked-at-the-front-door lane; /tasks has no counterpart, so it takes the one
 * remaining distinct hue freely.
 *
 * ⚠️ `backlog` and `todo` are both gray, so a board carrying both draws two
 * muted lanes side by side. That is /tasks' existing behaviour (its keyword
 * rule maps both words to grey) and matching it is the point of this change,
 * not a regression introduced by it. An owner who wants them distinct now has a
 * working lever for the first time: `status.color` outranks this map, and as of
 * WS-27ad it is actually rendered.
 */
const CATEGORY_HUES: Record<string, AccentHue> = {
  backlog: "gray",
  todo: "gray",
  in_progress: "blue",
  done: "green",
  cancelled: "red",
  triage: "violet",
};

/**
 * Name keywords, ported byte-for-byte from `stageColors.ts`.
 *
 * Unchanged on purpose: /tasks' rendering is driven entirely by these, and
 * "improving" one regex here silently repaints somebody's board. A missing case
 * (there is no `cancel` rule) is a deliberate non-change, not an oversight —
 * adding it would recolour any /tasks stage named "Cancelled".
 */
function keywordHue(name: string): AccentHue | null {
  const n = name.toLowerCase();
  if (/(done|complete|closed|finished|shipped)/.test(n)) return "green";
  if (/(wait|block|hold|paused|stuck)/.test(n)) return "amber";
  if (/(progress|doing|active|working|review|in[\s-]?process)/.test(n))
    return "blue";
  if (/(todo|to[\s-]?do|backlog|new|open|inbox)/.test(n)) return "gray";
  return null;
}

/** Positional fallback hues, in axis order. Keeps early lanes distinct. */
const POSITIONAL: AccentHue[] = ["gray", "blue", "violet", "amber"];

/** Everything either app knows about one lane, tag or status. All optional. */
export interface AccentInput {
  /** A stored colour NAME — `pm_task_statuses.color`, `pm_tags.color`. */
  color?: string | null;
  /** A machine-readable category — Projects' `STATUS_CATEGORIES`. */
  category?: string | null;
  /** The human-facing name, for axes nobody categorised (/tasks' stages). */
  name?: string | null;
  /** Where this lane sits on its axis, for the positional fallback. */
  index?: number;
  /** How many lanes the axis has. */
  total?: number;
  /**
   * Paint the LAST lane green even without a keyword.
   *
   * /tasks' rule: dropping on the final stage marks the task done, so the final
   * stage IS the done stage. Projects must not inherit it — a lane's meaning
   * there comes from its category, never from where it happens to sit.
   */
  lastIsDone?: boolean;
}

/**
 * The hue for one lane. Exported so the precedence itself is testable without
 * asserting on class strings.
 */
export function resolveHue(input: AccentInput): AccentHue {
  const stored = input.color?.trim().toLowerCase();
  if (stored && stored in COLOR_ALIASES) return COLOR_ALIASES[stored];

  const category = input.category?.trim().toLowerCase();
  if (category && category in CATEGORY_HUES) return CATEGORY_HUES[category];

  if (input.name) {
    const keyword = keywordHue(input.name);
    if (keyword) return keyword;
  }

  const index = input.index ?? 0;
  const total = input.total ?? 0;
  if (input.lastIsDone && total > 0 && index === total - 1) return "green";
  return POSITIONAL[Math.abs(index) % POSITIONAL.length];
}

/** The accent for one lane, tag or status. */
export function statusAccent(input: AccentInput): StatusAccent {
  return ACCENTS[resolveHue(input)];
}

/** The accent for a bare hue name — the tag picker's swatch list. */
export function accentForHue(hue: AccentHue): StatusAccent {
  return ACCENTS[hue];
}
