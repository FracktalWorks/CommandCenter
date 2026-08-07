import { describe, expect, it } from "vitest";
import { threadStatusLabel, timelineBranch, timelineKey } from "./timeline";
import type { Activity, EmailThread, StatusChange, TimelineEntry } from "./types";

const activity: Activity = {
  id: "act-1",
  type: "note",
  body: "Rang them",
};

const statusChange: StatusChange = {
  id: "sc-1",
  to_status: "Qualified",
  changed_by: "priya@fracktal.in",
};

const emailThread: EmailThread = {
  thread_id: "thread-1",
  account_id: "acct-1",
  message_id: "msg-1",
  subject: "Re: quote",
  status: "NEEDS_REPLY",
};

function entry(over: Partial<TimelineEntry>): TimelineEntry {
  return { kind: "activity", origin: "own", ...over };
}

describe("timelineBranch", () => {
  it("routes each kind to its own renderer", () => {
    expect(timelineBranch(entry({ kind: "activity", activity }))).toBe("activity");
    expect(
      timelineBranch(entry({ kind: "status_change", status_change: statusChange }))
    ).toBe("status_change");
    expect(
      timelineBranch(entry({ kind: "email_thread", email_thread: emailThread }))
    ).toBe("email_thread");
  });

  it("never routes an email thread into the activity branch", () => {
    // The bug this whole module exists for. `ActivityEntry` opens with
    // `entry.activity!` and then reads `activity.type` — an email entry
    // reaching it throws at runtime, and the `!` hides that from tsc. Before
    // the third branch existed the dispatch was binary, so "not a status
    // change" meant "an activity", and this was the shipped behaviour.
    const email = entry({ kind: "email_thread", email_thread: emailThread });
    expect(timelineBranch(email)).not.toBe("activity");
    expect(email.activity ?? null).toBeNull();
  });

  it("refuses an entry whose payload is missing rather than guessing", () => {
    // A kind with no payload means the server changed shape. Rendering it as
    // whatever branch happens to be last is the crash; an empty row reads as
    // data loss on a record somebody is trying to trust.
    expect(timelineBranch(entry({ kind: "email_thread" }))).toBe("unknown");
    expect(timelineBranch(entry({ kind: "activity", activity: null }))).toBe(
      "unknown"
    );
    expect(timelineBranch(entry({ kind: "status_change" }))).toBe("unknown");
  });
});

describe("timelineKey", () => {
  it("keys an email entry by its thread, not by its position", () => {
    // Entries arrive merged from three sources and re-sorted; a positional key
    // makes React reuse the wrong node the moment a newer email lands.
    expect(
      timelineKey(entry({ kind: "email_thread", email_thread: emailThread }), 3)
    ).toBe("email_thread-thread-1");
  });

  it("keeps the existing keys for the two older kinds", () => {
    expect(timelineKey(entry({ kind: "activity", activity }), 0)).toBe(
      "activity-act-1"
    );
    expect(
      timelineKey(entry({ kind: "status_change", status_change: statusChange }), 0)
    ).toBe("status_change-sc-1");
  });

  it("falls back to the index when an entry carries no id at all", () => {
    expect(timelineKey(entry({ kind: "activity" }), 7)).toBe("activity-7");
  });
});

describe("threadStatusLabel", () => {
  it("says the four statuses the way a human would", () => {
    expect(threadStatusLabel("NEEDS_REPLY")).toBe("Needs reply");
    expect(threadStatusLabel("AWAITING")).toBe("Awaiting reply");
    expect(threadStatusLabel("FYI")).toBe("FYI");
    expect(threadStatusLabel("DONE")).toBe("Done");
  });

  it("says nothing about a thread nobody classified", () => {
    // Absent is not the same as unknown: most threads have no status row, and
    // a badge on every one of them is noise the timeline does not need.
    expect(threadStatusLabel(null)).toBeNull();
    expect(threadStatusLabel(undefined)).toBeNull();
    expect(threadStatusLabel("  ")).toBeNull();
  });

  it("shows an unrecognised status verbatim rather than dropping it", () => {
    // The email app owns this vocabulary and may grow it. Hiding a value we do
    // not recognise is how a UI starts disagreeing with its own data.
    expect(threadStatusLabel("SNOOZED")).toBe("SNOOZED");
  });
});
