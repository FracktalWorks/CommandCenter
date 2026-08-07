import { describe, expect, it } from "vitest";
import {
  changedFields,
  CLAMPED_PROBABILITY,
  moveItem,
  POSITION_STEP,
  renumber,
  reorder,
  validateLostReasonDraft,
  validateStatusDraft,
} from "./settings";
import type { StatusType } from "./types";

// The admin API has no bulk reorder — it has a per-row PATCH — so what a drop
// SENDS is decided here (WS-26f f2, done-when 5).

function lane(id: string, position: number) {
  return { id, position };
}

const LANES = [
  lane("qualification", 10),
  lane("proposal", 20),
  lane("negotiation", 30),
  lane("won", 40),
];

describe("moveItem", () => {
  it("moves one item and leaves the rest in order", () => {
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("is a no-op for a drop that changes nothing", () => {
    const items = ["a", "b", "c"];
    expect(moveItem(items, 1, 1)).toBe(items);
  });

  it("is a no-op for an index that does not exist", () => {
    // An HTML5 drop can report an index for a row that has since re-rendered,
    // and dropping a card should never blank a grid.
    const items = ["a", "b", "c"];
    expect(moveItem(items, 7, 0)).toBe(items);
    expect(moveItem(items, 0, -1)).toBe(items);
  });
});

describe("renumber", () => {
  it("numbers lanes in tens so one can be inserted between two", () => {
    expect(renumber([lane("a", 3), lane("b", 91)])).toEqual([
      { id: "a", position: POSITION_STEP },
      { id: "b", position: POSITION_STEP * 2 },
    ]);
  });
});

describe("reorder", () => {
  it("patches only the rows that actually moved", () => {
    // Dragging the last lane to the top renumbers everything — that is the
    // point of renumbering — but sending a PATCH for a lane whose number did
    // not change is a write nobody asked for.
    const plan = reorder(LANES, 3, 0);
    expect(plan.items.map((l) => l.id)).toEqual([
      "won",
      "qualification",
      "proposal",
      "negotiation",
    ]);
    expect(plan.patches).toEqual([
      { id: "won", position: 10 },
      { id: "qualification", position: 20 },
      { id: "proposal", position: 30 },
      { id: "negotiation", position: 40 },
    ]);
  });

  it("leaves the lanes above an in-place swap untouched", () => {
    const plan = reorder(LANES, 3, 2);
    expect(plan.patches).toEqual([
      { id: "won", position: 30 },
      { id: "negotiation", position: 40 },
    ]);
  });

  it("sends nothing for a drop onto itself", () => {
    expect(reorder(LANES, 1, 1).patches).toEqual([]);
  });

  it("repairs a list whose positions were never in tens", () => {
    // The Zoho importer appends at max(position)+10 from whatever it found, so
    // a real pipeline is not guaranteed to be tidy. A reorder normalises it.
    const messy = [lane("a", 10), lane("b", 11), lane("c", 12)];
    expect(reorder(messy, 0, 0).patches).toEqual([
      { id: "b", position: 20 },
      { id: "c", position: 30 },
    ]);
  });
});

// ── D-CRM-10, client side (done-when 5: BOTH sides) ───────────────────────

describe("validateStatusDraft", () => {
  const open: StatusType = "open";

  it("mirrors the pinned values the gateway enforces", () => {
    expect(CLAMPED_PROBABILITY).toEqual({ won: 100, lost: 0 });
  });

  it("refuses a nameless status", () => {
    expect(validateStatusDraft({ name: "  ", type: open }, "deal")).toBe(
      "A status needs a name."
    );
  });

  it("refuses a percentage that is not one", () => {
    expect(
      validateStatusDraft({ name: "Pilot", type: open, probability: 140 }, "deal")
    ).toContain("outside 0-100");
    expect(
      validateStatusDraft({ name: "Pilot", type: open, probability: -1 }, "deal")
    ).toContain("outside 0-100");
  });

  it("names the rule when a won stage would not forecast 100", () => {
    // The message has to say what to DO: "422" in a toast is not an answer to
    // "why can I not save this row".
    const message = validateStatusDraft(
      { name: "Delivered", type: "won", probability: 40 },
      "deal"
    );
    expect(message).toContain("always forecasts 100%");
    expect(message).toContain("Set probability to 100");
  });

  it("names the rule when a lost stage would not forecast 0", () => {
    expect(
      validateStatusDraft(
        { name: "Dropped", type: "lost", probability: 25 },
        "deal"
      )
    ).toContain("always forecasts 0%");
  });

  it("judges an omitted probability as the 0 the column would default to", () => {
    // Not "leave it alone": the server lands it at 0, so a won stage saved
    // without one is a contradiction the moment it exists.
    expect(
      validateStatusDraft({ name: "Delivered", type: "won" }, "deal")
    ).toContain("always forecasts 100%");
  });

  it("accepts the terminal stages at their pinned values", () => {
    expect(
      validateStatusDraft(
        { name: "Delivered", type: "won", probability: 100 },
        "deal"
      )
    ).toBeNull();
    expect(
      validateStatusDraft({ name: "Dropped", type: "lost", probability: 0 }, "deal")
    ).toBeNull();
  });

  it("never applies the clamp to a lead status", () => {
    // `crm_lead_statuses` has no probability column at all, so a won lead
    // status is not a contradiction — it is a lane with no forecast.
    expect(validateStatusDraft({ name: "Qualified", type: "won" }, "lead")).toBeNull();
  });
});

describe("validateLostReasonDraft", () => {
  it("requires a label", () => {
    expect(validateLostReasonDraft("   ")).toBe("A lost reason needs a label.");
    expect(validateLostReasonDraft("Price")).toBeNull();
  });
});

describe("changedFields", () => {
  it("sends only what moved", () => {
    // `type` and `probability` are judged TOGETHER by the server's clamp, so
    // resending an unchanged one alongside a changed one is the difference
    // between a 422 the editor caused and one the data did.
    expect(
      changedFields(
        { name: "Proposal", type: "ongoing", probability: 50 },
        { name: "Proposal/Price Quote", type: "ongoing", probability: 50 }
      )
    ).toEqual({ name: "Proposal/Price Quote" });
  });

  it("is empty when nothing moved", () => {
    expect(changedFields({ a: 1 }, { a: 1 })).toEqual({});
  });
});
