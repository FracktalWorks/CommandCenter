import { describe, expect, it } from "vitest";
import { type SyncState, canPush, hasUpstreamTask, syncBadge } from "./syncState";

// Every state the gateway can send, named once so a fifth value cannot be
// added to the union without landing in these tables.
const STATES: SyncState[] = ["local", "pending", "synced", "awaiting_approval"];

describe("the sync-state decision table (BO-1b)", () => {
  it("allows Push from 'pending' and from nothing else", () => {
    expect(STATES.filter(canPush)).toEqual(["pending"]);
    // The one the Action Broker introduced: the write is already queued, so a
    // second Push would enqueue a second proposal for the same task.
    expect(canPush("awaiting_approval")).toBe(false);
    // An item with no state at all (mock rows, older payloads) is not pushable.
    expect(canPush(undefined)).toBe(false);
  });

  it("reports an upstream task only for the two states that have one", () => {
    expect(STATES.filter(hasUpstreamTask)).toEqual(["local", "synced"]);
    // Neither waiting state has been written to the tool — a provider round
    // trip for either would be asking about a task that does not exist.
    expect(hasUpstreamTask("pending")).toBe(false);
    expect(hasUpstreamTask("awaiting_approval")).toBe(false);
    expect(hasUpstreamTask(undefined)).toBe(true);
  });

  it("gives each waiting state its own badge, and the settled states none", () => {
    expect(syncBadge("pending")).toMatchObject({
      key: "sync:pending",
      icon: "Clock",
      label: "Not yet pushed",
      tone: "warning",
    });
    expect(syncBadge("awaiting_approval")).toMatchObject({
      key: "sync:awaiting_approval",
      icon: "ShieldCheck",
      label: "Waiting for approval",
      tone: "accent",
    });
    // `null` is the badge decision for the settled states, not an oversight:
    // a LOCAL item has no upstream to be out of step with, and a synced one
    // already shows its provider link.
    expect(syncBadge("local")).toBeNull();
    expect(syncBadge("synced")).toBeNull();
    expect(syncBadge(undefined)).toBeNull();
  });

  it("distinguishes the two waiting states — they are not synonyms", () => {
    const pending = syncBadge("pending");
    const queued = syncBadge("awaiting_approval");
    // Same shape, different everything: `pending` waits on the member,
    // `awaiting_approval` waits on the /actions inbox. Rendering one as the
    // other is the bug this table exists to prevent.
    expect(pending?.key).not.toBe(queued?.key);
    expect(pending?.label).not.toBe(queued?.label);
    expect(pending?.tone).not.toBe(queued?.tone);
  });

  it("names a tone, never a colour — the renderer owns the class table", () => {
    for (const state of STATES) {
      const badge = syncBadge(state);
      if (!badge) continue;
      expect(["muted", "danger", "accent", "warning"]).toContain(badge.tone);
      expect(JSON.stringify(badge)).not.toMatch(/#[0-9a-f]{3,8}\b|text-|bg-|border-/i);
    }
  });
});
