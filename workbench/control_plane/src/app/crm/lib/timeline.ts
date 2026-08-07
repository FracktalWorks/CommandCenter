// ── Timeline entry dispatch — pure, so the branch decision is testable ────
//
// `Timeline.tsx` renders three kinds of entry and cannot be render-tested here
// (vitest runs `environment: "node"` over `src/**/*.test.ts`; there is no jsdom
// and no `.tsx` in the include glob). The decision worth testing is therefore
// pulled out into this module, where it is plain data in and a string out.
//
// It exists because of a real trap. The dispatch used to be BINARY —
//
//     entry.kind === "status_change" ? <StatusEntry/> : <ActivityEntry/>
//
// — and `ActivityEntry` opens with `const activity = entry.activity!`. The `!`
// suppresses the null check, so tsc could not see that a third kind reaching
// that branch reads `.type` off null and throws at runtime. Adding a kind to
// the union in `types.ts` is therefore only half the change; the other half is
// a branch here, and `timeline.test.ts` is what says so out loud.

import type { TimelineEntry } from "./types";

/** Which renderer an entry belongs to, or `"unknown"` if nothing can render it. */
export type TimelineBranch =
  | "activity"
  | "status_change"
  | "email_thread"
  | "unknown";

/**
 * Route one entry to its renderer.
 *
 * Every branch requires its OWN payload to be present, not merely the matching
 * `kind`. A `kind` with no payload is a server that changed shape under us, and
 * the honest answer to that is "I cannot render this" — never "render it as an
 * activity", which is the crash, and never an empty row, which looks like data
 * loss to whoever is reading the record.
 */
export function timelineBranch(entry: TimelineEntry): TimelineBranch {
  if (entry.kind === "status_change" && entry.status_change) return "status_change";
  if (entry.kind === "email_thread" && entry.email_thread) return "email_thread";
  if (entry.kind === "activity" && entry.activity) return "activity";
  return "unknown";
}

/**
 * A stable React key for one entry.
 *
 * The list index alone is not enough: entries arrive merged from three sources
 * and re-sorted, so a key that is only positional makes React reuse the wrong
 * DOM node when a new email lands. The index stays as the tail because two
 * different sources can legitimately produce entries with no id at all.
 */
export function timelineKey(entry: TimelineEntry, index: number): string {
  const id =
    entry.activity?.id ??
    entry.status_change?.id ??
    entry.email_thread?.thread_id ??
    index;
  return `${entry.kind}-${id}`;
}

/** The email app's per-thread statuses, in the words a human uses for them. */
const THREAD_STATUS_LABELS: Record<string, string> = {
  NEEDS_REPLY: "Needs reply",
  AWAITING: "Awaiting reply",
  FYI: "FYI",
  DONE: "Done",
};

/**
 * The status badge's text, or null when there is nothing to say.
 *
 * A thread nobody classified has no status, and an unrecognised one is shown
 * verbatim rather than dropped: the email app owns that vocabulary and may
 * grow it, and silently hiding a value we do not recognise is how a UI starts
 * disagreeing with its own data.
 */
export function threadStatusLabel(
  status: string | null | undefined
): string | null {
  const value = (status || "").trim();
  if (!value) return null;
  return THREAD_STATUS_LABELS[value.toUpperCase()] ?? value;
}
