/**
 * Which band a meeting belongs to in the library.
 *
 * The list used to be one reverse-chronological run of rows reporting
 * `created_at`, duration and segment count — none of which is what anyone
 * scans for. What you actually scan for is *did anything come out of this*, and
 * *do I owe someone something*. So the library bands by what you'd do about a
 * meeting, not by when it happened.
 *
 * Pure and separate from the component so the rules are testable and so the
 * ordering can't drift silently as the UI changes.
 */

import type { MeetingListItem } from "./types";

export type BandKey = "live" | "upcoming" | "needs_you" | "done";

/** Ordered, because the bands are a priority list: what's happening now beats
 *  what's next, which beats what's waiting on you, which beats the archive. */
export const BAND_ORDER: BandKey[] = ["live", "upcoming", "needs_you", "done"];

export const BAND_LABEL: Record<BandKey, string> = {
  live: "Live now",
  upcoming: "Coming up",
  needs_you: "Needs you",
  done: "Earlier",
};

/** A meeting that hasn't been captured yet — nothing recorded, nothing
 *  transcribed. This is the same test the meeting page uses to show prep. */
export function isUnstarted(m: MeetingListItem): boolean {
  return (
    m.segment_count === 0 &&
    m.status !== "processing" &&
    m.status !== "recording" &&
    m.status !== "ready" &&
    m.status !== "failed"
  );
}

/** Has enough context that the copilot won't walk in cold. */
export function isPrepared(m: MeetingListItem): boolean {
  return (
    (m.agenda_count ?? 0) > 0 ||
    Boolean(m.has_brief) ||
    (m.attendee_count ?? 0) > 0
  );
}

export function bandOf(m: MeetingListItem): BandKey {
  if (m.is_live || m.status === "recording") return "live";
  if (isUnstarted(m)) return "upcoming";
  // Something finished but isn't closed out. Unapproved actions are the case
  // that matters — they're a promise someone made, sitting three clicks deep
  // inside a tab, which is where good intentions go to die.
  if ((m.pending_actions ?? 0) > 0) return "needs_you";
  if (m.status === "failed") return "needs_you";
  return "done";
}

/** Group meetings into ordered bands, dropping the empty ones. Ordering within
 *  a band differs by band: upcoming reads soonest-first (it's a queue), while
 *  everything else reads newest-first (it's a history). */
export function groupIntoBands(
  meetings: MeetingListItem[]
): { key: BandKey; label: string; items: MeetingListItem[] }[] {
  const buckets = new Map<BandKey, MeetingListItem[]>();
  for (const m of meetings) {
    const k = bandOf(m);
    const list = buckets.get(k);
    if (list) list.push(m);
    else buckets.set(k, [m]);
  }

  const upcoming = buckets.get("upcoming");
  if (upcoming) {
    upcoming.sort((a, b) => {
      // A meeting with a time is more urgent than one without; among those,
      // soonest first. Undated drafts sink to the bottom of the band.
      const ta = a.scheduled_at ? Date.parse(a.scheduled_at) : Infinity;
      const tb = b.scheduled_at ? Date.parse(b.scheduled_at) : Infinity;
      if (ta !== tb) return ta - tb;
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    });
  }

  return BAND_ORDER.filter((k) => (buckets.get(k)?.length ?? 0) > 0).map((k) => ({
    key: k,
    label: BAND_LABEL[k],
    items: buckets.get(k) as MeetingListItem[],
  }));
}

/** The one line under a meeting's title: what came of it, not how it was made. */
export function outcomeLine(m: MeetingListItem): string {
  const bits: string[] = [];
  if (bandOf(m) === "upcoming") {
    if ((m.agenda_count ?? 0) > 0) {
      bits.push(`Agenda · ${m.agenda_count} item${m.agenda_count === 1 ? "" : "s"}`);
    }
    if (m.has_brief) bits.push("Briefed");
    if ((m.attendee_count ?? 0) > 0) {
      bits.push(`${m.attendee_count} attendee${m.attendee_count === 1 ? "" : "s"}`);
    }
    return bits.length ? bits.join(" · ") : "Not prepared yet";
  }
  if ((m.pending_actions ?? 0) > 0) {
    bits.push(
      `${m.pending_actions} action${m.pending_actions === 1 ? "" : "s"} waiting for approval`
    );
  } else if ((m.action_count ?? 0) > 0) {
    bits.push(`${m.action_count} action${m.action_count === 1 ? "" : "s"}`);
  }
  if (m.has_notes) bits.push("Notes ready");
  if (m.status === "failed") bits.push("Transcription failed");
  return bits.join(" · ");
}
