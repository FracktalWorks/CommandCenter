import { describe, expect, it } from "vitest";
import {
  applyMove,
  boardTotals,
  moveRequest,
  needsLostReason,
  planMove,
  statusTone,
  toBoardLanes,
  type BoardLane,
} from "./board";
import type { Deal, Pipeline, Status } from "./types";

// ── Fixtures ──────────────────────────────────────────────────────────────
//
// Shaped exactly like GET /crm/pipeline's payload (routes/crm/pipeline.py's
// PipelineResponse), including the `organization_name` the gateway's LEFT
// JOIN projects onto every deal row — migration 144 has not been applied
// anywhere, so a fixture is the whole of what can be asserted here and the
// live render is owner-verified after it applies.

function status(over: Partial<Status> & { id: string; name: string }): Status {
  return {
    color: "gray",
    position: 10,
    type: "open",
    is_default: false,
    probability: 0,
    ...over,
  };
}

function deal(over: Partial<Deal> & { id: string }): Deal {
  return {
    name: "Printer order",
    currency: "INR",
    organization_name: null,
    ...over,
  };
}

const QUALIFICATION = status({
  id: "s1",
  name: "Qualification",
  position: 10,
  color: "blue",
});
const PROPOSAL = status({
  id: "s2",
  name: "Proposal",
  position: 30,
  type: "ongoing",
  color: "amber",
});
const LOST = status({
  id: "s3",
  name: "Closed Lost",
  position: 60,
  type: "lost",
  color: "red",
});

const PIPELINE: Pipeline = {
  lanes: [
    {
      // Deliberately out of order — the board must not depend on the payload's
      // ordering to be correct.
      status: PROPOSAL,
      rows: [
        deal({
          id: "d1",
          name: "Bosch printer",
          amount: 250000,
          status_id: "s2",
          organization_name: "Bosch India",
        }),
      ],
      count: 4,
      amount: 900000,
    },
    {
      status: QUALIFICATION,
      rows: [deal({ id: "d2", amount: 100000, status_id: "s1" })],
      count: 1,
      amount: 100000,
    },
    { status: LOST, rows: [], count: 0, amount: 0 },
  ],
};

describe("toBoardLanes", () => {
  it("orders lanes by position and keeps the empty ones", () => {
    // A kanban that hides its empty columns is a list.
    const lanes = toBoardLanes(PIPELINE);
    expect(lanes.map((l) => l.status.name)).toEqual([
      "Qualification",
      "Proposal",
      "Closed Lost",
    ]);
    expect(lanes[2].rows).toEqual([]);
  });

  it("carries the organization name the gateway joined in", () => {
    // WS-26c dw 2: the card prints it, and the browser must not client-side
    // join a ≤100-row page of organizations to get it.
    const lanes = toBoardLanes(PIPELINE);
    const proposal = lanes.find((l) => l.status.name === "Proposal")!;
    expect(proposal.rows[0].organization_name).toBe("Bosch India");
  });

  it("survives an unloaded board", () => {
    expect(toBoardLanes(null)).toEqual([]);
  });
});

describe("statusTone", () => {
  it("maps the stored colour onto a semantic token", () => {
    // `color` is free text the owner (and the Zoho importer) writes, so
    // `bg-${color}-500` would be a class Tailwind never saw at build time and
    // every lane would render colourless.
    expect(statusTone({ color: "amber", type: "ongoing" })).toBe("bg-warning");
    expect(statusTone({ color: "red", type: "lost" })).toBe("bg-destructive");
  });

  it("falls back by status TYPE, not to grey", () => {
    // An unrecognised colour on a won lane should still read as won.
    expect(statusTone({ color: "chartreuse", type: "won" })).toBe("bg-success");
    expect(statusTone({ color: "", type: "lost" })).toBe("bg-destructive");
  });
});

describe("boardTotals", () => {
  it("sums the LANE totals, not the rows returned", () => {
    // Each lane returns one page of deals; its count and ₹ total cover the
    // whole lane. Summing the visible cards would understate a busy board.
    const totals = boardTotals(toBoardLanes(PIPELINE));
    expect(totals.count).toBe(5);
    expect(totals.amount).toBe(1000000);
  });
});

describe("planMove", () => {
  it("describes a real move", () => {
    expect(planMove({ id: "d1", status_id: "s2" }, "s1")).toEqual({
      dealId: "d1",
      fromStatusId: "s2",
      toStatusId: "s1",
    });
  });

  it("refuses a drop back into the same lane", () => {
    // Sending it anyway would write a crm_status_changes row with a dwell of
    // zero and a timeline entry reading "Proposal → Proposal".
    expect(planMove({ id: "d1", status_id: "s2" }, "s2")).toBeNull();
  });

  it("treats a deal with no status as movable", () => {
    expect(planMove({ id: "d1", status_id: null }, "s1")?.fromStatusId).toBeNull();
  });
});

describe("moveRequest", () => {
  it("is the PATCH the drag issues", () => {
    // The status pill in the record sheet issues the same one, so the two
    // cannot disagree about what moving a deal means.
    expect(
      moveRequest({ dealId: "d1", fromStatusId: "s2", toStatusId: "s1" })
    ).toEqual({
      path: "/deals/d1",
      method: "PATCH",
      body: { status_id: "s1" },
    });
  });
});

describe("applyMove", () => {
  const lanes = toBoardLanes(PIPELINE);
  const move = { dealId: "d1", fromStatusId: "s2", toStatusId: "s1" };

  it("moves the card and re-tallies both lanes at once", () => {
    const next = applyMove(lanes, move);
    const from = next.find((l) => l.status.id === "s2")!;
    const to = next.find((l) => l.status.id === "s1")!;

    expect(from.rows.map((d) => d.id)).toEqual([]);
    expect(from.count).toBe(3);
    expect(from.amount).toBe(650000);
    expect(to.rows.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(to.count).toBe(2);
    expect(to.amount).toBe(350000);
  });

  it("re-stamps the moved card's status so it does not re-render in limbo", () => {
    const next = applyMove(lanes, move);
    expect(next.find((l) => l.status.id === "s1")!.rows[0].status_id).toBe("s1");
  });

  it("leaves the input untouched so a refusal can put the card back", () => {
    applyMove(lanes, move);
    expect(lanes.find((l) => l.status.id === "s2")!.rows).toHaveLength(1);
  });

  it("does nothing for a card it cannot find", () => {
    expect(
      applyMove(lanes, { dealId: "ghost", fromStatusId: "s2", toStatusId: "s1" })
    ).toBe(lanes);
  });

  it("never counts a lane below zero", () => {
    const empty: BoardLane[] = [
      { status: QUALIFICATION, rows: [], count: 0, amount: 0, tone: "bg-primary" },
      {
        status: PROPOSAL,
        rows: [deal({ id: "d9", status_id: "s2" })],
        count: 0,
        amount: 0,
        tone: "bg-warning",
      },
    ];
    const next = applyMove(empty, {
      dealId: "d9",
      fromStatusId: "s2",
      toStatusId: "s1",
    });
    expect(next[1].count).toBe(0);
  });
});

describe("needsLostReason", () => {
  it("asks before the drop rather than after the 422", () => {
    // The gateway refuses a move into a lost-type status with no reason. A
    // board that learns that from an error toast has already animated the
    // card into the lane.
    expect(needsLostReason({ lost_reason_id: null }, LOST)).toBe(true);
    expect(needsLostReason({ lost_reason_id: "r1" }, LOST)).toBe(false);
    expect(needsLostReason({ lost_reason_id: null }, PROPOSAL)).toBe(false);
  });
});
