/**
 * Tests for how the library bands meetings.
 *
 * The bands are a priority list — what's happening now, what's next, what's
 * waiting on you, then the archive — and getting the priority wrong is how a
 * meeting goes missing. These pin the ordering rules and the one band that
 * earns its keep: unapproved actions surfacing instead of hiding in a tab.
 */
import { describe, expect, it } from "vitest";
import { bandOf, groupIntoBands, isPrepared, outcomeLine } from "./bands";
import type { MeetingListItem } from "./types";

function meeting(over: Partial<MeetingListItem> = {}): MeetingListItem {
  return {
    id: "m1",
    title: "A meeting",
    platform: "other",
    status: "draft",
    language: null,
    duration_s: null,
    segment_count: 0,
    has_notes: false,
    owner_email: null,
    template_key: null,
    start_at: null,
    created_at: "2026-07-01T10:00:00Z",
    ...over,
  };
}

describe("band assignment", () => {
  it("puts a running session first, whichever way it reports being live", () => {
    expect(bandOf(meeting({ is_live: true }))).toBe("live");
    expect(bandOf(meeting({ status: "recording" }))).toBe("live");
  });

  it("treats a meeting with nothing captured as upcoming", () => {
    expect(bandOf(meeting({ status: "draft", segment_count: 0 }))).toBe("upcoming");
  });

  it("surfaces unapproved actions instead of leaving them in a tab", () => {
    const m = meeting({ status: "ready", segment_count: 40, pending_actions: 3 });
    expect(bandOf(m)).toBe("needs_you");
  });

  it("treats a failed transcription as needing you, not as archive", () => {
    expect(bandOf(meeting({ status: "failed", segment_count: 0 }))).toBe("needs_you");
  });

  it("files a finished, closed-out meeting under the archive", () => {
    const m = meeting({
      status: "ready",
      segment_count: 40,
      pending_actions: 0,
      action_count: 4,
      has_notes: true,
    });
    expect(bandOf(m)).toBe("done");
  });

  it("does not call a live meeting 'needs you' just because actions are pending", () => {
    // Live wins: acting on it now matters more than triaging it later.
    const m = meeting({ is_live: true, pending_actions: 5 });
    expect(bandOf(m)).toBe("live");
  });
});

describe("grouping", () => {
  it("orders bands by priority and drops empty ones", () => {
    const bands = groupIntoBands([
      meeting({ id: "a", status: "ready", segment_count: 5, has_notes: true }),
      meeting({ id: "b", is_live: true }),
    ]);
    expect(bands.map((b) => b.key)).toEqual(["live", "done"]);
  });

  it("reads upcoming soonest-first — it's a queue, not a history", () => {
    const bands = groupIntoBands([
      meeting({ id: "later", scheduled_at: "2026-08-02T10:00:00Z" }),
      meeting({ id: "sooner", scheduled_at: "2026-08-01T10:00:00Z" }),
    ]);
    const upcoming = bands.find((b) => b.key === "upcoming");
    expect(upcoming?.items.map((m) => m.id)).toEqual(["sooner", "later"]);
  });

  it("sinks undated drafts below anything with a time on it", () => {
    const bands = groupIntoBands([
      meeting({ id: "undated" }),
      meeting({ id: "dated", scheduled_at: "2026-08-01T10:00:00Z" }),
    ]);
    const upcoming = bands.find((b) => b.key === "upcoming");
    expect(upcoming?.items[0].id).toBe("dated");
  });

  it("returns nothing for an empty library", () => {
    expect(groupIntoBands([])).toEqual([]);
  });
});

describe("prepared state", () => {
  it("counts any real context as prepared", () => {
    expect(isPrepared(meeting({ agenda_count: 2 }))).toBe(true);
    expect(isPrepared(meeting({ has_brief: true }))).toBe(true);
    expect(isPrepared(meeting({ attendee_count: 3 }))).toBe(true);
  });

  it("an empty meeting is not prepared", () => {
    expect(isPrepared(meeting())).toBe(false);
  });
});

describe("the row's one line", () => {
  it("reports outcomes for a finished meeting, not mechanics", () => {
    const line = outcomeLine(
      meeting({ status: "ready", segment_count: 40, pending_actions: 2, has_notes: true })
    );
    expect(line).toContain("2 actions waiting for approval");
    expect(line).toContain("Notes ready");
    expect(line).not.toContain("segment");
  });

  it("reports prep state for an upcoming one", () => {
    const line = outcomeLine(meeting({ agenda_count: 4, has_brief: true }));
    expect(line).toContain("Agenda · 4 items");
    expect(line).toContain("Briefed");
  });

  it("says so plainly when an upcoming meeting has nothing", () => {
    expect(outcomeLine(meeting())).toBe("Not prepared yet");
  });

  it("gets singular and plural right", () => {
    expect(outcomeLine(meeting({ agenda_count: 1 }))).toContain("1 item");
    expect(
      outcomeLine(meeting({ status: "ready", segment_count: 4, pending_actions: 1 }))
    ).toContain("1 action waiting");
  });
});
