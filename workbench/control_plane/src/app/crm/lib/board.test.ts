import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyMove,
  boardTotals,
  moveRequest,
  needsLostReason,
  planMove,
  statusTone,
  toBoardLanes,
  weightedDeal,
  weightedRows,
  WEIGHTED_TYPES,
  type BoardLane,
} from "./board";
import type { Deal, Pipeline, Status, StatusType } from "./types";

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
  // 144's seed priors: a deal that has stated nothing inherits these.
  probability: 10,
});
const PROPOSAL = status({
  id: "s2",
  name: "Proposal",
  position: 30,
  type: "ongoing",
  color: "amber",
  probability: 50,
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
          probability: 50,
          status_id: "s2",
          organization_name: "Bosch India",
        }),
      ],
      count: 4,
      amount: 900000,
      // Whole-lane, from the gateway — deliberately NOT derivable from `rows`,
      // which is one page of the four deals the lane holds.
      weighted: 450000,
    },
    {
      status: QUALIFICATION,
      rows: [
        deal({ id: "d2", amount: 100000, probability: 10, status_id: "s1" }),
      ],
      count: 1,
      amount: 100000,
      weighted: 10000,
    },
    { status: LOST, rows: [], count: 0, amount: 0, weighted: 0 },
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

  it("rolls the weighted figures up the same way", () => {
    // WS-26f f3: the header's weighted number is the sum of the LANE weighted
    // figures the gateway computed, not a recomputation over the cards — the
    // Proposal lane holds four deals and returned one.
    const totals = boardTotals(toBoardLanes(PIPELINE));
    expect(totals.weighted).toBe(460000);
  });
});

// ── WS-26f f3 · the weighted formula (done-when 6) ────────────────────────

describe("weightedDeal", () => {
  it("uses the deal's own probability", () => {
    // D-CRM-10: forecast math reads the DEAL, never the stage. A rep who
    // knows the champion just left marks a Proposal deal at 20 without moving
    // it, and the forecast has to believe them.
    expect(weightedDeal({ amount: 200000, probability: 20 }, PROPOSAL)).toBe(
      40000
    );
  });

  it("inherits the stage default for a NULL probability", () => {
    // The inheritance materializes when a deal ENTERS a stage, so a NULL
    // survives only on rows that predate a move — i.e. every imported deal,
    // which is most of the board today.
    expect(weightedDeal({ amount: 200000, probability: null }, PROPOSAL)).toBe(
      100000
    );
    expect(
      weightedDeal({ amount: 200000, probability: undefined }, PROPOSAL)
    ).toBe(100000);
  });

  it("treats a stated 0 as a measurement, not as a missing value", () => {
    expect(weightedDeal({ amount: 200000, probability: 0 }, PROPOSAL)).toBe(0);
  });

  it("carries a 100 through unchanged", () => {
    expect(weightedDeal({ amount: 200000, probability: 100 }, PROPOSAL)).toBe(
      200000
    );
  });

  it("forecasts nothing for a deal with no amount", () => {
    expect(weightedDeal({ amount: null, probability: 80 }, PROPOSAL)).toBe(0);
  });

  it("falls back to zero when neither the deal nor the stage says", () => {
    expect(
      weightedDeal({ amount: 200000, probability: null }, { probability: null })
    ).toBe(0);
  });
});

describe("weightedRows", () => {
  const ON_HOLD = status({
    id: "s4",
    name: "Parked",
    position: 40,
    type: "on_hold",
    probability: 40,
  });
  const WON = status({
    id: "s5",
    name: "Closed Won",
    position: 50,
    type: "won",
    probability: 100,
  });
  const rows = [
    deal({ id: "a", amount: 100000, probability: 25 }),
    deal({ id: "b", amount: 200000, probability: null }),
    deal({ id: "c", amount: 50000, probability: 0 }),
  ];

  it("sums a mixed lane", () => {
    // 25000 + (200000 × 50% inherited) + 0
    expect(weightedRows(rows, PROPOSAL)).toBe(125000);
  });

  it("counts only open and ongoing stages", () => {
    expect(WEIGHTED_TYPES).toEqual(["open", "ongoing"]);
    expect(weightedRows(rows, QUALIFICATION)).toBeGreaterThan(0);
  });

  it("forecasts nothing from a won lane — that is closed revenue", () => {
    expect(weightedRows(rows, WON)).toBe(0);
  });

  it("forecasts nothing from a lost lane", () => {
    expect(weightedRows(rows, LOST)).toBe(0);
  });

  it("excludes on_hold, the fifth type the spec's prose never mentions", () => {
    // A deal nobody is working is not a forecast. Counting it at its stage's
    // prior is how a pipeline number stays high while the quarter empties.
    expect(weightedRows(rows, ON_HOLD)).toBe(0);
  });

  it("is zero for an empty lane rather than NaN", () => {
    expect(weightedRows([], PROPOSAL)).toBe(0);
  });
});

// ── WS-26g · the cross-language weighted parity fixture ───────────────────
//
// ONE file, read by BOTH runners. `tests/unit/test_crm_reports.py` drives the
// same rows through the emitted SQL (`core.WEIGHTED_SQL`, read out of the
// statement text by `_crm_fakes._WEIGHTED_SUM_RE`); this drives them through
// `weightedDeal`/`weightedRows`. Two independently typed tables are not
// parity, which is the whole reason the fixture exists rather than a comment
// pointing one implementation at the other.

type ParityRow = {
  name: string;
  amount: number | null;
  deal_probability: number | null;
  stage_probability: number | null;
  stage_type: StatusType;
  expected_weighted: number;
};

const PARITY: ParityRow[] = JSON.parse(
  readFileSync(
    fileURLToPath(
      // …/crm/lib → …/crm → …/app → …/src → control_plane → workbench → repo
      new URL(
        "../../../../../../tests/fixtures/crm_weighted_parity.json",
        import.meta.url
      )
    ),
    "utf-8"
  )
).rows;

describe("the weighted parity fixture", () => {
  it("is present and non-trivial", () => {
    // A fixture that quietly disappeared would leave this file asserting
    // nothing while the pytest half stayed green — the exact failure a shared
    // fixture exists to remove, so its absence must be loud on both sides.
    expect(PARITY.length).toBeGreaterThanOrEqual(10);
  });

  it.each(PARITY)(
    "weightedRows agrees with the SQL: $name",
    (row: ParityRow) => {
      // `weightedRows` is the function the fixture pins because it applies the
      // open/ongoing filter, exactly as the gateway's `_lane_totals` does — so
      // the won/lost/on_hold rows assert the exclusion rather than skipping.
      expect(
        weightedRows(
          [{ amount: row.amount, probability: row.deal_probability }],
          { type: row.stage_type, probability: row.stage_probability }
        )
      ).toBeCloseTo(row.expected_weighted, 6);
    }
  );

  it.each(PARITY.filter((row) => WEIGHTED_TYPES.includes(row.stage_type)))(
    "weightedDeal agrees for a forecastable stage: $name",
    (row: ParityRow) => {
      expect(
        weightedDeal(
          { amount: row.amount, probability: row.deal_probability },
          { probability: row.stage_probability }
        )
      ).toBeCloseTo(row.expected_weighted, 6);
    }
  );
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

  it("re-tallies the weighted figures with them", () => {
    // Leaving weighted until the server re-read would show a lane whose ₹
    // total dropped and whose forecast did not — two numbers side by side
    // disagreeing about the same drag. d1 is ₹250,000 at 50%.
    const next = applyMove(lanes, move);
    const from = next.find((l) => l.status.id === "s2")!;
    const to = next.find((l) => l.status.id === "s1")!;

    expect(from.weighted).toBe(450000 - 125000);
    expect(to.weighted).toBe(10000 + 125000);
  });

  it("never lets a re-tally take a lane's forecast negative", () => {
    const next = applyMove(
      [
        { ...lanes[0], weighted: 0 },
        { ...lanes[1] },
        { ...lanes[2] },
      ],
      { dealId: "d2", fromStatusId: "s1", toStatusId: "s2" }
    );
    expect(next[0].weighted).toBe(0);
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
      {
        status: QUALIFICATION,
        rows: [],
        count: 0,
        amount: 0,
        weighted: 0,
        tone: "bg-primary",
      },
      {
        status: PROPOSAL,
        rows: [deal({ id: "d9", status_id: "s2" })],
        count: 0,
        amount: 0,
        weighted: 0,
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
