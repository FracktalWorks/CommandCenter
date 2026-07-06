// Stage colour accents shared by the Next Actions list headers and board
// columns, so a stage reads the same on both surfaces. Stages are user-named,
// so the accent is derived from name keywords first (a "Done"/"Waiting"/"In
// progress" column gets the semantically-right tone regardless of position),
// then falls back to a stable position-based hue. Uses the app's semantic
// tokens (primary/success/warning/muted) — never raw colours — so it tracks
// the theme automatically.

export interface StageAccent {
  /** the small dot beside the label + column header underline */
  dot: string;
  /** a faint tinted background for the column header strip */
  soft: string;
  /** a readable text tone for the label on the soft background */
  text: string;
  /** left border accent for the list group header */
  bar: string;
}

const ACCENTS: Record<"grey" | "blue" | "amber" | "green" | "violet", StageAccent> = {
  grey: {
    dot: "bg-muted-foreground/60",
    soft: "bg-muted/40",
    text: "text-muted-foreground",
    bar: "border-l-muted-foreground/40",
  },
  blue: {
    dot: "bg-primary",
    soft: "bg-primary/10",
    text: "text-primary",
    bar: "border-l-primary",
  },
  amber: {
    dot: "bg-warning",
    soft: "bg-warning/10",
    text: "text-warning",
    bar: "border-l-warning",
  },
  green: {
    dot: "bg-success",
    soft: "bg-success/10",
    text: "text-success",
    bar: "border-l-success",
  },
  violet: {
    // no dedicated violet token — reuse primary at lower emphasis so a 5th+
    // stage still differs from plain blue without inventing a raw colour.
    dot: "bg-primary/60",
    soft: "bg-primary/5",
    text: "text-primary/80",
    bar: "border-l-primary/50",
  },
};

type Hue = keyof typeof ACCENTS;

/** Positional fallback hues, in board order (grey → blue → amber → … → green
 *  reserved for the last stage). Keeps early stages visually distinct. */
const POSITIONAL: Hue[] = ["grey", "blue", "violet", "amber"];

function keywordHue(name: string): Hue | null {
  const n = name.toLowerCase();
  if (/(done|complete|closed|finished|shipped)/.test(n)) return "green";
  if (/(wait|block|hold|paused|stuck)/.test(n)) return "amber";
  if (/(progress|doing|active|working|review|in[\s-]?process)/.test(n))
    return "blue";
  if (/(todo|to[\s-]?do|backlog|new|open|inbox)/.test(n)) return "grey";
  return null;
}

/** The accent for a stage given its name, index, and how many stages exist.
 *  The LAST stage is the "done" stage in this app (drop there = complete), so
 *  it always reads green unless a keyword says otherwise. */
export function stageAccent(
  name: string,
  index: number,
  total: number,
): StageAccent {
  const isLast = index === total - 1;
  const kw = keywordHue(name);
  if (kw) return ACCENTS[kw];
  if (isLast) return ACCENTS.green;
  return ACCENTS[POSITIONAL[index % POSITIONAL.length]];
}
