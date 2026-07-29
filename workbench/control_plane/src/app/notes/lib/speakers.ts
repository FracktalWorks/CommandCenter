/**
 * Speaker identity colour, in one place.
 *
 * The transcript coloured speakers; the live console coloured them differently;
 * the roster and list rows didn't colour them at all. Same person, three
 * appearances, no relationship between them — which is a large part of why the
 * app read as a collection of screens rather than one product.
 *
 * One hue per speaker, carried through every surface that mentions them: the
 * transcript's left edge, the name, the avatar, the roster chip. The payoff is
 * that a wall of text becomes scannable — you can see who dominated a meeting
 * before reading a word of it.
 *
 * Hues are drawn from the app's existing semantic tokens rather than a new
 * palette, so speakers stay legible in both themes without a second colour
 * system to maintain.
 */

const TEXT = [
  "text-primary",
  "text-accent",
  "text-success",
  "text-warning",
  "text-destructive",
];

const EDGE = [
  "border-primary",
  "border-accent",
  "border-success",
  "border-warning",
  "border-destructive",
];

const AVATAR = [
  "bg-primary/15 text-primary",
  "bg-accent/15 text-accent",
  "bg-success/15 text-success",
  "bg-warning/15 text-warning",
  "bg-destructive/15 text-destructive",
];

const DOT = [
  "bg-primary",
  "bg-accent",
  "bg-success",
  "bg-warning",
  "bg-destructive",
];

/**
 * Stable 0-based hue index for a speaker key ("S1", "S2", "Speaker 3"…).
 *
 * Falls back to hashing when the key carries no number, so a named speaker or
 * an unusual label still gets a consistent colour rather than always landing on
 * the first hue and colliding with everyone else.
 */
export function speakerHue(key: string | null | undefined): number {
  if (!key) return 0;
  const digits = key.replace(/\D/g, "");
  if (digits) {
    const n = parseInt(digits, 10);
    return (Number.isNaN(n) ? 0 : Math.max(0, n - 1)) % TEXT.length;
  }
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % TEXT.length;
}

export function speakerText(key: string | null | undefined): string {
  return key ? TEXT[speakerHue(key)] : "text-muted-foreground";
}

export function speakerEdge(key: string | null | undefined): string {
  return key ? EDGE[speakerHue(key)] : "border-border";
}

export function speakerAvatar(key: string | null | undefined): string {
  return key ? AVATAR[speakerHue(key)] : "bg-muted text-muted-foreground";
}

export function speakerDot(key: string | null | undefined): string {
  return key ? DOT[speakerHue(key)] : "bg-muted-foreground";
}

/** Initials for an avatar — two letters from a name, else the first two chars. */
export function speakerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name.trim().slice(0, 2) || "?").toUpperCase();
}
